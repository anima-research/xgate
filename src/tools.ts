/**
 * MCP tool definitions for X operations. Mirrors discord-mcpl/src/tools.ts.
 * Phase 2 ships the x.read tools; post/dm tools are declared for the roadmap
 * but their handlers arrive in Phase 4/5.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const toolDefinitions: ToolDefinition[] = [
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
    description: 'Fetch a user’s tweets newest-first from the cache.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '@handle or numeric user id' },
        limit: { type: 'number', description: 'Max tweets to return (default 50, max 200)' },
        before: { type: 'string', description: 'ISO timestamp; return only tweets older than this (paging)' },
        transcribe: { type: 'boolean', description: 'Batch-transcribe all images in the returned tweets' },
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
    description: 'Full-text search over cached tweets (FTS5).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'FTS5 query string' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      },
      required: ['query'],
    },
  },
];
