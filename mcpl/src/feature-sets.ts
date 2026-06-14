/**
 * Feature set declarations for the X MCPL server.
 *
 * Mirrors discord-mcpl/src/feature-sets.ts. Note hostState: the bridge is
 * user-agnostic, so read/unread cursors and notification high-water marks are
 * HOST-persisted state (hostState: true) — see x-bridge/DESIGN.md.
 */

import type { FeatureSetDeclaration } from '@connectome/mcpl-core';

// State model: `hostState: true` is HOST-managed (the host stores full state and
// injects it as `params.state`) and is single-valued by protocol — so x.feed is
// the one host-managed set. `rollback: true` (with hostState:false) is
// SERVER-managed: the host only tracks opaque checkpoint ids for undo. x.post /
// x.dm are server-managed. Hosts must thread the HOST-managed set for `state`
// independently of any server-managed sets (see the firstStateful/getStateful
// fixes in mcpl-harness + agent-framework).
export const featureSets: FeatureSetDeclaration[] = [
  {
    name: 'x.read',
    description:
      'Look up tweets, threads, user profiles, timelines, and search the cache. ' +
      'Served cache-first by the bridge; live fetches cost money and are gated bridge-side.',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'x.post',
    description: 'Post tweets, replies, and quotes (Phase 4).',
    uses: ['tools', 'channels.publish'],
    rollback: true, // server-managed undo (wired in Phase 4)
    hostState: false,
  },
  {
    name: 'x.notifications',
    description:
      'Subscribe to timelines / searches / threads / mentions as channels; the bridge ' +
      'polls per-resource and pushes new items live. For durable, cursor-tracked ' +
      'catch-up use x.feed instead.',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'x.feed',
    description:
      'A persistent, self-curated feed. Add/remove sources (user timelines, searches, ' +
      'mentions), see per-source unread counts, and pull durable catch-up that advances ' +
      'read cursors. State is host-persisted and survives restarts.',
    uses: ['tools'],
    rollback: true,
    hostState: true,
  },
  {
    name: 'x.dm',
    description: 'Direct messages (declared now, wired in Phase 5; needs per-account OAuth).',
    uses: ['tools'],
    rollback: true, // server-managed undo (wired in Phase 5)
    hostState: false,
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
