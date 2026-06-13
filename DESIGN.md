# X Bridge — design

A shared Twitter/X cache + API gateway for a fleet of bots, fronted by per-bot
MCPL drivers. This document is the durable record of the architecture and the
decisions behind it.

## Goal

Let many bots read and post to X without each one hammering (and paying for) the
X API. One long-lived **bridge daemon** owns the cache, the credentials, the
rate-limit/cost budget, and the polling. Each bot gets a thin **`x-mcpl`**
frontend that talks to the bridge.

```
  bot A ─┐                              ┌─ X API v2 (read: app bearer)
  bot B ─┤  each via its own x-mcpl     │   (write/DM: per-account OAuth user ctx)
  bot C ─┘  frontend (TS, stateful) ──► BRIDGE DAEMON ─┤
                ▲    SSE push           │  - owns x-cache.db  (single writer)
                └───────────────────────┤  - owns account write-credentials
                                        │  - cost + rate-limit ledger
                                        └─ centralized per-resource polling
```

## Decisions (2026-06-13)

1. **Standalone bridge daemon**, not a library embedded per-MCPL. One writer,
   shared cache, shared budget, dedupe across bots. (The 100–200 concurrent
   "users" are almost all reads served from cache.)
2. **Python bridge + TypeScript frontends.** The X API client and ingest logic
   already exist and work in Python (`~/archivist/scripts/twitter_backfill.py`);
   the bridge reuses them. `x-mcpl` mirrors `discord-mcpl` and talks to the
   bridge over a thin HTTP/JSON + SSE contract.
3. **SQLite (WAL), reusing the `archive.db` schema.** Millions of rows + a
   single writer is squarely in SQLite's comfort zone, FTS5 search is already
   built, and the 27k-tweet seed corpus drops straight in. All data access goes
   through a repository layer (`bridge/db.py`) so a Postgres swap later is
   contained.
4. **The bridge is user-agnostic.** MCPL is persistent — the *host* owns state.
   Read/unread cursors, subscriptions, and notification high-water marks live in
   host-persisted MCPL feature-set state (`hostState: true`), NOT in the bridge.
   The only user-ish thing the bridge holds is **write credentials per account**,
   needed solely for posting and DMs. The bridge polls per *resource*, never per
   *user*; each host dedupes the stream against its own persisted cursor.

## Cache semantics

Three freshness tiers:

| Tier            | Examples                              | Policy                          |
|-----------------|---------------------------------------|---------------------------------|
| Immutable       | tweet body, author_id, created_at     | cache forever                   |
| Mutable metrics | like / RT / reply counts              | TTL (`METRICS_TTL`), refetch    |
| Collections     | timelines, threads, search results    | membership + cursor, TTL        |

Two money-savers:
- **Negative cache** — remember 404 / deleted / protected so we don't re-pay to
  rediscover absence (`negative_cache` table, with its own TTL).
- **Cost ledger** — every API call's per-resource spend is tallied against the
  v2 price table (post $0.005 / user $0.010 / media $0.005) into
  `api_cost_ledger`. Lifted from `backfill.py`.

**Money safety:** the bridge serves from cache by default. It only spends on the
X API when a request explicitly asks (`?fresh=1` / cache miss) **and**
`X_BRIDGE_ALLOW_FETCH=1` is set **and** a bearer is configured. Otherwise a miss
returns `404 {"cached": false}` and costs nothing.

## Schema (additive over the archive.db shape)

Existing tables kept as-is: `tweets`, `media`, `tweet_urls`, `tweets_fts`,
`media_fts`. Added by `schema.sql`:

- `accounts(account_id PK, handle, read_bearer?, oauth_token?, oauth_secret?, …)`
  — first-class now; only one row wired initially. Note: posting/DMs need
  **user-context OAuth**, a *different* credential from the app-only read bearer.
  That's the real reason multi-account is more than "more tokens."
- `resource_freshness(resource_key PK, kind, last_fetched, cursor, expires_at)`
  — TTL + pagination state for collections.
- `negative_cache(resource_key PK, reason, seen_at, expires_at)`.
- `api_cost_ledger(id PK, ts, endpoint, kind, posts, users, media, cost_usd,
  rate_limit, rate_remaining, rate_reset)`.

## HTTP contract (bridge)

```
GET  /health
GET  /tweet/:id                       cached tweet (+?fresh=1 to force refetch)
GET  /thread/:conversation_id         thread membership + freshness
GET  /user/:handle                    profile (derived from cache until API-backed)
GET  /timeline/:handle_or_id?limit=   author timeline, newest first
GET  /search?q=&limit=                FTS5 over cached tweets
GET  /budget                          cost ledger summary
POST /tweet   {account_id, text, reply_to?, quote?}   (Phase 4)
DEL  /tweet/:id  {account_id}                          (Phase 4)
GET  /stream/:resource  (SSE)         poll fan-out of new items   (Phase 3)
```

## MCPL mapping (`x-mcpl`, mirrors `discord-mcpl`)

- **Feature sets:** `x.read`, `x.post` (rollback=true — posted tweet recorded for
  checkpoint undo, like discord `send_message`), `x.notifications`
  (`hostState: true`), `x.dm` (declared, wired later).
- **Channels:** a user timeline / a search query / a conversation thread / the
  mentions stream — each subscribable; bridge polls → SSE fan-out → host pushes.
- **Tools:** `lookup_tweet`, `get_thread`, `get_user`, `user_timeline`, `search`,
  `post_tweet`, `reply`, `quote`, `delete_tweet`, (later) `send_dm`.

## Phased build

1. **Bridge read path** ← *this scaffold*. HTTP read endpoints over a copy of
   `archive.db`; freshness / negative-cache / cost-ledger tables; budget endpoint.
   Testable with curl against the 27k seeded tweets, no spend.
2. **x-mcpl read frontend** — clone discord-mcpl, swap adapter to the bridge HTTP
   client, wire `x.read` tools + channels.
3. **Polling + SSE notifications** — per-resource adaptive poller → SSE;
   `x.notifications` channels with host-side cursors.
4. **Posting** — `accounts` write-creds, OAuth user-context, `x.post` + rollback.
5. **DMs / multi-account** — flip on the already-declared surfaces.

Cache syndication (multi-host replication) stays a later concern; the repository
layer keeps the SQLite→Postgres door open if it comes to that.

## Provenance

- Seed corpus + cache schema: `~/archivist/archive.db` (tweets/media/tweet_urls + FTS5).
- X API v2 client, ingest, cost table: `~/archivist/scripts/twitter_backfill.py`.
- Driver template: `~/connectome-local/discord-mcpl`.
