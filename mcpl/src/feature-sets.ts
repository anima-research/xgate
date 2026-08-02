/**
 * Feature set declarations for the X MCPL server (SPEC §6.1, App. B.2).
 *
 * `uses` is a closed vocabulary in 0.5 (§6.2): only the capability paths listed
 * in `grant.ts` are legal, and §6.4's derivation is fail-closed — a feature set
 * whose `uses` is absent, empty, or carries an unrecognized value is invalid and
 * gets disabled with reason `invalid_uses`. Each entry below therefore names
 * only capabilities this server actually exercises; an inaccurate declaration
 * now costs the feature set rather than being cosmetic.
 *
 * `hostState` is gone: it was never a spec field. The host-managed/server-managed
 * split is signalled per response by whether the server includes `data`/`patch`
 * in its state block (§8.3), which x.feed does via handlers.ts. `rollback` stays
 * — §8.1 keeps it on the feature set and §8 is unchanged in 0.5.0.
 */

import type { XFeatureSet } from './grant.js';

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
    description: 'Post tweets, replies, and quotes (Phase 4).',
    // `channels.publish` dropped: this server has no channels/publish handler at
    // all (server.ts handleNotification), so declaring it was the same
    // over-declaration class as `pushEvents`. §6.4(2) makes under-declaration the
    // safe direction — when Phase 4 wires publishing, the host rejects the
    // undeclared use and emits a declaration-mismatch diagnostic; security never
    // depended on the declaration.
    uses: ['tools'],
    rollback: true, // server-managed undo (wired in Phase 4)
  },
  {
    name: 'x.notifications',
    description:
      'Subscribe to timelines / searches / threads / mentions as channels; the bridge ' +
      'polls per-resource and pushes new items live. For durable, cursor-tracked ' +
      'catch-up use x.feed instead.',
    // This set owns no tools (featureSetForTool never returns it). What it
    // actually exercises is the channel surface: channels/list (channels.register
    // per the §14.1 table), channels/open + channels/close (channels.lifecycle),
    // and channels/incoming (channels.incoming). §14.1 permits naming these in
    // `uses` for honest degradation reporting — they are not the authorization,
    // which is the connection grant.
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
