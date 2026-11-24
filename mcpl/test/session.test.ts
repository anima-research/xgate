import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { McplConnection } from '@animalabs/mcpl-core';
import { WebSocket } from 'ws';
import { mintAid1 } from '../src/auth.js';
import { BridgeClient } from '../src/bridge-client.js';
import { DEFAULT_AUTH, type AuthConfig } from '../src/config.js';
import { FeedStore } from '../src/feed.js';
import { admit, serveWs } from '../src/index.js';
import { Session, type App } from '../src/session.js';
import { PNG, image, stubBridge, tweet, type StubBridge } from './stub-bridge.js';

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError?: boolean; content: Block[] };
type Listed = { name: string; annotations: { readOnlyHint: boolean }; _meta: Record<string, unknown> };
type Event = { featureSet: string; eventId: string; tags: string[]; payload: { content: Array<{ text: string }> } };

const MCPL = { experimental: { mcpl: { version: '0.5' } } };
const HINTED = { experimental: { mcpl: { version: '0.5', toolHints: true } } };
const ALL = { effectiveCapabilities: ['tools', 'pushEvents'] };
const SOURCE_TOOLS = ['feed_add', 'feed_remove', 'feed_set'];

const at = (day: number, min = 0) => `2026-03-${String(day).padStart(2, '0')}T10:${String(min).padStart(2, '0')}:00.000Z`;

/** A thread whose tweets carry no conversation id, as archive imports do; one, fetched from X later, answers a tweet that is not there. */
const corpus = () => [
  tweet('101', 'ada', 'a first tweet about gardens', at(1, 0)),
  tweet('102', 'bea', 'there is another side to it', at(1, 1), { reply_to_tweet_id: '101', reply_to_username: 'ada' }),
  tweet('103', 'cy', 'do you have any examples?', at(1, 2), { reply_to_tweet_id: '102', reply_to_username: 'bea' }),
  tweet('104', 'bea', 'here is one', at(1, 3), { reply_to_tweet_id: '103', reply_to_username: 'cy', media: [image('3_900', 'a poem on a screen')] }),
  tweet('105', 'ada', 'fair', at(1, 4), { reply_to_tweet_id: '102', reply_to_username: 'bea' }),
  tweet('106', 'late', 'and what came of it?', at(1, 5), { reply_to_tweet_id: '999', conversation_id: '101' }),
  tweet('201', 'dov', 'an older tweet', at(2)),
  tweet('202', 'dov', 'hello @bea, about gardens', at(3)),
];

async function connect(o: { capabilities?: Record<string, unknown>; policy?: Record<string, unknown> | null; bridge?: StubBridge; dir?: string; client?: string; accept?: boolean } = {}) {
  const bridge = o.bridge ?? await stubBridge(corpus());
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'xgate-session-'));
  const logged: string[] = [];
  const app: App = { bridge: new BridgeClient({ baseUrl: bridge.url }), feeds: new FeedStore(dir), log: (...a) => logged.push(a.join(' ')), sourcesOpen: new Set(), checkEveryMs: 3_600_000 };
  const c2s = new PassThrough(); const s2c = new PassThrough();
  const session = new Session(McplConnection.fromStreams(c2s, s2c), app, o.client ?? 'one');
  void session.serve();
  const client = McplConnection.fromStreams(s2c, c2s);
  // The host's side: take the events the server sends.
  const events: Event[] = [];
  void (async () => {
    try {
      for (;;) {
        const m = await client.nextMessage();
        if (m.type === 'request' && m.request.method === 'push/event') { events.push(m.request.params as Event); client.sendResponse(m.request.id, { accepted: o.accept ?? true }); }
      }
    } catch { /* closed */ }
  })();
  const init = await client.sendRequest('initialize', { protocolVersion: '2024-11-05', capabilities: o.capabilities ?? MCPL, clientInfo: { name: 'test', version: '0' } }) as
    { capabilities: { experimental?: { mcpl: { pushEvents?: boolean; toolHints?: boolean; toolsets?: Record<string, { default: string }>; featureSets: Array<{ name: string; uses: string[] }> } } } };
  const policy = o.policy === undefined ? ALL : o.policy;
  const receipt = policy ? await client.sendRequest('featureSets/update', policy) as { mode: string; unavailableFeatures: Array<{ featureSet: string }> } : null;
  const call = (name: string, args?: unknown) => client.sendRequest('tools/call', { name, arguments: args }) as Promise<Result>;
  const say = async (name: string, args?: unknown) => { const r = await call(name, args); assert.equal(r.isError, undefined, r.content[0]?.text); return r.content[0]!.text!; };
  const rpc = (method: string, params: unknown = {}) => client.sendRequest(method, params) as Promise<Record<string, any>>;
  return { client, session, app, bridge, dir, init, receipt, call, say, rpc, events, logged, close: () => { c2s.end(); s2c.end(); bridge.close(); } };
}

