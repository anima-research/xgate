#!/usr/bin/env node
/**
 * x-mcpl — per-bot MCPL frontend for X/Twitter. CLI entry point.
 *
 * Usage:
 *   x-mcpl --stdio                 # MCP-compatible stdio transport
 *   x-mcpl --tcp <port>            # TCP transport for MCPL hosts
 *
 * Environment:
 *   X_BRIDGE_URL    Bridge daemon base URL (default http://127.0.0.1:8810)
 *   X_BACKFILL      Recent cached tweets to deliver when a channel opens (default 0)
 */

import * as net from 'node:net';
import { McplConnection } from '@connectome/mcpl-core';
import { BridgeClient } from './bridge-client.js';
import { XMcplServer } from './server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useStdio = args.includes('--stdio');
  const tcpIdx = args.indexOf('--tcp');
  const tcpPort = tcpIdx >= 0 ? parseInt(args[tcpIdx + 1], 10) : undefined;

  if (!useStdio && !tcpPort) {
    console.error('Usage: x-mcpl --stdio | --tcp <port>');
    process.exit(1);
  }

  const baseUrl = process.env.X_BRIDGE_URL ?? 'http://127.0.0.1:8810';
  const backfillOnOpen = parseInt(process.env.X_BACKFILL ?? '0', 10) || 0;
  const bridge = new BridgeClient({ baseUrl, token: process.env.X_BRIDGE_TOKEN });

  // Fail fast if the bridge isn't reachable.
  try {
    const h = await bridge.health();
    console.error(`[x-mcpl] bridge ${baseUrl} ok — ${h.tweets} tweets cached, allow_fetch=${h.allow_fetch}`);
  } catch (e) {
    console.error(`[x-mcpl] cannot reach bridge at ${baseUrl}: ${(e as Error).message}`);
    process.exit(1);
  }

  // Readiness: /health is UNauthenticated, so it can't catch a misrouted URL or a
  // missing/invalid token — those would silently 401/403 every read while the
  // frontend looks "connected". Probe one authenticated endpoint and fail loudly.
  try {
    await bridge.budget();
  } catch (e) {
    console.error(
      `[x-mcpl] bridge reachable but an authenticated request failed: ${(e as Error).message}\n` +
      `         Check X_BRIDGE_URL and X_BRIDGE_TOKEN. The URL must point directly at the\n` +
      `         bridge vhost — for borgs that is https://xgate.animalabs.ai (NOT\n` +
      `         https://borgs.animalabs.ai/xgate, which misroutes to another service).`,
    );
    process.exit(1);
  }

  const makeServer = () => new XMcplServer(bridge, { backfillOnOpen });

  if (useStdio) {
    const conn = McplConnection.fromStreams(process.stdin, process.stdout);
    await makeServer().serve(conn);
    return;
  }

  const server = net.createServer((socket) => {
    const conn = McplConnection.fromTcp(socket);
    makeServer().serve(conn).catch((e) => console.error('[x-mcpl] serve error:', (e as Error).message));
  });
  server.listen(tcpPort, '127.0.0.1', () => {
    console.error(`[x-mcpl] listening on tcp://127.0.0.1:${tcpPort}`);
  });
}

main().catch((e) => {
  console.error('[x-mcpl] fatal:', e);
  process.exit(1);
});
