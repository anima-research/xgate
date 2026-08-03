/**
 * MCPL 0.5 capability grants, advertisement shape, and fail-closed feature-set
 * derivation.
 *
 * These types live here rather than in `@animalabs/mcpl-core` because the
 * published core (v0.2.2) still models 0.4: `McplCapabilities.channels` is a
 * bare `boolean`, `FeatureSetDeclaration` carries the non-spec `hostState`, and
 * there is no grant type at all. Nothing 0.5-shaped has been released, so this
 * module codes against the specification text directly.
 *
 * Two vocabularies live here and must not be confused:
 *
 *  - The **advertisement** (SPEC §5.1) is a recursive tree mirroring the
 *    capability paths. A boolean `true` at any level is shorthand for "every
 *    leaf beneath this node"; `false` or absence means none.
 *  - The **capability paths** (§6.2 / App. B.2) are the closed, dot-separated
 *    vocabulary that `uses` and `effectiveCapabilities` draw on.
 *
 * `effectiveCapabilities` is the sole normative allowlist (§5.4): every path
 * not present is denied. Absence is denial, never a default-allow, and nothing
 * here is a deny-list.
 */

// ── Capability paths (§6.2 / App. B.2) ──

/**
 * The complete, closed capability-path vocabulary of §6.2. This list is
 * normative: a value outside it is not a capability path, and nothing may
 * invent, abbreviate, or derive others.
 */
export const CAPABILITY_PATHS = [
  'pushEvents',
  'tools',
  'modelInfo',
  'inferenceRequest',
  'inferenceRequest.streaming',
  'inferenceLifecycle',

  'contextHooks.beforeInference.observe',
  'contextHooks.beforeInference.inject.system',
  'contextHooks.beforeInference.inject.beforeUser',
  'contextHooks.beforeInference.inject.afterUser',

  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'channels.streaming',
  'channels.acknowledge',
  'channels.typing',
] as const;

export type CapabilityPath = (typeof CAPABILITY_PATHS)[number];

const CAPABILITY_PATH_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_PATHS);

/** Type guard for the closed §6.2 vocabulary. */
export function isCapabilityPath(value: unknown): value is CapabilityPath {
  return typeof value === 'string' && CAPABILITY_PATH_SET.has(value);
}

// ── Advertisement (§5.1) ──

/**
 * Recursive advertisement node: `true` means every leaf beneath this point,
 * `false`/absent means none, an object names the leaves explicitly.
 */
export type CapabilityAdvertisement = boolean | { [segment: string]: CapabilityAdvertisement };

/**
 * The `experimental.mcpl` object — flat, with capability members at the top
 * level and `featureSets` among them (§5.1, §17.1). This is the server's
 * manifest.
 */
export interface McplAdvertisement {
  version: string;
  /** §17.2 canonical content digest. Omitted: this server does not implement §17. */
  revision?: string;
  featureSets?: XFeatureSet[];
  /** Capability members, mirroring the §6.2 path tree. */
  [member: string]: unknown;
}

// ── Feature-set declaration (§6.1, App. B.2, §8.1) ──

/**
 * App. B.2 requires `description` and `uses`; §8.1 keeps `rollback` on the
 * feature set. `hostState` is not a spec field and is not declared here — the
 * host/server split for state is signalled per-response by the presence of
 * `data`/`patch` (§8.3), not by a declaration flag.
 *
 * `name` is this codebase's representation of the declaration's map key.
 */
export interface XFeatureSet {
  name: string;
  description: string;
  uses: string[];
  rollback?: boolean;
}

// ── The grant (§5.4) ──

/**
 * Match one `effectiveCapabilities` entry against one capability path.
 *
 * §5.4: "Matching is over full paths with `*` wildcards, and implementations
 * MUST perform a generic recursive walk — a hardcoded set of nestable keys is
 * non-conforming, since the vocabulary is depth 3 and will grow." This walk is
 * generic over segments and knows no capability names.
 *
 * A `*` segment matches exactly one segment. A shorter entry does NOT match a
 * longer path: `channels` alone does not grant `channels.incoming`. §5.4 makes
 * `effectiveCapabilities` an allowlist of paths in which "every path not
 * present is denied", so implying descendants would be a default-allow.
 */
function entryMatchesPath(entry: string, path: string): boolean {
  const e = entry.split('.');
  const p = path.split('.');
  if (e.length !== p.length) return false;
  return e.every((seg, i) => seg === '*' || seg === p[i]);
}

/**
 * The effective capability grant: the sole normative allowlist (§5.4).
 *
 * Absence of a path is denial. A `CapabilityGrant` is never widened by anything
 * a peer says outside a `featureSets/update` Request (§6.6, §6.7, §16.6).
 */
