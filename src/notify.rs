//! Outbound alerts through a Telegram bot, a webhook with a JSON body template,
//! or both. Channels are read from the settings at send time, so a panel edit
//! applies to the next alert.
//!
//! Events: a node going offline and returning, a billing period's traffic
//! crossing the threshold and the full allowance, expiry dates approaching or
//! rolled forward, and a sign-in to the panel.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Local, NaiveDate, TimeZone, Timelike, Utc};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::api::Admin;
use crate::{App, Shared};

/// One alert. `node` lists the node names it concerns, comma-separated, and is
/// empty for a sign-in.
#[derive(Debug, Clone, Default)]
pub struct Note {
    pub event: &'static str,
    pub node: String,
    pub title: String,
    pub message: String,
    /// Unix seconds, stamped when queued: delivery can trail the event by minutes
    /// while a channel is retried.
    pub time: i64,
}

/// Alerts awaiting delivery. A channel that stays down holds each alert for
/// about a minute per channel (`ATTEMPTS` × the 15 s client timeout plus the
/// pauses), so the queue can fill; beyond it alerts are dropped with a warning
/// rather than held in memory without bound.
pub const QUEUE: usize = 64;
const ATTEMPTS: u32 = 3;
const RETRY: Duration = Duration::from_secs(10);

/// Nodes listed in one alert before the rest are only counted. Discord rejects a
/// message over 2000 characters and WeCom one over 2048 bytes, and an outage on
/// the hub's side names every node at once; twenty lines of typical names stay
/// within both.
const LISTED: usize = 20;

/// How often connectivity and traffic are examined. An offline alert therefore
/// trails the grace period by at most this interval.
const SWEEP: Duration = Duration::from_secs(30);

/// A node that returned from an absence longer than the grace period within
/// `FLAP_WINDOW` of going away again is flapping, and that absence is reported
/// only once it lasts `FLAP_GRACE`. Simulated over an hour at the default grace,
/// a node up for one minute and down for four otherwise sends 23 alerts.
const FLAP_WINDOW: i64 = 3_600;
const FLAP_GRACE: i64 = 1_800;

pub const DEFAULT_BODY: &str =
    r#"{"event":"{{event}}","node":"{{node}}","title":"{{title}}","message":"{{message}}"}"#;
pub const DEFAULT_TEXT: &str = "{{title}}\n{{message}}";

/// Numeric settings as `(key, min, max, default)`.
const NUMBERS: [(&str, i64, i64, i64); 3] = [
    // Minutes a node may stay away before it is reported. Agents reconnect within
    // seconds of a network or hub interruption, which one minute already covers.
    ("notify_grace", 1, 1_440, 3),
    // Percent of the allowance that raises the first traffic alert; 0 disables
    // traffic alerts.
    ("notify_traffic", 0, 100, 80),
    // Days ahead an expiry is listed; 0 disables both expiry reminders and
    // renewal notices.
    ("notify_expiry", 0, 365, 7),
];

/// Credentials, reported to the panel only as set or unset. A webhook URL is
/// commonly the credential itself (Discord, Slack, DingTalk, WeCom, Bark).
const SECRETS: [&str; 3] = ["notify_telegram_token", "notify_webhook_url", "notify_webhook_headers"];

fn number(app: &App, key: &str) -> i64 {
    let (_, min, max, default) =
        NUMBERS.iter().copied().find(|(k, ..)| *k == key).expect("a numeric setting");
    app.db.get(key).and_then(|v| v.parse().ok()).filter(|n| (min..=max).contains(n)).unwrap_or(default)
}

fn setting(app: &App, key: &str) -> Option<String> {
    app.db.get(key).filter(|v| !v.is_empty())
}

/// A template setting, where empty means `default`.
fn template(app: &App, key: &str, default: &str) -> String {
    setting(app, key).unwrap_or_else(|| default.into())
}

/// The notification half of `GET /api/settings`, defaults filled in so that the
/// panel can echo every value back unchanged.
pub fn settings(app: &App, out: &mut serde_json::Map<String, Value>) {
    for (key, ..) in NUMBERS {
        out.insert(key.into(), json!(number(app, key).to_string()));
    }
    let login = if app.db.get("notify_login").as_deref() == Some("off") { "off" } else { "on" };
    out.insert("notify_login".into(), json!(login));
    out.insert("notify_telegram_chat".into(), json!(app.db.get("notify_telegram_chat").unwrap_or_default()));
    out.insert("notify_telegram_text".into(), json!(template(app, "notify_telegram_text", DEFAULT_TEXT)));
    out.insert("notify_webhook_body".into(), json!(template(app, "notify_webhook_body", DEFAULT_BODY)));
    for key in SECRETS {
        out.insert(format!("{key}_set"), json!(setting(app, key).is_some()));
    }
}

