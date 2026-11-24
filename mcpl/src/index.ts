#!/usr/bin/env node
/**
 * x-mcpl — reading X/Twitter through the xgate bridge, as an MCPL server (and a plain MCP one).
 *
 *   x-mcpl --ws 7480 [--host 127.0.0.1]   serve agents over WebSocket at /mcpl, known by Archipelago identity
 *   x-mcpl --stdio --client <name>        serve one local agent, whose feed is kept under <name>
 *   x-mcpl check                          ask the bridge who this server is to it, and say who would be served
 *
 * Over WebSocket there are no tokens to hand out: an agent's host sends an
 * Archipelago `aid1` token for the audience "xgate" (config.ts). Other machines
 * reach the server through a TLS front (tailscale serve).
 * Home: $XGATE_MCPL_HOME (default ~/.config/xgate-mcpl).
 */
import type { KeyObject } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';
import { WebSocketServer } from 'ws';
import { AuthFault, resolveIssuers, verifyAid1 } from './auth.js';
import { BridgeClient } from './bridge-client.js';
import { HOME, loadAuth, loadBridge, type AuthConfig } from './config.js';
import { FeedStore } from './feed.js';
import { SERVER_NAME, Session, VERSION, type App } from './session.js';

/** WebSocket paths served (trailing slashes ignored). /mcpl is canonical. */
export const WS_PATHS: ReadonlySet<string> = new Set(['/mcpl', '/mcp', '/']);
export function wsPathAllowed(path: string): boolean { return WS_PATHS.has(path.replace(/\/+$/, '') || '/'); }

/** Bearer header or ?token= query parameter (the host's default). */
export function bearerOf(headers: Record<string, string | string[] | undefined>, url: string): string {
  const h = headers.authorization;
  const fromHeader = (Array.isArray(h) ? h[0] : h ?? '').replace(/^Bearer\s+/i, '').trim();
  return fromHeader || new URL(url, 'http://x').searchParams.get('token') || '';
}

/** Verify a connection's credential: who it is, and when the credential stops being valid. */
export function admit(token: string, auth: AuthConfig, issuers: Map<string, KeyObject>): { ok: true; sub: string; exp: number } | { ok: false; reason: string } {
  try {
    const id = verifyAid1(token, { audience: auth.audience, issuers, requiredScopes: auth.requiredScopes, subjects: auth.subjects });
    return { ok: true, sub: id.sub, exp: id.exp };
  } catch (e) {
    return { ok: false, reason: e instanceof AuthFault ? e.reason : (e as Error).message };
  }
}

function log(...args: unknown[]): void {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  process.stderr.write(`${stamp} ${args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))).join(' ')}\n`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The WebSocket server: every connection is admitted by its aid1 token, and ends when that token does. */
export function serveWs(o: { port: number; host: string; auth: AuthConfig; issuers: Map<string, KeyObject>; app: App }): Server {
  const { auth, issuers, app } = o;
  let connections = 0;
  const http = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: VERSION, connections }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    // Browsers always send Origin; agents and hosts do not. Refusing it closes
    // cross-site WebSocket hijacking by any page the user happens to visit.
    // The path carries no authority (the token does), so the spellings clients use are accepted.
    if (!wsPathAllowed(path)) { app.log(`ws: refused a connection (path ${path.slice(0, 60)}: use /mcpl)`); socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    if (req.headers.origin) { app.log('ws: refused a connection (browser Origin header)'); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', (e) => app.log('ws connection error:', (e as Error).message));
      const verdict = admit(bearerOf(req.headers, req.url ?? '/'), auth, issuers);
      if (!verdict.ok) { app.log(`ws: refused a connection (${verdict.reason})`); ws.close(4401, 'unauthorized'); return; }
      const { sub, exp } = verdict;
      app.log(`ws: ${sub} connected (token valid until ${new Date(exp * 1000).toISOString()})`);
      connections++;
      // The credential ends the session: a host redials with a fresh token.
      let expiry: NodeJS.Timeout;
      const arm = () => {
        const left = exp * 1000 - Date.now();
        if (left <= 0) { app.log(`ws: ${sub}: token expired, closing`); ws.close(4001, 'token expired'); return; }
        expiry = setTimeout(arm, Math.min(left, 2 ** 31 - 1)); // setTimeout overflows past ~24.8 days
      };
      arm();
      const conn = McplConnection.fromWebSocket(ws as unknown as Parameters<typeof McplConnection.fromWebSocket>[0]);
      void new Session(conn, app, sub).serve().finally(() => { clearTimeout(expiry); connections--; app.log(`ws: ${sub} disconnected`); });
    });
  });
  http.listen(o.port, o.host);
  return http;
}

