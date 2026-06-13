# x-bridge

Shared Twitter/X cache + API gateway for a fleet of MCPL bots. See
[`DESIGN.md`](./DESIGN.md) for the architecture and decisions.

**Phase 1 (this scaffold):** read path over a seeded copy of `archive.db`.
Cache-first, money-safe (no API spend unless explicitly enabled).

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

## Endpoints (Phase 1)

| Route | Notes |
|-------|-------|
| `GET /health` | counts, db path, fetch/bearer status |
| `GET /tweet/:id` | `?fresh=1` forces a refetch (needs fetch enabled) |
| `GET /thread/:conversation_id` | all cached tweets in a conversation |
| `GET /user/:handle` | profile derived from cached tweets |
| `GET /timeline/:handle_or_id` | `?limit=` `?before=ISO` |
| `GET /search?q=` | FTS5 over cached tweets |
| `GET /budget` | cost ledger summary |

## Money safety

Cache-first by default. Live X API fetch happens only when
`X_BRIDGE_ALLOW_FETCH=1` **and** a bearer (`X_BRIDGE_BEARER` / `BEARER`) is set.
Otherwise a cache miss returns `404 {"cached": false}` and costs nothing.

## Config (env)

`X_BRIDGE_DB`, `X_BRIDGE_SEED_DB`, `X_BRIDGE_HOST`, `X_BRIDGE_PORT`,
`X_BRIDGE_ALLOW_FETCH`, `X_BRIDGE_BEARER`, `X_BRIDGE_METRICS_TTL`,
`X_BRIDGE_COLLECTION_TTL`, `X_BRIDGE_NEGATIVE_TTL`.