/// Why a notification setting cannot be stored, or `None` when it can.
pub fn setting_error(key: &str, value: &str) -> Option<String> {
    if let Some((_, min, max, _)) = NUMBERS.iter().find(|(k, ..)| *k == key) {
        let fits = value.parse::<i64>().is_ok_and(|n| (*min..=*max).contains(&n));
        return (!fits).then(|| format!("{key} must be a number from {min} to {max}"));
    }
    let only = |s: &str, extra: &[u8]| {
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let problem = match key {
        "notify_login" => (!matches!(value, "on" | "off")).then_some("notify_login must be on or off"),
        "notify_webhook_headers" => return parse_headers(value).err(),
        // Empty clears a channel's field, or restores a template's default.
        "notify_telegram_token"
        | "notify_telegram_chat"
        | "notify_webhook_url"
        | "notify_telegram_text"
        | "notify_webhook_body"
            if value.is_empty() =>
        {
            None
        }
        "notify_telegram_text" => None,
        // Interpolated into the request path, so only the shape BotFather issues
        // is accepted.
        "notify_telegram_token" => {
            (!value.split_once(':').is_some_and(|(id, secret)| digits(id) && only(secret, b"_-")))
                .then_some("Telegram bot token must look like 123456:ABC-DEF")
        }
        "notify_telegram_chat" => {
            let valid = match value.strip_prefix('@') {
                Some(name) => only(name, b"_"),
                None => digits(value.strip_prefix('-').unwrap_or(value)),
            };
            (!valid).then_some("Telegram chat must be a numeric id or an @username")
        }
        // Plain http is accepted: a relay on the hub's own host or network is a
        // common target, and only an admin can set this.
        "notify_webhook_url" => (!reqwest::Url::parse(value)
            .is_ok_and(|u| matches!(u.scheme(), "http" | "https")))
        .then_some("webhook URL must start with http:// or https://"),
        "notify_webhook_body" => serde_json::from_str::<Value>(&render(value, &sample(), r#"s"i\te"#, true))
            .is_err()
            .then_some("webhook body must be valid JSON once filled in; keep each placeholder inside quotes"),
        _ => return Some(format!("unknown setting: {key}")),
    };
    problem.map(Into::into)
}

/// Values that exercise every escape the body template must survive.
fn sample() -> Note {
    Note {
        event: "test",
        node: r#"a"b\c"#.into(),
        title: "{{message}}".into(),
        message: "line\nline".into(),
        ..Default::default()
    }
}

/// `Name: value`, one per line. Values are never echoed in an error: they are
/// typically the credential.
fn parse_headers(text: &str) -> Result<Vec<(HeaderName, HeaderValue)>, String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (name, value) =
                line.split_once(':').ok_or("every webhook header line must read Name: value")?;
            let name = HeaderName::try_from(name.trim())
                .map_err(|_| format!("invalid header name {:?}", name.trim()))?;
            let value = HeaderValue::try_from(value.trim())
                .map_err(|_| format!("invalid value for header {name}"))?;
            Ok((name, value))
        })
        .collect()
}

/// Substitutes the placeholders in a single pass, JSON-escaping each value when
/// `json` is set so it is valid inside a string literal. A second pass would also
/// substitute placeholders contained in the inserted values, such as a node name.
fn render(template: &str, note: &Note, site: &str, json: bool) -> String {
    let time = clock(note.time);
    let fields = [
        ("{{event}}", note.event),
        ("{{node}}", note.node.as_str()),
        ("{{title}}", note.title.as_str()),
        ("{{message}}", note.message.as_str()),
        ("{{site}}", site),
        ("{{time}}", time.as_str()),
    ];
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(at) = rest.find("{{") {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        match fields.iter().find(|(key, _)| rest.starts_with(key)) {
            Some((key, value)) => {
                if json {
                    let quoted = Value::from(*value).to_string();
                    out.push_str(&quoted[1..quoted.len() - 1]);
                } else {
                    out.push_str(value);
                }
                rest = &rest[key.len()..];
            }
            None => {
                out.push_str("{{");
                rest = &rest[2..];
            }
        }
    }
    out.push_str(rest);
    out
}

enum Channel {
    Telegram { token: String, chat: String, text: String },
    Webhook { url: String, headers: String, body: String },
}

impl Channel {
    fn name(&self) -> &'static str {
        match self {
            Channel::Telegram { .. } => "telegram",
            Channel::Webhook { .. } => "webhook",
        }
    }
}

