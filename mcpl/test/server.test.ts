/**
 * Integration tests for XMcplServer over a real TCP McplConnection pair,
 * driving the live bridge. Mirrors discord-mcpl/test/server.test.ts.
 *
 * Requires the bridge at X_BRIDGE_URL (default http://127.0.0.1:8810).
 * Live-dependent tests skip if the bridge is unreachable.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';

import { McplConnection, method } from '@animalabs/mcpl-core';
import type {
  McplInitializeParams,
  McplInitializeResult,
  ChannelsOpenResult,
  ChannelsListResult,
  ChannelsIncomingParams,
} from '@animalabs/mcpl-core';

import { BridgeClient, type BridgeTweet } from '../src/bridge-client.js';
import { XMcplServer } from '../src/server.js';
import { featureSets } from '../src/feature-sets.js';
import { CAPABILITY_PATHS, isCapabilityPath, type DegradationReceipt } from '../src/grant.js';

// SPEC 6.2 / App. B.2: `uses` is a closed vocabulary. §6.4 makes the derivation
// fail-closed, so an entry outside the vocabulary now disables its feature set
// with reason `invalid_uses` rather than being cosmetic.
test('every declared `uses` value is in the SPEC 6.2 capability-path vocabulary', () => {
  for (const fs of featureSets) {
    assert.ok(Array.isArray(fs.uses) && fs.uses.length > 0, `${fs.name}: uses must be non-empty`);
    for (const u of fs.uses) {
      assert.ok(isCapabilityPath(u), `${fs.name}: '${u}' is not one of ${CAPABILITY_PATHS.join(', ')}`);
    }
  }
});

// The non-spec `hostState` field is gone (issue #1 point 3). The host/server
// state split is signalled per response by `data`/`patch` (§8.3), not by a
// declaration flag.
test('no feature set declares the non-spec `hostState` field', () => {
  for (const fs of featureSets) {
    assert.equal('hostState' in fs, false, `${fs.name} still declares hostState`);
  }
});

const baseUrl = process.env.X_BRIDGE_URL ?? 'http://127.0.0.1:8810';
const bridge = new BridgeClient({ baseUrl });

async function bridgeUp(): Promise<boolean> {
  try { await bridge.health(); return true; } catch { return false; }
}

interface Pair { client: McplConnection; serverConn: McplConnection; tcpServer: net.Server; }

async function makePair(): Promise<Pair> {
  const tcpServer = net.createServer();
  tcpServer.listen(0, '127.0.0.1');
  await new Promise<void>((r) => tcpServer.once('listening', r));
  const addr = tcpServer.address() as net.AddressInfo;
  const [serverConn, clientSocket] = await Promise.all([
    McplConnection.acceptTcp(tcpServer),
    new Promise<net.Socket>((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port: addr.port }, () => resolve(s));
    }),
  ]);
  return { client: McplConnection.fromTcp(clientSocket), serverConn, tcpServer };
}

/** The advertisement as it appears on the wire (§5.1); core's type still lags. */
interface WireAdvertisement {
  version?: string;
  pushEvents?: unknown;
  tools?: unknown;
  rollback?: unknown;
  channels?: unknown;
  featureSets?: Array<{ name: string; uses: string[]; rollback?: boolean; hostState?: unknown }>;
}

function advertisement(result: McplInitializeResult): WireAdvertisement {
  return result.capabilities.experimental?.mcpl as unknown as WireAdvertisement;
}

/** Everything this server advertises, as a host that grants all of it would. */
const FULL_GRANT = ['tools', 'channels.register', 'channels.lifecycle', 'channels.incoming'];

async function handshake(client: McplConnection): Promise<McplInitializeResult> {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: { experimental: { mcpl: { version: '0.5' } } },
    clientInfo: { name: 'test-host', version: '0.0.0' },
  };
  const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
  client.sendNotification('notifications/initialized');
  return result;
}

/**
 * §5.3: hosts MUST send the initial policy as a Request, before accepting any
 * inbound privileged method, even when nothing is enabled or disabled. The
 * response is the §6.7 degradation receipt.
 */
async function sendPolicy(
  client: McplConnection,
  policy: { effectiveCapabilities?: string[]; deniedCapabilities?: string[]; enabled?: string[]; disabled?: string[] },
): Promise<DegradationReceipt> {
  return (await client.sendRequest(method.FEATURE_SETS_UPDATE, policy)) as DegradationReceipt;
}

/** Handshake plus a full grant with every feature set switched on. */
async function handshakeAndGrant(client: McplConnection): Promise<McplInitializeResult> {
  const result = await handshake(client);
  await sendPolicy(client, {
    effectiveCapabilities: FULL_GRANT,
    enabled: featureSets.map((f) => f.name),
  });
  return result;
}

/**
 * Wait for the next `channels/incoming` **Request** (§14.3) and answer it with
 * per-message results, as a host must.
 */
