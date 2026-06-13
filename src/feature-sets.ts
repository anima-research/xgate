/**
 * Feature set declarations for the X MCPL server.
 *
 * Mirrors discord-mcpl/src/feature-sets.ts. Note hostState: the bridge is
 * user-agnostic, so read/unread cursors and notification high-water marks are
 * HOST-persisted state (hostState: true) — see x-bridge/DESIGN.md.
 */

import type { FeatureSetDeclaration } from '@connectome/mcpl-core';

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
    rollback: true,
    hostState: false,
  },
  {
    name: 'x.notifications',
    description:
      'Subscribe to timelines / searches / threads / mentions as channels; the bridge ' +
      'polls per-resource and pushes new items. Read cursors are persisted host-side.',
    uses: ['tools'],
    rollback: false,
    hostState: true,
  },
  {
    name: 'x.dm',
    description: 'Direct messages (declared now, wired in Phase 5; needs per-account OAuth).',
    uses: ['tools'],
    rollback: true,
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
      return 'x.read';
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