fn channels(app: &App) -> Vec<Channel> {
    let mut out = Vec::new();
    if let (Some(token), Some(chat)) =
        (setting(app, "notify_telegram_token"), setting(app, "notify_telegram_chat"))
    {
        out.push(Channel::Telegram {
            token,
            chat,
            text: template(app, "notify_telegram_text", DEFAULT_TEXT),
        });
    }
    if let Some(url) = setting(app, "notify_webhook_url") {
        let headers = app.db.get("notify_webhook_headers").unwrap_or_default();
        out.push(Channel::Webhook { url, headers, body: template(app, "notify_webhook_body", DEFAULT_BODY) });
    }
    out
}

/// Why a delivery failed, and whether another attempt could change that. A
/// refused credential or a malformed request fails identically every time, and
/// retrying it would hold the queue for 20 s per alert.
struct Failure {
    retry: bool,
    reason: String,
}

/// The client alerts are sent with, separate from `App::http` because it must not
/// follow redirects. reqwest resends a POST answered with 301 or 302 as a GET
/// without its body, which the far end typically accepts: the panel would report
/// success while nothing arrives. A redirect to another host also withholds only
/// `Authorization` and cookies, so a credential header such as `X-Gotify-Key`
/// would follow it. Built on first use, so a hub without channels never
/// allocates it.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client")
    })
}

async fn post(app: &App, channel: &Channel, note: &Note) -> Result<(), Failure> {
    let site = site_name(app);
    let request = match channel {
        // Plain text: under a parse mode Telegram rejects a message whose node
        // name happens to contain markup.
        Channel::Telegram { token, chat, text } => client()
            .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
            .json(&json!({"chat_id": chat, "text": render(text, note, &site, false)})),
        Channel::Webhook { url, headers, body } => {
            // `insert` into one map: `RequestBuilder::header` and `HeaderMap::extend`
            // both append, which would send a configured Content-Type alongside the
            // default instead of in its place.
            let mut map = HeaderMap::new();
            map.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            for (name, value) in parse_headers(headers).map_err(|reason| Failure { retry: false, reason })? {
                map.insert(name, value);
            }
            client().post(url).headers(map).body(render(body, note, &site, true))
        }
    };
    // The URL is stripped from the error: Telegram's carries the bot token and a
    // webhook's is often the credential, and the error reaches both the journal
    // and the panel.
    let mut response = request.send().await.map_err(|e| Failure {
        retry: true,
        reason: format!("{:#}", anyhow::Error::from(e.without_url())),
    })?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    if status.is_redirection() {
        let reason = format!("{status}: the URL redirects; enter the address it redirects to");
        return Err(Failure { retry: false, reason });
    }
    // The first chunk carries the reason (Telegram's `description`, Discord's
    // `message`) without reading an error page of arbitrary length.
    let head = response.chunk().await.ok().flatten().unwrap_or_default();
    Err(Failure {
        retry: status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS,
        reason: format!(
            "{status}: {}",
            String::from_utf8_lossy(&head).chars().take(300).collect::<String>().trim()
        ),
    })
}

/// Queues an alert without waiting, so that sign-in and housekeeping never
/// stall behind a slow channel.
pub fn send(app: &App, mut note: Note) {
    note.time = Utc::now().timestamp();
    if let Err(mpsc::error::TrySendError::Full(note)) = app.notes.try_send(note) {
        warn!("notification queue is full; dropped {:?}", note.title);
    }
}

/// Delivers queued alerts one at a time, each channel retried independently.
///
/// At most once: an alert that exhausts its attempts is dropped, and the state
/// that produced it (`down_since`, the traffic step, the digest date) already
/// records it as sent, so it is not raised again.
pub async fn deliver(app: Shared, mut inbox: mpsc::Receiver<Note>) {
    while let Some(note) = inbox.recv().await {
        for channel in channels(&app) {
            for attempt in 1..=ATTEMPTS {
                match post(&app, &channel, &note).await {
                    Ok(()) => break,
                    Err(f) if !f.retry || attempt == ATTEMPTS => {
                        warn!("{} alert {:?} not delivered: {}", channel.name(), note.title, f.reason);
                        break;
                    }
                    Err(f) => {
                        debug!("{} alert {:?}, attempt {attempt}: {}", channel.name(), note.title, f.reason);
                        tokio::time::sleep(RETRY).await;
                    }
                }
            }
        }
    }
}

