-- Additive schema for x-bridge, applied on top of the archive.db shape
-- (tweets, media, tweet_urls, tweets_fts, media_fts already exist in the seed).
-- Safe to run repeatedly: every statement is IF NOT EXISTS.

PRAGMA journal_mode = WAL;

-- Write credentials per account. Only one row wired initially; posting/DMs
-- (Phase 4/5) need user-context OAuth, distinct from the app-only read bearer.
CREATE TABLE IF NOT EXISTS accounts (
    account_id    TEXT PRIMARY KEY,   -- X numeric user id
    handle        TEXT,               -- @handle (no @)
    read_bearer   TEXT,               -- optional per-account app bearer
    oauth_token   TEXT,               -- user-context token (posting/DM)
    oauth_secret  TEXT,
    scopes        TEXT,
    created_at    TEXT,
    updated_at    TEXT
);

-- TTL + pagination cursor for collection resources (timeline/thread/search).
-- resource_key e.g. "timeline:123", "thread:456", "search:from:foo".
CREATE TABLE IF NOT EXISTS resource_freshness (
    resource_key  TEXT PRIMARY KEY,
    kind          TEXT,               -- timeline | thread | search | tweet | user
    last_fetched  TEXT,
    cursor        TEXT,               -- next_token / pagination cursor
    expires_at    TEXT
);

-- Remember absences so we don't re-pay to rediscover them.
CREATE TABLE IF NOT EXISTS negative_cache (
    resource_key  TEXT PRIMARY KEY,
    reason        TEXT,               -- deleted | protected | notfound | suspended
    seen_at       TEXT,
    expires_at    TEXT
);

-- Per-call spend, tallied against the v2 price table.
CREATE TABLE IF NOT EXISTS api_cost_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT,
    endpoint        TEXT,
    kind            TEXT,
    status          INTEGER,
    posts           INTEGER DEFAULT 0,
    users           INTEGER DEFAULT 0,
    media           INTEGER DEFAULT 0,
    cost_usd        REAL DEFAULT 0,
    rate_limit      INTEGER,
    rate_remaining  INTEGER,
    rate_reset      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ledger_ts ON api_cost_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_negcache_expires ON negative_cache(expires_at);
