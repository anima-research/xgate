/**
 * Feature set declarations for the X MCPL server (SPEC §6).
 *
 * Feature sets are a cooperative convenience derived from the capability grant
 * (§5.4/§6.4); they are not a security boundary and they confer nothing. `uses`
 * is a closed vocabulary (§6.2 / App. B.2) and is typed as `CapabilityPath[]`
 * so an unrecognised value is a compile error rather than an `invalid_uses`
 * disable at runtime.
 *
 * `hostState` is not a spec field and was dropped in the 0.5 migration. The host
 * still learns which set owns a state checkpoint from the `featureSet` member of
 * the checkpoint itself (see handlers.ts `committed()`), which is where §8.2 puts
 * that information.
 */

import { type CapabilityPath, isCapabilityPath, type CapabilityGrant } from './capabilities.js';

/**
 * A 0.5 feature-set declaration. §6.2 requires `description` and `uses`; §8.1
 * adds the optional `rollback` flag (§8 is unchanged in 0.5.0).
 */
export interface XFeatureSet {
  name: string;
  description: string;
  uses: CapabilityPath[];
  rollback?: boolean;
}

export const featureSets: XFeatureSet[] = [
  {
    name: 'x.read',
    description:
      'Look up tweets, threads, user profiles, timelines, and search the cache. ' +
      'Served cache-first by the bridge; live fetches cost money and are gated bridge-side.',
    uses: ['tools'],
    rollback: false,
  },
  {
    name: 'x.post',
    description: 'Post tweets, replies, and quotes (Phase 4; no tools wired yet).',
    // Posting is a tool surface (post_tweet/reply_tweet/…), not channels/publish:
    // this server has no channels/publish handler at all.
    uses: ['tools'],
    rollback: true, // server-managed undo (wired in Phase 4)
  },
  {
    name: 'x.notifications',
    description:
      'Subscribe to timelines / searches / threads / mentions as channels; the bridge ' +
      'polls per-resource and pushes new items live. For durable, cursor-tracked ' +
      'catch-up use x.feed instead.',
    // This set owns no tools; it is the channel surface — channels/list (register),
    // channels/open + channels/close (lifecycle), and channels/incoming (§14.1).
    uses: ['channels.register', 'channels.lifecycle', 'channels.incoming'],
    rollback: false,
  },
  {
    name: 'x.feed',
    description:
      'A persistent, self-curated feed. Add/remove sources (user timelines, searches, ' +
      'mentions), see per-source unread counts, and pull durable catch-up that advances ' +
      'read cursors. State is host-persisted and survives restarts.',
    uses: ['tools'],
    rollback: true,
  },
  {
    name: 'x.dm',
    description: 'Direct messages (declared now, wired in Phase 5; needs per-account OAuth).',
    uses: ['tools'],
    rollback: true, // server-managed undo (wired in Phase 5)
  },
];

/** Check if a feature set is in a given enabled list (supports `x.*` wildcards). */
export function isEnabled(name: string, enabledSets: Set<string>): boolean {
  if (enabledSets.has(name)) return true;
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.') + '.*';
    if (enabledSets.has(prefix)) return true;
  }
  return false;
}

/** Map a tool name to the feature set that owns it (undefined = always available). */
export function featureSetForTool(toolName: string): string | undefined {
  switch (toolName) {
    case 'lookup_tweet':
    case 'get_thread':
    case 'get_user':
    case 'user_timeline':
    case 'search_tweets':
    case 'get_image':
    case 'transcribe_image':
    case 'peek_thread':
    case 'peek_timeline':
      return 'x.read';
    case 'feed_show':
    case 'feed_add':
    case 'feed_remove':
    case 'feed_mute':
    case 'feed_unmute':
    case 'feed_read':
      return 'x.feed';
    case 'post_tweet':
    case 'reply_tweet':
    case 'quote_tweet':
    case 'delete_tweet':
      return 'x.post';
    case 'send_dm':
      return 'x.dm';
    default:
      return undefined;
  }
}

/** One entry of the degradation receipt's `unavailableFeatures` (§6.7). */
export interface UnavailableFeature {
  featureSet: string;
  missingCapabilities: string[];
  effect: 'disabled';
  /** §6.4 diagnostic reason, when the declaration itself was rejected. */
  reason?: 'invalid_uses';
}

export interface FeatureSetDerivation {
  enabled: Set<string>;
  unavailable: UnavailableFeature[];
}

/**
 * Derive enabled feature sets from the capability grant (§6.4), fail-closed.
 *
 *  1. Absent, empty, or unrecognised `uses` ⇒ invalid; disabled, reason `invalid_uses`.
 *  2. Any capability in `uses` not in the grant ⇒ disabled, and the missing paths are
 *     reported in the receipt as consequence testimony — never as a claim of entitlement.
 *
 * The host's explicit `disabled` list always removes; its `enabled` list can only
 * confirm a set the grant already permits. Feature sets carry no authority of their
 * own, so nothing here can widen the grant.
 */
export function deriveEnabledFeatureSets(
  declarations: readonly XFeatureSet[],
  grant: CapabilityGrant,
  hostEnabled?: readonly string[],
  hostDisabled?: readonly string[],
): FeatureSetDerivation {
  const enabled = new Set<string>();
  const unavailable: UnavailableFeature[] = [];
  const disabledSet = new Set(hostDisabled ?? []);
  const enabledSet = hostEnabled ? new Set(hostEnabled) : undefined;

  for (const fs of declarations) {
    const uses = fs.uses as unknown[];
    if (!Array.isArray(uses) || uses.length === 0 || !uses.every(isCapabilityPath)) {
      unavailable.push({
        featureSet: fs.name,
        missingCapabilities: [],
        effect: 'disabled',
        reason: 'invalid_uses',
      });
      continue;
    }
    const missing = grant.missing(fs.uses);
    if (missing.length > 0) {
      unavailable.push({ featureSet: fs.name, missingCapabilities: missing, effect: 'disabled' });
      continue;
    }
    if (isEnabled(fs.name, disabledSet)) {
      unavailable.push({ featureSet: fs.name, missingCapabilities: [], effect: 'disabled' });
      continue;
    }
    // An explicit `enabled` list, when the host sends one, is a restriction on top
    // of the derivation — never a widening of it.
    if (enabledSet && !isEnabled(fs.name, enabledSet)) {
      unavailable.push({ featureSet: fs.name, missingCapabilities: [], effect: 'disabled' });
      continue;
    }
    enabled.add(fs.name);
  }

  return { enabled, unavailable };
}