/// `POST /api/notify/test`: one alert through every configured channel, past the
/// queue and its retries, so each channel's own error reaches the panel.
pub async fn test(_: Admin, State(app): State<Shared>) -> Response {
    let channels = channels(&app);
    if channels.is_empty() {
        return (StatusCode::BAD_REQUEST, "no notification channel is configured").into_response();
    }
    let note = Note {
        event: "test",
        title: "✅ 测试通知".into(),
        message: "收到这条说明通知渠道可用".into(),
        time: Utc::now().timestamp(),
        ..Default::default()
    };
    let mut failed = Vec::new();
    for channel in &channels {
        if let Err(f) = post(&app, channel, &note).await {
            failed.push(format!("{}: {}", channel.name(), f.reason));
        }
    }
    if failed.is_empty() {
        Json(json!({"sent": channels.iter().map(Channel::name).collect::<Vec<_>>()})).into_response()
    } else {
        (StatusCode::BAD_GATEWAY, failed.join("; ")).into_response()
    }
}

pub fn signed_in(app: &App, how: &str, ip: IpAddr) {
    if app.db.get("notify_login").as_deref() != Some("off") {
        let message = format!("{how} · 来自 {ip}");
        send(app, Note { event: "login", title: "🔑 面板登录".into(), message, ..Default::default() });
    }
}

/// Expiry dates that housekeeping rolled forward, as `(name, "old → new")`.
pub fn renewed(app: &App, items: Vec<(&str, String)>) {
    if number(app, "notify_expiry") > 0 {
        if let Some(note) = batch("renew", "🔁", "已自动续期", items) {
            send(app, note);
        }
    }
}

/// Once a day from 09:00 hub time, the nodes expiring within the configured
/// window. The date is stored once sent, so a restart does not repeat it, and
/// not while no channel is configured, so one configured later that day still
/// receives the digest.
pub fn expiry_digest(app: &App, now: DateTime<Local>) -> Result<Option<Note>> {
    let days = number(app, "notify_expiry");
    let today = now.date_naive();
    if days == 0
        || now.hour() < 9
        || app.db.get("notify_expiry_sent") == Some(today.to_string())
        || channels(app).is_empty()
    {
        return Ok(None);
    }
    let mut soon: Vec<(NaiveDate, String)> = app
        .db
        .nodes()?
        .into_iter()
        .filter_map(|n| {
            let date = n.expires_at.as_deref()?.parse::<NaiveDate>().ok()?;
            (0..=days).contains(&(date - today).num_days()).then_some((date, n.name))
        })
        .collect();
    soon.sort();
    app.db.set("notify_expiry_sent", &today.to_string())?;
    let items = soon
        .iter()
        .map(|(date, name)| {
            let left = match (*date - today).num_days() {
                0 => "今天到期".into(),
                d => format!("还剩 {d} 天"),
            };
            (name.as_str(), format!("{date} {left}"))
        })
        .collect();
    Ok(batch("expiry", "⏳", "即将到期", items))
}

/// One alert for any number of nodes: a list in the message, the names in
/// `node`. `None` when there is nothing to say.
fn batch(event: &'static str, mark: &str, what: &str, items: Vec<(&str, String)>) -> Option<Note> {
    let (title, message) = match items.as_slice() {
        [] => return None,
        [(name, detail)] => (format!("{mark} {name} {what}"), detail.clone()),
        _ => {
            let mut lines: Vec<String> =
                items.iter().take(LISTED).map(|(name, detail)| format!("{name} · {detail}")).collect();
            if items.len() > LISTED {
                lines.push(format!("……另外 {} 台", items.len() - LISTED));
            }
            (format!("{mark} {} 台节点{what}", items.len()), lines.join("\n"))
        }
    };
    let node = items.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(", ");
    Some(Note { event, node, title, message, ..Default::default() })
}

/// Sweep state that need not outlive the process.
#[derive(Default)]
pub struct Watch {
    /// Set after the first sweep, which records the traffic steps already reached
    /// without announcing them again after a restart.
    primed: bool,
    /// Per node, the billing period and the traffic step last announced in it.
    traffic: HashMap<i64, (String, i64)>,
    /// Per absent node, when a sweep first found it absent. Absence is measured
    /// from here rather than from `last_seen`, which an agent reporting every few
    /// minutes leaves minutes old: measured from that, a restart of such an agent
    /// caught by a single sweep would already be past the grace period. After a
    /// hub restart the first sweep finds every node absent, which also gives each
    /// agent the whole grace period to reconnect.
    absent: HashMap<i64, i64>,
    /// Per node, when it last returned from an absence longer than the grace
    /// period. Absences shorter than that, such as an agent restart, do not count.
    returned: HashMap<i64, i64>,
}

pub async fn watch(app: Shared) {
    let mut watch = Watch::default();
    let mut ticker = tokio::time::interval(SWEEP);
    loop {
        ticker.tick().await;
        // Synchronous database work, kept off the runtime threads like a report.
        match tokio::task::block_in_place(|| sweep(&app, &mut watch, Utc::now().timestamp())) {
            Ok(notes) => notes.into_iter().for_each(|note| send(&app, note)),
            Err(e) => warn!("notification sweep failed: {e:#}"),
        }
    }
}