export class CapabilityGrant {
  /** No grant at all — the pre-policy state mandated by §5.3. */
  static readonly EMPTY = new CapabilityGrant([]);

  private readonly entries: readonly string[];

  constructor(entries: readonly string[]) {
    this.entries = [...entries];
  }

  has(path: CapabilityPath): boolean {
    return this.entries.some((e) => entryMatchesPath(e, path));
  }

  /** Narrow to the intersection with `other`. Never widens. */
  intersect(other: CapabilityGrant): CapabilityGrant {
    const kept = CAPABILITY_PATHS.filter((p) => this.has(p) && other.has(p));
    return new CapabilityGrant(kept);
  }

  get list(): readonly string[] {
    return this.entries;
  }
}

// ── featureSets/update (§5.3, §6.7) ──

/** `featureSets/update` params (Host → Server, Notification or Request). */
export interface PolicyParams {
  effectiveCapabilities?: unknown;
  deniedCapabilities?: unknown;
  enabled?: unknown;
  disabled?: unknown;
}

export interface PolicyValidation {
  /** Set when the message must be rejected as malformed (§5.4). */
  malformed?: string;
  effectiveCapabilities: string[];
  enabled: string[];
  disabled: string[];
  /** Present but carries no authority (§5.4): diagnostic data only. */
  deniedCapabilities: string[];
}

function stringArray(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === 'string')) return null;
  return v as string[];
}

/**
 * Validate a policy message. §5.4: "If a path appears in both
 * [effectiveCapabilities and deniedCapabilities], the receiving side MUST fail
 * closed and reject the policy message as malformed."
 *
 * `deniedCapabilities` is parsed only to run that consistency check; it "MUST
 * NOT participate in any authorization decision" and is never consulted below.
 */
export function validatePolicy(params: PolicyParams | undefined): PolicyValidation {
  const p = params ?? {};
  const effective = stringArray(p.effectiveCapabilities);
  const denied = stringArray(p.deniedCapabilities);
  const enabled = stringArray(p.enabled);
  const disabled = stringArray(p.disabled);

  const base: PolicyValidation = {
    effectiveCapabilities: effective ?? [],
    deniedCapabilities: denied ?? [],
    enabled: enabled ?? [],
    disabled: disabled ?? [],
  };

  if (effective === null || denied === null || enabled === null || disabled === null) {
    return { ...base, malformed: 'policy fields must be arrays of strings' };
  }
  const overlap = effective.filter((e) => denied.includes(e));
  if (overlap.length > 0) {
    return {
      ...base,
      malformed: `path in both effectiveCapabilities and deniedCapabilities: ${overlap.join(', ')}`,
    };
  }
  return base;
}

// ── Derivation (§6.4) ──

export type DerivationStatus =
  | { enabled: true }
  | { enabled: false; reason: 'invalid_uses' }
  | { enabled: false; reason: 'capability_denied'; missingCapabilities: string[] };

/**
 * Derive a feature set's availability from the grant. §6.4 requires this to
 * fail closed:
 *
 *  1. Absent, empty, or unrecognized `uses` ⇒ invalid; disabled with reason
 *     `invalid_uses`. We do not guess what it meant.
 *  2. Valid but incomplete `uses` ⇒ the connection grant still protects; the
 *     declaration was never the security boundary.
 */
export function deriveFeatureSet(set: XFeatureSet, grant: CapabilityGrant): DerivationStatus {
  const uses = set.uses;
  if (!Array.isArray(uses) || uses.length === 0) return { enabled: false, reason: 'invalid_uses' };
  if (!uses.every(isCapabilityPath)) return { enabled: false, reason: 'invalid_uses' };

  const missing = uses.filter((u) => !grant.has(u as CapabilityPath));
  if (missing.length > 0) {
    return { enabled: false, reason: 'capability_denied', missingCapabilities: missing };
  }
  return { enabled: true };
}

// ── Degradation receipt (§6.7) ──

export interface UnavailableFeature {
  featureSet: string;
  missingCapabilities: string[];
  effect: 'disabled';
}

/**
 * The response to a `featureSets/update` Request is a degradation receipt, not
 * an acknowledgement (§6.7).
 *
 * It reports what this server *will do*. It never asserts what this server is
 * *entitled to*: §6.7 bars the host from widening any grant in response to a
 * receipt, and a receipt that asked for capabilities would be the coercion
 * lever that rule exists to remove.
 */
export interface DegradationReceipt {
  accepted: boolean;
  mode?: 'full' | 'degraded';
  unavailableFeatures?: UnavailableFeature[];
  notes?: string[];
}
