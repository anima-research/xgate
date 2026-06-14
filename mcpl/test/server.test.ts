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

import { McplConnection, method } from '@connectome/mcpl-core';
import type {
  McplInitializeParams,
  McplInitializeResult,
  ChannelsOpenResult,
  ChannelsListResult,
  ChannelsIncomingParams,
  JsonRpcNotification,
} from '@connectome/mcpl-core';

import { BridgeClient } from '../src/bridge-client.js';
import { XMcplServer } from '../src/server.js';
import { featureSets } from '../src/feature-sets.js';

// Invariant: host-managed state (`hostState: true`) is single-valued by protocol
// (one unkeyed `params.state`), so x.feed must be the sole host-managed set.
// Server-managed rollback sets (x.post/x.dm) are separate and may coexist — the
// host is responsible for threading the host-managed set independently of them
// (see firstStateful/getStatefulFeatureSet fixes in the hosts).
test('x.feed is the sole host-managed (hostState) feature set', () => {
  const hostManaged = featureSets.filter((f) => f.hostState);
  assert.equal(hostManaged.length, 1, `expected one hostState set, got: ${hostManaged.map((f) => f.name).join(', ')}`);
  assert.equal(hostManaged[0].name, 'x.feed');
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

async function handshake(client: McplConnection): Promise<McplInitializeResult> {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: { experimental: { mcpl: { version: '0.4' } } },
    clientInfo: { name: 'test-host', version: '0.0.0' },
  };
  const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
  client.sendNotification('notifications/initialized');
  return result;
}

/** Wait for the next channels/incoming notification, or time out. */
function nextIncoming(client: McplConnection, timeoutMs = 5000): Promise<ChannelsIncomingParams> {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for channels/incoming')), timeoutMs);
    try {
      for (;;) {
        const msg = await client.nextMessage();
        if (msg.type === 'notification' && (msg.notification as JsonRpcNotification).method === method.CHANNELS_INCOMING) {
          clearTimeout(timer);
          resolve(msg.notification.params as ChannelsIncomingParams);
          return;
        }
      }
    } catch (e) {
      clearTimeout(timer);
      reject(e as Error);
    }
  });
}

test('initialize advertises MCPL capabilities (channels, pushEvents, featureSets)', async () => {
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    const result = await handshake(client);
    const mcpl = result.capabilities.experimental?.mcpl;
    assert.ok(mcpl, 'server should advertise mcpl caps');
    assert.equal(mcpl?.channels, true);
    assert.equal(mcpl?.pushEvents, true);
    assert.ok(mcpl?.featureSets?.some((f) => f.name === 'x.read'));
    // x.feed is the single host-managed (hostState) feature set.
    assert.ok(mcpl?.featureSets?.some((f) => f.name === 'x.feed' && f.hostState === true));
    // Exactly one hostState set (the host injects/records state for the first one).
    assert.equal(mcpl?.featureSets?.filter((f) => f.hostState === true).length, 1);
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

test('live: tools/call user_timeline returns cached tweets', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge);
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
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

test('live: channels/open backfills cached tweets as channels/incoming', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const { client, serverConn, tcpServer } = await makePair();
  const server = new XMcplServer(bridge, { backfillOnOpen: 3 });
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
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