test('a host is offered reading, the feed and events, and web tools', async () => {
  const s = await connect();
  const mcpl = s.init.capabilities.experimental!.mcpl;
  assert.deepEqual(mcpl.featureSets.map((f) => [f.name, f.uses]), [['x.read', ['tools']], ['x.feed', ['tools']], ['x.events', ['pushEvents']]]);
  assert.equal(mcpl.pushEvents, true);
  assert.equal(mcpl.toolsets, undefined, 'toolsets are declared only to a host that advertised toolHints');
  assert.equal(s.receipt!.mode, 'full');
  const { tools, _meta } = await s.rpc('tools/list') as { tools: Listed[]; _meta?: unknown };
  assert.deepEqual(tools.map((t) => t.name), ['lookup_tweet', 'get_thread', 'peek_thread', 'user_timeline', 'peek_timeline', 'get_user', 'search_tweets', 'get_image', 'transcribe_image', 'feed_show', 'feed_read', ...SOURCE_TOOLS]);
  for (const t of tools) assert.deepEqual(t._meta, { 'mcpl/class': ['web'] }, t.name);
  assert.deepEqual(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name), ['feed_read', ...SOURCE_TOOLS]);
  assert.equal(_meta, undefined);
  assert.doesNotMatch((tools.find((t) => t.name === 'feed_show') as unknown as { description: string }).description, /toolset/);
  // Without toolHints the toolset is implicitly open (§21.4.1).
  assert.match(await s.say('feed_add', { kind: 'timeline', value: '@dov' }), /^Added timeline:@dov \(quiet\)\. 2 tweets are there to read with feed_read\./);
  s.close();
});

test('a thread is shown from any of its tweets, as a tree, with its gap', async () => {
  const s = await connect();
  const text = await s.say('get_thread', { tweetId: 'https://x.com/bea/status/104' });
  assert.deepEqual(text.split('\n').filter((l) => !l.startsWith('    ')), [
    'thread of 6 cached tweets · @ada(2) @bea(2) @cy(1) @late(1) · 2026-03-01',
    'Each tweet answers the one directly above it, unless ↳ names another.',
    '1 of these answers a tweet that is not cached, so the thread has gaps.',
    '',
    '[1] @ada · 2026-03-01 10:00Z · id 101',
    '[2] @bea · 2026-03-01 10:01Z · id 102',
    '  [3] @cy · 2026-03-01 10:02Z · id 103',
    '  ▶[4] @bea · 2026-03-01 10:03Z · id 104',
    '  [5] @ada ↳[2] · 2026-03-01 10:04Z · id 105',
    '[6] @late ↳ tweet 999, not cached · 2026-03-01 10:05Z · id 106',
  ]);
  assert.match(text, /\n {6}\[image 3_900\] a poem on a screen\n/);
  // The same thread from its root, cut to two tweets.
  assert.match(await s.say('get_thread', { tweetId: '101', limit: 2 }), /^thread of 6 cached tweets.*\nShowing 2 of 6: /);
  assert.match(await s.say('peek_thread', { tweetId: '105' }), /^thread of 6 cached tweets · started by @ada · 1 image or video/);
  const none = await s.call('get_thread', { tweetId: '777' });
  assert.equal(none.isError, true);
  assert.match(none.content[0]!.text!, /nothing of a thread around tweet 777 is cached/);
  s.close();
});

test('one tweet comes with what it answers and how much of its thread there is', async () => {
  const s = await connect();
  assert.equal(await s.say('lookup_tweet', { tweetId: '102' }), [
    '@bea ↳ @ada, tweet 101 · 2026-03-01 10:01Z · id 102',
    '    there is another side to it',
    '',
    'It answers @ada (tweet 101): "a first tweet about gardens"',
    '2 replies to it are cached. Its thread has 6 cached tweets: get_thread shows it.',
  ].join('\n'));
  assert.match(await s.say('lookup_tweet', { tweetId: '106' }), /The tweet it answers \(999\) is not cached\./);
  assert.match(await s.say('lookup_tweet', { tweetId: '201' }), /Nothing else of its thread is cached\.$/);
  assert.equal((await s.call('lookup_tweet', { tweetId: 'not an id' })).isError, true);
  s.close();
});

