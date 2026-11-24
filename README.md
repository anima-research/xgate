# xgate

A shared Twitter/X cache + API gateway for a fleet of bots, with per-bot MCPL
drivers. One long-lived daemon owns the cache, the X credentials, the cost
budget, polling, and image transcription; each bot connects through a thin MCPL
frontend.

## Components

- **[`bridge/`](./bridge)** — the gateway daemon (Python, stdlib-only). Owns the
  SQLite cache (`archive.db` shape, seeded), the X API v2 client, the cost
  ledger, the per-resource poller + SSE, and on-demand image transcription.
  Full architecture and decisions in [`bridge/DESIGN.md`](./bridge/DESIGN.md).
- **[`mcpl/`](./mcpl)** — the MCPL frontend (TypeScript). One service for
  every agent over WebSocket, each known by its Archipelago identity, or one
  process per agent over stdio. Talks to the bridge over HTTP; renders tweets
  and threads as text an agent can follow (a thread is a tree, with its gaps
  said), shows images as pictures, keeps each agent's **feed** (`x.feed`) and
  sends new tweets of the sources an agent set to notify as push events
  (`x.events`). See [`mcpl/README.md`](./mcpl/README.md).

```
  agent ──► mcpl frontend (feeds, events) ──HTTP──► bridge ──► X API v2
                                                      │         (read: app bearer)
                                                      └─ SQLite cache + media + cost ledger
```

## Status

- ✅ Read path, live read-through, three-tier freshness, negative cache, cost ledger
- ✅ Threads found from any of their tweets, over reply links as well as X's
  conversation id (which archive-imported rows lack)
- ✅ Preview endpoints (`/thread/:id/preview`, `/timeline/:who/preview`) — counts,
  participants, span, image counts without bodies
- ✅ Per-agent feed (`x.feed`), kept by the frontend, survives restarts
- ✅ New tweets of followed timelines as push events (`x.events`)
- ✅ Image handling: alt-text, byte caching, `media_fts` search, bounded-parallel
  Haiku transcription, `get_image` (the picture itself) / `transcribe_image`
- ✅ Archipelago login over WebSocket; toolsets (SPEC §21) for the feed's sources
- The bridge's per-resource poller and `/stream` (SSE) are still there; the
  frontend no longer uses them
- ⏳ Posting & DMs — not wired (need user-context OAuth write credentials)

## Deployment

The bridge runs on **borgs.animalabs.ai** as a systemd **user** service
(`~/.config/systemd/user/x-bridge.service`, linger enabled, `Restart=always`),
listening on `127.0.0.1:8810`. Zero runtime dependencies — bare `python3`, no
venv/pip needed (transcription calls the Anthropic API over stdlib `urllib`).

```bash
# on borgs
systemctl --user status x-bridge        # service state
systemctl --user restart x-bridge        # after a code update
curl -s localhost:8810/health            # liveness + counts
journalctl --user -u x-bridge -n 50      # logs
```

## Credentials

Held in `bridge/.env` (gitignored, never committed):

- `X_BRIDGE_BEARER` — X API v2 app-only bearer (read).
- `X_BRIDGE_ALLOW_FETCH=1` — enables live fetch/spend (cache-first otherwise).
- `ANTHROPIC_API_KEY` — enables image transcription (Haiku 4.5). Absent it,
  reads still work and transcription endpoints return 503.

Write credentials (posting/DMs) are not configured — those features stay declared
but unwired until user-context OAuth is added (`accounts` table is shaped for it).
