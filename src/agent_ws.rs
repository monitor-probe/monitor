//! The agent side of the hub: one WebSocket per node carrying JSON-RPC 2.0
//! notifications. A single long-lived connection on which either end may speak
//! first, with self-describing frames readable via curl or a browser console.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Local};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::auth::node_ip;
use crate::db::Db;
use crate::{App, Shared};

/// How often a quiet agent is probed, and how long the hub waits for any frame
/// before abandoning the connection.
const HEARTBEAT: Duration = Duration::from_secs(30);
const SILENCE: Duration = Duration::from_secs(120);

/// Reports closer together than this are dropped. The agent's floor is one
/// second; half of it leaves room for two reports the network has bunched.
const REPORT_SPACING: Duration = Duration::from_millis(500);

/// Probe results admitted per window: twice what the busiest honest node sends
/// in one -- every probe it may run, each at the shortest interval -- since a
/// window can straddle two rounds.
const RESULT_WINDOW: Duration = Duration::from_secs(Db::MIN_PROBE_INTERVAL as u64);
const RESULTS_PER_WINDOW: u32 = 2 * Db::MAX_PROBES_PER_NODE as u32;

/// Distinguishes one agent session on a node from the next. A connection can
/// remain nominally open for up to SILENCE, long enough for the agent to have
/// given up and reconnected; without this tag a late teardown would remove the
/// live session that replaced it.
static SESSION: AtomicU64 = AtomicU64::new(0);

/// When the hub received a frame, read from both clocks at once: the wall clock
/// for stamps and calendar dates, the monotonic one for durations.
#[derive(Debug, Clone, Copy)]
pub struct Arrival {
    pub tick: Instant,
    pub at: DateTime<Local>,
}

impl Arrival {
    pub fn now() -> Self {
        Self { tick: Instant::now(), at: Local::now() }
    }

    fn minute(&self) -> i64 {
        self.at.timestamp().div_euclid(60)
    }
}

/// One connected agent. Held in memory only, and rebuilt within one report
/// interval of a hub restart.
///
/// A single map, because "the node is online" and "the node has current figures"
/// are the same fact. Split across two, they required manual synchronisation at
/// every call site and diverged: the connection was recorded at the handshake
/// and the metrics at the first report, so a node that had connected but not yet
/// reported appeared offline for a whole `--interval`.
#[derive(Debug)]
pub struct Agent {
    /// Distinguishes one session on a node from the next; see [`release`].
    pub session: u64,
    /// Outbound channel, used to push probe assignments.
    pub tx: mpsc::Sender<String>,
    /// The latest report, or `Null` between connecting and the first one.
    pub metrics: serde_json::Value,
    pub last_seen: i64,
    /// The wall-clock minute this session last wrote a history row for, or the
    /// one it opened in. A row is written when a report arrives past it.
    ///
    /// No row is written for the minute a session opens in. The session it
    /// replaced has already written that row from the reports of a whole
    /// minute, which the new session's first report would overwrite with a
    /// single sample.
    last_minute: Option<i64>,
    /// The reading the next history row measures its network rate from. See
    /// [`report`].
    mark: Option<Mark>,
    /// Running mean of the minute in progress.
    minute: Minute,
    /// When this session's first and latest reports arrived, and how many came
    /// after the first. See [`Agent::interval`].
    reports: Option<(Instant, Instant, u32)>,
}

impl Agent {
    pub fn new(session: u64, tx: mpsc::Sender<String>) -> Self {
        Self {
            session,
            tx,
            metrics: serde_json::Value::Null,
            last_seen: 0,
            last_minute: None,
            mark: None,
            minute: Minute::default(),
            reports: None,
        }
    }

    /// The interval the agent reports at, in whole seconds: the mean spacing of
    /// this session's reports, `None` before the second. The agent does not
    /// state its own, and a reinstall keeps it unless told otherwise, so the
    /// install dialog shows this as what it would keep.
    pub fn interval(&self) -> Option<u64> {
        let (first, last, spacings) = self.reports?;
        (spacings > 0)
            .then(|| (last.duration_since(first).as_secs_f64() / f64::from(spacings)).round() as u64)
    }
}

/// Where a history row's network rate starts: the kernel's counters as a report
/// carried them, so the chart integrates to the bytes the traffic row books.
/// Without it a row would hold the agent's reading of a single second -- a 1-in-60
/// sample of the minute it describes.
///
/// `tick` is an `Instant` rather than the wall clock, because the rate divides by
/// a duration. NTP stepping the clock backwards -- a fresh boot correcting
/// itself, a restored snapshot -- makes a wall-clock difference negative, and the
/// `.max(1)` guarding the division would then divide a whole minute of bytes by
/// one second. The agent computes its own rate against `Instant` for the same
/// reason.
#[derive(Debug)]
struct Mark {
    tick: Instant,
    epoch: String,
    counters: (i64, i64),
}

/// Fields a history row carries as the mean of its minute rather than the single
/// reading that landed on the boundary. A 30-second spike between two samples is
/// real load that a point sample would report as idle.
///
/// `load` is absent because no history row carries it: it is a live figure read
/// from the report. `net_rx` and `net_tx` are absent because [`report`] derives
/// them from the kernel's counters, which is exact.
const MEAN_FLOAT: [&str; 1] = ["cpu"];
const MEAN_INT: [&str; 6] = ["mem_used", "swap_used", "disk_used", "tcp", "udp", "procs"];

/// Running sums for the minute in progress, one slot per averaged field.
#[derive(Debug, Default)]
struct Minute {
    sums: [f64; MEAN_FLOAT.len() + MEAN_INT.len()],
    reports: f64,
}

impl Minute {
    fn add(&mut self, metrics: &serde_json::Value) {
        for (slot, key) in MEAN_FLOAT.iter().chain(&MEAN_INT).enumerate() {
            self.sums[slot] += metrics.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
        }
        self.reports += 1.0;
    }

    /// Replaces each averaged field with the mean of the reports folded in so
    /// far, keeping integers integral: `insert_metric` reads them with `as_i64`,
    /// which returns nothing for a value carrying a fraction.
    fn write_into(&self, row: &mut serde_json::Value) {
        let Some(obj) = row.as_object_mut() else { return };
        if self.reports == 0.0 {
            return;
        }
        for (slot, key) in MEAN_FLOAT.iter().chain(&MEAN_INT).enumerate() {
            if !obj.contains_key(*key) {
                continue;
            }
            let mean = self.sums[slot] / self.reports;
            let mean = if slot < MEAN_FLOAT.len() { json!(mean) } else { json!(mean.round() as i64) };
            obj.insert((*key).to_owned(), mean);
        }
    }
}

/// What one connection may cost the hub, and the probe results it has yet to
/// file. Local to the connection, unlike [`Agent`], which others read.
///
/// A node token is enough to send frames at any rate, and each is parsed and
/// most are written: unbounded, 34,209 reports over one connection in ten
/// seconds would have the hub write 93 MB (measured). The agent's own pace is
/// known, so what exceeds it is dropped: reports faster than its one-second
/// floor, a second hello, and results beyond [`Db::MAX_PROBES_PER_NODE`]
/// probes each run every [`Db::MIN_PROBE_INTERVAL`] seconds.
///
/// ponytail: the caps start afresh with each connection, so a token reconnecting
/// in a loop costs two commits per handshake -- the hello, and the first
/// report's `last_seen` -- rather than a few per minute. An honest agent cannot
/// do this, as it doubles its wait after a short session. A per-node limit on
/// handshakes if it is ever observed; reissuing the token ends it meanwhile.
#[derive(Debug, Default)]
struct Session {
    greeted: bool,
    last_report: Option<Instant>,
    /// Start of the current result window and the results admitted in it.
    window: Option<(Instant, u32)>,
    /// Whether a dropped or unusable frame has been logged; see [`Session::complain`].
    complained: bool,
    /// Probe results as `(task_id, ts, latency)`, filed a minute at a time
    /// because each commit writes at least one page.
    results: Vec<(i64, i64, i64)>,
}

