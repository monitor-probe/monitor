-- The schema monitor v1.0.0 created, verbatim: schema version 3, the oldest a
-- released hub has written. Frozen; `db::tests` upgrades it through `Db::open`.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
-- 8 MiB of page cache. The whole working set of a few hundred nodes fits, so
-- the read paths stop going back to the filesystem.
PRAGMA cache_size = -8192;
-- Without these the WAL grows to whatever the busiest minute needed and never
-- gives the space back: a hub is a long-running process on a small VPS.
PRAGMA wal_autocheckpoint = 256;
PRAGMA journal_size_limit = 1048576;

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  -- The agent's credential, in the clear: the panel shows a node's install
  -- command whenever it is asked, so it has to be able to read it back.
  token         TEXT    NOT NULL UNIQUE,
  sort          INTEGER NOT NULL DEFAULT 0,
  public        INTEGER NOT NULL DEFAULT 1,
  price         REAL    NOT NULL DEFAULT 0,
  currency      TEXT    NOT NULL DEFAULT 'USD',
  billing_cycle TEXT    NOT NULL DEFAULT 'monthly',
  expires_at    TEXT,
  remark        TEXT    NOT NULL DEFAULT '',
  traffic_limit INTEGER NOT NULL DEFAULT 0,
  traffic_mode  TEXT    NOT NULL DEFAULT 'sum',
  traffic_reset_day INTEGER NOT NULL DEFAULT 1,
  hostname TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '',
  kernel   TEXT NOT NULL DEFAULT '', arch TEXT NOT NULL DEFAULT '',
  virt     TEXT NOT NULL DEFAULT '', cpu_name TEXT NOT NULL DEFAULT '',
  cpu_cores INTEGER NOT NULL DEFAULT 0, mem_total INTEGER NOT NULL DEFAULT 0,
  swap_total INTEGER NOT NULL DEFAULT 0, disk_total INTEGER NOT NULL DEFAULT 0,
  agent_version TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
  ipv4 TEXT NOT NULL DEFAULT '', ipv6 TEXT NOT NULL DEFAULT '',
  -- ISO 3166-1 alpha-2, looked up from `ip` once per address. Empty until the
  -- lookup answers, and empty is what a node whose country nobody could tell
  -- stays: the public page just leaves the badge off.
  country TEXT NOT NULL DEFAULT '',
  -- Survives the disconnection it describes, unlike the in-memory live entry:
  -- an offline node's page is exactly where "since when" is worth reading.
  last_seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Monotonic byte counters that survive both agent reboots and hub restarts.
CREATE TABLE IF NOT EXISTS traffic (
  node_id  INTEGER PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
  boot_id  TEXT    NOT NULL DEFAULT '',
  last_rx  INTEGER NOT NULL DEFAULT 0,
  last_tx  INTEGER NOT NULL DEFAULT 0,
  total_rx INTEGER NOT NULL DEFAULT 0,
  total_tx INTEGER NOT NULL DEFAULT 0,
  month_rx INTEGER NOT NULL DEFAULT 0,
  month_tx INTEGER NOT NULL DEFAULT 0,
  month_start TEXT NOT NULL DEFAULT '',
  day_rx INTEGER NOT NULL DEFAULT 0,
  day_tx INTEGER NOT NULL DEFAULT 0,
  day_start TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS metric (
  node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  cpu REAL NOT NULL,
  mem_used INTEGER NOT NULL, swap_used INTEGER NOT NULL, disk_used INTEGER NOT NULL,
  net_rx INTEGER NOT NULL, net_tx INTEGER NOT NULL,
  tcp INTEGER NOT NULL, udp INTEGER NOT NULL, procs INTEGER NOT NULL,
  PRIMARY KEY (node_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ping_task (
  id       INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL,
  target   TEXT    NOT NULL,
  interval INTEGER NOT NULL DEFAULT 60
);

CREATE TABLE IF NOT EXISTS ping_node (
  task_id INTEGER NOT NULL REFERENCES ping_task(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, node_id)
);

-- Key order follows the only query there is: one node, one time window,
-- every probe. With task_id ahead of ts SQLite can seek to the node and no
-- further, then scans every record it ever kept -- see the migration in open().
CREATE TABLE IF NOT EXISTS ping_record (
  node_id INTEGER NOT NULL, task_id INTEGER NOT NULL,
  ts INTEGER NOT NULL, latency INTEGER NOT NULL,
  PRIMARY KEY (node_id, ts, task_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT    PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
