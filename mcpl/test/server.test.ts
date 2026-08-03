/**
 * Integration tests for XMcplServer over a real TCP McplConnection pair,
 * driving the live bridge.
 *
 * Requires the bridge at X_BRIDGE_URL (default http://127.0.0.1:8810).
 * Live-dependent tests skip if the bridge is unreachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';

import { McplConnection, method } from '@animalabs/mcpl-core';

import { BridgeClient } from '../src/bridge-client.js';
import { XMcplServer } from '../src/server.js';
import { featureSets } from '../src/feature-sets.js';
import { CAPABILITY_PATHS, type CapabilityPath } from '../src/capabilities.js';
import type {
  ChannelsIncomingParams,
  DegradationReceipt,
  XMcplAdvertisement,
} from '../src/protocol.js';

// SPEC §6.2 / App. B.2: `uses` is a closed vocabulary. A set whose `uses` is
// absent, empty, or carries an unrecognised value is invalid and gets disabled.
test('every declared feature set uses only §6.2 capability paths', () => {
  for (const fs of featureSets) {
    assert.ok(Array.isArray(fs.uses) && fs.uses.length > 0, `${fs.name}: uses must be non-empty`);
    for (const u of fs.uses) {
      assert.ok(
        (CAPABILITY_PATHS as readonly string[]).includes(u),
        `${fs.name}: '${u}' is not a §6.2 capability path`,
      );
    }
  }
});

// SPEC §6.2: `hostState` is not a spec field.
test('feature sets carry no non-spec members', () => {
  for (const fs of featureSets) {
    assert.ok(!('hostState' in fs), `${fs.name} still declares hostState`);
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

interface HandshakeResult {
  capabilities: { experimental?: { mcpl?: XMcplAdvertisement } };
}

async function handshake(client: McplConnection): Promise<HandshakeResult> {
  const params = {
    protocolVersion: '2024-11-05',
    capabilities: { experimental: { mcpl: { version: '0.5' } } },
    clientInfo: { name: 'test-host', version: '0.0.0' },
  };
  const result = (await client.sendRequest('initialize', params)) as HandshakeResult;
  client.sendNotification('notifications/initialized');
  return result;
}

/**
 * The initial policy exchange (§5.3): a Request carrying the effective grant. The
 * server treats every capability-dependent behavior as unavailable until this
 * lands, so tests that exercise tools or channels must send it.
 */
async function sendPolicy(
  client: McplConnection,
  effectiveCapabilities: CapabilityPath[],
  extra: Record<string, unknown> = {},
): Promise<DegradationReceipt> {
  return (await client.sendRequest(method.FEATURE_SETS_UPDATE, {
    effectiveCapabilities,
    ...extra,
  })) as DegradationReceipt;
}

const FULL_GRANT: CapabilityPath[] = [
  'tools',
  'channels.register',
  'channels.lifecycle',
  'channels.incoming',
];

/**
 * Wait for the next channels/incoming **Request** (§14.3) and answer it with
 * per-message results.
 */
