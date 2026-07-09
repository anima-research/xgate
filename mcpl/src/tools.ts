/**
 * MCP tool definitions for X operations. Mirrors discord-mcpl/src/tools.ts.
 * Phase 2 ships the x.read tools; post/dm tools are declared for the roadmap
 * but their handlers arrive in Phase 4/5.
 */

import { featureSetForTool } from './feature-sets.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Owning feature set, surfaced in tools/list so the host can attribute
   *  host-managed state to the right set per tool call (no guessing). */
  featureSet?: string;
}

/** Reusable `format` property: compact rendered text (default) vs raw JSON. */
const FORMAT_PROP = {
  format: {
    type: 'string',
    enum: ['compact', 'full'],
    description: 'compact = terse readable text (default); full = raw JSON objects',
  },
} as const;

const baseToolDefinitions: ToolDefinition[] = [
  {
    name: 'lookup_tweet',
    description:
      'Fetch a single tweet by id. Served from cache; set fresh=true to force a live ' +
      'refetch (costs money — use sparingly, e.g. to refresh like/RT counts). Set ' +
      'transcribe=true to also transcribe any images on the tweet.',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: 'Numeric tweet id' },
        fresh: { type: 'boolean', description: 'Force a live refetch instead of serving cache' },
        transcribe: { type: 'boolean', description: 'Transcribe the tweet’s images (vision model)' },
        ...FORMAT_PROP,
      },
      required: ['tweetId'],
    },
  },
  {
    name: 'get_thread',
    description:
      'Fetch all cached tweets in a conversation (thread), oldest-first. Set ' +
      'transcribe=true to transcribe every image in the thread in one batch — ' +
      'recommended when you need to read the images, since it runs them in parallel.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id (root tweet id of the thread)' },
        transcribe: { type: 'boolean', description: 'Batch-transcribe all images in the thread' },
        ...FORMAT_PROP,
      },
      required: ['conversationId'],
    },
  },
  {
    name: 'get_user',
    description: 'Fetch a user profile (currently derived from cached tweets: handle, id, counts, span).',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '@handle (with or without @) or numeric user id' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'user_timeline',
    description:
      'Fetch a user’s tweets newest-first from the cache. Use before/since to page ' +
      'or pull a time range (e.g. since=2024-01-01 & before=2024-02-01).',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '@handle or numeric user id' },
        limit: { type: 'number', description: 'Max tweets to return (default 50, max 200)' },
        before: { type: 'string', description: 'ISO timestamp; only tweets older than this (exclusive upper bound / paging)' },
        since: { type: 'string', description: 'ISO timestamp; only tweets at/after this (inclusive lower bound)' },
        transcribe: { type: 'boolean', description: 'Batch-transcribe all images in the returned tweets' },
        ...FORMAT_PROP,
      },
      required: ['handle'],
    },
  },
  {
    name: 'get_image',
    description:
      'Return the original full-resolution image(s) as image content you can see. ' +
      'Pass a mediaId for one image, or a tweetId for all images on that tweet. ' +
      'Also returns alt-text/transcription as text when available.',
    inputSchema: {
      type: 'object',
      properties: {
        mediaId: { type: 'string', description: 'A single media id (e.g. 3_2043…)' },
        tweetId: { type: 'string', description: 'A tweet id — returns all of its images' },
      },
    },
  },
  {
    name: 'transcribe_image',
    description:
      'Transcribe a single image to text via the vision model (cached after the ' +
      'first call). Useful when you want the text/description without the pixels.',
    inputSchema: {
      type: 'object',
      properties: {
        mediaId: { type: 'string', description: 'The media id to transcribe' },
      },
      required: ['mediaId'],
    },
  },
  {
    name: 'search_tweets',
    description:
      'Query the cached archive. `query` is an FTS5 full-text search (tweet text + ' +
      'image transcriptions) and is OPTIONAL — omit it and pass only filters for a ' +
      'pure range/filter query. Filters: author, since (inclusive ISO date), until ' +
      '(exclusive ISO date), tier (spine|cast|context|bridge). At least one of ' +
      'query/author/since/until/tier is required. E.g. {tier:"spine", author:"repligate", ' +
      'since:"2024-01-01", until:"2024-07-01"}.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'FTS5 query string (optional)' },
        author: { type: 'string', description: 'Restrict to one author (@handle or username)' },
        since: { type: 'string', description: 'Inclusive lower bound (ISO date/timestamp)' },
        until: { type: 'string', description: 'Exclusive upper bound (ISO date/timestamp)' },
        tier: { type: 'string', enum: ['spine', 'cast', 'context', 'bridge'], description: 'Curation tier filter' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
        ...FORMAT_PROP,
      },
    },
  },
  {
    name: 'peek_thread',
    description:
      'Preview a thread WITHOUT fetching the bodies: tweet count, participants (with ' +
      'per-author counts), time span, image count, and the root author. Use this to ' +
      'decide whether a thread is worth opening before you pay to read it.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id (root tweet id)' },
      },
      required: ['conversationId'],
    },
  },
  {
    name: 'peek_timeline',
    description:
      'Preview what is cached for a user’s timeline WITHOUT fetching bodies: how many ' +
      'tweets, the time span, last tweet time, and image count.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '@handle or numeric user id' },
      },
      required: ['handle'],
    },
  },
  // ── x.feed — persistent, host-state-backed curated feed ──
  {
    name: 'feed_show',
    description:
      'Show your curated feed: each source with its per-source unread count and last-seen ' +
      'time. Read-only — does not advance any cursor.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'feed_add',
    description:
      'Add a source to your feed. kind is "timeline" (a user’s tweets), "search" (an FTS ' +
      'query), or "mentions" (mentions of a handle). Idempotent — re-adding is a no-op. ' +
      'On add it primes the source (fetches recent tweets) so the feed has content right ' +
      'away, and reports how many are available.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['timeline', 'search', 'mentions'], description: 'Source type' },
        value: { type: 'string', description: '@handle / numeric id (timeline, mentions) or query (search)' },
        label: { type: 'string', description: 'Optional friendly label' },
        prime: { type: 'boolean', description: 'Default true: fetch recent tweets on add so the feed is not empty. Set false to add without fetching.' },
      },
      required: ['kind', 'value'],
    },
  },
  {
    name: 'feed_remove',
    description: 'Remove a source from your feed (by its id or value, e.g. "@handle").',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source id or value' } },
      required: ['source'],
    },
  },
  {
    name: 'feed_mute',
    description: 'Mute a source: it stays in the feed but is skipped by feed_read.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source id or value' } },
      required: ['source'],
    },
  },
  {
    name: 'feed_unmute',
    description: 'Unmute a previously muted source.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'Source id or value' } },
      required: ['source'],
    },
  },
  {
    name: 'feed_read',
    description:
      'Pull items across all non-muted feed sources, newest-first. By default returns only ' +
      'what is new since each source’s last-seen cursor and advances the cursors (durable ' +
      'catch-up — what you read will not resurface). Set unread_only:false to browse the ' +
      'latest regardless of read state (non-destructive — leaves cursors untouched).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max items per source (default 20)' },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: only read these source ids/values (default: all non-muted)',
        },
        unread_only: {
          type: 'boolean',
          description: 'Default true: only items past each cursor. false = latest regardless of read state (a browse; does not advance cursors).',
        },
        peek: { type: 'boolean', description: 'If true, show items but do NOT advance cursors (catch-up preview)' },
      },
    },
  },
];

/**
 * Tools exposed via tools/list, each tagged with its owning `featureSet` (single
 * source of truth: featureSetForTool). Hosts use this tag to attribute
 * host-managed state to the correct feature set per tool call — essential when a
 * server has more than one stateful feature set (here x.feed alongside the
 * server-managed x.post/x.dm), so the feed's state isn't misattributed/dropped.
 */
export const toolDefinitions: ToolDefinition[] = baseToolDefinitions.map((t) => ({
  ...t,
  featureSet: featureSetForTool(t.name),
}));