test('an image comes as the picture itself', async () => {
  const s = await connect();
  for (const args of [{ tweetId: '104' }, { mediaId: '3_900' }]) {
    const r = await s.call('get_image', args);
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.content[0], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
    assert.match(r.content[1]!.text!, /^\[image 3_900\]/);
  }
  assert.equal(await s.say('transcribe_image', { mediaId: '3_900' }), 'a poem on a screen');
  assert.match((await s.call('get_image', { tweetId: '101' })).content[0]!.text!, /tweet 101 has no images/);
  assert.match((await s.call('get_image', { mediaId: 'nope' })).content[0]!.text!, /\[image nope\] is not available/);
  s.close();
});

test('a query the full-text index refuses is explained, not passed on raw', async () => {
  const s = await connect();
  const r = await s.call('search_tweets', { query: '@bea' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text!, /^search_tweets: the query is not valid full-text syntax \(fts5: syntax error near "@"\)\. Put a phrase, a handle or anything with punctuation in double quotes/);
  assert.match(await s.say('search_tweets', { query: '"@bea"', order: 'recent' }), /^search: "@bea" \(newest first\) · 1 tweet · /);
  assert.ok(s.bridge.requests.some((u) => u.startsWith('/search') && u.includes('order=recent')));
  s.close();
});

test('the feed is kept between sessions, per agent', async () => {
  const first = await connect();
  await first.say('feed_add', { kind: 'timeline', value: '@dov', label: 'janus' });
  await first.say('feed_add', { kind: 'mentions', value: '@bea' });
  assert.match(await first.say('feed_read', { limit: 1 }), /^── timeline:@dov "janus" · 1 unread ──\n\[1\] @dov · 2026-03-03 10:00Z · id 202\n[^]*── mentions:@bea · 1 unread ──/);
  first.close();
  // A new process, the same state directory.
  const again = await connect({ dir: first.dir });
  assert.equal(await again.say('feed_show'), [
    '2 sources in your feed:',
    'timeline:@dov "janus" · quiet · nothing unread · read to 2026-03-03 10:00Z',
    'mentions:@bea · quiet · nothing unread · read to 2026-03-03 10:00Z',
  ].join('\n'));
  again.bridge.tweets.push(tweet('203', 'dov', 'newer', at(4)));
  assert.match(await again.say('feed_read', { keep_unread: true }), /── timeline:@dov "janus" · 1 unread ──\n\[1\] @dov · 2026-03-04 10:00Z · id 203/);
  assert.match(await again.say('feed_show'), /timeline:@dov "janus" · quiet · 1 unread/);
  await again.say('feed_read');
  assert.equal(await again.say('feed_read'), 'Nothing unread in the 2 sources read.');
  assert.match(await again.say('feed_read', { latest: true, limit: 1, sources: ['@dov'] }), /· 1 latest ──\n\[1\] @dov · 2026-03-04/);
  again.close();
  const other = await connect({ dir: first.dir, client: 'two' });
  assert.equal(await other.say('feed_show'), 'Your feed has no sources yet.');
  other.close();
});

test('with toolHints, the tools that change the feed\'s sources are a toolset the host opens', async () => {
  const s = await connect({ capabilities: HINTED });
  const mcpl = s.init.capabilities.experimental!.mcpl;
  assert.equal(mcpl.toolHints, true);
  assert.equal(mcpl.toolsets!.sources!.default, 'closed');
  const listed = async () => await s.rpc('tools/list') as { tools: Listed[]; _meta: Record<string, unknown> };
  let l = await listed();
  assert.deepEqual(l._meta, { 'mcpl/rev': 0 });
  assert.deepEqual(l.tools.filter((t) => t._meta['mcpl/presence'] === 'dynamic').map((t) => [t.name, t._meta['mcpl/toolset'], t._meta['mcpl/visible']]), SOURCE_TOOLS.map((n) => [n, 'sources', false]));
  assert.ok(l.tools.filter((t) => !SOURCE_TOOLS.includes(t.name)).every((t) => t._meta['mcpl/presence'] === 'static'));
  assert.match((l.tools.find((t) => t.name === 'feed_show') as unknown as { description: string }).description, /feed_add, feed_remove, feed_set\) are in the toolset "sources"\.$/);
  assert.deepEqual(await s.rpc('toolsets/list'), { open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [] } } });

  const closed = await s.call('feed_add', { kind: 'timeline', value: '@dov' });
  assert.equal(closed.isError, true);
  assert.match(closed.content[0]!.text!, /feed_add belongs to the toolset "sources", which is not open/);
  assert.equal(await s.say('feed_show'), 'Your feed has no sources yet.', 'the static feed tools need no toolset');

  const opened = await s.rpc('toolsets/open', { toolset: 'sources' });
  assert.deepEqual(opened, {
    toolset: 'sources', title: 'Feed sources', content: [{ type: 'text', text: 'Your feed has no sources yet.' }],
    _meta: { 'mcpl/hints': { rev: 2, tools: SOURCE_TOOLS.map((name) => ({ name, visible: true })), toolsets: [{ toolset: 'sources', state: 'open', title: 'Feed sources' }] } },
  });
  await s.say('feed_add', { kind: 'timeline', value: '@dov' });
  const adopted = await s.rpc('toolsets/open', { toolset: 'sources' });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted._meta, undefined, 'adopting what is open changes nothing');
  assert.match(adopted.content[0].text, /^1 source in your feed:\ntimeline:@dov · quiet · not read yet$/);
  assert.deepEqual(await s.rpc('toolsets/list'), { open: [{ toolset: 'sources', title: 'Feed sources' }], _meta: { 'mcpl/hints': { rev: 3, tools: SOURCE_TOOLS.map((name) => ({ name, visible: true })) } } });
  l = await listed();
  assert.deepEqual([l._meta, l.tools.filter((t) => t._meta['mcpl/visible'] === true).map((t) => t.name)], [{ 'mcpl/rev': 3 }, SOURCE_TOOLS]);

  assert.deepEqual(await s.rpc('toolsets/close', { toolset: 'sources' }), { _meta: { 'mcpl/hints': { rev: 4, tools: SOURCE_TOOLS.map((name) => ({ name, visible: false })), toolsets: [{ toolset: 'sources', state: 'closed' }] } } });
  assert.deepEqual(await s.rpc('toolsets/close', { toolset: 'sources' }), {});
  assert.equal((await s.call('feed_remove', { source: '@dov' })).isError, true);
  await assert.rejects(s.rpc('toolsets/open', { toolset: 'builder' }), /No toolset "builder" here; there is "sources"\./);
  await assert.rejects(s.rpc('toolsets/open', { toolset: 'sources', instance: 'a' }), /has no instances/);
  s.close();
});

