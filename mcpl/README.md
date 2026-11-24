# x-mcpl

Reading X/Twitter for agents, through the xgate bridge: an MCPL 0.5 server (and a plain MCP one). The bridge holds the cache, the X credentials and the budget; this server turns its answers into text an agent can follow, and keeps each agent's feed.

## What an agent gets

**Reading** (feature set `x.read`)

| Tool | What it answers |
|---|---|
| `lookup_tweet` | one tweet, with what it answers and how much of its thread is cached |
| `get_thread` | the thread around any tweet, as a tree |
| `peek_thread`, `peek_timeline` | sizes without the tweets |
| `user_timeline` | an account's tweets, newest first, or a stretch of time |
| `search_tweets` | full-text search of the cache with filters, best match or newest first; `fresh: true` has X searched first |
| `get_user` | a profile |
| `get_image` | an image itself, as a picture |
| `transcribe_image` | an image described in words |

Every tweet shows its id, because every tool takes one, and a tweet's address on x.com works wherever an id does:

```
[2] @bob ↳ @alice, tweet 100 · 2026-03-01 10:05Z · ♥3 · id 200
    the tweet's text
    [image 3_77] what the image shows
    links tweet 555 by @carol
```

A thread is a tree. A tweet answers the one directly above it unless `↳` names another; a tweet with several answers indents each of them; the tweet asked for is marked `▶`:

```
thread of 6 cached tweets · @ada(2) @bea(2) @cy(1) @late(1) · 2026-03-01
Each tweet answers the one directly above it, unless ↳ names another.
1 of these answers a tweet that is not cached, so the thread has gaps.

[1] @ada · 2026-03-01 10:00Z · id 101
[2] @bea · 2026-03-01 10:01Z · id 102
  [3] @cy · 2026-03-01 10:02Z · id 103
  ▶[4] @bea · 2026-03-01 10:03Z · id 104
  [5] @ada ↳[2] · 2026-03-01 10:04Z · id 105
[6] @late ↳ tweet 999, not cached · 2026-03-01 10:05Z · id 106
```

The cache rarely holds a whole conversation, and the thread says where it has gaps instead of reading as complete.

**The feed** (feature set `x.feed`)

An agent follows sources: an account's timeline, a search, the mentions of a handle. `feed_show` lists them with what is unread in each; `feed_read` shows the unread tweets and marks them read. Each source is `notify`, `quiet` or `muted`.

The three tools that change the list (`feed_add`, `feed_remove`, `feed_set`) are the toolset `sources` (SPEC §21). A host that knows toolsets keeps them out of the agent's standing tool list until the agent opens it; any other host lists them with the rest.

The feed is kept by this server, one file per agent in `state/`, so it is there after a restart of either side.

**Events** (feature set `x.events`)

A session looks at its agent's `notify` sources every five minutes. What is unread there is sent as one push event per source (tags `x:new-tweets`, `x:from:<handle>`, `x:has-media`) and marked read once the host takes it, so the feed and the events never tell the same tweet twice. The first look comes ten seconds after the host is ready and covers what was posted while the agent was away.

A timeline is kept current from X: the bridge refreshes it from the newest tweet it has, at most every fifteen minutes, so a check costs what was newly posted and a tweet arrives within about twenty minutes of being posted. A search or mentions source is read from the cache alone and notifies of what reaches the cache.

## What costs money

The bridge pays X per tweet, author and image it fetches. This server asks for a fetch only where the tool text says so:

| What | When X is asked | Roughly |
|---|---|---|
| `lookup_tweet` | the tweet is not cached, or `fresh: true` | a cent or two |
| `user_timeline`, a timeline source of a feed | the cached timeline is over fifteen minutes old | per new tweet |
| `get_user` | no profile is stored | a cent |
| `get_thread` with `fresh: true` | always | up to a hundred tweets |
| `search_tweets` with `fresh: true` | always | about a dollar |

Everything else is answered by the cache. A plain `search_tweets`, and a feed's search and mentions sources, never have X searched: a recent search returns up to a hundred tweets and is paid for in full every time it runs.

A host that leaves `x.events` off gets no events; `feed_set` says so when an agent asks for `notify`.

## Run

Node 20 or later.

```sh
npm ci && npm run build
node dist/src/index.js check                       # the bridge, and who would be served
node dist/src/index.js --stdio --client <name>     # one local agent, whose feed is kept under <name>
node dist/src/index.js --ws 7480                   # several agents, at ws://127.0.0.1:7480/mcpl
npm test
```

Home is `$XGATE_MCPL_HOME`, by default `~/.config/xgate-mcpl`:

| File | What |
|---|---|
| `config.json` | who is served over WebSocket (below), and `bridge.url` |
| `bridge_token` | this server's token for the bridge, one line, mode 600. `X_BRIDGE_TOKEN` in the environment wins over it |
| `state/feed-<agent>.json` | each agent's feed |
| `server.log` | when run from the launchd file in `deploy/` |

The bridge's address is `X_BRIDGE_URL`, else `bridge.url` in `config.json`, else `https://xgate.animalabs.ai`.

### Who gets in: Archipelago identity

Over WebSocket no token of the bridge's is handed to anyone. An agent's host asks the home node (`id.animalabs.ai`) for a short-lived `aid1` token for the audience `xgate` at each dial and sends it with the connection. The server verifies it offline against the home node's public key, and closes the session when the token ends; the host then dials again with a fresh one.

An agent with `mcplAdmin` and `identity` on adds the server itself, naming the access and nothing else:

```json
{ "id": "xgate", "url": "wss://<host>/mcpl", "access": "xgate" }
```

Two places decide who gets in, and a new agent needs both:

1. **The home node** gives a token for `xgate` only to a principal whose `audiences` include it, and the audience has to be declared there first.
2. **This server** answers only the subjects in `config.json`, and needs a restart to read a change:

   ```json
   { "auth": { "subjects": ["agent:<name>@id.animalabs.ai", "agent:*@<another home>"] } }
   ```

   With no subjects set the server refuses to start; `"*"` serves everyone the home node gives a token to.

Over stdio there is no identity: the agent is whoever started the process, and `--client <name>` is required, because the feed is kept under that name.

```json
"xgate": { "command": "node", "args": ["/path/to/xgate/mcpl/dist/src/index.js", "--stdio", "--client", "<name>"],
           "env": { "X_BRIDGE_URL": "https://xgate.animalabs.ai", "X_BRIDGE_TOKEN": "…" } }
```

Either way the bridge sees one token, this server's, and counts all of its agents' spending under it.

### As a service on a Mac

`deploy/xgate-mcpl.plist` is a launchd job that runs the WebSocket server on 127.0.0.1:7480; put the paths of your checkout, node and home into it. `tailscale serve` puts TLS in front of it for a tailnet:

```sh
cp deploy/xgate-mcpl.plist ~/Library/LaunchAgents/ai.animalabs.xgate-mcpl.plist   # after editing its paths
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.animalabs.xgate-mcpl.plist
tailscale serve --bg --https=8873 http://127.0.0.1:7480
curl -s https://<host>:8873/health
```

After a rebuild or a change to `config.json`: `launchctl kickstart -k gui/$(id -u)/ai.animalabs.xgate-mcpl`. Connected hosts dial again on their own.

## What it needs of the bridge

A bridge with `/thread/:id` taking any tweet of a thread, `/search?order=recent` and `/search?cached=1` (all in this repository's `bridge/`). Against an older bridge the server still runs, with three differences: threads are found by X's conversation id alone, which about half the cache lacks; search sources of a feed are read best match first, which makes their unread counts unreliable; and every plain search has X searched, which is paid for.
