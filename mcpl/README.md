# x-mcpl

Per-bot MCPL frontend for X/Twitter. A thin, stateful driver that talks to the
[`x-bridge`](../x-bridge) daemon over its HTTP contract. Mirrors the structure of
[`discord-mcpl`](../discord-mcpl).

The bridge owns the cache, the token, the cost budget, and the poller. This
package translates MCPL tool calls / channels into bridge requests, and renders
results as compact, readable text (pass `format:"full"` on a read tool for the
raw JSON object).

For long-lived agents it also exposes a **persistent curated feed** (`x.feed`):
add/remove sources (timelines, searches, mentions), see per-source unread counts,
and pull durable, cursor-tracked catch-up. `feed_add` primes a source (fetches its
recent tweets, cache-first) so the feed isn't empty and reports how many are
available; `feed_read` defaults to unread catch-up (advances cursors) but takes
`unread_only:false` to browse the latest regardless of read state without touching
cursors. The feed's state is host-persisted and
survives restarts via the MCPL host-managed-state mechanism — the host injects the
current state into every `tools/call` as `params.state` and persists the `state`
checkpoint a feed tool returns (agent-framework's `CheckpointManager` → Chronicle).
Because the host injects/records state for a single feature set per server, `x.feed`
is the only set that returns state data; the bridge stays deliberately user-agnostic.
(The non-spec `hostState` declaration field is gone as of MCPL 0.5 — the
host-managed/server-managed split is signalled per response by whether the state
block carries `data`/`patch`, SPEC §8.3.)

To preview before you pay to open: `peek_thread` / `peek_timeline` return size,
participants, time span and image counts without fetching bodies.

## Status

| Piece | State |
|-------|-------|
| `bridge-client.ts` — typed HTTP client over the bridge (+ preview wrappers) | ✅ done, live-tested |
| `feature-sets.ts` — `x.read` / `x.feed` / `x.notifications` / `x.post` / `x.dm` | ✅ declared |
| `tools.ts` — `x.read` + `peek_*` + `x.feed` tool schemas | ✅ done |
| `render.ts` — compact tweet/list/preview rendering | ✅ done, unit-tested |
| `feed.ts` — pure feed reducer + renderer (host-state backed) | ✅ done, unit-tested |
| `handlers.ts` — tool dispatch → bridge (read, peek, feed) | ✅ done, live-tested |
| `server.ts` — `McplConnection` orchestrator; threads host state through tools | ✅ done |
| `channels.ts` — timeline/search/thread/mentions channels | ✅ done |
| `sse.ts` — bridge SSE subscription → `channels/incoming` | ✅ done, live e2e |
| `index.ts` — CLI entry (stdio/tcp) | ✅ done |
| `x.post` / `x.dm` tool handlers | ⏳ needs write credentials |

## Test

```bash
# with the bridge running at http://127.0.0.1:8810 (allow_fetch=1 for live e2e)
cd ../x-bridge && python3 -m bridge --port 8810 &
cd ../x-mcpl && npm install && npm test    # 13/13; live tests skip if bridge is down
```

`X_BRIDGE_URL` overrides the bridge location for the tests.

## Run it

```bash
X_BRIDGE_URL=http://127.0.0.1:8810 X_BACKFILL=20 npm run start -- --tcp 9100
```

Opening an `x.timeline` / `x.search` / `x.thread` channel subscribes to the
bridge's SSE stream; new tweets arrive live as `channels/incoming` Requests
(SPEC §14.3 — the host answers with per-message `results`) (ambient
awareness, no cursor). For durable, cursor-tracked catch-up that won't resurface
what you've read, use the `x.feed` tools (`feed_add`, `feed_show`, `feed_read`)
instead — those persist host-side.

## Not wired: posting & DMs

`x.post` and `x.dm` are declared feature sets with tool schemas, but their
handlers are intentionally absent: the app-only read bearer cannot post or DM,
and no user-context OAuth credential is available. Wiring them is a credentials
task, not a code-architecture one — `accounts` (bridge) and the feature sets are
already shaped for it.