test('new tweets of a source set to notify are sent as one event, and are read by that', async () => {
  const s = await connect();
  await s.say('feed_add', { kind: 'timeline', value: '@dov' });
  await s.say('feed_read');
  assert.equal(await s.say('feed_set', { source: '@dov', mode: 'notify' }), 'timeline:@dov is now notify.');
  await s.session.check();
  assert.equal(s.events.length, 0, 'nothing new, nothing sent');

  s.bridge.tweets.push(tweet('203', 'dov', 'first of two', at(4, 0)), tweet('204', 'dov', 'second, with a picture', at(4, 1), { media: [image('3_1')] }));
  await s.session.check();
  assert.equal(s.events.length, 1);
  const e = s.events[0]!;
  assert.deepEqual([e.featureSet, e.eventId, e.tags], ['x.events', 'tweets_dov_204', ['x:new-tweets', 'x:from:dov', 'x:has-media']]);
  assert.equal(e.payload.content[0]!.text, [
    '[xgate] 2 new tweets from @dov',
    '',
    '@dov · 2026-03-04 10:00Z · id 203',
    '    first of two',
    '',
    '@dov · 2026-03-04 10:01Z · id 204',
    '    second, with a picture',
    '    [image 3_1]',
    '',
    'They are marked read in your feed.',
  ].join('\n'));
  assert.equal(await s.say('feed_read'), 'Nothing unread in timeline:@dov.');
  await s.session.check();
  assert.equal(s.events.length, 1, 'told once');
  s.close();
});

test('an event the host does not take leaves its tweets unread', async () => {
  const s = await connect({ accept: false });
  await s.say('feed_add', { kind: 'timeline', value: '@dov', mode: 'notify' });
  s.bridge.tweets.push(tweet('299', 'dov', 'posted later', new Date(Date.now() + 60_000).toISOString()));
  await s.session.check();
  assert.equal(s.events.length, 1);
  assert.match(await s.say('feed_read', { keep_unread: true }), /· 1 unread ──\n\[1\] @dov .* id 299/);
  s.close();
});

