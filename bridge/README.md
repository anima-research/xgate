# x-bridge

Shared Twitter/X cache + API gateway for a fleet of MCPL bots. See
[`DESIGN.md`](./DESIGN.md) for the architecture and decisions.

**Status:** read path + live read-through + per-resource poller with SSE
notifications (Phases 1–3) complete and live-tested. Cache-first and money-safe:
no API spend unless `X_BRIDGE_ALLOW_FETCH=1` and a bearer are set, and then only
on cache misses / stale collections.

## Quick start

```bash
# 1. Seed the cache from the archivist corpus + apply the additive schema
python3 scripts/init_cache_db.py

# 2. Run the bridge (stdlib only, no deps)
python3 -m bridge --port 8810

# 3. Hit it
curl -s localhost:8810/health | python3 -m json.tool
curl -s 'localhost:8810/timeline/repligate?limit=3' | python3 -m json.tool
curl -s 'localhost:8810/search?q=consciousness&limit=3' | python3 -m json.tool
curl -s localhost:8810/budget | python3 -m json.tool
```

## Endpoints

| Route | Notes |
|-------|-------|
| `GET /health` | counts, db path, fetch/bearer status, active streams |
| `GET /tweet/:id` | `?fresh=1` forces a live refetch (needs fetch enabled) |
| `GET /thread/:conversation_id` | cached thread; `?fresh=1` polls via recent search |
| `GET /thread/:conversation_id/preview` | size, participants, span, image count, root author — **no bodies** |
| `GET /user/:handle` | API-backed profile (`users` table); `?fresh=1` to refetch |
| `GET /timeline/:handle_or_id` | live read-through when stale; `?limit=` `?fresh=1` |
| `GET /timeline/:handle_or_id/preview` | cached count, span, last-tweet time, image count — **no bodies** |
| `GET /search?q=` | FTS5 over cache; live read-through when stale; `?fresh=1` |
| `GET /stream/:resource` | **SSE** of new tweets for a resource (`timeline:<id>`, `search:<q>`, `thread:<cid>`). `?poll=1` polls-if-stale on connect |
| `GET /media/:id` | original image bytes (lazy-downloaded from the X CDN, cached) |
| `GET /media/:id/transcription` | on-demand Haiku transcription (`?fresh=1` to redo); 503 if no Anthropic key |
| `GET /budget` | cost ledger summary |

`/tweet`, `/thread`, `/timeline`, `/search` accept `?transcribe=1` to transcribe
every image in the result set in one bounded-parallel batch before returning.
`/search` also matches image transcriptions (`media_fts`).

Resource keys for `/stream`: `timeline:<handleOrId>`, `search:<query>`,
`thread:<conversationId>`. A background poller refreshes each subscribed
resource every `X_BRIDGE_POLL_INTERVAL` seconds (default 60) and fans new tweets
to all subscribers.

## Tests

```bash
python3 tests/test_read.py            # repo read layer (no spend)
python3 tests/test_poller.py          # poller pub/sub fan-out (no spend)
python3 tests/test_refresh_concurrency.py  # per-resource lock (no spend)
```

## Money safety

Cache-first by default. Live X API fetch happens only when
`X_BRIDGE_ALLOW_FETCH=1` **and** a bearer (`X_BRIDGE_BEARER` / `BEARER`) is set.
Otherwise a cache miss returns `404 {"cached": false}` and costs nothing.

## Config (env)

`X_BRIDGE_DB`, `X_BRIDGE_SEED_DB`, `X_BRIDGE_HOST`, `X_BRIDGE_PORT`,
`X_BRIDGE_ALLOW_FETCH`, `X_BRIDGE_BEARER`, `X_BRIDGE_METRICS_TTL`,
`X_BRIDGE_COLLECTION_TTL`, `X_BRIDGE_NEGATIVE_TTL`, `X_BRIDGE_POLL_INTERVAL`,
`X_BRIDGE_MEDIA_DIR`, `X_BRIDGE_TRANSCRIBE_MODEL`, `X_BRIDGE_TRANSCRIBE_PARALLEL`,
`ANTHROPIC_API_KEY` (enables transcription). A `.env` file beside the repo is
auto-loaded (gitignored).