impl Session {
    fn admit_report(&mut self, tick: Instant) -> bool {
        if self.last_report.is_some_and(|last| tick.saturating_duration_since(last) < REPORT_SPACING) {
            return false;
        }
        self.last_report = Some(tick);
        true
    }

    fn admit_result(&mut self, tick: Instant) -> bool {
        let (start, admitted) = self.window.get_or_insert((tick, 0));
        if tick.saturating_duration_since(*start) >= RESULT_WINDOW {
            (*start, *admitted) = (tick, 0);
        }
        *admitted += 1;
        *admitted <= RESULTS_PER_WINDOW
    }

    /// Logs the first dropped or unusable frame of a session as a warning and
    /// the rest at debug: a peer that sends one tends to send thousands, and each
    /// line is a journal write.
    fn complain(&mut self, node_id: i64, what: impl std::fmt::Display) {
        if std::mem::replace(&mut self.complained, true) {
            debug!("node {node_id}: {what}");
        } else {
            warn!("node {node_id}: {what}; more of these on this connection are logged at debug");
        }
    }

    /// Files the probe results gathered so far. Taken rather than kept on a
    /// failure, so a database that refuses them cannot grow the buffer.
    fn file_results(&mut self, app: &App, node_id: i64) -> Result<()> {
        let results = std::mem::take(&mut self.results);
        if results.is_empty() {
            return Ok(());
        }
        app.db.insert_pings(node_id, &results)
    }
}

#[derive(Deserialize)]
struct Rpc {
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

pub async fn handler(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(token) = bearer(&headers) else {
        return (StatusCode::UNAUTHORIZED, "missing token").into_response();
    };
    let Ok(Some(node_id)) = app.db.node_by_token(token) else {
        // The same response whether the token is malformed or merely unknown.
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    };
    let ip = node_ip(&headers, peer.ip()).to_string();

    upgrade.read_buffer_size(crate::api::SOCKET_BUFFER).max_message_size(crate::api::MAX_FRAME).on_upgrade(
        move |socket| async move {
            if let Err(e) = serve(app, node_id, ip, socket).await {
                debug!("node {node_id} disconnected: {e:#}");
            }
        },
    )
}

/// Extracts the node token from `Authorization: Bearer <token>`.
pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ").filter(|t| !t.is_empty())
}

async fn serve(app: Shared, node_id: i64, ip: String, mut socket: WebSocket) -> Result<()> {
    let (tx, mut rx) = mpsc::channel::<String>(16);
    let tag = SESSION.fetch_add(1, Ordering::Relaxed);
    // Online from the handshake rather than the first report: a panel reporting
    // otherwise for a whole interval would describe the hub's bookkeeping rather
    // than the machine.
    app.agents.write().unwrap_or_else(|e| e.into_inner()).insert(node_id, Agent::new(tag, tx));
    info!("node {node_id} connected from {ip}");

    // Send the probe list before the first report arrives.
    let _ = socket.send(Message::Text(ping_tasks_message(&app, node_id).into())).await;

    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await; // The first tick completes immediately.
    let mut last_frame = Instant::now();
    // The address this node's country is still owed for. A lookup that failed,
    // or was held back by `ASKED`, is retried on the heartbeat while the
    // connection lasts; otherwise it would wait for the next hello, which on a
    // steady link is days away.
    let mut owed: Option<String> = None;
    let mut session = Session::default();

    let outcome = loop {
        tokio::select! {
            outbound = rx.recv() => match outbound {
                Some(text) => socket.send(Message::Text(text.into())).await?,
                None => break Ok(()),
            },
            // A machine that leaves the network without closing its socket would
            // leave this receive pending until the kernel abandons the TCP session
            // hours later, with the node reading online and its metrics frozen. A
            // ping every HEARTBEAT proves the path in both directions; any frame
            // in return, the pong included, counts as a sign of life.
            _ = heartbeat.tick() => {
                let quiet = last_frame.elapsed();
                if quiet > SILENCE {
                    break Err(anyhow::anyhow!("silent for {}s", quiet.as_secs()));
                }
                if let Some(source) = &owed {
                    match tokio::task::block_in_place(|| app.db.country_owed(node_id, source)) {
                        Ok(true) => locate(app.clone(), node_id, source.clone()),
                        Ok(false) => owed = None,
                        Err(e) => debug!("node {node_id}: country check failed: {e:#}"),
                    }
                }
                socket.send(Message::Ping(Vec::new().into())).await?;
            }
            inbound = socket.recv() => {
                last_frame = Instant::now();
                match inbound {
                // A frame can wait on the single database connection, which a
                // restore or vacuum can hold for seconds. Without this, agents
                // would park every worker thread on that lock and starve the rest
                // of the runtime -- the panel, the public page, the shutdown
                // signal.
                Some(Ok(Message::Text(text))) => {
                    let arrival = Arrival::now();
                    match tokio::task::block_in_place(|| dispatch(&app, node_id, &ip, &text, &mut session, arrival)) {
                        Ok(Some(source)) => {
                            locate(app.clone(), node_id, source.clone());
                            owed = Some(source);
                        }
                        Ok(None) => {}
                        Err(e) => session.complain(node_id, format_args!("unusable message: {e:#}")),
                    }
                }
                Some(Ok(Message::Close(_))) | None => break Ok(()),
                Some(Ok(_)) => {}
                Some(Err(e)) => break Err(e.into()),
                }
            }
        }
    };

    let ended = release(&app, node_id, tag);
    if ended.is_some() {
        info!("node {node_id} went offline");
    }
    tokio::task::block_in_place(|| close(&app, node_id, ended.as_ref(), &mut session));
    outcome
}

/// Drops a node's connection state, but only while the session tagged `tag` is
/// still the one holding it, and returns what it held.
///
/// A teardown can arrive up to SILENCE after the agent gave up, by which time a
/// reconnect may have installed a newer session under the same node id; clearing
/// that one would mark a node offline while it is reporting normally.
fn release(app: &App, node_id: i64, tag: u64) -> Option<Agent> {
    let mut agents = app.agents.write().unwrap_or_else(|e| e.into_inner());
    if !agents.get(&node_id).is_some_and(|a| a.session == tag) {
        return None;
    }
    agents.remove(&node_id)
}

/// Files what an ended session still held: the node's held reading, the probe
/// results not yet filed, and when the node was last seen, with the capacities
/// it last reported.
///
/// All of it for a session that ended on its own, which [`release`] reports as
/// `ended`. One a reconnect replaced files its probe results alone: they
/// arrived on this connection and no other, while its successor files newer
/// figures of the rest, and an older `last_seen` would move that back. One the
/// panel ended, by deleting the node, reissuing its token or restoring the
/// database, files nothing.
fn close(app: &App, node_id: i64, ended: Option<&Agent>, session: &mut Session) {
    if ended.is_none() && !app.agents.read().unwrap_or_else(|e| e.into_inner()).contains_key(&node_id) {
        return;
    }
    if let Err(e) = session.file_results(app, node_id) {
        warn!("node {node_id}: filing its last probe results failed: {e:#}");
    }
    let Some(agent) = ended else { return };
    book_held(app, Some(node_id));
    if agent.last_seen > 0 {
        if let Err(e) = app.db.touch_seen(node_id, agent.last_seen, &agent.metrics) {
            warn!("node {node_id}: recording when it was last seen failed: {e:#}");
        }
    }
}