test('a source set to notify starts from now, and only a timeline can notify', async () => {
  const s = await connect();
  // Never read: its past is not sent.
  await s.say('feed_add', { kind: 'timeline', value: '@dov', mode: 'notify' });
  await s.session.check();
  assert.equal(s.events.length, 0);
  for (const kind of ['search', 'mentions']) {
    const r = await s.call('feed_add', { kind, value: 'opus', mode: 'notify' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text!, /^feed_add: only an account's timeline can notify/);
  }
  s.close();
});

test('without x.events nothing is sent, and setting notify says so', async () => {
  const s = await connect({ policy: { effectiveCapabilities: ['tools'] } });
  assert.deepEqual([s.receipt!.mode, s.receipt!.unavailableFeatures.map((u) => u.featureSet)], ['degraded', ['x.events']]);
  assert.match(await s.say('feed_add', { kind: 'timeline', value: '@dov', mode: 'notify' }), /Your host does not take events from this server \(its feature set x\.events is off\)/);
  s.bridge.tweets.push(tweet('299', 'dov', 'posted later', new Date(Date.now() + 60_000).toISOString()));
  await s.session.check();
  assert.equal(s.events.length, 0);
  assert.match(await s.say('feed_read'), /· 1 unread ──/);
  s.close();
});

test('a feature set the host left out is refused; a plain MCP client has every tool', async () => {
  const s = await connect({ policy: { effectiveCapabilities: ['tools'], enabled: ['x.read'] } });
  assert.deepEqual(s.receipt!.unavailableFeatures.map((u) => u.featureSet), ['x.feed', 'x.events']);
  assert.match((await s.call('feed_show')).content[0]!.text!, /feed_show: feature set x\.feed is not enabled for this connection\./);
  assert.match(await s.say('peek_timeline', { handle: '@dov' }), /^@dov: 2 cached tweets/);
  s.close();
  const plain = await connect({ capabilities: {}, policy: null });
  assert.equal(plain.init.capabilities.experimental, undefined);
  assert.equal(await plain.say('feed_show'), 'Your feed has no sources yet.');
  assert.match(await plain.say('user_timeline', { handle: 'dov', limit: 1 }), /^@dov · 1 tweet · /);
  plain.close();
});

test('over WebSocket an agent gets in by its Archipelago identity, and by nothing else', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const issuers = new Map<string, KeyObject>([['id.example', publicKey]]);
  const auth: AuthConfig = { ...DEFAULT_AUTH, subjects: ['agent:one@id.example'] };
  const mint = (o: { sub?: string; aud?: string } = {}) => mintAid1(privateKey, { iss: 'id.example', sub: o.sub ?? 'agent:one@id.example', kind: 'agent', name: 'One', aud: o.aud ?? 'xgate', scopes: [], ttlSeconds: 60 });
  assert.deepEqual(admit(mint(), auth, issuers), { ok: true, sub: 'agent:one@id.example', exp: (admit(mint(), auth, issuers) as { exp: number }).exp });
  assert.deepEqual(admit(mint({ aud: 'exa' }), auth, issuers), { ok: false, reason: 'audience exa' });
  assert.deepEqual(admit(mint({ sub: 'agent:someone@id.example' }), auth, issuers), { ok: false, reason: 'subject agent:someone@id.example not allowed here' });

  const bridge = await stubBridge(corpus());
  const app: App = { bridge: new BridgeClient({ baseUrl: bridge.url }), feeds: new FeedStore(mkdtempSync(join(tmpdir(), 'xgate-ws-'))), log: () => {}, sourcesOpen: new Set(), checkEveryMs: 3_600_000 };
  const http = serveWs({ port: 0, host: '127.0.0.1', auth, issuers, app });
  await new Promise((r) => http.once('listening', r));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/mcpl`;

  const refused = new WebSocket(url);
  assert.equal(await new Promise((r) => refused.once('close', (code) => r(code))), 4401);

  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${mint()}` } });
  await new Promise((r) => ws.once('open', r));
  const client = McplConnection.fromWebSocket(ws as unknown as Parameters<typeof McplConnection.fromWebSocket>[0]);
  await client.sendRequest('initialize', { protocolVersion: '2024-11-05', capabilities: MCPL, clientInfo: { name: 'test', version: '0' } });
  await client.sendRequest('featureSets/update', ALL);
  const added = await client.sendRequest('tools/call', { name: 'feed_add', arguments: { kind: 'timeline', value: '@dov' } }) as Result;
  assert.match(added.content[0]!.text!, /^Added timeline:@dov/);
  // The feed is kept under the identity the token carried.
  assert.deepEqual(app.feeds.get('agent:one@id.example').sources.map((x) => x.id), ['timeline:dov']);
  ws.close(); http.close(); bridge.close();
});

test('over stdio the agent has to be named, since its feed is kept under that name', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--stdio'], { encoding: 'utf8', env: { ...process.env, XGATE_MCPL_HOME: mkdtempSync(join(tmpdir(), 'xgate-home-')) } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Over stdio --client is needed/);
});
