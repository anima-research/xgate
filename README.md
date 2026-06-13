# x-mcpl

Per-bot MCPL frontend for X/Twitter. A thin, stateful driver that talks to the
[`x-bridge`](../x-bridge) daemon over its HTTP contract. Mirrors the structure of
[`discord-mcpl`](../discord-mcpl).

The bridge owns the cache, the token, the cost budget, and the poller. This
package translates MCPL tool calls / channels into bridge requests. Read/unread
and notification cursors live in host-persisted MCPL state (`hostState: true`),
because the bridge is deliberately user-agnostic.

## Status

| Piece | State |
|-------|-------|
| `bridge-client.ts` — typed HTTP client over the bridge | ✅ done, live-tested |
| `feature-sets.ts` — `x.read` / `x.post` / `x.notifications` / `x.dm` | ✅ declared |
| `tools.ts` — `x.read` tool schemas | ✅ done |
| `handlers.ts` — tool dispatch → bridge | ✅ done (read tools), live-tested |
| `server.ts` — `McplConnection` orchestrator (mirror discord-mcpl) | ✅ done |
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
bridge's SSE stream; new tweets arrive as `channels/incoming`. Read/unread
cursors are the host's to persist (the bridge stays user-agnostic).

## Not wired: posting & DMs

`x.post` and `x.dm` are declared feature sets with tool schemas, but their
handlers are intentionally absent: the app-only read bearer cannot post or DM,
and no user-context OAuth credential is available. Wiring them is a credentials
task, not a code-architecture one — `accounts` (bridge) and the feature sets are
already shaped for it.