/// Handles one inbound frame and returns the address a country lookup is now
/// owed for, if any. The lookup itself is an outbound request and happens off
/// this path; see `locate`.
fn dispatch(
    app: &App,
    node_id: i64,
    ip: &str,
    text: &str,
    session: &mut Session,
    arrival: Arrival,
) -> Result<Option<String>> {
    let rpc: Rpc = serde_json::from_str(text)?;
    // Results gathered in an earlier minute are filed on the next frame of any
    // kind: reports arrive every few seconds even where every probe runs once an
    // hour. A failure is logged rather than returned, which would discard the
    // frame that happened to trigger it.
    if session.results.first().is_some_and(|&(_, ts, _)| ts.div_euclid(60) != arrival.minute()) {
        if let Err(e) = session.file_results(app, node_id) {
            session.complain(node_id, format_args!("filing probe results failed: {e:#}"));
        }
    }
    match rpc.method.as_str() {
        "hello" => {
            if std::mem::replace(&mut session.greeted, true) {
                session.complain(node_id, "a second hello on one connection was ignored");
                return Ok(None);
            }
            let field = |k: &str| rpc.params.get(k).and_then(|v| v.as_str()).unwrap_or("");
            let source =
                country_source(ip, field("ipv4"), field("ipv6")).map_or_else(String::new, |a| a.to_string());
            let owed = app.db.save_facts(node_id, &rpc.params, ip, &source)?;
            return Ok(owed.then_some(source));
        }
        // Dropped quietly: two reports the network bunched are how an honest
        // agent trips this.
        "report" if !session.admit_report(arrival.tick) => {
            debug!("node {node_id}: a report within {REPORT_SPACING:?} of the last was dropped")
        }
        "report" => report(app, node_id, rpc.params, arrival)?,
        "ping.result" if !session.admit_result(arrival.tick) => session.complain(
            node_id,
            format_args!(
                "more than {RESULTS_PER_WINDOW} probe results within {RESULT_WINDOW:?} were dropped"
            ),
        ),
        "ping.result" => {
            let task_id = rpc.params.get("task_id").and_then(|v| v.as_i64()).unwrap_or(0);
            // A missing reading is not a reading of -1: `close_bucket` counts
            // every negative latency as a lost packet, so defaulting here would
            // render a malformed frame as an outage. A report follows the same
            // rule for a counter it cannot read.
            let latency = rpc.params.get("latency_ms").and_then(|v| v.as_i64());
            if let (true, Some(latency)) = (task_id > 0, latency) {
                session.results.push((task_id, arrival.at.timestamp(), latency));
            }
        }
        other => debug!("node {node_id} sent unknown method {other}"),
    }
    Ok(None)
}

/// Globally routable. Excluded on the v4 side: RFC 1918, CGNAT (100.64/10),
/// loopback, link-local, 0/8, 192.0.0/24, 198.18/15 (the fake-IP range of
/// TUN-mode proxies), multicast and reserved. On the v6 side only 2000::/3
/// counts, which leaves out ULA, link-local and loopback.
///
/// The agent ranks its interface addresses by the same ranges, and
/// `api::addresses` decides by them which to show; the two lists are to be
/// changed together.
pub(crate) fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || a == 0
                || a >= 224
                || (a == 100 && b & 0xc0 == 64)
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && b & 0xfe == 18))
        }
        IpAddr::V6(v6) => v6.segments()[0] & 0xe000 == 0x2000,
    }
}

/// The address a node's country is looked up from: a public address on the
/// node's own interface, v4 before v6, and failing both the address its
/// connection arrived from. `None` when none of them is public, as where hub
/// and node share a network; such an address has no country and is not sent to
/// the lookup service.
///
/// An interface address belongs to the machine. The connection's source may
/// belong to whatever stands in front of it, and on a home network behind a
/// transparent proxy that is an exit in another country. v4 leads because a
/// tunnelled v6, such as a tunnel broker's prefix, locates at the tunnel server
/// rather than at the machine.
///
/// The interface addresses are the agent's word, so each must parse as an
/// address of its own family before it can reach the lookup URL.
fn country_source(ip: &str, ipv4: &str, ipv6: &str) -> Option<IpAddr> {
    let v4 = ipv4.parse::<Ipv4Addr>().ok().map(IpAddr::V4);
    let v6 = ipv6.parse::<Ipv6Addr>().ok().map(IpAddr::V6);
    [v4, v6, ip.parse().ok()].into_iter().flatten().find(|a| public(*a))
}

/// When each node was last looked up.
///
/// A failed lookup leaves the country column empty, so `save_facts` continues to
/// report the node as owed one and `serve` retries it on every heartbeat; without
/// this gate that would be an outbound request every 30 seconds, and an agent
/// reconnecting every few seconds -- a poor link, or two machines sharing a
/// token -- would add one per reconnect. Keying on the address cannot cover the
/// second case: the two machines report different addresses, so every reconnect
/// reads as a new question and the gate never closes. Only the time is
/// recorded. The cost is that a node genuinely changing address within the hour
/// acquires its badge when the hour is up, and an empty column is already a
/// permitted state. Returning to the last address answered before the current
/// one is not a change: `Db::save_facts` restores that answer without asking.
static ASKED: OnceLock<Mutex<HashMap<i64, Instant>>> = OnceLock::new();
const LOCATE_RETRY: Duration = Duration::from_secs(3_600);

/// Resolves a node's lookup address (see [`country_source`]) to a country, at
/// most once per hour per node.
///
/// The answer comes from a third party and appears on the public page, so only
/// two ASCII letters are ever stored. Anything else -- an outage, a rate limit,
/// an address the service cannot place -- leaves the column empty and the badge
/// hidden until the retry.
///
/// ponytail: no backoff beyond that one window, and the record is per process. A
/// hub restart repeats the lookup once per node.
fn locate(app: Shared, node_id: i64, source: String) {
    let mut asked = ASKED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if asked.get(&node_id).is_some_and(|at| at.elapsed() < LOCATE_RETRY) {
        return;
    }
    asked.insert(node_id, Instant::now());
    drop(asked);

    tokio::spawn(async move {
        let lookup = async {
            let url = format!("https://ipinfo.io/{source}/country");
            anyhow::Ok(app.http.get(url).send().await?.error_for_status()?.text().await?)
        };
        let cc = match lookup.await {
            Ok(body) => body.trim().to_ascii_uppercase(),
            Err(e) => return debug!("node {node_id}: no country for {source}: {e:#}"),
        };
        if cc.len() != 2 || !cc.bytes().all(|b| b.is_ascii_uppercase()) {
            return debug!("node {node_id}: {source} resolved to no country");
        }
        if let Err(e) = app.db.set_country(node_id, &cc, &source) {
            warn!("node {node_id}: storing country {cc} failed: {e:#}");
        }
    });
}

/// Figures `api::node_view` fills into `metrics` from the traffic row. They never
/// arrive from an agent and are therefore not part of the contract one must meet.
pub(crate) const INJECTED: [&str; 4] = ["total_rx", "total_tx", "month_rx", "month_tx"];

/// Everything an agent must send, derived from the public view rather than
/// restated a third time: this list, `api::PUBLIC_METRICS` and the check below
/// must agree, and only one of them is an independent fact.
///
/// The measure is what the hub depends on, not what it stores. `uptime`,
/// `mem_total`, `swap_total` and `disk_total` never reach the `metric` table but
/// go straight to the browser, and the default theme blanks a node's entire live
/// view when one is absent. Derived from the stored columns instead, this list
/// left those four uncovered, so an agent renaming one blanked every card on the
/// page with nothing in any log to explain it.
///
/// Hub and agent ship as two binaries from two repositories, and every reader
/// here ends in `unwrap_or(0)`: a field the agent renames does not fail, it
/// records zero until someone examines that chart.
fn report_fields() -> impl Iterator<Item = &'static str> {
    ["boot_id", "net_rx_total", "net_tx_total"]
        .into_iter()
        .chain(crate::api::PUBLIC_METRICS.iter().copied().filter(|k| !INJECTED.contains(k)))
}

