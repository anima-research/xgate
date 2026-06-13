/**
 * End-to-end Phase 3 test: a tweet flows live through the whole stack —
 *   X API → bridge poller → SSE → x-mcpl SseSubscription → channels/incoming.
 *
 * To get a deterministic, cheap signal we delete the single newest cached tweet
 * for a known author and clear its freshness; opening the channel triggers a
 * poll-if-stale on the bridge, which re-discovers that tweet and streams it.
 *
 * Requires the bridge at X_BRIDGE_URL with fetching enabled (allow_fetch=true).
 * Skips if the bridge is down or fetching is disabled (no real-data path).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';

import { McplConnection, method } from '@connectome/mcpl-core';
import type {
  McplInitializeParams,
  ChannelsOpenResult,
  ChannelsIncomingParams,
} from '@connectome/mcpl-core';

import { BridgeClient } from '../src/bridge-client.js';
import { XMcplServer } from '../src/server.js';

const baseUrl = process.env.X_BRIDGE_URL ?? 'http://127.0.0.1:8810';
const REPLIGATE_ID = '1359981346119155719';
const bridge = new BridgeClient({ baseUrl });

async function makePair() {
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

async function handshake(client: McplConnection) {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: { experimental: { mcpl: { version: '0.4' } } },
    clientInfo: { name: 'live-test', version: '0' },
  };
  await client.sendRequest('initialize', params);
  client.sendNotification('notifications/initialized');
}

function nextIncoming(client: McplConnection, timeoutMs: number): Promise<ChannelsIncomingParams | null> {
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      for (;;) {
        const msg = await client.nextMessage();
        if (msg.type === 'notification' && msg.notification.method === method.CHANNELS_INCOMING) {
          clearTimeout(timer);
          resolve(msg.notification.params as ChannelsIncomingParams);
          return;
        }
      }
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

test('live e2e: a tweet streams X→bridge→SSE→channels/incoming', async (t) => {
  let health;
  try { health = await bridge.health(); } catch { return t.skip('bridge not reachable'); }
  if (!health.allow_fetch || !health.bearer_configured) return t.skip('bridge fetching disabled');

  // Make the resource stale + missing its newest tweet so the poll re-discovers it.
  await fetch(`${baseUrl}/__test_make_stale/${REPLIGATE_ID}`, { method: 'POST' }).catch(() => {});

  const { client, serverConn, tcpServer } = await makePair();
  // No backfill: the only way a message arrives is the live SSE path.
  const server = new XMcplServer(bridge, { backfillOnOpen: 0 });
  const serving = server.serve(serverConn);
  try {
    await handshake(client);
    const open = (await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'x.timeline',
      address: { value: REPLIGATE_ID },
    })) as ChannelsOpenResult;

    const incoming = await nextIncoming(client, 20_000);
    assert.ok(incoming, 'expected a live channels/incoming within 20s');
    const m = incoming!.messages[0];
    assert.equal(m.channelId, open.channel.id);
    assert.ok(/^\d+$/.test(m.messageId), 'real tweet id');
    assert.ok(m.content[0].type === 'text' && m.content[0].text.length > 0, 'has text');
  } finally {
    client.close(); tcpServer.close(); await serving.catch(() => {});
  }
});
