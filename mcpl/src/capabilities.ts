/**
 * MCPL 0.5 capability grants (SPEC §5.4, §6.2, §6.4).
 *
 * The capability grant is the security boundary. Nothing in this file consults
 * anything the server says about itself: `effectiveCapabilities` as sent by the
 * host is the sole normative allowlist, every path not present is denied, and
 * `deniedCapabilities` is diagnostic data that MUST NOT participate in any
 * authorization decision (§5.4).
 *
 * `@animalabs/mcpl-core` still carries the 0.4 shapes (flat `channels: boolean`,
 * `FeatureSetDeclaration.hostState`), so the 0.5 types live here rather than
 * blocking on a released core.
 */

/**
 * The closed capability vocabulary — SPEC §6.2 and Appendix B.2, verbatim.
 * `uses` MUST contain only these values; anything else makes the declaration
 * invalid (§6.2).
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

const CAPABILITY_PATH_SET: ReadonlySet<string> = new Set(CAPABILITY_PATHS);

export function isCapabilityPath(value: unknown): value is CapabilityPath {
  return typeof value === 'string' && CAPABILITY_PATH_SET.has(value);
}

/**
 * Generic recursive segment walk over a dot-separated path (§5.4: "implementations
 * MUST perform a generic recursive walk — a hardcoded set of nestable keys is
 * non-conforming").
 *
 * A granted entry matches a required path when every segment is either equal or
 * `*`. A trailing `*` also matches one or more remaining segments, so `channels.*`
 * covers `channels.incoming` and `*` covers everything. A bare prefix is NOT a
 * wildcard: `channels` does not grant `channels.incoming` — absence is denial.
 */
function segmentsMatch(granted: string[], required: string[], gi = 0, ri = 0): boolean {
  if (gi === granted.length) return ri === required.length;
  const seg = granted[gi];
  if (seg === '*' && gi === granted.length - 1) {
    // Trailing wildcard: consume one or more remaining segments.
    return ri < required.length;
  }
  if (ri >= required.length) return false;
  if (seg !== '*' && seg !== required[ri]) return false;
  return segmentsMatch(granted, required, gi + 1, ri + 1);
}

export class MalformedPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedPolicyError';
  }
}

/**
 * A host-computed capability grant. Constructed empty: until the initial policy
 * exchange completes, every capability-dependent behavior is unavailable (§5.3).
 */
export class CapabilityGrant {
  private readonly granted: string[][];

  private constructor(entries: string[]) {
    this.granted = entries.map((e) => e.split('.'));
  }

  /** The empty grant — denies everything. This is the correct default (§5.4). */
  static empty(): CapabilityGrant {
    return new CapabilityGrant([]);
  }

  /**
   * Build a grant from a `featureSets/update` payload.
   *
   * `deniedCapabilities` is read only to detect the contradiction §5.4 requires
   * us to fail closed on; it never contributes to what is allowed.
   *
   * @throws MalformedPolicyError if a path appears in both lists.
   */
  static fromPolicy(effective: unknown, denied: unknown): CapabilityGrant {
    const eff = toStringArray(effective);
    const den = toStringArray(denied);
    const denSet = new Set(den);
    const both = eff.filter((p) => denSet.has(p));
    if (both.length > 0) {
      throw new MalformedPolicyError(
        `path(s) in both effectiveCapabilities and deniedCapabilities: ${both.join(', ')}`,
      );
    }
    return new CapabilityGrant(eff);
  }

  /** Does the grant permit this capability path? Absence is denial (§5.4). */
  allows(path: CapabilityPath): boolean {
    const required = path.split('.');
    return this.granted.some((g) => segmentsMatch(g, required));
  }

  /**
   * Is this grant no wider than `other` over the whole §6.2 vocabulary?
   *
   * Used to tell a reduction from an expansion when a host sends the policy in a
   * form that may not carry a grant change (§6.7: `featureSets/update` MUST be a
   * Request for any change to the effective grant). A reduction may be applied
   * from either form; an expansion may not.
   */
  isNoWiderThan(other: CapabilityGrant): boolean {
    return CAPABILITY_PATHS.every((p) => !this.allows(p) || other.allows(p));
  }

  /** Which of these paths are NOT granted (diagnostics for the receipt, §6.7). */
  missing(paths: readonly CapabilityPath[]): CapabilityPath[] {
    return paths.filter((p) => !this.allows(p));
  }

  get entries(): string[] {
    return this.granted.map((g) => g.join('.'));
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