/// One pass over every node. Nodes going offline, nodes returning and traffic
/// crossings are each gathered into one alert per pass. An outage on the hub's
/// side, which drops every agent within about 30 s, therefore produces one or
/// two alerts rather than one per node (two for 40 nodes in simulation), and the
/// rate stays below the 20 messages a minute that Telegram groups, DingTalk and
/// WeCom accept.
///
/// A return is announced only after an offline alert, whether or not the node
/// still has alerts enabled: brief disconnections within the grace period stay
/// silent in both directions. Nothing is recorded as announced while no channel
/// is configured, so configuring one afterwards still reports nodes already down
/// and traffic already past a step.
fn sweep(app: &App, watch: &mut Watch, now: i64) -> Result<Vec<Note>> {
    let online: HashSet<i64> = app.agents.read().unwrap_or_else(|e| e.into_inner()).keys().copied().collect();
    let nodes = app.db.nodes()?;
    // Node ids are rowids, which SQLite hands to the next node created once the
    // newest is deleted; state kept under a deleted id would pass that node's
    // absence, return and traffic step to the new one.
    // ponytail: a delete and a create within one SWEEP still inherit; key by
    // creation time if that ever matters.
    let ids: HashSet<i64> = nodes.iter().map(|n| n.id).collect();
    watch.absent.retain(|id, _| ids.contains(id));
    watch.returned.retain(|id, _| ids.contains(id));
    watch.traffic.retain(|id, _| ids.contains(id));
    let grace = number(app, "notify_grace") * 60;
    let armed = !channels(app).is_empty();
    let (mut down, mut up) = (Vec::new(), Vec::new());
    for node in &nodes {
        if online.contains(&node.id) {
            if watch.absent.remove(&node.id).is_some_and(|since| now - since >= grace) {
                watch.returned.insert(node.id, now);
            }
            if node.down_since > 0 {
                app.db.set_down_since(node.id, 0)?;
                up.push((node.name.as_str(), format!("离线 {}", span(now - node.down_since))));
            }
            continue;
        }
        // A node that has never reported cannot be announced, and tracking its
        // absence would count its first connection as a return from an outage.
        if node.last_seen == 0 {
            continue;
        }
        let since = *watch.absent.entry(node.id).or_insert(now);
        let flapping = watch.returned.get(&node.id).is_some_and(|back| since - back < FLAP_WINDOW);
        let wait = if flapping { grace.max(FLAP_GRACE) } else { grace };
        if armed && node.notify && node.down_since == 0 && now - since >= wait {
            app.db.set_down_since(node.id, node.last_seen)?;
            down.push((node.name.as_str(), format!("最后上报 {}", clock(node.last_seen))));
        }
    }
    let mut notes: Vec<Note> = [batch("offline", "🔴", "离线", down), batch("online", "🟢", "恢复在线", up)]
        .into_iter()
        .flatten()
        .collect();

    let percent = number(app, "notify_traffic");
    let mut metered = Vec::new();
    let traffic = if percent > 0 && armed { app.db.all_traffic() } else { HashMap::new() };
    for node in nodes.iter().filter(|n| n.traffic_limit > 0) {
        let Some(t) = traffic.get(&node.id) else { continue };
        let used = match node.traffic_mode.as_str() {
            "up" => t.month_tx,
            "down" => t.month_rx,
            "max" => t.month_rx.max(t.month_tx),
            _ => t.month_rx.saturating_add(t.month_tx),
        };
        // i128: 100 × a limit near i64::MAX would overflow.
        let reached = |p: i64| used as i128 * 100 >= node.traffic_limit as i128 * p as i128;
        let step = if reached(100) {
            100
        } else if reached(percent) {
            percent
        } else {
            0
        };
        // A step below the one recorded is a manual correction; storing it lets the
        // same crossing be announced again.
        let last = watch.traffic.insert(node.id, (t.month_start.clone(), step));
        let told = last.is_some_and(|(period, last)| period == t.month_start && last >= step);
        if step == 0 || told || !watch.primed {
            continue;
        }
        let mode = match node.traffic_mode.as_str() {
            "up" => "仅上行",
            "down" => "仅下行",
            "max" => "取较大值",
            _ => "上下行相加",
        };
        let share = used as i128 * 100 / node.traffic_limit as i128;
        let detail = format!(
            "已用 {share}%，{} / {}（{mode}），本期自 {} 起",
            gib(used),
            gib(node.traffic_limit),
            t.month_start
        );
        metered.push((node.name.as_str(), detail));
    }
    notes.extend(batch("traffic", "⚠️", "流量提醒", metered));
    watch.primed = true;
    Ok(notes)
}

