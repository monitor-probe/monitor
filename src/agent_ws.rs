//! The agent side of the hub: one WebSocket per node carrying JSON-RPC 2.0
//! notifications. A single long-lived connection on which either end may speak
//! first, with self-describing frames readable via curl or a browser console.

use std::borrow::Cow;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Number};
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

/// Facts are written at most this often. The agent sends a hello as it
/// connects and another when its facts change, which it checks once a minute.
/// One arriving sooner is held until the first heartbeat past the spacing
/// rather than dropped: the agent does not repeat a hello, and a stalled link
/// can deliver two of them together. The heartbeat rather than the next
/// report, which `--interval` can put an hour away.
const HELLO_SPACING: Duration = Duration::from_secs(30);

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
/// are the same fact. Split across two, they would need synchronising at every
/// call site, and a node connected but not yet reporting would read offline for
/// a whole `--interval`.
#[derive(Debug)]
pub struct Agent {
    /// Distinguishes one session on a node from the next; see [`release`].
    pub session: u64,
    /// Asks the session to resend the node's probe list; see [`push_ping_tasks`].
    /// Closed, it ends the session.
    pub tx: mpsc::Sender<()>,
    /// The latest report, or `None` between connecting and the first one.
    pub metrics: Option<Report>,
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
    /// The latest report as JSON, `Null` before the first one.
    pub fn metrics_json(&self) -> serde_json::Value {
        self.metrics.as_ref().map_or(serde_json::Value::Null, |m| json!(m))
    }

