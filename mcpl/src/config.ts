/**
 * Configuration: $XGATE_MCPL_HOME (default ~/.config/xgate-mcpl).
 *
 *   config.json    { "auth": { "subjects": ["agent:<name>@id.animalabs.ai", ...] }, "bridge": { "url": "https://xgate.animalabs.ai" } }
 *   bridge_token   this server's token for the bridge, one line (mode 600). X_BRIDGE_TOKEN in the environment wins over it.
 *   state/         each agent's feed: feed-<agent>.json
 *
 * Over WebSocket an agent is known by its Archipelago identity. Its host asks
 * the home node for an `aid1` token for the audience "xgate" at each dial and
 * sends it with the connection: the agent holds no token of the bridge's, and
 * deploys the server by naming the access ("access": "xgate").
 *
 * Two places decide who gets in. The home node decides who may have a token
 * for the audience. `auth.subjects` here decides whom this server answers, and
 * it has to be set: the home node also gives tokens to principals it doesn't
 * hold to a list of audiences, and what this server fetches from X is paid for.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.XGATE_MCPL_HOME ?? join(homedir(), '.config', 'xgate-mcpl');

export interface AuthConfig {
  audience: string;
  /** Whose tokens are taken. A key left out is read from https://<domain>/.well-known/mcpl-identity at start. */
  issuers: Array<{ domain: string; publicKey?: string }>;
  /** Who is answered: `sub` patterns, `*` for any run of characters. "agent:*@id.animalabs.ai" is every agent of that home. */
  subjects: string[];
  requiredScopes: string[];
}

export const DEFAULT_AUTH: AuthConfig = {
  audience: 'xgate',
  issuers: [{ domain: 'id.animalabs.ai' }],
  subjects: [],
  requiredScopes: [],
};

interface ConfigFile { auth?: Partial<AuthConfig>; bridge?: { url?: string } }

function configFile(home: string): ConfigFile {
  const file = join(home, 'config.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ConfigFile) : {};
}

export function loadAuth(home = HOME): AuthConfig {
  return { ...DEFAULT_AUTH, ...(configFile(home).auth ?? {}) };
}

/** Where the bridge is, and this server's token for it (null: an open bridge, as on localhost). */
export function loadBridge(home = HOME): { url: string; token: string | null } {
  const file = join(home, 'bridge_token');
  return {
    url: process.env.X_BRIDGE_URL?.trim() || configFile(home).bridge?.url || 'https://xgate.animalabs.ai',
    token: process.env.X_BRIDGE_TOKEN?.trim() || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '') || null,
  };
}