fn span(seconds: i64) -> String {
    let minutes = seconds.max(0) / 60;
    match (minutes / 1_440, minutes / 60 % 24, minutes % 60) {
        (0, 0, m) => format!("{m} 分钟"),
        (0, h, m) => format!("{h} 小时 {m} 分钟"),
        (d, h, _) => format!("{d} 天 {h} 小时"),
    }
}

fn site_name(app: &App) -> String {
    setting(app, "site_name").unwrap_or_else(|| "Monitor".into())
}

/// Hub-local time with its offset: a hub in a container commonly runs on UTC
/// while its operator reads local time.
fn clock(ts: i64) -> String {
    Local.timestamp_opt(ts, 0).single().map(|t| t.format("%m-%d %H:%M %:z").to_string()).unwrap_or_default()
}

/// GiB, labelled GB as in the panel.
fn gib(bytes: i64) -> String {
    format!("{:.2} GB", bytes as f64 / (1u64 << 30) as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_ws::Agent;
    use crate::db::{Db, Node, NodePatch, TrafficPatch};

    fn app() -> App {
        App::for_test(Db::open(":memory:").unwrap())
    }

    fn node(app: &App, name: &str, notify: bool, last_seen: i64) -> i64 {
        let id = app
            .db
            .create_node(&Node { name: name.into(), traffic_reset_day: 1, ..Default::default() }, name)
            .unwrap();
        app.db.update_node(id, &NodePatch { notify: Some(notify), ..Default::default() }).unwrap();
        app.db.touch_seen(id, last_seen).unwrap();
        id
    }

    fn connect(app: &App, id: i64) {
        let (tx, _) = mpsc::channel(1);
        app.agents.write().unwrap().insert(id, Agent::new(1, tx));
    }

    /// Offline alerts are only marked while a channel exists to carry them.
    fn with_channel(app: &App) {
        app.db.set("notify_webhook_url", "http://127.0.0.1:9/").unwrap();
    }

    #[test]
    fn a_rendered_body_stays_json_whatever_the_values_contain() {
        let body = render(
            r#"{"t":"{{title}}","m":"{{message}}","n":"{{node}}","s":"{{site}}","x":"{{other}}"}"#,
            &sample(),
            r#"my "hub""#,
            true,
        );
        let parsed: Value = serde_json::from_str(&body).unwrap();
        // Single pass: the title's own "{{message}}" is text, not a placeholder.
        assert_eq!(parsed["t"], "{{message}}");
        assert_eq!(parsed["m"], "line\nline");
        assert_eq!(parsed["n"], r#"a"b\c"#);
        assert_eq!(parsed["s"], r#"my "hub""#);
        assert_eq!(parsed["x"], "{{other}}", "an unknown placeholder is left as written");
        // Telegram's text is not JSON: the same values arrive unescaped.
        assert_eq!(
            render("[{{site}}] {{node}}\n{{message}}", &sample(), "hub", false),
            "[hub] a\"b\\c\nline\nline"
        );

        assert_eq!(setting_error("notify_webhook_body", DEFAULT_BODY), None);
        assert!(setting_error("notify_webhook_body", r#"{"content": {{title}}}"#).is_some(), "unquoted");
        assert!(setting_error("notify_webhook_headers", "Authorization Bearer x").is_some());
        assert_eq!(setting_error("notify_webhook_headers", "Authorization: Bearer x\n\nX-Id: 1"), None);
        assert!(setting_error("notify_telegram_token", "123:abc/../x").is_some(), "goes into the path");
        assert_eq!(setting_error("notify_telegram_token", "123456:AA-b_c"), None);
        for chat in ["-1001234", "42", "@my_channel", ""] {
            assert_eq!(setting_error("notify_telegram_chat", chat), None, "{chat}");
        }
        assert!(setting_error("notify_telegram_chat", "-").is_some());
        assert!(setting_error("notify_webhook_url", "ftp://x").is_some());
        assert!(
            setting_error("notify_expiry_sent", "2026-01-01").is_some(),
            "internal state is not a setting"
        );
        assert!(setting_error("notify_unknown", "").is_some(), "an empty value does not make a key known");

        // A long list is cut to what Discord and WeCom accept; `node` stays whole.
        let names: Vec<String> = (0..60).map(|i| format!("n{i}")).collect();
        let note =
            batch("offline", "🔴", "离线", names.iter().map(|n| (n.as_str(), "d".into())).collect()).unwrap();
        assert_eq!(note.title, "🔴 60 台节点离线");
        assert_eq!(note.message.lines().count(), LISTED + 1);
        assert!(note.message.ends_with("……另外 40 台"));
        assert_eq!(note.node.split(", ").count(), 60);
    }

    #[test]
    fn offline_is_announced_once_after_the_grace_period_and_paired_with_the_return() {
        let app = app();
        let now = 1_000_000;
        let a = node(&app, "a", true, now - 600);
        node(&app, "b", true, now - 600);
        let quiet = node(&app, "quiet", false, now - 600);
        let brief = node(&app, "brief", true, now - 600);
        let mut watch = Watch { primed: true, ..Default::default() };

        // Nothing is marked while no channel could carry the alert, so the nodes
        // are still reported once one is configured.
        assert!(sweep(&app, &mut watch, now).unwrap().is_empty(), "the grace period starts when seen absent");
        assert!(sweep(&app, &mut watch, now + 180).unwrap().is_empty(), "no channel");
        with_channel(&app);
        connect(&app, brief);
        let notes = sweep(&app, &mut watch, now + 210).unwrap();
        assert_eq!(notes.len(), 1, "two nodes down in one sweep are one alert");
        assert_eq!(notes[0].title, "🔴 2 台节点离线");
        assert_eq!(notes[0].node, "a, b", "not the opted-out node, nor one back within the grace period");
        assert!(sweep(&app, &mut watch, now + 240).unwrap().is_empty(), "announced once");

        // A restart forgets nothing that was announced: the state is in the row.
        let mut restarted = Watch::default();
        assert!(sweep(&app, &mut restarted, now + 300).unwrap().is_empty());
        assert!(sweep(&app, &mut restarted, now + 900).unwrap().is_empty());

        connect(&app, a);
        connect(&app, quiet);
        let notes = sweep(&app, &mut restarted, now + 900).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].event, "online");
        assert_eq!(notes[0].title, "🟢 a 恢复在线", "only the node whose absence was announced");
        assert_eq!(notes[0].message, "离线 25 分钟");
        assert!(sweep(&app, &mut restarted, now + 930).unwrap().is_empty());
    }

    /// `last_seen` is written once a minute at best, and once per report for an
    /// agent reporting less often. Measured from it, a restart of an agent on a
    /// five-minute interval would be past the grace period the moment a sweep
    /// caught it.
    #[test]
    fn a_restart_is_not_an_outage_however_old_the_last_report_is() {
        let app = app();
        with_channel(&app);
        let now = 1_000_000;
        let id = node(&app, "slow", true, now - 240);
        connect(&app, id);
        let mut watch = Watch { primed: true, ..Default::default() };
        assert!(sweep(&app, &mut watch, now).unwrap().is_empty());
        app.agents.write().unwrap().remove(&id);
        assert!(sweep(&app, &mut watch, now + 30).unwrap().is_empty(), "absent for one sweep");
        connect(&app, id);
        assert!(sweep(&app, &mut watch, now + 60).unwrap().is_empty());
    }

    #[test]
    fn a_flapping_node_is_reported_only_once_an_absence_outlasts_half_an_hour() {
        let app = app();
        let t = 1_000_000;
        with_channel(&app);
        let id = node(&app, "flappy", true, t);
        let mut watch = Watch { primed: true, ..Default::default() };
        let mut at = |now: i64| -> Vec<&'static str> {
            sweep(&app, &mut watch, now).unwrap().into_iter().map(|n| n.event).collect()
        };
        let back = |now| {
            connect(&app, id);
            app.db.touch_seen(id, now).unwrap();
        };
        let gone = |last_seen| {
            app.agents.write().unwrap().remove(&id);
            app.db.touch_seen(id, last_seen).unwrap();
        };

        // A five-minute absence is an ordinary outage.
        assert!(at(t).is_empty());
        assert_eq!(at(t + 300), ["offline"]);
        back(t + 330);
        assert_eq!(at(t + 330), ["online"]);
        // Gone again ten minutes later: flapping, so ten minutes pass in silence,
        // but an absence that reaches half an hour is still reported.
        gone(t + 900);
        assert!(at(t + 900).is_empty());
        assert!(at(t + 1_500).is_empty());
        assert_eq!(at(t + 2_700), ["offline"]);
        back(t + 2_730);
        assert_eq!(at(t + 2_730), ["online"]);

        // An hour online restores the ordinary grace period.
        gone(t + 2_730 + 3_600);
        assert!(at(t + 2_730 + 3_600).is_empty());
        assert_eq!(at(t + 2_730 + 3_600 + 180), ["offline"]);
        back(t + 6_600);
        at(t + 6_600);

        // A 30-second absence, an agent restart, is not a flap.
        gone(t + 10_800);
        at(t + 10_830);
        back(t + 10_860);
        at(t + 10_860);
        gone(t + 11_000);
        assert!(at(t + 11_000).is_empty());
        assert_eq!(at(t + 11_180), ["offline"], "the next absence keeps the ordinary grace period");
    }

    /// A deleted node's id goes to the next node created, and a node's first
    /// connection is not a return from an outage: either would put a new node on
    /// the flapping grace period or suppress its first traffic alert.
    #[test]
    fn a_new_node_starts_with_no_absence_return_or_traffic_step() {
        let app = app();
        with_channel(&app);
        let (t, gb) = (1_000_000, 1i64 << 30);
        let metered = |id: i64| {
            app.db
                .update_node(id, &NodePatch { traffic_limit: Some(100 * gb), ..Default::default() })
                .unwrap();
            let patch = TrafficPatch { month_rx: Some(90 * gb), month_tx: Some(0), ..Default::default() };
            app.db.set_traffic(id, &patch).unwrap();
        };
        let mut watch = Watch { primed: true, ..Default::default() };
        let mut at = |now: i64| -> Vec<&'static str> {
            sweep(&app, &mut watch, now).unwrap().into_iter().map(|n| n.event).collect()
        };

        let old = node(&app, "old", false, t);
        metered(old);
        assert_eq!(at(t), ["traffic"]);
        app.db.delete_node(old).unwrap();
        assert!(at(t + 30).is_empty());

        let new = node(&app, "new", true, 0);
        assert_eq!(new, old, "the id is reused");
        metered(new);
        assert_eq!(at(t + 60), ["traffic"]);
        connect(&app, new);
        app.db.touch_seen(new, t + 600).unwrap();
        assert!(at(t + 600).is_empty());
        app.agents.write().unwrap().remove(&new);
        assert!(at(t + 630).is_empty());
        assert_eq!(at(t + 810), ["offline"], "the ordinary grace period");
    }

    #[test]
    fn traffic_is_announced_at_the_threshold_and_at_the_allowance_once_each() {
        let app = app();
        let id = node(&app, "t", false, 0);
        let gb = 1i64 << 30;
        app.db.update_node(id, &NodePatch { traffic_limit: Some(100 * gb), ..Default::default() }).unwrap();
        let mut watch = Watch::default();
        let used = |month_rx: i64| {
            app.db.set_traffic(
                id,
                &TrafficPatch { month_rx: Some(month_rx), month_tx: Some(0), ..Default::default() },
            )
        };
        let titles = |watch: &mut Watch| -> Vec<String> {
            let notes = sweep(&app, watch, 0).unwrap().into_iter().filter(|n| n.event == "traffic");
            notes.map(|n| format!("{} {}", n.title, n.message.split('，').next().unwrap())).collect()
        };

        used(85 * gb).unwrap();
        assert!(titles(&mut watch).is_empty());
        assert!(titles(&mut watch).is_empty(), "no channel");
        with_channel(&app);
        assert_eq!(
            titles(&mut watch),
            ["⚠️ t 流量提醒 已用 85%"],
            "a crossing made before the channel existed"
        );
        let mut watch = Watch::default();
        assert!(titles(&mut watch).is_empty(), "the first sweep after a start records, it does not repeat");
        used(10 * gb).unwrap();
        assert!(titles(&mut watch).is_empty(), "below the threshold");
        used(81 * gb).unwrap();
        assert_eq!(
            titles(&mut watch),
            ["⚠️ t 流量提醒 已用 81%"],
            "a correction downward re-arms the crossing"
        );
        used(95 * gb).unwrap();
        assert!(titles(&mut watch).is_empty(), "no alert per percent between the two steps");
        used(100 * gb).unwrap();
        assert_eq!(titles(&mut watch), ["⚠️ t 流量提醒 已用 100%"]);
        assert!(titles(&mut watch).is_empty());
    }

    #[test]
    fn the_expiry_digest_is_sent_once_a_day_from_nine() {
        let app = app();
        let at = |h| Local.with_ymd_and_hms(2026, 9, 15, h, 0, 0).unwrap();
        for (name, date) in
            [("later", "2026-09-30"), ("soon", "2026-09-20"), ("today", "2026-09-15"), ("gone", "2026-09-14")]
        {
            let id = node(&app, name, false, 0);
            app.db.set_expiry(id, date).unwrap();
        }
        assert!(expiry_digest(&app, at(8)).unwrap().is_none(), "not before nine");
        assert!(expiry_digest(&app, at(9)).unwrap().is_none(), "no channel, and the day is not spent");
        with_channel(&app);
        let note = expiry_digest(&app, at(9)).unwrap().unwrap();
        assert_eq!(note.title, "⏳ 2 台节点即将到期");
        assert_eq!(note.message, "today · 2026-09-15 今天到期\nsoon · 2026-09-20 还剩 5 天");
        assert!(expiry_digest(&app, at(10)).unwrap().is_none(), "once per day");
    }
}