    pub fn new(session: u64, tx: mpsc::Sender<()>) -> Self {
        Self {
            session,
            tx,
            metrics: None,
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
/// `.max(1.0)` guarding the division would then divide a whole minute of bytes by
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

/// Figures a history row also carries at their highest over the minute, each
/// as the agent measured it across one report interval, under the column it is
/// stored in. The row's own figure is the minute's mean, which for a rate
/// integrates to the traffic totals and therefore stores a 15-second burst at
/// 286 Mbps as 72 Mbps (measured); a 15-second CPU spike to 100% is likewise a
/// minute at 25%.
///
/// Taken from the agent rather than derived here from the arrival of two
/// frames: the network bunches frames, and a second of bytes divided by the
/// half second between two arrivals would record twice the rate that ran.
const PEAK_FLOAT: [(&str, &str); 1] = [("cpu", "cpu_max")];
const PEAK_INT: [(&str, &str); 2] = [("net_rx", "net_rx_max"), ("net_tx", "net_tx_max")];

/// Declares [`Report`] with one optional field per name, so that the struct and
/// [`Report::numbers`] cannot list different figures.
macro_rules! report {
    ($($number:ident),* $(,)?) => {
        /// One report, read into the fields the hub uses rather than into a
        /// generic tree: at 300 nodes reporting each second, building a `Value`
        /// cost 28% of the hub's instructions and looking keys up in it another
        /// 14% (callgrind, 2026-11-25). Fields the hub does not know are skipped.
        ///
        /// Each figure keeps the agent's own `Number`, so [`report`] judges what
        /// was sent: a counter beyond `i64`, a fraction or a negative value is
        /// no reading rather than a different one. A field left out is `None`;
        /// one sent as `null` fails the parse like any other malformed figure.
        #[derive(Debug, Default, Clone, PartialEq, Deserialize, Serialize)]
        pub struct Report {
            #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
            boot_id: Option<serde_json::Value>,
            #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
            iface: Option<serde_json::Value>,
            #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
            load: Option<[Number; 3]>,
            $(
                #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
                $number: Option<Number>,
            )*
        }

        impl Report {
            /// Every plain figure under its key.
            fn numbers(&self) -> [(&'static str, &Option<Number>); [$(stringify!($number)),*].len()] {
                [$((stringify!($number), &self.$number)),*]
            }

            /// The plain figure under `key`, if the report carried it.
            pub(crate) fn figure(&self, key: &str) -> Option<&Number> {
                match key {
                    $(stringify!($number) => self.$number.as_ref(),)*
                    _ => None,
                }
            }
        }
    };
}

report!(
    uptime,
    cpu,
    mem_total,
    mem_used,
    swap_total,
    swap_used,
    disk_total,
    disk_used,
    net_rx_total,
    net_tx_total,
    net_rx,
    net_tx,
    tcp,
    udp,
    procs,
);

/// Hands a key's value, `null` included, to the field's own type. `Option`'s
/// impl would read `null` as absent, and a figure sent as `null` would pass
/// as one left out.
fn present<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

impl Report {
    /// Reads a report's parameters. Only an object is a report: serde would also
    /// accept an array, taking its elements as the fields in declaration order.
    fn parse(params: &str) -> Result<Report> {
        anyhow::ensure!(params.trim_start().starts_with('{'), "report must be an object");
        Ok(serde_json::from_str(params)?)
    }

    /// The [`STICKY`] fields alone, from parameters [`Report::parse`] refused
    /// over some other field. The agent does not resend a sticky value while it
    /// is unchanged, so one arriving in a refused report would otherwise be lost
    /// for the rest of the connection: a new `boot_id` among them, and the next
    /// reports would be filled with the old epoch.
    fn sticky_of(params: &str) -> Option<Report> {
        #[derive(Deserialize)]
        struct Sticky {
            #[serde(default, deserialize_with = "present")]
            boot_id: Option<serde_json::Value>,
            #[serde(default, deserialize_with = "present")]
            iface: Option<serde_json::Value>,
            #[serde(default, deserialize_with = "present")]
            mem_total: Option<Number>,
            #[serde(default, deserialize_with = "present")]
            swap_total: Option<Number>,
            #[serde(default, deserialize_with = "present")]
            disk_total: Option<Number>,
        }
        if !params.trim_start().starts_with('{') {
            return None;
        }
        let s: Sticky = serde_json::from_str(params).ok()?;
        Some(Report {
            boot_id: s.boot_id,
            iface: s.iface,
            mem_total: s.mem_total,
            swap_total: s.swap_total,
            disk_total: s.disk_total,
            ..Report::default()
        })
    }

    /// Whether the report carries `key` in a usable form, for [`check_contract`].
    /// An empty `boot_id` counts as left out.
    fn carries(&self, key: &str) -> bool {
        match key {
            "boot_id" => self.boot_id.as_ref().is_some_and(|v| !v.is_null() && *v != ""),
            "iface" => self.iface.as_ref().is_some_and(|v| !v.is_null()),
            "load" => self.load.is_some(),
            _ => self.figure(key).is_some(),
        }
    }

    /// Fills each [`STICKY`] field this report leaves out from `held`, and
    /// records in `held` the ones it carries.
    fn fill_sticky(&mut self, held: &mut Report) {
        fn one<T: Clone + PartialEq>(field: &mut Option<T>, held: &mut Option<T>) {
            match (&*field, &*held) {
                (Some(value), _) if held.as_ref() != Some(value) => *held = Some(value.clone()),
                (None, Some(value)) => *field = Some(value.clone()),
                _ => {}
            }
        }
        one(&mut self.boot_id, &mut held.boot_id);
        one(&mut self.iface, &mut held.iface);
        one(&mut self.mem_total, &mut held.mem_total);
        one(&mut self.swap_total, &mut held.swap_total);
        one(&mut self.disk_total, &mut held.disk_total);
    }
}

/// Running sums for the minute in progress, one slot per averaged field, and
/// the highest of each peak figure.
#[derive(Debug, Default)]
struct Minute {
    sums: [f64; MEAN_FLOAT.len() + MEAN_INT.len()],
    reports: f64,
    peaks: [f64; PEAK_FLOAT.len() + PEAK_INT.len()],
}

impl Minute {
    fn add(&mut self, metrics: &Report) {
        let figure = |key: &str| metrics.figure(key).and_then(Number::as_f64).unwrap_or(0.0);
        for (slot, key) in MEAN_FLOAT.iter().chain(&MEAN_INT).enumerate() {
            self.sums[slot] += figure(key);
        }
        for (peak, (key, _)) in self.peaks.iter_mut().zip(PEAK_FLOAT.iter().chain(&PEAK_INT)) {
            *peak = peak.max(figure(key));
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
        // Written whatever the report carried, so an agent sending these keys
        // itself cannot choose the stored value.
        for (slot, (peak, (_, column))) in
            self.peaks.iter().zip(PEAK_FLOAT.iter().chain(&PEAK_INT)).enumerate()
        {
            let peak = if slot < PEAK_FLOAT.len() { json!(peak) } else { json!(*peak as i64) };
            obj.insert((*column).to_owned(), peak);
        }
    }
}

/// Whether a frame at `tick` keeps `spacing` from the last admitted, which it
/// then becomes.
fn spaced(last: &mut Option<Instant>, tick: Instant, spacing: Duration) -> bool {
    if last.is_some_and(|last| tick.saturating_duration_since(last) < spacing) {
        return false;
    }
    *last = Some(tick);
    true
}

/// What one connection may cost the hub, and the probe results it has yet to
/// file. Local to the connection, unlike [`Agent`], which others read.
///
/// A node token is enough to send frames at any rate, and each is parsed and
/// most are written: unbounded, 34,209 reports over one connection in ten
/// seconds would have the hub write 93 MB (measured). The agent's own pace is
/// known, so what exceeds it is dropped: reports faster than its one-second
/// floor, hellos beyond one per [`HELLO_SPACING`] save the latest, and results
/// beyond [`Db::MAX_PROBES_PER_NODE`] probes each run every
/// [`Db::MIN_PROBE_INTERVAL`] seconds.
///
/// ponytail: the caps start afresh with each connection, so a token reconnecting
/// in a loop costs two commits per handshake -- the hello, and the first
/// report's `last_seen` -- rather than a few per minute. An honest agent cannot
/// do this, as it doubles its wait after a short session. A per-node limit on
/// handshakes if it is ever observed; reissuing the token ends it meanwhile.
#[derive(Debug, Default)]
struct Session {
    last_hello: Option<Instant>,
    /// The latest hello that arrived within [`HELLO_SPACING`] of the last one
    /// written; see there.
    held_hello: Option<serde_json::Value>,
    last_report: Option<Instant>,
    /// Start of the current result window and the results admitted in it.
    window: Option<(Instant, u32)>,
    /// Whether a dropped or unusable frame has been logged; see [`Session::complain`].
    complained: bool,
    /// Probe results as `(task_id, ts, latency)`, filed a minute at a time
    /// because each commit writes at least one page.
    results: Vec<(i64, i64, i64)>,
    /// The last value of each [`STICKY`] field this connection carried.
    sticky: Report,
}

impl Session {
    fn admit_report(&mut self, tick: Instant) -> bool {
        spaced(&mut self.last_report, tick, REPORT_SPACING)
    }

    fn admit_hello(&mut self, tick: Instant) -> bool {
        spaced(&mut self.last_hello, tick, HELLO_SPACING)
    }

    /// The held hello, once the spacing allows it to be written.
    fn held_hello_due(&mut self, tick: Instant) -> Option<serde_json::Value> {
        if self.held_hello.is_some() && self.admit_hello(tick) {
            self.held_hello.take()
        } else {
            None
        }
    }

    /// Fills each [`STICKY`] field a report leaves out from the last value this
    /// connection carried, and records the ones it carries. Called before the
    /// spacing check and for a refused report too: a value in a dropped or
    /// refused report is still the agent's latest, and the agent does not send it
    /// again while it is unchanged.
    fn fill_sticky(&mut self, report: &mut Report) {
        report.fill_sticky(&mut self.sticky);
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
        let mut results = std::mem::take(&mut self.results);
        if results.is_empty() {
            return Ok(());
        }
        // Results held back by a stalled link arrive in one read and share its
        // second; on the `(node, ts, task)` key all but the last would replace
        // one another, and the probes lost during the stall would go uncounted.
        // Each therefore lands at least a second before the next result of the
        // same probe.
        let mut next = HashMap::new();
        for (task, ts, _) in results.iter_mut().rev() {
            if let Some(&later) = next.get(task) {
                *ts = (*ts).min(later - 1);
            }
            next.insert(*task, *ts);
        }
        app.db.insert_pings(node_id, &results)
    }
}

/// Report fields an agent may leave out while they are unchanged, which this
/// hub then fills from the last value the connection carried, so that every
/// step past `dispatch` reads whole reports. Each is a capacity or an identity
/// that changes with a reboot, a resize or a reinstall: together 142 of a
/// report's 471 bytes (measured).
///
/// Offered by [`capabilities_message`] at the start of each connection rather
/// than assumed from a version: an agent leaves a field out only when the hub
/// has named it, so an older hub, which names none, keeps receiving whole
/// reports. Older agents ignore the frame.
const STICKY: [&str; 5] = ["boot_id", "iface", "mem_total", "swap_total", "disk_total"];

fn capabilities_message() -> String {
    json!({"method": "capabilities", "params": {"sticky": STICKY}}).to_string()
}

/// A frame with its parameters left unparsed until the method says what they
/// are: a report is read into a [`Report`], anything else into a `Value`.
#[derive(Deserialize)]
struct Rpc<'a> {
    #[serde(borrow)]
    method: Cow<'a, str>,
    #[serde(borrow, default)]
    params: Option<&'a RawValue>,
}

/// The node a request's bearer token belongs to, with the token, or the 401
/// text. The same text whether the token is malformed or merely unknown.
fn authenticate<'h>(app: &App, headers: &'h HeaderMap) -> Result<(i64, &'h str), &'static str> {
    let token = bearer(headers).ok_or("missing token")?;
    match app.db.node_by_token(token) {
        Ok(Some(id)) => Ok((id, token)),
        _ => Err("invalid token"),
    }
}

pub async fn handler(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let (node_id, token) = match authenticate(&app, &headers) {
        Ok((id, token)) => (id, token.to_owned()),
        Err(refusal) => return crate::api::answer(StatusCode::UNAUTHORIZED, refusal),
    };
    let ip = node_ip(&app, &headers, peer.ip()).to_string();

    upgrade.read_buffer_size(crate::api::SOCKET_BUFFER).max_message_size(crate::api::MAX_FRAME).on_upgrade(
        move |socket| async move {
            if let Err(e) = serve(app, node_id, &token, ip, socket).await {
                debug!("node {node_id} disconnected: {e:#}");
            }
        },
    )
}

/// A glimpse rather than a session: an agent whose session runs over one
/// address family connects here over the other, so the hub can record the
/// address it appears at there. An interface holding only a private address of
/// that family -- NAT66, a ULA behind a masquerading host -- says nothing of
/// where it exits, and the session, arriving in one family, cannot.
///
/// A route of its own rather than a query on the session's: a hub from before
/// this one would take `?echo` for a session, retire the live one, and flap the
/// node on every connect, where it answers an unknown path with 404 and the
/// agent goes without. Authenticated like a session, so no anonymous path, and
/// it opens none: whatever is running is left alone.
pub async fn echo(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let node_id = match authenticate(&app, &headers) {
        Ok((id, _)) => id,
        Err(refusal) => return crate::api::answer(StatusCode::UNAUTHORIZED, refusal),
    };
    // A proxy that wrote nothing leaves the proxy's own address here, which
    // would replace an exit recorded earlier with one the panel never shows.
    let ip = node_ip(&app, &headers, peer.ip());
    if public(ip) {
        if let Err(e) = app.db.set_ip_other(node_id, &ip.to_string()) {
            warn!("node {node_id}: storing the address seen in the other family failed: {e:#}");
        }
    }
    upgrade.on_upgrade(|_| async {})
}

/// Extracts the node token from `Authorization: Bearer <token>`.
pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ").filter(|t| !t.is_empty())
}

async fn serve(app: Shared, node_id: i64, token: &str, ip: String, mut socket: WebSocket) -> Result<()> {
    // One slot: a resend already queued reads the list as it is when it runs.
    let (tx, mut rx) = mpsc::channel::<()>(1);
    // Online from the handshake rather than the first report: a panel reporting
    // otherwise for a whole interval would describe the hub's bookkeeping rather
    // than the machine.
    let Some(tag) = tokio::task::block_in_place(|| enlist(&app, node_id, token, tx)) else {
        return Ok(());
    };
    info!("node {node_id} connected from {ip}");

    let mut session = Session::default();
    // Every exit, an error included, passes through `release` and `close` below.
    // One returning past them would leave the node listed online with its
    // metrics frozen until the agent reconnected, and never if it does not.
    let outcome: Result<()> = async {
        let mut heartbeat = tokio::time::interval(HEARTBEAT);
        heartbeat.tick().await; // The first tick completes immediately.
        let mut last_frame = Instant::now();
        // The address this node's country is still owed for. A lookup that failed,
        // or was held back by `ASKED`, is retried on the heartbeat while the
        // connection lasts; otherwise it would wait for the next hello, which on a
        // steady link is days away.
        let mut owed: Option<String> = None;
        // Whether the last read of the probe list failed; see [`tasks_frame`].
        let mut tasks_failing = false;
        // Both sent before the first report arrives, which carries every field
        // whatever the agent has learnt by then.
        socket.send(Message::Text(capabilities_message().into())).await?;
        send_tasks(&app, node_id, &mut socket, &mut tasks_failing).await?;

        loop {
            tokio::select! {
                resend = rx.recv() => match resend {
                    Some(()) => send_tasks(&app, node_id, &mut socket, &mut tasks_failing).await?,
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
                    if let Some(facts) = session.held_hello_due(Instant::now()) {
                        match tokio::task::block_in_place(|| save_facts(&app, node_id, &ip, &facts)) {
                            Ok(Some(source)) => owed = Some(source),
                            Ok(None) => {}
                            Err(e) => session.complain(node_id, format_args!("storing held facts failed: {e:#}")),
                        }
                    }
                    if let Some(source) = &owed {
                        match tokio::task::block_in_place(|| app.db.country_owed(node_id, source)) {
                            Ok(true) => locate(app.clone(), node_id, source.clone()),
                            Ok(false) => owed = None,
                            Err(e) => debug!("node {node_id}: country check failed: {e:#}"),
                        }
                    }
                    if tasks_failing {
                        send_tasks(&app, node_id, &mut socket, &mut tasks_failing).await?;
                    }
                    socket.send(Message::Ping(Vec::new().into())).await?;
                }
                inbound = socket.recv() => {
                    last_frame = Instant::now();
                    match inbound {
                    // Handled on this worker. The steps that can wait on the
                    // database enter `blocking` themselves; see there.
                    Some(Ok(Message::Text(text))) => {
                        let arrival = Arrival::now();
                        match dispatch(&app, node_id, &ip, &text, &mut session, arrival) {
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
        }
    }
    .await;

    let ended = release(&app, node_id, tag);
    if ended.is_some() {
        info!("node {node_id} went offline");
    }
    tokio::task::block_in_place(|| close(&app, node_id, ended.as_ref(), &mut session));
    outcome
}

/// Installs a session as the node's connection and returns its tag, or None,
/// with nothing left installed, when `token` no longer belongs to the node.
///
/// The token was checked before the upgrade. A reissue or a delete writes the
/// database first and then removes the node's entry, so one landing between
/// that check and this point removes an entry that is not yet this one; the
/// token is therefore checked again once the entry is in place, where such a
/// write landing later removes it instead. A connection this one displaced is
/// not put back on a refusal: it may have ended meanwhile, its teardown finding
/// this entry and leaving it, and put back it would show the node online with
/// nothing behind it.
fn enlist(app: &App, node_id: i64, token: &str, tx: mpsc::Sender<()>) -> Option<u64> {
    let tag = SESSION.fetch_add(1, Ordering::Relaxed);
    app.agents.write().unwrap_or_else(|e| e.into_inner()).insert(node_id, Agent::new(tag, tx));
    match app.db.node_by_token(token) {
        Ok(Some(id)) if id == node_id => return Some(tag),
        Ok(_) => info!(
            "node {node_id}: refused a session whose token was reissued or node deleted during the handshake"
        ),
        Err(e) => warn!("node {node_id}: refused a session, its token could not be checked again: {e:#}"),
    }
    release(app, node_id, tag);
    None
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
        if let Err(e) = app.db.touch_seen(node_id, agent.last_seen, &agent.metrics_json()) {
            warn!("node {node_id}: recording when it was last seen failed: {e:#}");
        }
    }
}

/// Runs a frame's database work. The single connection can be held for
/// seconds by a restore or a vacuum; waiting for it inside `block_in_place`
/// hands this worker's other tasks to another thread, where waiting outside it
/// would stall them -- the panel, the public page, the shutdown signal. Only
/// the frames that write pay for the handoff, about one a minute per node:
/// wrapping every frame would cost about 12% of the hub's CPU at 300 nodes
/// reporting each second (4.02% of a core against 3.50%) and would keep the
/// hub at 154 threads against 7.
fn blocking<R>(f: impl FnOnce() -> R) -> R {
    tokio::task::block_in_place(f)
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
    let params = rpc.params.map_or("null", RawValue::get);
    let value = || serde_json::from_str::<serde_json::Value>(params);
    // Parsed here and failed only in its own arm below, so that a malformed
    // report is dropped for its spacing and still files the results before it.
    let parsed = (rpc.method == "report").then(|| match Report::parse(params) {
        Ok(mut report) => {
            session.fill_sticky(&mut report);
            Ok(report)
        }
        Err(e) => {
            if let Some(mut sticky) = Report::sticky_of(params) {
                session.fill_sticky(&mut sticky);
            }
            Err(e)
        }
    });
    // Results gathered in an earlier minute are filed on the next frame of any
    // kind: reports arrive every few seconds even where every probe runs once an
    // hour. A failure is logged rather than returned, which would discard the
    // frame that happened to trigger it.
    if session.results.first().is_some_and(|&(_, ts, _)| ts.div_euclid(60) != arrival.minute()) {
        if let Err(e) = blocking(|| session.file_results(app, node_id)) {
            session.complain(node_id, format_args!("filing probe results failed: {e:#}"));
        }
    }
    match &*rpc.method {
        "hello" if !session.admit_hello(arrival.tick) => {
            debug!("node {node_id}: a hello within {HELLO_SPACING:?} of the last was held");
            session.held_hello = Some(value()?);
        }
        "hello" => {
            session.held_hello = None;
            let facts = value()?;
            return blocking(|| save_facts(app, node_id, ip, &facts));
        }
        // Dropped quietly: two reports the network bunched are how an honest
        // agent trips this.
        "report" if !session.admit_report(arrival.tick) => {
            debug!("node {node_id}: a report within {REPORT_SPACING:?} of the last was dropped")
        }
        "report" => {
            if let Some(parsed) = parsed {
                report(app, node_id, parsed?, arrival)?;
            }
        }
        "ping.result" if !session.admit_result(arrival.tick) => session.complain(
            node_id,
            format_args!(
                "more than {RESULTS_PER_WINDOW} probe results within {RESULT_WINDOW:?} were dropped"
            ),
        ),
        "ping.result" => {
            let params = value()?;
            let task_id = params.get("task_id").and_then(|v| v.as_i64()).unwrap_or(0);
            // A missing reading is not a reading of -1: `close_bucket` counts
            // every negative latency as a lost packet, so defaulting here would
            // render a malformed frame as an outage. A report follows the same
            // rule for a counter it cannot read.
            let latency = params.get("latency_ms").and_then(|v| v.as_i64());
            if let (true, Some(latency)) = (task_id > 0, latency) {
                session.results.push((task_id, arrival.at.timestamp(), latency));
            }
        }
        other => debug!("node {node_id} sent unknown method {other}"),
    }
    Ok(None)
}

/// Stores a hello's facts and returns the address a country lookup is now owed
/// for, if any.
fn save_facts(app: &App, node_id: i64, ip: &str, facts: &serde_json::Value) -> Result<Option<String>> {
    let field = |k: &str| facts.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let source = country_source(ip, field("ipv4"), field("ipv6")).map_or_else(String::new, |a| a.to_string());
    Ok(app.db.save_facts(node_id, facts, ip, &source)?.then_some(source))
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
static ASKED: OnceLock<Mutex<HashMap<i64, Option<Instant>>>> = OnceLock::new();
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
/// hub restart reopens the gate for every node still owed a country.
fn locate(app: Shared, node_id: i64, source: String) {
    let mut asked = ASKED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if !spaced(asked.entry(node_id).or_default(), Instant::now(), LOCATE_RETRY) {
        return;
    }
    drop(asked);

    tokio::spawn(async move {
        let lookup = async {
            let url = format!("https://ipinfo.io/{source}/country");
            anyhow::Ok(app.http.get(url).send().await?.error_for_status()?.text().await?)
        };
        let body = match lookup.await {
            Ok(body) => body,
            Err(e) => return debug!("node {node_id}: no country for {source}: {e:#}"),
        };
        let Some(cc) = country_code(&body) else {
            return debug!("node {node_id}: {source} resolved to no country");
        };
        if let Err(e) = app.db.set_country(node_id, &cc, &source) {
            warn!("node {node_id}: storing country {cc} failed: {e:#}");
        }
    });
}

/// The country in a lookup's reply. The reply reaches the public page, so
/// nothing but two ASCII letters passes: a proxy's error page or an empty body
/// is no answer.
fn country_code(body: &str) -> Option<String> {
    let cc = body.trim();
    (cc.len() == 2 && cc.bytes().all(|b| b.is_ascii_alphabetic())).then(|| cc.to_ascii_uppercase())
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
/// would leave those four uncovered, and an agent renaming one would blank every
/// card on the page with nothing in any log to explain it.
///
/// Hub and agent ship as two binaries from two repositories, and every reader
/// here ends in `unwrap_or(0)`: a field the agent renames does not fail, it
/// records zero until someone examines that chart.
fn report_fields() -> impl Iterator<Item = &'static str> {
    ["boot_id", "net_rx_total", "net_tx_total"]
        .into_iter()
        .chain(crate::api::PUBLIC_METRICS.iter().copied().filter(|k| !INJECTED.contains(k)))
}

/// Reports, once per connection, when a report omits fields the hub depends on.
/// A version number cannot serve here: an agent that renames a field carries a
/// higher version, not a lower one. An empty `boot_id` counts as omitted, since
/// no reading can be taken without one.
fn check_contract(node_id: i64, metrics: &Report) {
    let missing: Vec<&str> = report_fields().filter(|k| !metrics.carries(k)).collect();
    if !missing.is_empty() {
        // scripts/e2e.sh fails on "reports without"; the two change together.
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
    /// When the machine booted, from the uptime reported with the counters.
    booted: Option<i64>,
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
    let book =
        |r: &Reading| blocking(|| app.db.accumulate(node_id, &r.epoch, r.counters, r.arrival.at, r.booted));
    let mut held = held(app);
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

/// The held readings, locked. A booking holds this lock across a database call:
/// a frame finding it taken waits as `db::lock` waits for the connection.
///
/// A booking that returned can still be undone by its batch failing to commit
/// (`Db::batched`). All of them then count as unbooked: booking a reading
/// already stored again adds nothing.
fn held(app: &App) -> std::sync::MutexGuard<'_, HashMap<i64, Reading>> {
    let mut held = crate::db::lock(&app.readings);
    if app.db.batch_lost() {
        held.values_mut().for_each(|r| r.booked = false);
    }
    held
}

/// Books held readings not yet booked: one node's as its session ends, every
/// node's as the hub stops. Otherwise a node that reboots before reporting again
/// takes the bytes since its last booking with it.
pub fn book_held(app: &App, node: Option<i64>) {
    let mut held = held(app);
    for (id, reading) in held.iter_mut().filter(|(id, r)| !r.booked && node.is_none_or(|n| n == **id)) {
        match app.db.accumulate(*id, &reading.epoch, reading.counters, reading.arrival.at, reading.booted) {
            Ok(_) => reading.booked = true,
            Err(e) => warn!("node {id}: booking its last reading failed: {e:#}"),
        }
    }
}

fn report(app: &App, node_id: i64, metrics: Report, arrival: Arrival) -> Result<()> {
    // Missing fields remain compatible with older agents, while malformed values
    // must not become a live frame that can crash a browser. Counter validation
    // is separate: a missing or null kernel reading must not alter its
    // baseline.
    let number = |n: &Number| n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0);
    for (key, value) in metrics.numbers() {
        anyhow::ensure!(value.as_ref().is_none_or(number), "invalid report field {key}");
    }
    if let Some(load) = &metrics.load {
        anyhow::ensure!(load.iter().all(number), "invalid load");
    }
    // No reading is not a reading of zero: booking zero would align the
    // baseline to it and book the next report's lifetime counter as one delta.
    // Anything that is not a non-negative i64 is likewise no reading -- a u64
    // beyond the signed range, a float, or a negative value -- and so is a pair
    // without an epoch, which cannot say whether it continues the last one.
    let counter = |n: &Option<Number>| n.as_ref().and_then(Number::as_i64).filter(|n| *n >= 0);
    let reading = metrics
        .boot_id
        .as_ref()
        .and_then(|v| v.as_str())
        .filter(|e| !e.is_empty())
        .zip(counter(&metrics.net_rx_total).zip(counter(&metrics.net_tx_total)))
        .map(|(epoch, counters)| {
            // The agent reports 0 where /proc/uptime cannot be read, which is
            // no boot time: taken as one, every epoch change would book.
            let uptime = counter(&metrics.uptime).filter(|up| *up > 0);
            let booted = uptime.map(|up| arrival.at.timestamp() - up);
            Reading { epoch: epoch.to_owned(), counters, arrival, booted, booked: false }
        });
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
        let mut row = json!(&metrics);
        entry.minute.write_into(&mut row);
        if let (Some((epoch, (rx, tx))), Some(mark), Some(obj)) = (&span, &entry.mark, row.as_object_mut()) {
            if mark.epoch == *epoch {
                // Fractional seconds: whole ones would drop up to 0.99 s of the
                // minute and overstate its rate by up to 1.7%.
                let elapsed = arrival.tick.saturating_duration_since(mark.tick).as_secs_f64().max(1.0);
                obj.insert("net_rx".into(), json!(((rx - mark.counters.0).max(0) as f64 / elapsed) as i64));
                obj.insert("net_tx".into(), json!(((tx - mark.counters.1).max(0) as f64 / elapsed) as i64));
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
    // "Offline since" is read from this column, so a session ending before its
    // first minute boundary must still leave a mark. The report itself moves
    // into the live view: copying every report would account for 44% of the
    // allocations on this path at 300 nodes reporting each second.
    let seen = (row.is_some() || first).then(|| json!(&metrics));
    entry.metrics = Some(metrics);
    drop(agents);

    if let Some(row) = &row {
        blocking(|| app.db.insert_metric(node_id, minute * 60, row))?;
    }
    if let Some(seen) = &seen {
        blocking(|| app.db.touch_seen(node_id, arrival.at.timestamp(), seen))?;
    }
    Ok(())
}

fn ping_tasks_message(app: &App, node_id: i64) -> Result<String> {
    let tasks = app.db.ping_tasks_for(node_id)?;
    Ok(json!({"method": "ping.tasks", "params": tasks}).to_string())
}

/// The node's probe list as a frame, or `None` while it cannot be read, which
/// sets `failing` for the heartbeat to retry. The agent starts each connection
/// without probes and replaces its list with each one it receives, so an empty
/// list in place of an unreadable one would stop every probe.
fn tasks_frame(app: &App, node_id: i64, failing: &mut bool) -> Option<String> {
    match ping_tasks_message(app, node_id) {
        Ok(text) => {
            if std::mem::replace(failing, false) {
                info!("node {node_id}: its probe list was read and sent after failing");
            }
            // Only targets stored before the panel bounded them, or restored
            // from such a backup, reach this. Sent all the same: the agent's
            // refusal is the visible symptom, and this names its cause.
            if text.len() > crate::api::MAX_FRAME {
                warn!(
                    "node {node_id}: its probe list is {} bytes, past the agent's 64 KiB frame limit; the agent will drop each session until the probe targets are shortened",
                    text.len()
                );
            }
            Some(text)
        }
        Err(e) if *failing => {
            debug!("node {node_id}: reading its probe list failed again: {e:#}");
            None
        }
        Err(e) => {
            *failing = true;
            warn!("node {node_id}: reading its probe list failed; retried each heartbeat: {e:#}");
            None
        }
    }
}

/// Sends the node's probe list unless it cannot be read; see [`tasks_frame`].
async fn send_tasks(app: &App, node_id: i64, socket: &mut WebSocket, failing: &mut bool) -> Result<()> {
    // Off the worker, like every other read here: a restore or vacuum holds the
    // connection for seconds.
    if let Some(text) = tokio::task::block_in_place(|| tasks_frame(app, node_id, failing)) {
        socket.send(Message::Text(text.into())).await?;
    }
    Ok(())
}

/// Asks the connected agents' sessions to resend their probe lists, so a panel
/// edit takes effect without waiting for a reconnect. `only` limits it to one
/// node, for an edit that changed that node alone. The read happens in each
/// session, which retries a failed one on its heartbeat.
pub fn push_ping_tasks(app: &App, only: Option<i64>) {
    let agents = app.agents.read().unwrap_or_else(|e| e.into_inner());
    for (_, agent) in agents.iter().filter(|(id, _)| only.is_none_or(|only| only == **id)) {
        // Full means a resend is already queued; closed, a session ending.
        let _ = agent.tx.try_send(());
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::db::{Node, PingTask, Span};

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

    #[test]
    fn a_token_opens_the_route_only_for_its_node() {
        let app = app();
        let token = crate::auth::random_token();
        let id = app.db.create_node(&Node { name: "n".into(), ..Default::default() }, &token).unwrap();
        let with = |value: &str| {
            let mut h = HeaderMap::new();
            h.insert("authorization", value.parse().unwrap());
            h
        };
        assert_eq!(authenticate(&app, &with(&format!("Bearer {token}"))).ok(), Some((id, token.as_str())));
        for refused in [HeaderMap::new(), with("Bearer nope"), with("Basic abc")] {
            assert!(authenticate(&app, &refused).is_err());
        }
    }

    /// A reissue or a delete that lands between the handshake's token check and
    /// the session taking its place finds no entry to remove, so the session
    /// must not stay installed on the token it was let in with.
    #[test]
    fn a_session_let_in_on_a_token_since_retired_does_not_stay() {
        let app = app();
        let token = crate::auth::random_token();
        let id = app.db.create_node(&Node { name: "n".into(), ..Default::default() }, &token).unwrap();
        let online = |app: &App| app.agents.read().unwrap().contains_key(&id);
        assert!(enlist(&app, id, &token, mpsc::channel(1).0).is_some(), "a current token is let in");
        assert!(online(&app));

        app.db.reset_token(id, &crate::auth::random_token()).unwrap();
        app.agents.write().unwrap().remove(&id);
        assert!(enlist(&app, id, &token, mpsc::channel(1).0).is_none(), "a reissued token is not");
        assert!(!online(&app));

        let token = crate::auth::random_token();
        app.db.reset_token(id, &token).unwrap();
        assert!(app.db.delete_node(id).unwrap());
        assert!(enlist(&app, id, &token, mpsc::channel(1).0).is_none(), "nor a deleted node's");
        assert!(!online(&app));
    }

    /// A connected agent, the precondition for filing any report: the session
    /// holds the node's live state.
    fn connect(app: &App) -> (i64, mpsc::Receiver<()>) {
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

    /// [`report`] given a report written as JSON, failing where `dispatch` would
    /// on one that does not parse.
    fn report_value(app: &App, id: i64, params: serde_json::Value, arrival: Arrival) -> Result<()> {
        report(app, id, Report::parse(&params.to_string())?, arrival)
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
            .ping_records(id, Span::minutes(0, 60))
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
        let good = app.agents.read().unwrap()[&id].metrics_json();
        for bad in [
            json!({"load":null}),
            json!({"load":[1,"bad",3]}),
            json!({"load":[1,2]}),
            json!({"load":[1,-2,3]}),
            json!({"cpu":"bad"}),
            json!({"cpu":null}),
            json!({"cpu":-1}),
            json!([]),
            json!([null, "eth0"]),
        ] {
            assert!(report_value(&app, id, bad.clone(), at(30)).is_err(), "{bad}");
            assert_eq!(app.agents.read().unwrap()[&id].metrics_json(), good);
        }
        send(&app, id, &mut session, 60, &report_json("boot", 2_000, 600)).unwrap();
        assert_eq!(total_rx(&app, id), 1_000);
    }

    /// The hub stopped at 60 s and, back at 3600 s, finds the node rebooted at
    /// 1800 s: the bytes since that boot are booked, not discarded.
    #[test]
    fn a_reboot_while_the_hub_was_down_keeps_the_bytes_since_boot() {
        let app = app();
        let (id, _held) = connect(&app);
        let report = |boot: &str, rx: i64, uptime: i64| {
            json!({
                "jsonrpc": "2.0", "method": "report",
                "params": {"boot_id": boot, "cpu": 1, "load": [0, 0, 0], "mem_used": 1,
                           "uptime": uptime, "net_rx_total": rx, "net_tx_total": 0}
            })
            .to_string()
        };
        let mut session = Session::default();
        send(&app, id, &mut session, 0, &report("k1/d", 900_000, 50_000)).unwrap();
        send(&app, id, &mut session, 60, &report("k1/d", 901_000, 50_060)).unwrap();
        assert_eq!(total_rx(&app, id), 1_000);

        app.readings.lock().unwrap().clear();
        let mut session = Session::default();
        send(&app, id, &mut session, 3_600, &report("k2/d", 5_000, 1_800)).unwrap();
        assert_eq!(total_rx(&app, id), 6_000);

        // A second machine on the token, one with no uptime to report among
        // them: each swap only realigns.
        for (i, (epoch, uptime)) in
            [("k3/d", 900_000), ("k4/d", 0), ("k2/d", 1_900), ("k4/d", 0)].iter().enumerate()
        {
            let mut session = Session::default();
            let secs = 3_660 + i as u64 * 30;
            send(&app, id, &mut session, secs, &report(epoch, 80_000_000_000, *uptime)).unwrap();
        }
        assert_eq!(total_rx(&app, id), 6_000);
    }

    /// The lifetime total must never decrease, and must never book bytes nobody
    /// moved. The counters behind it, and the uptime that decides whether a new
    /// epoch's reading is booked whole, arrive from another repository's binary
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
            report_value(
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
            |minute: u64, params: serde_json::Value| report_value(&app, id, params, at(minute * 60)).unwrap();
        report_at(0, json!({"boot_id": "b", "net_rx_total": 1_000, "net_tx_total": 0}));
        report_at(1, json!({"net_rx_total": 50_000, "net_tx_total": 0}));
        report_at(2, json!({"boot_id": "", "net_rx_total": 60_000, "net_tx_total": 0}));
        report_at(3, json!({"boot_id": "b", "cpu": 1.0}));
        report_at(4, json!({"boot_id": "b", "net_rx_total": 3_000, "net_tx_total": 0}));
        assert_eq!(total_rx(&app, id), 2_000, "the baseline is still the last reading taken");
    }

    /// The contract check is what makes a cross-repository rename visible.
    /// Derived from the columns the hub stores, it would miss four fields that
    /// never reach the `metric` table but do reach the browser; the default theme
    /// blanks a node's entire live view if one is absent, so the drift would
    /// surface as empty cards and no log output.
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
        // `Report` reads the same list: a field of the contract missing from it
        // would be skipped as unknown and never reach the live view.
        let mut numeric = Report::default().numbers().map(|(key, _)| key).to_vec();
        let mut expected: Vec<&str> =
            fields.into_iter().filter(|k| !matches!(*k, "boot_id" | "load")).collect();
        numeric.sort_unstable();
        expected.sort_unstable();
        assert_eq!(numeric, expected);
    }

    /// A minute of reports a second apart: each moves the live view, history
    /// takes one row stamped on the boundary, and the traffic row and
    /// `last_seen` are written as the minute turns (`last_seen` also by the
    /// session's first report) rather than with every report.
    #[test]
    fn a_minute_of_reports_writes_one_row_and_books_traffic_as_it_turns() {
        let app = app();
        let (id, _held) = connect(&app);
        let mut session = Session::default();
        for second in 0..60 {
            send(&app, id, &mut session, second, &report_json("boot-a", 1_000 + second as i64 * 100, 0))
                .unwrap();
        }
        assert_eq!(
            app.agents.read().unwrap()[&id].metrics_json()["net_rx_total"],
            6_900,
            "the live view follows"
        );
        assert_eq!(total_rx(&app, id), 0, "within the minute nothing past the baseline is booked");
        assert_eq!(
            app.db.node(id).unwrap().unwrap().last_seen,
            at(0).at.timestamp(),
            "within the minute last_seen is written once, by the first report"
        );
        assert!(
            app.db.metrics(id, Span::minutes(0, 60)).unwrap().is_empty(),
            "a session writes no row for its first minute"
        );

        send(&app, id, &mut session, 60, &report_json("boot-a", 7_000, 0)).unwrap();
        // The minute's last reading, 59 s in, is what the boundary books; the
        // reading that crossed it waits for the next.
        assert_eq!(total_rx(&app, id), 5_900);
        let rows = app.db.metrics(id, Span::minutes(0, 60)).unwrap();
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
        // Every column gets a value of its own, so two of them swapped anywhere
        // between the report and the read shows.
        const OFFSETS: [(&str, i64); 6] = [
            ("mem_used", 0),
            ("swap_used", 1_000),
            ("disk_used", 2_000),
            ("tcp", 3_000),
            ("udp", 4_000),
            ("procs", 5_000),
        ];
        let burst = |(rx, tx): (i64, i64), (rx_now, tx_now): (i64, i64), cpu: f64, count: i64| {
            let mut params = json!({"boot_id": "boot-a", "net_rx_total": rx, "net_tx_total": tx,
                                    // What the agent measured over its own last second.
                                    "net_rx": rx_now, "net_tx": tx_now, "cpu": cpu});
            for (column, offset) in OFFSETS {
                params[column] = json!(count + offset);
            }
            json!({"jsonrpc": "2.0", "method": "report", "params": params}).to_string()
        };

        // The CPU is busiest at the first sample and eases off; 60 MB come down
        // and 20 MB go up in between, and the halfway sample caught the busiest
        // second of that transfer. The first lands half a second in, so the row
        // spans 59.5 s.
        dispatch(&app, id, "ip", &burst((1_000, 0), (0, 0), 99.5, 100), &mut session, at_ms(500)).unwrap();
        let halfway = burst((1_000 + 45_000_000, 15_000_000), (3_000_000, 1_000_000), 50.0, 151);
        send(&app, id, &mut session, 30, &halfway).unwrap();
        send(&app, id, &mut session, 60, &burst((1_000 + 60_000_000, 20_000_000), (0, 0), 1.0, 201)).unwrap();

        let row = &app.db.metrics(id, Span::minutes(0, 60)).unwrap()[0];
        assert_eq!(
            row["net_rx"], 1_008_403,
            "60 MB over 59.5 s, not the agent's 0 nor over 59 whole seconds"
        );
        assert_eq!(row["net_tx"], 336_134, "20 MB over 59.5 s, from the tx counter");
        assert_eq!(row["net_rx_max"], 3_000_000, "the busiest second survives the mean");
        assert_eq!(row["net_tx_max"], 1_000_000, "in each direction");
        let cpu = row["cpu"].as_f64().unwrap();
        assert!((cpu - 150.5 / 3.0).abs() < 1e-9, "the mean of the minute, fraction kept: {cpu}");
        assert_eq!(row["cpu_max"], 99.5, "and its busiest second of CPU survives it too");
        // Integers remain integral: the column is read with as_i64, which returns
        // nothing for the 150.67 the raw mean would produce.
        for (column, offset) in OFFSETS {
            assert_eq!(row[column], 151 + offset, "{column}");
        }
        // The live view still shows the instantaneous reading, which is its
        // purpose.
        assert_eq!(app.agents.read().unwrap()[&id].metrics_json()["net_rx"], 0);
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
        let before = app.db.metrics(id, Span::minutes(0, 60)).unwrap();
        assert_eq!(before.len(), 1, "the running session wrote the row for this minute");

        // The socket drops and the agent returns within the same minute.
        let (tx, _rx) = mpsc::channel(4);
        app.agents.write().unwrap().insert(id, Agent::new(2, tx));
        let loud = json!({"jsonrpc": "2.0", "method": "report",
                          "params": {"boot_id": "boot-a", "cpu": 99.0, "net_rx_total": 9_000,
                                     "net_tx_total": 4_500}})
        .to_string();
        send(&app, id, &mut Session::default(), 70, &loud).unwrap();
        assert_eq!(
            app.db.metrics(id, Span::minutes(0, 60)).unwrap(),
            before,
            "the row keeps the minute it described"
        );
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
            file(
                &app,
                held,
                Reading { epoch: epoch.into(), counters: (rx, tx), arrival, booted: None, booked: false },
            )
            .unwrap();
            app.db.accumulate(every, epoch, (rx, tx), arrival.at, None).unwrap();
        }
        book_held(&app, Some(held));

        let (kept, booked) = (app.db.stored_traffic(held), app.db.stored_traffic(every));
        assert_eq!(kept, booked);
        // The comparison is only as good as the boundary it spans.
        assert_eq!(booked.month_start, "2026-02-01", "the period turned at midnight");
        assert!(booked.day_rx > 0 && booked.total_rx > booked.day_rx, "bytes fell on both sides of midnight");
    }

    /// A booking whose batch is rolled back is booked again at the break that
    /// follows; otherwise the bytes up to it would be lost with the old span.
    #[test]
    fn a_booking_rolled_back_with_its_batch_is_booked_again() {
        let app = app();
        let (id, _held) = connect(&app);
        let mut session = Session::default();
        send(&app, id, &mut session, 0, &report_json("boot-a", 1_000, 0)).unwrap();
        app.db.execute_for_test(
            "CREATE TRIGGER fail BEFORE INSERT ON metric BEGIN SELECT RAISE(ROLLBACK, 'disk full'); END",
        );
        // The minute turns: the reading is booked, then the history row fails
        // and takes the batch with it.
        assert!(send(&app, id, &mut session, 60, &report_json("boot-a", 5_000, 0)).is_err());
        app.db.execute_for_test("DROP TRIGGER fail");
        send(&app, id, &mut session, 70, &report_json("boot-b", 100, 0)).unwrap();
        assert_eq!(total_rx(&app, id), 4_000);
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

        // A session that ends before its first report has no time to record.
        let (tx, _rx) = mpsc::channel(4);
        app.agents.write().unwrap().insert(id, Agent::new(2, tx));
        let agent = release(&app, id, 2).expect("the session is still the node's");
        close(&app, id, Some(&agent), &mut Session::default());
        assert_eq!(app.db.node(id).unwrap().unwrap().last_seen, at(10).at.timestamp(), "last_seen stays");
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
            let reading = |rx, secs| Reading {
                epoch: "e".into(),
                counters: (rx, 0),
                arrival: at(secs),
                booted: None,
                booked: false,
            };
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
        let hostname = || app.db.node(id).unwrap().unwrap().hostname;
        let cpu =
            |value: f64| json!({"jsonrpc": "2.0", "method": "report", "params": {"cpu": value}}).to_string();
        let live_cpu = || app.agents.read().unwrap()[&id].metrics_json()["cpu"].clone();
        dispatch(&app, id, "ip", &cpu(1.0), &mut session, at_ms(10_000)).unwrap();
        dispatch(&app, id, "ip", &cpu(2.0), &mut session, at_ms(10_300)).unwrap();
        assert_eq!(live_cpu(), 1.0, "a report 300 ms after the last is dropped");
        dispatch(&app, id, "ip", &cpu(3.0), &mut session, at_ms(11_000)).unwrap();
        assert_eq!(live_cpu(), 3.0, "one a second later is the agent's own pace");

        // The busiest honest node runs every probe at the shortest interval, and
        // one window can span two of its rounds: none of that may be dropped.
        let task = probe(&app, id, "p");
        let round = Db::MAX_PROBES_PER_NODE as usize;
        let per_window = RESULT_WINDOW.as_secs().div_ceil(Db::MIN_PROBE_INTERVAL as u64) as usize + 1;
        let rounds = round * per_window;
        let window = RESULT_WINDOW.as_millis() as u64;
        for n in 0..rounds {
            // The first round opens the window; the others land in its last
            // millisecond.
            let ms = if n < round { 20_000 } else { 20_000 + window - 1 };
            dispatch(&app, id, "ip", &result_json(task, 1), &mut session, at_ms(ms)).unwrap();
        }
        assert_eq!(session.results.len(), rounds, "every round an honest node fits in a window passes");
        for _ in 0..1_000 {
            dispatch(&app, id, "ip", &result_json(task, 1), &mut session, at_ms(20_000 + window - 1))
                .unwrap();
        }
        let capped = session.results.len();
        assert!(capped < rounds + 1_000, "a flood within the window is cut off");
        dispatch(&app, id, "ip", &result_json(task, 1), &mut session, at_ms(20_000 + window)).unwrap();
        assert_eq!(session.results.len(), capped + 1, "the next window admits again");

        let due = |session: &mut Session, secs| {
            session.held_hello_due(at(secs).tick).map(|f| f["hostname"].clone())
        };
        send(&app, id, &mut session, 100, &hello("first")).unwrap();
        send(&app, id, &mut session, 101, &hello("second")).unwrap();
        send(&app, id, &mut session, 102, &hello("third")).unwrap();
        assert_eq!(hostname(), "first", "facts are written at most once per spacing");
        assert_eq!(due(&mut session, 129), None);
        assert_eq!(
            due(&mut session, 130),
            Some(json!("third")),
            "the latest held hello is due once the spacing passes"
        );
        assert_eq!(due(&mut session, 131), None, "and only once");
        send(&app, id, &mut session, 150, &hello("renamed")).unwrap();
        assert_eq!(due(&mut session, 159), None, "the spacing runs from the held hello's write");
        send(&app, id, &mut session, 160, &hello("again")).unwrap();
        assert_eq!(hostname(), "again", "a hello written directly supersedes the held one");
        assert_eq!(due(&mut session, 300), None);
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
        assert_eq!(n.mem_total, 0, "capacities are the reports' to store, not an older agent's hello");
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
    fn a_lookup_reply_counts_only_as_two_letters() {
        assert_eq!(country_code(" us\n").as_deref(), Some("US"));
        for body in ["", "U", "USA", "U1", "U-", "é", " - ", "<!doctype html>", "ÜS"] {
            assert_eq!(country_code(body), None, "{body:?}");
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
        // Ids naming no probe this node runs.
        for task in [0, -1, 99] {
            send(&app, id, &mut session, 0, &result_json(task, 42)).unwrap();
        }
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

    /// A panel edit reaches the sessions it concerns, and each sends its own
    /// node's list; one that cannot be read is an error, never an empty list.
    #[test]
    fn a_probe_edit_is_pushed_to_the_nodes_it_names() {
        let app = app();
        let (a, b) = (node(&app), node(&app));
        let task = probe(&app, a, "p");
        let (ta, mut to_a) = mpsc::channel(1);
        let (tb, mut to_b) = mpsc::channel(1);
        app.agents.write().unwrap().insert(a, Agent::new(1, ta));
        app.agents.write().unwrap().insert(b, Agent::new(2, tb));

        push_ping_tasks(&app, Some(a));
        assert!(to_a.try_recv().is_ok());
        assert!(to_b.try_recv().is_err(), "an edit of one node is pushed to that node alone");
        push_ping_tasks(&app, None);
        assert!(to_a.try_recv().is_ok() && to_b.try_recv().is_ok());

        let list =
            |id| serde_json::from_str::<serde_json::Value>(&ping_tasks_message(&app, id).unwrap()).unwrap();
        assert_eq!(list(a)["method"], "ping.tasks");
        assert_eq!(list(a)["params"][0]["id"], task);
        assert_eq!(list(b)["params"], json!([]), "a node without probes is told so");
        let mut failing = false;
        assert!(tasks_frame(&app, a, &mut failing).is_some() && !failing);
        app.db.execute_for_test("ALTER TABLE ping_node RENAME TO hidden");
        for attempt in ["the first failure", "a retry"] {
            assert_eq!(
                tasks_frame(&app, a, &mut failing),
                None,
                "{attempt} sends nothing, not an empty list"
            );
            assert!(failing, "{attempt} leaves the list owed");
        }
        app.db.execute_for_test("ALTER TABLE hidden RENAME TO ping_node");
        assert!(tasks_frame(&app, a, &mut failing).is_some() && !failing, "the heartbeat's retry sends it");
    }

    #[test]
    fn results_bunched_into_one_second_keep_a_row_each() {
        let app = app();
        let id = node(&app);
        let mut session = Session::default();
        let one = probe(&app, id, "one");
        for latency in [-1, -1, 30] {
            send(&app, id, &mut session, 0, &result_json(one, latency)).unwrap();
        }
        send(&app, id, &mut session, 60, r#"{"method":"whatever"}"#).unwrap();
        let loss = app.db.ping_records(id, Span::minutes(0, 60)).unwrap().1;
        assert_eq!(loss[one.to_string()], 200.0 / 3.0, "the two timeouts before the reply count");
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
        assert!(live(), "the reconnected agent stays online and keeps receiving probe pushes");
    }

    #[test]
    fn a_report_leaves_out_what_its_connection_already_carried() {
        let app = app();
        let (id, _held) = connect(&app);
        let mut session = Session::default();
        let report = |params: serde_json::Value| json!({"method": "report", "params": params}).to_string();
        let live = || app.agents.read().unwrap()[&id].metrics_json();
        let whole = json!({"boot_id": "b1", "iface": "eth0", "mem_total": 1_000, "swap_total": 0,
                           "disk_total": 5_000, "cpu": 1.0, "net_rx_total": 10, "net_tx_total": 10});
        dispatch(&app, id, "ip", &report(whole), &mut session, at_ms(0)).unwrap();
        // Dropped for its spacing, yet the agent will not send this disk total again.
        let resized = json!({"disk_total": 6_000, "cpu": 2.0, "net_rx_total": 20, "net_tx_total": 20});
        dispatch(&app, id, "ip", &report(resized), &mut session, at_ms(300)).unwrap();
        let sparse = json!({"cpu": 3.0, "net_rx_total": 30, "net_tx_total": 30});
        dispatch(&app, id, "ip", &report(sparse.clone()), &mut session, at_ms(1_000)).unwrap();
        let m = live();
        assert_eq!(
            (m["cpu"].clone(), m["boot_id"].clone(), m["iface"].clone()),
            (json!(3.0), json!("b1"), json!("eth0"))
        );
        assert_eq!(m["disk_total"], 6_000, "the value the dropped report carried");
        assert_eq!(m["swap_total"], 0);

        // Another connection fills from nothing it has not itself carried.
        dispatch(&app, id, "ip", &report(sparse), &mut Session::default(), at_ms(2_000)).unwrap();
        assert!(live().get("boot_id").is_none());
    }

    /// `STICKY` is what the hub offers the agent to leave out, and each field
    /// offered has to be filled back in.
    #[test]
    fn every_field_offered_as_sticky_is_filled_back_in() {
        let whole: Report = serde_json::from_value(json!({"boot_id": "b", "iface": "eth0", "mem_total": 1,
                                                          "swap_total": 2, "disk_total": 3, "cpu": 4.0}))
        .unwrap();
        let mut held = Report::default();
        whole.clone().fill_sticky(&mut held);
        for key in STICKY {
            let mut sparse = json!(&whole);
            sparse.as_object_mut().unwrap().remove(key);
            let mut sparse: Report = serde_json::from_value(sparse).unwrap();
            sparse.fill_sticky(&mut held);
            assert_eq!(sparse, whole, "{key}");
        }
        // A report refused over another field still records every sticky one.
        let mut refused = json!(&whole);
        refused["cpu"] = serde_json::Value::Null;
        let refused = refused.to_string();
        assert!(Report::parse(&refused).is_err());
        let mut from_refused = Report::default();
        Report::sticky_of(&refused).unwrap().fill_sticky(&mut from_refused);
        assert_eq!(from_refused, held);
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