function nextIncoming(
  client: McplConnection,
  timeoutMs = 5000,
  accept = true,
): Promise<ChannelsIncomingParams> {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for channels/incoming')), timeoutMs);
    try {
      for (;;) {
        const msg = await client.nextMessage();
        if (msg.type === 'notification' && msg.notification.method === method.CHANNELS_INCOMING) {
          clearTimeout(timer);
          reject(new Error('channels/incoming arrived as a Notification; SPEC 14.3 defines it as a Request'));
          return;
        }
        if (msg.type === 'request' && msg.request.method === method.CHANNELS_INCOMING) {
          const p = msg.request.params as ChannelsIncomingParams;
          client.sendResponse(msg.request.id, {
            results: p.messages.map((m) => ({
              messageId: m.messageId,
              accepted: accept,
              ...(accept ? { conversationId: 'conv_test' } : {}),
            })),
          });
          clearTimeout(timer);
          resolve(p);
          return;
        }
      }
    } catch (e) {
      clearTimeout(timer);
      reject(e as Error);
    }
  });
}

// §5.1: the advertisement mirrors the §6.2 capability paths as a nested object
// of leaves. It is an input to the host's grant computation, never an
// authorization (§5.4), so it must name only what this server exercises.
test('initialize advertises the 0.5 recursive capability tree', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    const mcpl = advertisement(await handshake(client));
    assert.ok(mcpl, 'server should advertise mcpl caps');
    assert.equal(mcpl.version, '0.5');
    assert.deepEqual(mcpl.channels, { register: true, lifecycle: true, incoming: true });
    assert.equal(mcpl.tools, true);
    assert.ok(mcpl.featureSets?.some((f) => f.name === 'x.read'));
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

// Issue #1 point 2: `pushEvents: true` was declared and no `push/event` is sent
// anywhere. Advertisement is an input to the grant computation (§5.4), so
// over-declaring widens the computed grant beyond what the server needs.
test('initialize does not advertise capabilities the server never exercises', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    const mcpl = advertisement(await handshake(client));
    assert.equal(mcpl.pushEvents, undefined, 'no push/event is sent anywhere in this server');
    assert.equal(mcpl.rollback, undefined, 'rollback is not a SPEC 6.2 capability path');
    const channels = mcpl.channels as Record<string, unknown>;
    for (const absent of ['publish', 'streaming', 'acknowledge', 'typing']) {
      assert.equal(channels[absent], undefined, `channels.${absent} is not implemented`);
    }
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

test('tools/list returns the x.read tools', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshakeAndGrant(client);
    const r = (await client.sendRequest('tools/list', {})) as { tools: Array<{ name: string }> };
    const names = r.tools.map((t) => t.name);
    for (const n of ['lookup_tweet', 'get_thread', 'get_user', 'user_timeline', 'search_tweets']) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

test('live: tools/call user_timeline returns cached tweets', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshakeAndGrant(client);
    // format:'full' opts into the raw JSON object (default is compact text).
    const r = (await client.sendRequest('tools/call', {
      name: 'user_timeline',
      arguments: { handle: 'repligate', limit: 3, format: 'full' },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.ok(!r.isError, 'tool call should succeed');
    const data = JSON.parse(r.content[0].text) as { count: number };
    assert.ok(data.count > 0, 'should return tweets');
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

test('feature-set gating: disabled x.read blocks the tool', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshakeAndGrant(client);
    client.sendNotification(method.FEATURE_SETS_UPDATE, { disabled: ['x.read'] });
    await new Promise((r) => setTimeout(r, 100));
    const r = (await client.sendRequest('tools/call', {
      name: 'search_tweets',
      arguments: { query: 'x', limit: 1 },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not enabled/);
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

// §5.3: "Until the initial policy exchange completes, a server MUST treat every
// capability-dependent behavior as unavailable." Pre-0.5 the server switched
// every feature set on at initialize, which was a default-allow.
test('no feature set is usable before the initial policy Request', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    const r = (await client.sendRequest('tools/call', {
      name: 'search_tweets',
      arguments: { query: 'x', limit: 1 },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not enabled/);
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

// §6.7: the Request form's response is a degradation receipt, not an
// acknowledgement. It reports what the server will do; it never asserts
// entitlement, and the host must not widen anything in response to it.
test('featureSets/update Request returns a degradation receipt', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshake(client);

    const full = await sendPolicy(client, { effectiveCapabilities: FULL_GRANT, enabled: ['x.*'] });
    assert.equal(full.accepted, true);
    assert.equal(full.mode, 'full');
    assert.deepEqual(full.unavailableFeatures, []);

    // Narrowing the grant degrades exactly the sets whose `uses` needed it.
    const narrowed = await sendPolicy(client, { effectiveCapabilities: ['tools'] });
    assert.equal(narrowed.mode, 'degraded');
    const degraded = narrowed.unavailableFeatures?.find((u) => u.featureSet === 'x.notifications');
    assert.ok(degraded, 'x.notifications should degrade without the channel capabilities');
    assert.deepEqual(degraded?.missingCapabilities.sort(), [
      'channels.incoming',
      'channels.lifecycle',
      'channels.register',
    ]);
    assert.equal(degraded?.effect, 'disabled');
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

// §5.4: "If a path appears in both [effectiveCapabilities and
// deniedCapabilities], the receiving side MUST fail closed and reject the policy
// message as malformed." §6.6 requires an error object, not a failure flag.
test('featureSets/update with a path in both lists is rejected as malformed', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    await assert.rejects(
      () => sendPolicy(client, { effectiveCapabilities: ['tools'], deniedCapabilities: ['tools'] }),
      /Malformed/,
    );
    // Failing closed: the grant is held at nothing, so tools stay unusable.
    const r = (await client.sendRequest('tools/call', {
      name: 'search_tweets',
      arguments: { query: 'x', limit: 1 },
    })) as { isError?: boolean };
    assert.equal(r.isError, true);
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

// §14.1 + §5.4: a denied capability behaves as if never advertised, and §6.6
// requires an error object with the documented code (-32002, §14.6).
test('channel methods are refused with -32002 when the capability is not granted', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    await sendPolicy(client, { effectiveCapabilities: ['tools'] });
    await assert.rejects(
      () => client.sendRequest(method.CHANNELS_OPEN, { type: 'x.timeline', address: { value: 'repligate' } }),
      /Capability denied: channels\.lifecycle/,
    );
    await assert.rejects(() => client.sendRequest(method.CHANNELS_LIST, {}), /Capability denied: channels\.register/);
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

// ── channels/incoming (§14.3) ──

const STUB_TWEET: BridgeTweet = {
  tweet_id: '1234567890',
  author_id: 'u_777',
  author_username: 'alice',
  text: 'hello from the stub bridge',
  created_at: '2026-08-01T10:30:00Z',
  reply_to_tweet_id: null,
  reply_to_username: null,
  conversation_id: 't_42',
  retweet_count: 0,
  favorite_count: 0,
  source: null,
  media: [],
  urls: [],
};

/**
 * Minimal stand-in for BridgeClient: enough for channels/open + backfill,
 * with an unroutable base URL so the SSE subscription fails immediately
 * instead of reaching a live bridge.
 */
function stubBridge(tweets: BridgeTweet[]): BridgeClient {
  return {
    baseUrl: 'http://127.0.0.1:1',
    authHeaders: () => ({}),
    mediaUrl: (id: string) => `http://127.0.0.1:1/media/${id}`,
    userTimeline: async () => tweets,
  } as unknown as BridgeClient;
}

// Issue #1 point 1. §4.1's table and §14.3 both define `channels/incoming` as a
// Server → Host Request. Sending it as a Notification discarded the per-message
// `results` contract: the server could not learn which messages were accepted,
// or that any were rejected.
test('channels/incoming is a Request whose per-message results are consumed', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(stubBridge([STUB_TWEET]), { backfillOnOpen: 3 });
  const serving = server.serve(serverConn);
  try {
    await handshakeAndGrant(client);
    const open = (await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'x.timeline',
      address: { value: 'repligate' },
    })) as ChannelsOpenResult;

    const incoming = await nextIncoming(client);
    assert.equal(incoming.messages.length, 1);
    assert.equal(incoming.messages[0].messageId, STUB_TWEET.tweet_id);
    assert.equal(incoming.messages[0].channelId, open.channel.id);
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

// §5.4: a denied capability behaves as if never advertised. §14.1: incoming is
// "server→host content injection plus wake authority — a write, and one of the
// most consequential a server has", so it is gated on the grant, not on the
// channel having been opened.
test('no channels/incoming is sent when channels.incoming is not granted', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(stubBridge([STUB_TWEET]), { backfillOnOpen: 3 });
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    await sendPolicy(client, {
      effectiveCapabilities: ['tools', 'channels.register', 'channels.lifecycle'],
      enabled: ['x.*'],
    });
    await client.sendRequest(method.CHANNELS_OPEN, { type: 'x.timeline', address: { value: 'repligate' } });
    await assert.rejects(() => nextIncoming(client, 750), /timeout/);
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

test('live: channels/open backfills cached tweets as channels/incoming', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge, { backfillOnOpen: 3 });
  const serving = server.serve(serverConn);
  try {
    await handshakeAndGrant(client);
    const open = (await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'x.timeline',
      address: { value: 'repligate' },
    })) as ChannelsOpenResult;
    assert.equal(open.channel.type, 'x.timeline');

    const incoming = await nextIncoming(client);
    assert.ok(incoming.messages.length >= 1);
    const m = incoming.messages[0];
    assert.equal(m.channelId, open.channel.id);
    assert.ok(m.content[0].type === 'text');

    const list = (await client.sendRequest(method.CHANNELS_LIST, {})) as ChannelsListResult;
    assert.ok(list.channels.some((c) => c.id === open.channel.id));
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});