/// Those carrying a plain number. `boot_id` is a string and `load` an array of
/// three; each is checked separately.
fn numeric_fields() -> impl Iterator<Item = &'static str> {
    report_fields().filter(|k| !matches!(*k, "boot_id" | "load"))
}

/// Reports, once per connection, when a report omits fields the hub depends on.
/// A version number cannot serve here: an agent that renames a field carries a
/// higher version, not a lower one. An empty `boot_id` counts as omitted, since
/// no reading can be taken without one.
fn check_contract(node_id: i64, metrics: &serde_json::Value) {
    let missing: Vec<&str> =
        report_fields().filter(|k| metrics.get(k).is_none_or(|v| v.is_null() || *v == "")).collect();
    if !missing.is_empty() {
        warn!("node {node_id} reports without {missing:?}: this agent and this hub are out of step, and what depends on those fields -- traffic, charts, the default theme's live view -- will not show them");
    }
}

/// One report's pair of kernel byte counters, the span they belong to, and when
/// the hub received them.
#[derive(Debug)]
pub struct Reading {
    /// The agent's `boot_id`: comparable readings share it.
    epoch: String,
    counters: (i64, i64),
    arrival: Arrival,
    /// Whether this reading has been booked into the traffic row.
    booked: bool,
}

impl Reading {
    /// Whether `next` continues this reading's span. A new epoch or a counter
    /// that moved backwards leaves nothing to subtract.
    fn continued_by(&self, next: &Reading) -> bool {
        self.epoch == next.epoch && next.counters.0 >= self.counters.0 && next.counters.1 >= self.counters.1
    }
}

/// Holds a node's newest reading and books it into the traffic row about once a
/// minute rather than with every report.
///
/// Each booking is a commit that writes at least one page. Booked with every
/// report, the traffic row would be most of what the hub writes: measured at
/// 1.04 GB in 7.3 hours for eight nodes reporting every second, against an 8 MB
/// database. Holding a reading back loses nothing, because the kernel counter
/// keeps counting: a later booking takes in everything since the last reading
/// booked. Skipping the readings in between gives the same totals as booking
/// all of them, provided every break is booked on both sides:
///
/// - no reading held: book this one, which aligns the baseline or takes in what
///   the node counted while away;
/// - a break: book the held reading as the last of its span, then this one as
///   the first of the next;
/// - a new minute: book the held reading, dated by its own arrival, so a byte
///   moved before midnight still counts toward that day; where it was already
///   booked (reports a minute or more apart) book this one;
/// - otherwise book nothing.
///
/// Per node rather than per session, and booked under one lock. A session
/// holding its own reading would, once a reconnect had replaced it, hold an
/// older reading than its successor; booking that as it closed would move the
/// baseline back and count the difference twice.
///
/// ponytail: one lock for every node, held across a booking, so a report waits
/// while another node's booking waits on the database. Per-node locks if a slow
/// query ever holds reports up behind one.
fn file(app: &App, node_id: i64, reading: Reading) -> Result<()> {
    let book = |r: &Reading| app.db.accumulate(node_id, &r.epoch, r.counters, r.arrival.at);
    let mut held = app.readings.lock().unwrap_or_else(|e| e.into_inner());
    // Whether the held reading, then this one, is booked.
    let (book_last, book_this) = match held.get(&node_id) {
        None => (false, true),
        Some(last) if !last.continued_by(&reading) => (!last.booked, true),
        Some(last) if last.arrival.minute() != reading.arrival.minute() => (!last.booked, last.booked),
        Some(_) => (false, false),
    };
    if book_last {
        book(&held[&node_id])?;
    }
    if book_this {
        book(&reading)?;
    }
    held.insert(node_id, Reading { booked: book_this, ..reading });
    Ok(())
}

/// Books held readings not yet booked: one node's as its session ends, every
/// node's as the hub stops. Otherwise a node that reboots before reporting again
/// takes the bytes since its last booking with it.
pub fn book_held(app: &App, node: Option<i64>) {
    let mut held = app.readings.lock().unwrap_or_else(|e| e.into_inner());
    for (id, reading) in held.iter_mut().filter(|(id, r)| !r.booked && node.is_none_or(|n| n == **id)) {
        match app.db.accumulate(*id, &reading.epoch, reading.counters, reading.arrival.at) {
            Ok(_) => reading.booked = true,
            Err(e) => warn!("node {id}: booking its last reading failed: {e:#}"),
        }
    }
}

fn report(app: &App, node_id: i64, metrics: serde_json::Value, arrival: Arrival) -> Result<()> {
    // Missing fields remain compatible with older agents, while malformed values
    // must not become a live frame that can crash a browser. Counter validation
    // is separate: a missing or null kernel reading must not alter its
    // baseline.
    let number = |v: &serde_json::Value| v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0);
    anyhow::ensure!(metrics.is_object(), "report must be an object");
    for key in numeric_fields() {
        anyhow::ensure!(metrics.get(key).is_none_or(number), "invalid report field {key}");
    }
    if let Some(load) = metrics.get("load") {
        anyhow::ensure!(
            load.as_array().is_some_and(|v| v.len() == 3 && v.iter().all(number)),
            "invalid load"
        );
    }
    // No reading is not a reading of zero: booking zero would align the
    // baseline to it and book the next report's lifetime counter as one delta.
    // Anything that is not a non-negative i64 is likewise no reading -- a u64
    // beyond the signed range, a float, or a negative value -- and so is a pair
    // without an epoch, which cannot say whether it continues the last one.
    let counter = |k: &str| metrics.get(k).and_then(|v| v.as_i64()).filter(|n| *n >= 0);
    let reading = metrics
        .get("boot_id")
        .and_then(|v| v.as_str())
        .filter(|e| !e.is_empty())
        .zip(counter("net_rx_total").zip(counter("net_tx_total")))
        .map(|(epoch, counters)| Reading { epoch: epoch.to_owned(), counters, arrival, booked: false });
    let span = reading.as_ref().map(|r| (r.epoch.clone(), r.counters));
    if let Some(reading) = reading {
        file(app, node_id, reading)?;
    }

    let minute = arrival.minute();
    let mut agents = app.agents.write().unwrap_or_else(|e| e.into_inner());
    // Absence means the session was retired mid-flight: the panel rotated the
    // token, or the socket is unwinding. The reading above remains filed; there
    // is simply no longer a session to attribute the rest to.
    let Some(entry) = agents.get_mut(&node_id) else { return Ok(()) };
    let first = entry.last_seen == 0;
    if first {
        check_contract(node_id, &metrics);
    }
    // History holds one row per minute; the live view receives every report.
    let store = *entry.last_minute.get_or_insert(minute) != minute;
    entry.metrics = metrics.clone();
    entry.last_seen = arrival.at.timestamp();
    entry.reports = Some(match entry.reports {
        Some((first, _, n)) => (first, arrival.tick, n + 1),
        None => (arrival.tick, arrival.tick, 0),
    });
    entry.minute.add(&metrics);

    // The stored row summarises the interval since the previous row rather than
    // the instant it is stamped with: the network rate from the kernel's
    // counters over that interval, every other averaged field from the mean of
    // the reports in between. The live view retains the report as it arrived.
    //
    // Measured within one span only. At a break the row keeps the agent's own
    // reading, and the mark restarts from the new span.
    let row = store.then(|| {
        let mut row = metrics.clone();
        entry.minute.write_into(&mut row);
        if let (Some((epoch, (rx, tx))), Some(mark), Some(obj)) = (&span, &entry.mark, row.as_object_mut()) {
            if mark.epoch == *epoch {
                let elapsed = arrival.tick.saturating_duration_since(mark.tick).as_secs().max(1) as i64;
                obj.insert("net_rx".into(), json!((rx - mark.counters.0).max(0) / elapsed));
                obj.insert("net_tx".into(), json!((tx - mark.counters.1).max(0) / elapsed));
            }
        }
        entry.last_minute = Some(minute);
        entry.minute = Minute::default();
        row
    });
    if let Some((epoch, counters)) = span {
        if row.is_some() || entry.mark.as_ref().is_none_or(|m| m.epoch != epoch) {
            entry.mark = Some(Mark { tick: arrival.tick, epoch, counters });
        }
    }
    drop(agents);

    if let Some(row) = &row {
        app.db.insert_metric(node_id, minute * 60, row)?;
    }
    // "Offline since" is read from this column, so a session ending before its
    // first minute boundary must still leave a mark.
    if row.is_some() || first {
        app.db.touch_seen(node_id, arrival.at.timestamp(), &metrics)?;
    }
    Ok(())
}

