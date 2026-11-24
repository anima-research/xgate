// Archipelago `aid1` verification (the audience contract) — offline, multi-issuer.
// Copied from ecowitt-mcpl/src/auth.ts (its verifier from games-mcpl), unchanged below this header.
//
// aid1.<b64url(payload json)>.<b64url(ed25519 signature over "aid1.<payload>")>
// Verify the literal bytes, then parse. Never re-canonicalize.

import { createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

export type PrincipalKind = 'human' | 'agent' | 'service';

export interface Identity {
  sub: string;
  name: string;
  kind: PrincipalKind;
  issuer: string;
  scopes: string[];
  exp: number;
}

export class AuthFault extends Error {
  constructor(message: string, public reason: string) { super(message); }
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromString(key: string): KeyObject {
  if (!key.startsWith('ed25519:')) throw new Error('issuer key must be ed25519:<b64url>');
  const raw = Buffer.from(key.slice(8), 'base64url');
  if (raw.length !== 32) throw new Error('issuer key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

export interface VerifierOptions {
  audience: string;
  /** domain → public key */
  issuers: Map<string, KeyObject>;
  requiredScopes: string[];
  /** Allowed `sub` patterns (`*` = any run of characters). Empty = any subject the issuer vouches for. */
  subjects: string[];
  now?: () => number;
}

export function subjectMatches(pattern: string, sub: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(sub);
}

/** Throws AuthFault on any defect; the reason is for the server log only. */
export function verifyAid1(token: string, opts: VerifierOptions): Identity {
  const why = (reason: string): never => { throw new AuthFault('A valid Archipelago identity token is required.', reason); };
  if (typeof token !== 'string' || token.length > 16384) why('shape');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'aid1') why('shape');
  let payload: any;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { why('payload'); }
  const key = opts.issuers.get(payload?.iss);
  if (!key) why(`untrusted issuer ${String(payload?.iss)}`);
  let ok = false;
  try { ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key!, Buffer.from(parts[2], 'base64url')); } catch { ok = false; }
  if (!ok) why('signature');
  const now = (opts.now?.() ?? Date.now()) / 1000;
  if (payload.v !== 1) why('version');
  if (payload.aud !== opts.audience) why(`audience ${String(payload.aud)}`);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) why('expired');
  if (!Number.isFinite(payload.iat) || payload.iat > now + 300) why('iat');
  if (!['human', 'agent', 'service'].includes(payload.kind)) why('kind');
  if (typeof payload.sub !== 'string' || !payload.sub.startsWith(`${payload.kind}:`) || payload.sub.length > 512 || !/^[A-Za-z0-9._~:@+=\/-]+$/.test(payload.sub)) why('sub');
  if (typeof payload.name !== 'string' || !payload.name || payload.name.length > 200) why('name');
  if (!Array.isArray(payload.scopes) || !payload.scopes.every((s: unknown) => typeof s === 'string')) why('scopes');
  for (const s of opts.requiredScopes) if (!payload.scopes.includes(s)) why(`missing scope ${s}`);
  if (opts.subjects.length && !opts.subjects.some((p) => subjectMatches(p, payload.sub))) why(`subject ${payload.sub} not allowed here`);
  return { sub: payload.sub, name: payload.name, kind: payload.kind, issuer: payload.iss, scopes: payload.scopes, exp: payload.exp };
}

/** Resolve issuer keys: pinned, else https://<domain>/.well-known/mcpl-identity. */
export async function resolveIssuers(
  issuers: { domain: string; publicKey?: string }[],
  log: (...a: unknown[]) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, KeyObject>> {
  const map = new Map<string, KeyObject>();
  for (const iss of issuers) {
    let key = iss.publicKey;
    if (!key) {
      try {
        const res = await fetchImpl(`https://${iss.domain}/.well-known/mcpl-identity`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const wk = await res.json() as { scheme?: string; domain?: string; publicKey?: string };
        if (wk.scheme !== 'ed25519' || wk.domain !== iss.domain || typeof wk.publicKey !== 'string') throw new Error('malformed well-known document');
        key = wk.publicKey;
      } catch (e) {
        log(`auth: issuer ${iss.domain}: key unavailable (${(e as Error).message}); its tokens will be refused. Pin auth.issuers[].publicKey in config.json.`);
        continue;
      }
    }
    map.set(iss.domain, publicKeyFromString(key));
  }
  return map;
}

/** Test helper: mint an aid1 token with a given private key. */
export function mintAid1(privateKey: KeyObject, p: { iss: string; sub: string; kind: PrincipalKind; name: string; aud: string; scopes: string[]; ttlSeconds: number }): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = { v: 1, iss: p.iss, sub: p.sub, kind: p.kind, name: p.name, aud: p.aud, scopes: p.scopes, iat, exp: iat + p.ttlSeconds, jti: randomBytes(12).toString('base64url') };
  const head = `aid1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${head}.${sign(null, Buffer.from(head), privateKey).toString('base64url')}`;
}
