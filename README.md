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
| `server.ts` — `McplConnection` orchestrator (mirror discord-mcpl) | ⏳ next |
| `channels.ts` — timeline/search/thread/mentions channels | ⏳ Phase 3 |
| `index.ts` — CLI entry (stdio/tcp) | ⏳ next |

## Test

```bash
# with the bridge running at http://127.0.0.1:8810
cd ../x-bridge && python3 -m bridge --port 8810 &
cd ../x-mcpl && npm install && npm test    # 7/7; live tests skip if bridge is down
```

`X_BRIDGE_URL` overrides the bridge location for the tests.

## Next (Phase 2 finish + Phase 3)

1. `server.ts` + `index.ts` — wire `handleToolCall` into an `McplConnection`
   request loop (initialize handshake, `tools/list`, `tools/call`, feature-set
   gating via `featureSetForTool` + `isEnabled`). Mirror `discord-mcpl/src/server.ts`.
2. `channels.ts` — map timeline/search/thread/mentions onto MCPL channels.
3. Bridge-side poller + SSE so notification channels push (Phase 3).