fn ping_tasks_message(app: &App, node_id: i64) -> String {
    let tasks = app.db.ping_tasks_for(node_id).unwrap_or_default();
    json!({"jsonrpc": "2.0", "method": "ping.tasks", "params": tasks}).to_string()
}

/// Pushes the current probe list to every connected agent, so a panel edit takes
/// effect without waiting for a reconnect.
pub fn push_ping_tasks(app: &App) {
    let connected: Vec<(i64, mpsc::Sender<String>)> = app
        .agents
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(id, agent)| (*id, agent.tx.clone()))
        .collect();
    for (node_id, sender) in connected {
        // The queue carries only these messages, so a full one indicates an agent
        // that has stopped reading its socket. It is dropped within SILENCE and
        // reconnects onto the current list; what must not happen is the panel
        // reporting a push that never occurred.
        if sender.try_send(ping_tasks_message(app, node_id)).is_err() {
            warn!("node {node_id} is not draining its queue; it gets the new probe list when it reconnects");
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::db::{Node, PingTask};

    fn app() -> App {
        App::for_test(Db::open(":memory:").unwrap())
    }

    fn node(app: &App) -> i64 {
        app.db
            .create_node(
                &Node { name: "n".into(), traffic_reset_day: 1, ..Default::default() },
                &crate::auth::random_token(),
            )
            .unwrap()
    }

    /// A connected agent, the precondition for filing any report: the session
    /// holds the node's live state.
    fn connect(app: &App) -> (i64, mpsc::Receiver<String>) {
        let id = node(app);
        let (tx, rx) = mpsc::channel(4);
        app.agents.write().unwrap().insert(id, Agent::new(1, tx));
        (id, rx)
    }

    /// A frame arriving `ms` milliseconds after 23:58 on 31 January: a new minute
    /// every 60 s, and midnight with the start of the billing period at 120 s.
    fn at_ms(ms: u64) -> Arrival {
        static START: OnceLock<Instant> = OnceLock::new();
        let start = *START.get_or_init(Instant::now);
        let base = Local.with_ymd_and_hms(2026, 1, 31, 23, 58, 0).unwrap();
        Arrival {
            tick: start + Duration::from_millis(ms),
            at: base + chrono::Duration::milliseconds(ms as i64),
        }
    }

    fn at(secs: u64) -> Arrival {
        at_ms(secs * 1_000)
    }

    /// One frame on `session`, `secs` into the test's clock.
    fn send(app: &App, id: i64, session: &mut Session, secs: u64, text: &str) -> Result<Option<String>> {
        dispatch(app, id, "ip", text, session, at(secs))
    }

    fn report_json(boot: &str, rx: i64, tx: i64) -> String {
        json!({
            "jsonrpc": "2.0", "method": "report",
            "params": {"boot_id": boot, "cpu": 12.5, "load": [0.5, 0.4, 0.3],
                       "mem_used": 100, "net_rx_total": rx, "net_tx_total": tx}
        })
        .to_string()
    }

    fn probe(app: &App, node: i64, name: &str) -> i64 {
        app.db
            .save_ping_task(&PingTask {
                name: name.into(),
                target: "1.1.1.1:443".into(),
                interval: 60,
                nodes: vec![node],
                ..Default::default()
            })
            .unwrap()
    }

    fn result_json(task: i64, latency: i64) -> String {
        json!({"jsonrpc": "2.0", "method": "ping.result", "params": {"task_id": task, "latency_ms": latency}})
            .to_string()
    }

    fn results(app: &App, id: i64) -> Vec<(i64, i64)> {
        let mut seen: Vec<(i64, i64)> = app
            .db
            .ping_records(id, 0, 60)
            .unwrap()
            .0
            .iter()
            .map(|r| (r["task_id"].as_i64().unwrap(), r["latency"].as_i64().unwrap()))
            .collect();
        // Sorted rather than indexed: rows landing in one second come back in
        // no particular order.
        seen.sort();
        seen
    }

    fn total_rx(app: &App, id: i64) -> i64 {
        app.db.all_traffic()[&id].total_rx
    }

    #[test]
    fn malformed_reports_leave_the_last_good_frame_and_counters_untouched() {
        let app = app();
        let (id, _held) = connect(&app);
        let mut session = Session::default();
        send(&app, id, &mut session, 0, &report_json("boot", 1_000, 500)).unwrap();
        let good = app.agents.read().unwrap()[&id].metrics.clone();
        for bad in [json!({"load":null}), json!({"load":[1,"bad",3]}), json!({"cpu":"bad"}), json!([])] {
            assert!(report(&app, id, bad, at(30)).is_err());
            assert_eq!(app.agents.read().unwrap()[&id].metrics, good);
        }
        send(&app, id, &mut session, 60, &report_json("boot", 2_000, 600)).unwrap();
        assert_eq!(total_rx(&app, id), 1_000);
    }

    /// The lifetime total must never decrease, and must never book bytes nobody
    /// moved. The two figures behind it arrive from another repository's binary
    /// and are the only report fields that mutate state outliving the
    /// connection.
    #[test]
    fn a_hostile_counter_can_neither_inflate_the_total_nor_wrap_it() {
        let app = app();
        let (id, _held) = connect(&app);
        // A minute apart, so each reading that is one gets booked. Both
        // counters, always: `report` pairs them, so omitting one makes the pair
        // unreadable and every assertion below pass for that reason rather than
        // the one under test.
        let minute = std::cell::Cell::new(0);
        let send = |boot: &str, rx: serde_json::Value| {
            minute.set(minute.get() + 1);
            report(
                &app,
                id,
                json!({"boot_id": boot, "net_rx_total": rx, "net_tx_total": 0}),
                at(minute.get() * 60),
            )
        };

        // A negative reading is rejected and, critically, does not survive as the
        // baseline the next report subtracts from, which would make that report's
        // delta its own value plus 5 GB.
        assert!(send("b", json!(-5_000_000_000i64)).is_err());
        send("b", json!(1_000)).unwrap();
        assert_eq!(total_rx(&app, id), 0, "a node that moved nothing books nothing");

        // Nor does a u64 beyond the signed range, which `as_i64` cannot read: no
        // reading, so the baseline is unchanged.
        send("b", json!(u64::MAX)).unwrap();
        send("b", json!(2_000)).unwrap();
        assert_eq!(total_rx(&app, id), 1_000, "only the 1 000 bytes this hub watched climb");

        // The total saturates rather than wrapping. A plain `+=` would wrap to
        // i64::MIN in release builds, where overflow checks are disabled,
        // producing a lifetime figure that has decreased.
        app.db
            .set_traffic(id, &crate::db::TrafficPatch { total_rx: Some(i64::MAX - 10), ..Default::default() })
            .unwrap();
        send("c", json!(0)).unwrap();
        send("c", json!(i64::MAX)).unwrap();
        assert_eq!(total_rx(&app, id), i64::MAX, "the total clamps; it never goes backwards");
    }

    /// No reading is not a reading of zero, and a pair of counters without an
    /// epoch is no reading: neither books anything or moves the baseline, so the
    /// next real reading is a delta rather than a lifetime counter.
    #[test]
    fn a_report_without_an_epoch_or_counters_is_no_reading() {
        let app = app();
        let (id, _held) = connect(&app);
        let report_at =
            |minute: u64, params: serde_json::Value| report(&app, id, params, at(minute * 60)).unwrap();
        report_at(0, json!({"boot_id": "b", "net_rx_total": 1_000, "net_tx_total": 0}));
        report_at(1, json!({"net_rx_total": 50_000, "net_tx_total": 0}));
        report_at(2, json!({"boot_id": "", "net_rx_total": 60_000, "net_tx_total": 0}));
        report_at(3, json!({"boot_id": "b", "cpu": 1.0}));
        report_at(4, json!({"boot_id": "b", "net_rx_total": 3_000, "net_tx_total": 0}));
        assert_eq!(total_rx(&app, id), 2_000, "the baseline is still the last reading taken");
    }

    /// The contract check is what makes a cross-repository rename visible.
    /// Derived from the columns the hub stores, it missed four fields that never
    /// reach the `metric` table but do reach the browser; the default theme
    /// blanks a node's entire live view if one is absent, so the drift surfaced
    /// as empty cards and no log output.
    #[test]
    fn the_contract_covers_every_field_the_browser_needs_not_just_the_stored_ones() {
        let fields: Vec<&str> = report_fields().collect();
        for needed in ["uptime", "mem_total", "swap_total", "disk_total"] {
            assert!(fields.contains(&needed), "{needed} reaches the theme, so a rename has to warn");
        }
        // boot_id and the two kernel counters extend the contract beyond the
        // public view; the four the hub fills in are not the agent's
        // responsibility.
        for injected in INJECTED {
            assert!(!fields.contains(&injected), "{injected} is the hub's own, not part of the contract");
        }
        assert!(fields.contains(&"boot_id") && fields.contains(&"net_rx_total"));
        // The numeric list is the same list minus the two that are not plain
        // numbers, so neither can drift from the other.
        let numeric: Vec<&str> = numeric_fields().collect();
        assert_eq!(numeric.len(), fields.len() - 2);
        assert!(!numeric.contains(&"load") && !numeric.contains(&"boot_id"));
    }

    /// A minute of reports a second apart: each moves the live view, history
    /// takes one row stamped on the boundary, and the traffic row is booked as
    /// the minute turns rather than with every report.
    #[test]
    fn a_minute_of_reports_writes_one_row_and_books_traffic_as_it_turns() {
        let app = app();
        let (id, _held) = connect(&app);
        let mut session = Session::default();
        for second in 0..60 {
            send(&app, id, &mut session, second, &report_json("boot-a", 1_000 + second as i64 * 100, 0))
                .unwrap();
        }
        assert_eq!(app.agents.read().unwrap()[&id].metrics["net_rx_total"], 6_900, "the live view follows");
        assert_eq!(total_rx(&app, id), 0, "within the minute nothing past the baseline is booked");
        assert!(
            app.db.metrics(id, 0, 60).unwrap().is_empty(),
            "a session writes no row for its first minute"
        );

        send(&app, id, &mut session, 60, &report_json("boot-a", 7_000, 0)).unwrap();
        // The minute's last reading, 59 s in, is what the boundary books; the
        // reading that crossed it waits for the next.
        assert_eq!(total_rx(&app, id), 5_900);
        let rows = app.db.metrics(id, 0, 60).unwrap();
        assert_eq!(rows.len(), 1, "a minute of reports is one row");
        // History rows are keyed by (node, ts), so counting them proves nothing on
        // its own: reports a second apart collapse onto one row with or without
        // the minute gate. The stamp is what demonstrates it.
        assert_eq!(rows[0]["ts"], at(60).minute() * 60, "stamped on the minute, not on the report");
        assert_eq!(
            app.db.node(id).unwrap().unwrap().last_seen,
            at(60).at.timestamp(),
            "last_seen is written too"
        );
    }

    /// The interval a reinstall would keep, read from the reports: known from the
    /// second, and not thrown by one delayed on the way.
    #[test]
    fn the_reporting_interval_is_the_mean_spacing_of_the_session() {
        let app = app();
        let (id, _held) = connect(&app);
        let mut session = Session::default();
        let interval = |app: &App| app.agents.read().unwrap()[&id].interval();
        let report = report_json("boot-a", 0, 0);
        dispatch(&app, id, "ip", &report, &mut session, at_ms(0)).unwrap();
        assert_eq!(interval(&app), None, "one report has no spacing");
        for ms in [5_000, 10_000, 17_900, 20_000, 25_000] {
            dispatch(&app, id, "ip", &report, &mut session, at_ms(ms)).unwrap();
        }
        assert_eq!(interval(&app), Some(5), "a report held up for 2.9 s does not make it 8");
    }

    /// A history row describes the minute preceding it rather than the instant it
    /// is stamped with: the network rate from the counters the kernel reported
    /// over it, everything else from the mean of the reports in between.
    #[test]
    fn a_history_row_describes_its_whole_minute_not_one_instant() {
        let app = app();
        let (id, _held) = connect(&app);
        let mut session = Session::default();
        let burst = |rx: i64, instant: i64, cpu: f64, mem: i64| {
            json!({"jsonrpc": "2.0", "method": "report",
                   "params": {"boot_id": "boot-a", "net_rx_total": rx, "net_tx_total": 0,
                              // What the agent measured over its own last second.
                              "net_rx": instant, "net_tx": 0, "cpu": cpu, "mem_used": mem}})
            .to_string()
        };

        // Busy for half the minute, then idle; 60 MB arrive in between, and by
        // the next sample both have ended.
        send(&app, id, &mut session, 0, &burst(1_000, 0, 100.0, 100)).unwrap();
        send(&app, id, &mut session, 60, &burst(1_000 + 60_000_000, 0, 0.0, 201)).unwrap();

        let row = &app.db.metrics(id, 0, 60).unwrap()[0];
        assert_eq!(row["net_rx"], 1_000_000, "60 MB over 60 s is 1 MB/s, not the agent's 0");
        assert_eq!(row["cpu"], 50.0, "the mean of the minute, not the idle second it ended on");
        // Integers remain integral: the column is read with as_i64, which returns
        // nothing for the 150.5 the raw mean would produce.
        assert_eq!(row["mem_used"], 151);
        // The live view still shows the instantaneous reading, which is its
        // purpose.
        assert_eq!(app.agents.read().unwrap()[&id].metrics["net_rx"], 0);
    }

    /// A reconnect arrives mid-minute, and that minute's row already holds the
    /// mean of the preceding session. Replacing it with the single sample that
    /// opened the new session would stop the chart integrating to the totals
    /// printed beside it.
    #[test]
    fn a_reconnect_leaves_the_minute_it_lands_in_alone() {
        let app = app();
        let (id, _held) = connect(&app);
        let mut session = Session::default();
        send(&app, id, &mut session, 0, &report_json("boot-a", 1_000, 500)).unwrap();
        send(&app, id, &mut session, 60, &report_json("boot-a", 2_000, 500)).unwrap();
        let before = app.db.metrics(id, 0, 60).unwrap();
        assert_eq!(before.len(), 1, "the running session wrote the row for this minute");

        // The socket drops and the agent returns within the same minute.
        let (tx, _rx) = mpsc::channel(4);
        app.agents.write().unwrap().insert(id, Agent::new(2, tx));
        let loud = json!({"jsonrpc": "2.0", "method": "report",
                          "params": {"boot_id": "boot-a", "cpu": 99.0, "net_rx_total": 9_000,
                                     "net_tx_total": 4_500}})
        .to_string();
        send(&app, id, &mut Session::default(), 70, &loud).unwrap();
        assert_eq!(app.db.metrics(id, 0, 60).unwrap(), before, "the row keeps the minute it described");
    }

    /// Booking about once a minute must leave exactly what booking every report
    /// leaves -- the total, the month and the day -- across everything that
    /// breaks a span: midnight on the first of the month, a reboot, a counter
    /// that shrinks under an agent predating the epoch digest, and reports
    /// minutes apart.
    ///
    /// Two nodes receive the same readings: one through `file`, the other booked
    /// on arrival.
    #[test]
    fn holding_readings_back_books_what_booking_every_one_would() {
        let app = app();
        let (held, every) = (node(&app), node(&app));
        let mut readings: Vec<(u64, &str, i64, i64)> = Vec::new();
        for second in 0..150 {
            let s = second as i64;
            readings.push((second, "a", 10_000 + s * 1_000, 5_000 + s * 300));
        }
        // A reboot mid-minute: a new epoch, counters restarting near zero.
        for second in 150..175 {
            let s = second as i64 - 150;
            readings.push((second, "b", 100 + s * 700, 50 + s * 200));
        }
        // An interface leaves the sum: tx drops within the epoch while rx climbs.
        for second in 175..200 {
            let s = second as i64 - 175;
            readings.push((second, "b", 20_000 + s * 900, 1_000 + s * 100));
        }
        // Reports minutes apart, each in a minute of its own.
        for (i, second) in [320, 450, 451, 700].into_iter().enumerate() {
            readings.push((second, "b", 50_000 + i as i64 * 40_000, 4_000 + i as i64 * 3_000));
        }

        for (second, epoch, rx, tx) in readings {
            let arrival = at(second);
            file(&app, held, Reading { epoch: epoch.into(), counters: (rx, tx), arrival, booked: false })
                .unwrap();
            app.db.accumulate(every, epoch, (rx, tx), arrival.at).unwrap();
        }
        book_held(&app, Some(held));

        let (kept, booked) = (app.db.stored_traffic(held), app.db.stored_traffic(every));
        assert_eq!(kept, booked);
        // The comparison is only as good as the boundary it spans.
        assert_eq!(booked.month_start, "2026-02-01", "the period turned at midnight");
        assert!(booked.day_rx > 0 && booked.total_rx > booked.day_rx, "bytes fell on both sides of midnight");
    }

    #[test]
    fn a_reading_held_across_a_session_is_booked_when_it_closes() {
        let app = app();
        let (id, _held) = connect(&app);
        let task = probe(&app, id, "p");
        let mut session = Session::default();
        send(&app, id, &mut session, 0, &report_json("boot-a", 1_000, 0)).unwrap();
        send(&app, id, &mut session, 10, &report_json("boot-a", 4_000, 0)).unwrap();
        send(&app, id, &mut session, 11, &result_json(task, 42)).unwrap();
        assert_eq!(total_rx(&app, id), 0);
        assert!(results(&app, id).is_empty(), "results wait for the minute to turn");

        let agent = release(&app, id, 1).expect("the session is still the node's");
        close(&app, id, Some(&agent), &mut session);
        assert_eq!(total_rx(&app, id), 3_000, "the held reading is booked");
        assert_eq!(results(&app, id), vec![(task, 42)], "the gathered results are filed");
        assert_eq!(app.db.node(id).unwrap().unwrap().last_seen, at(10).at.timestamp());
    }

    /// A reconnect replacing a half-open session leaves that session's probe
    /// results to it alone: the minute before the link failed. A session the
    /// panel ended files nothing.
    #[test]
    fn a_replaced_session_still_files_its_probe_results() {
        let app = app();
        let (id, _held) = connect(&app);
        let task = probe(&app, id, "p");
        let mut session = Session::default();
        send(&app, id, &mut session, 0, &report_json("boot-a", 1_000, 0)).unwrap();
        send(&app, id, &mut session, 10, &report_json("boot-a", 4_000, 0)).unwrap();
        send(&app, id, &mut session, 11, &result_json(task, 42)).unwrap();

        let (tx, _rx) = mpsc::channel(4);
        app.agents.write().unwrap().insert(id, Agent::new(2, tx));
        let ended = release(&app, id, 1);
        assert!(ended.is_none(), "the reconnect holds the node");
        close(&app, id, ended.as_ref(), &mut session);
        assert_eq!(results(&app, id), vec![(task, 42)], "no other connection received them");
        assert_eq!(total_rx(&app, id), 0, "the held reading is the successor's to book");

        let mut ended_by_panel = Session::default();
        send(&app, id, &mut ended_by_panel, 12, &result_json(task, 7)).unwrap();
        app.agents.write().unwrap().remove(&id);
        close(&app, id, None, &mut ended_by_panel);
        assert_eq!(results(&app, id), vec![(task, 42)]);
    }

    #[test]
    fn a_hub_stopping_books_every_reading_it_held() {
        let app = app();
        let (a, b) = (node(&app), node(&app));
        for (id, rx) in [(a, 1_000), (b, 5_000)] {
            let reading =
                |rx, secs| Reading { epoch: "e".into(), counters: (rx, 0), arrival: at(secs), booked: false };
            file(&app, id, reading(rx, 0)).unwrap();
            file(&app, id, reading(rx + 700, 5)).unwrap();
        }
        book_held(&app, None);
        assert_eq!((total_rx(&app, a), total_rx(&app, b)), (700, 700));
    }

    /// A node token is enough to send frames at any rate. What exceeds the
    /// agent's own pace is dropped, and nothing within it.
    #[test]
    fn a_connection_is_held_to_the_pace_of_an_agent() {
        let app = app();
        let (id, _held) = connect(&app);
        let mut session = Session::default();
        let hello = |name: &str| {
            json!({"jsonrpc": "2.0", "method": "hello", "params": {"hostname": name}}).to_string()
        };
        send(&app, id, &mut session, 0, &hello("first")).unwrap();
        send(&app, id, &mut session, 1, &hello("second")).unwrap();
        assert_eq!(app.db.node(id).unwrap().unwrap().hostname, "first", "one hello per connection");

        let cpu =
            |value: f64| json!({"jsonrpc": "2.0", "method": "report", "params": {"cpu": value}}).to_string();
        let live_cpu = || app.agents.read().unwrap()[&id].metrics["cpu"].clone();
        dispatch(&app, id, "ip", &cpu(1.0), &mut session, at_ms(10_000)).unwrap();
        dispatch(&app, id, "ip", &cpu(2.0), &mut session, at_ms(10_300)).unwrap();
        assert_eq!(live_cpu(), 1.0, "a report 300 ms after the last is dropped");
        dispatch(&app, id, "ip", &cpu(3.0), &mut session, at_ms(11_000)).unwrap();
        assert_eq!(live_cpu(), 3.0, "one a second later is the agent's own pace");

        let task = probe(&app, id, "p");
        for _ in 0..RESULTS_PER_WINDOW + 10 {
            send(&app, id, &mut session, 20, &result_json(task, 1)).unwrap();
        }
        assert_eq!(session.results.len(), RESULTS_PER_WINDOW as usize, "the excess of one window is dropped");
        send(&app, id, &mut session, 25, &result_json(task, 1)).unwrap();
        assert_eq!(session.results.len(), RESULTS_PER_WINDOW as usize + 1, "the next window admits again");
    }

    #[test]
    fn hello_stores_the_facts_and_the_observed_address() {
        let app = app();
        let id = node(&app);
        let hello = json!({
            "jsonrpc": "2.0", "method": "hello",
            "params": {"hostname": "vps-1", "os": "Debian 12", "cpu_cores": 4, "mem_total": 2048}
        });
        dispatch(&app, id, "198.51.100.4", &hello.to_string(), &mut Session::default(), at(0)).unwrap();

        let n = app.db.node(id).unwrap().unwrap();
        assert_eq!(n.hostname, "vps-1");
        assert_eq!(n.cpu_cores, 4);
        assert_eq!(n.ip, "198.51.100.4");
    }

    /// The country follows the machine rather than whatever stands in front of
    /// it. The two cases from the field: an LXC NAT guest connecting over v6,
    /// and a home host whose gateway proxies the connection to the hub abroad.
    #[test]
    fn the_country_is_looked_up_from_an_address_the_machine_holds() {
        let source = |ip, v4, v6| country_source(ip, v4, v6).map(|a| a.to_string());
        let some = |s: &str| Some(s.to_owned());
        // NAT: the private interface has no country, the connection does.
        assert_eq!(source("203.0.113.7", "10.10.1.5", ""), some("203.0.113.7"));
        // An old agent reporting the ULA ahead of the public /128.
        assert_eq!(source("2401:b60:1c::5", "10.10.1.5", "fd42:43af::1"), some("2401:b60:1c::5"));
        // Behind a transparent proxy: the machine's own v6 wins over the exit.
        assert_eq!(source("198.51.100.77", "192.168.1.5", "2409:8a1e::5"), some("2409:8a1e::5"));
        // A public v4 on the interface leads a tunnelled v6.
        assert_eq!(source("2001:470::5", "198.51.100.4", "2001:470::5"), some("198.51.100.4"));
        // Hub and node on one network: nothing to look up.
        assert_eq!(source("192.168.1.2", "192.168.1.5", "fd00::5"), None);
        assert_eq!(source("100.64.0.9", "198.18.0.1", ""), None, "CGNAT and a TUN proxy are not public");
        // The agent's fields reach a URL, so each must be an address of its family.
        assert_eq!(source("192.168.1.2", "2409:8a1e::5", "198.51.100.4"), None, "families swapped");
        assert_eq!(source("192.168.1.2", "1.1.1.1/../x", "2409:8a1e::5/x"), None);
    }

    #[test]
    fn public_means_globally_routable() {
        let public = |ip: &str| public(ip.parse().unwrap());
        for ip in [
            "10.0.0.1",
            "172.31.0.1",
            "192.168.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.0.1",
            "0.0.0.1",
            "192.0.0.4",
            "198.19.0.1",
            "224.0.0.1",
            "fd42::1",
            "fe80::1",
            "::1",
        ] {
            assert!(!public(ip), "{ip}");
        }
        for ip in
            ["1.1.1.1", "100.128.0.1", "172.32.0.1", "192.0.1.1", "198.20.0.1", "2401:b60:1c::5", "3fff::1"]
        {
            assert!(public(ip), "{ip}");
        }
    }

    #[test]
    fn a_hello_owes_a_lookup_only_for_a_public_source_without_a_country() {
        let app = app();
        let id = node(&app);
        // A connection each, as each hello opens one.
        let hello = |ip: &str, ipv4: &str, ipv6: &str| {
            let text = json!({"jsonrpc": "2.0", "method": "hello", "params": {"ipv4": ipv4, "ipv6": ipv6}});
            dispatch(&app, id, ip, &text.to_string(), &mut Session::default(), at(0)).unwrap()
        };
        assert_eq!(hello("198.51.100.77", "192.168.1.5", "2409:8a1e::5").as_deref(), Some("2409:8a1e::5"));
        app.db.set_country(id, "CN", "2409:8a1e::5").unwrap();
        assert_eq!(hello("198.51.100.88", "192.168.1.5", "2409:8a1e::5"), None);
        assert_eq!(app.db.node(id).unwrap().unwrap().country, "CN", "a new proxy exit changes nothing");
        assert_eq!(hello("192.168.1.2", "192.168.1.5", ""), None);
    }

    #[test]
    fn ping_results_are_recorded_and_bad_ones_ignored() {
        let app = app();
        let id = node(&app);
        let mut session = Session::default();
        // Assigned probes: a result is readable only through a node's current
        // assignments.
        let (one, two) = (probe(&app, id, "one"), probe(&app, id, "two"));
        send(&app, id, &mut session, 0, &result_json(one, 42)).unwrap();
        // The rejected results carry task ids of their own: a bare count would be
        // satisfied by the key collapsing them onto a valid row.
        send(&app, id, &mut session, 0, &result_json(two, 15)).unwrap();
        send(&app, id, &mut session, 0, &result_json(0, 42)).unwrap(); // no such task
        send(&app, id, &mut session, 0, &result_json(-1, 42)).unwrap(); // nor this one
        send(&app, id, &mut session, 0, &result_json(99, 42)).unwrap(); // not this node's
                                                                        // A frame carrying no reading. Defaulting to -1 would file it as a lost
                                                                        // packet, rendering a malformed frame as an outage.
        let blind = json!({"jsonrpc": "2.0", "method": "ping.result", "params": {"task_id": one}});
        send(&app, id, &mut session, 0, &blind.to_string()).unwrap();
        assert!(results(&app, id).is_empty(), "gathered until the minute turns");

        // Any frame of a later minute files them.
        send(&app, id, &mut session, 60, r#"{"method":"whatever"}"#).unwrap();
        assert_eq!(
            results(&app, id),
            vec![(one, 42), (two, 15)],
            "each real task keeps its own result, and only those"
        );
    }

    #[test]
    fn the_token_is_read_from_the_authorization_header_only() {
        let mut h = HeaderMap::new();
        assert_eq!(bearer(&h), None, "no header means no token");
        h.insert("authorization", "Bearer abc123".parse().unwrap());
        assert_eq!(bearer(&h), Some("abc123"));
        h.insert("authorization", "abc123".parse().unwrap());
        assert_eq!(bearer(&h), None, "a bare value is not a bearer token");
        h.insert("authorization", "Bearer ".parse().unwrap());
        assert_eq!(bearer(&h), None, "an empty token is not accepted");
    }

    #[test]
    fn a_late_teardown_leaves_the_reconnected_session_alone() {
        let app = app();
        let id = node(&app);
        let live = || app.agents.read().unwrap().contains_key(&id);
        // release() reads the session tag rather than the channel, so a dropped
        // receiver changes nothing.
        let connect = |session| {
            let (tx, _) = mpsc::channel(1);
            app.agents.write().unwrap().insert(id, Agent::new(session, tx));
        };

        // The ordinary case: the session ending is the one on record.
        connect(1);
        assert!(release(&app, id, 1).is_some());
        assert!(!live(), "its own teardown clears the node");

        // The race: the agent gave up and reconnected while the old socket was
        // half-open, so session 2 is live when session 1 unwinds.
        connect(1);
        connect(2);
        assert!(release(&app, id, 1).is_none(), "a stale session must release nothing");
        assert!(live(), "the reconnected agent stays online");
        assert!(app.agents.read().unwrap().contains_key(&id), "and keeps receiving probe pushes");
    }

    #[test]
    fn junk_from_an_agent_is_rejected_without_taking_the_connection_down() {
        let app = app();
        let id = node(&app);
        let mut session = Session::default();
        assert!(send(&app, id, &mut session, 0, "not json").is_err());
        // Unknown methods are ignored.
        assert!(send(&app, id, &mut session, 0, r#"{"method":"whatever"}"#).is_ok());
    }
}