/** The bridge answers, and takes this server's token. Says what is wrong otherwise. */
async function bridgeProblem(bridge: BridgeClient): Promise<string | null> {
  try {
    await bridge.health();
  } catch (e) {
    return `cannot reach the bridge at ${bridge.baseUrl}: ${(e as Error).message}`;
  }
  try {
    // /health needs no token, so it cannot tell a wrong address or token: /budget can.
    await bridge.budget();
  } catch (e) {
    return `the bridge at ${bridge.baseUrl} answers, but not to this server's token: ${(e as Error).message}. ` +
      `Check X_BRIDGE_TOKEN (or ${join(HOME, 'bridge_token')}) and the address, which is the bridge's own vhost (https://xgate.animalabs.ai).`;
  }
  return null;
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const { url, token } = loadBridge();
  const bridge = new BridgeClient({ baseUrl: url, token: token ?? undefined });
  const auth = loadAuth();

  if (command === 'check') {
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`home ${HOME}`);
    const issuers = await resolveIssuers(auth.issuers, (...said) => out(said.join(' ')));
    out(`over WebSocket: audience ${auth.audience}; issuers ${auth.issuers.map((i) => `${i.domain}${issuers.has(i.domain) ? '' : ' (KEY UNAVAILABLE)'}`).join(', ')}; ` +
      `served: ${auth.subjects.join(' ') || 'NOBODY — set auth.subjects in config.json'}`);
    const problem = await bridgeProblem(bridge);
    if (problem) { out(`bridge FAILED: ${problem}`); process.exitCode = 1; return; }
    const h = await bridge.health();
    out(`bridge ok: ${url}, ${h.tweets} tweets cached, ${h.allow_fetch ? 'fetches from X where a token may' : 'does not fetch from X'}`);
    return;
  }

  const stdio = process.argv.includes('--stdio');
  const port = Number(arg('--ws'));
  const client = arg('--client');
  if (stdio ? !client : !port) {
    process.stderr.write(`${SERVER_NAME} ${VERSION}\nUsage: x-mcpl --ws <port> [--host <h>] | --stdio --client <name> | check\n` +
      `Over stdio --client is needed: the agent's feed is kept under that name.\nHome: ${HOME}\n`);
    process.exit(2);
  }
  const problem = await bridgeProblem(bridge);
  if (problem) { log(problem); process.exit(1); }

  const app: App = { bridge, log, feeds: new FeedStore(join(HOME, 'state')), sourcesOpen: new Set(), checkEveryMs: 5 * 60_000 };

  if (stdio) {
    await new Session(McplConnection.fromStreams(process.stdin, process.stdout), app, client!).serve();
    return;
  }

  if (!auth.subjects.length) {
    process.stderr.write(`${join(HOME, 'config.json')} names nobody to serve: set "auth": { "subjects": ["agent:<name>@id.animalabs.ai", ...] } ("*" serves everyone the home node gives a token to).\n`);
    process.exit(2);
  }
  const host = arg('--host') ?? '127.0.0.1';
  const issuers = await resolveIssuers(auth.issuers, log);
  if (!issuers.size) { log('auth: no issuer key could be resolved, so nobody could be admitted'); process.exit(1); }
  const http = serveWs({ port, host, auth, issuers, app });
  http.on('error', (e) => { log(`http server error on ${host}:${port}:`, e); process.exit(1); });
  http.on('listening', () => log(`${SERVER_NAME} ${VERSION}: listening on ws://${host}:${port}/mcpl; bridge ${url}; audience ${auth.audience}, issuers ${[...issuers.keys()].join(', ')}, serving ${auth.subjects.join(' ')}`));
  const bye = () => { log('shutting down'); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

function isEntryPoint(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isEntryPoint()) main().catch((e) => { log('fatal:', (e as Error).message); process.exit(1); });
