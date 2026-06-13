/**
 * Tool dispatch — maps an MCP tool call to the BridgeClient and returns a
 * JSON-able result. Kept separate from server.ts so it's testable against a
 * live bridge without an MCPL host (see test/handlers.test.ts).
 */

import type { BridgeClient } from './bridge-client.js';

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export async function handleToolCall(
  bridge: BridgeClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'lookup_tweet': {
        const t = await bridge.getTweet(String(args.tweetId), Boolean(args.fresh));
        return t ? { ok: true, data: t } : { ok: false, error: 'not found / not cached' };
      }
      case 'get_thread': {
        const tweets = await bridge.getThread(String(args.conversationId));
        return { ok: true, data: { count: tweets.length, tweets } };
      }
      case 'get_user': {
        const u = await bridge.getUser(String(args.handle));
        return u ? { ok: true, data: u } : { ok: false, error: 'unknown user (not in cache)' };
      }
      case 'user_timeline': {
        const tweets = await bridge.userTimeline(
          String(args.handle),
          typeof args.limit === 'number' ? args.limit : 50,
          args.before ? String(args.before) : undefined,
        );
        return { ok: true, data: { count: tweets.length, tweets } };
      }
      case 'search_tweets': {
        const tweets = await bridge.search(
          String(args.query),
          typeof args.limit === 'number' ? args.limit : 50,
        );
        return { ok: true, data: { count: tweets.length, tweets } };
      }
      default:
        return { ok: false, error: `unknown or not-yet-implemented tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
