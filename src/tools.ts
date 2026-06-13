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
      'refetch (costs money — use sparingly, e.g. to refresh like/RT counts).',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: 'Numeric tweet id' },
        fresh: { type: 'boolean', description: 'Force a live refetch instead of serving cache' },
      },
      required: ['tweetId'],
    },
  },
  {
    name: 'get_thread',
    description: 'Fetch all cached tweets in a conversation (thread), oldest-first.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation id (root tweet id of the thread)' },
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
      },
      required: ['handle'],
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