function nextIncoming(client: McplConnection, timeoutMs = 5000): Promise<ChannelsIncomingParams> {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for channels/incoming')), timeoutMs);
    try {
      for (;;) {
        const msg = await client.nextMessage();
        if (msg.type === 'request' && msg.request.method === method.CHANNELS_INCOMING) {
          const p = msg.request.params as ChannelsIncomingParams;
          client.sendResponse(msg.request.id, {
            results: p.messages.map((m) => ({
              messageId: m.messageId,
              accepted: true,
              conversationId: 'conv_test',
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

test('initialize advertises only the capabilities this server exercises', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    const result = await handshake(client);
    const mcpl = result.capabilities.experimental?.mcpl;
    assert.ok(mcpl, 'server should advertise mcpl caps');
    assert.equal(mcpl?.version, '0.5');
    // §5.4: over-declaration widens the computed grant. There is no push/event
    // call site, no channels/publish handler, and no streaming/ack/typing.
    // (Probed before the deepEqual below — its assertion signature narrows
    // `mcpl.channels` to the exact literal and would reject these accesses.)
    assert.ok(!('pushEvents' in (mcpl as object)), 'pushEvents must not be advertised');
    assert.equal(mcpl?.channels?.publish, undefined);
    assert.equal(mcpl?.channels?.streaming, undefined);
    assert.equal(mcpl?.channels?.acknowledge, undefined);
    assert.equal(mcpl?.channels?.typing, undefined);
    // §5.1: recursive advertisement, leaves only.
    assert.deepEqual(mcpl?.channels, { register: true, lifecycle: true, incoming: true });
    const sets = mcpl?.featureSets as Array<{ name: string }>;
    assert.ok(sets.some((f) => f.name === 'x.read'));
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

test('tools/list returns the x.read tools', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    const r = (await client.sendRequest('tools/list', {})) as { tools: Array<{ name: string }> };
    const names = r.tools.map((t) => t.name);
    for (const n of ['lookup_tweet', 'get_thread', 'get_user', 'user_timeline', 'search_tweets']) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

// §5.3/§5.4: the server must not grant itself anything. Before the initial policy
// exchange every capability-dependent behavior is unavailable.
test('no default-allow: tools are blocked until initial policy arrives', async () => {
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

// §6.7: the response to the Request form is a degradation receipt.
test('featureSets/update Request returns a degradation receipt', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    const receipt = await sendPolicy(client, ['tools']);
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.mode, 'degraded'); // x.notifications needs channels.*
    const names = (receipt.unavailableFeatures ?? []).map((u) => u.featureSet);
    assert.ok(names.includes('x.notifications'));
    const notif = (receipt.unavailableFeatures ?? []).find((u) => u.featureSet === 'x.notifications');
    assert.deepEqual(notif?.missingCapabilities.sort(), [
      'channels.incoming', 'channels.lifecycle', 'channels.register',
    ]);
    assert.equal(notif?.effect, 'disabled');

    const full = await sendPolicy(client, FULL_GRANT);
    assert.equal(full.mode, 'full');
    assert.deepEqual(full.unavailableFeatures, []);
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

// §5.4: a path in both effectiveCapabilities and deniedCapabilities is malformed;
// the receiving side must fail closed.
test('a path in both grant lists is rejected as malformed', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    await sendPolicy(client, FULL_GRANT);
    await assert.rejects(
      () => sendPolicy(client, ['tools'], { deniedCapabilities: ['tools'] }),
      /Malformed capability policy/,
    );
    // Failed closed: the previously granted tools are gone.
    const r = (await client.sendRequest('tools/call', {
      name: 'search_tweets',
      arguments: { query: 'x', limit: 1 },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(r.isError, true);
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
    await handshake(client);
    await sendPolicy(client, FULL_GRANT);
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
    await handshake(client);
    await sendPolicy(client, FULL_GRANT, { disabled: ['x.read'] });
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

// §14.1: channels/incoming requires channels.incoming. Denial is absence.
test('channels/incoming is withheld when channels.incoming is not granted', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge, { backfillOnOpen: 3 });
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    await sendPolicy(client, ['tools', 'channels.register', 'channels.lifecycle']);
    await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'x.timeline',
      address: { value: 'repligate' },
    });
    await assert.rejects(() => nextIncoming(client, 1500), /timeout/);
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});

test('live: channels/open backfills cached tweets as a channels/incoming Request', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge, { backfillOnOpen: 3 });
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    await sendPolicy(client, FULL_GRANT);
    const open = (await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'x.timeline',
      address: { value: 'repligate' },
    })) as { channel: { id: string; type: string } };
    assert.equal(open.channel.type, 'x.timeline');

    const incoming = await nextIncoming(client);
    assert.ok(incoming.messages.length >= 1);
    const m = incoming.messages[0];
    assert.equal(m.channelId, open.channel.id);
    assert.ok(m.content[0].type === 'text');
    // §16: namespaced tags only; a timeline is overheard, not addressed.
    assert.ok(m.tags?.includes('chat:ambient'));
    assert.ok(m.tags?.every((tag) => tag.includes(':')));

    const list = (await client.sendRequest(method.CHANNELS_LIST, {})) as {
      channels: Array<{ id: string }>;
    };
    assert.ok(list.channels.some((c) => c.id === open.channel.id));
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});
