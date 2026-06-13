/**
 * Tool dispatch — maps an MCP tool call to the BridgeClient and returns a
 * JSON-able result. Kept separate from server.ts so it's testable against a
 * live bridge without an MCPL host (see test/handlers.test.ts).
 */

import type { ContentBlock } from '@connectome/mcpl-core';
import { textContent } from '@connectome/mcpl-core';
import type { BridgeClient, BridgeMedia } from './bridge-client.js';

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** When set, the server uses these blocks verbatim as the tool result content
   *  (e.g. image blocks for get_image) instead of JSON-encoding `data`. */
  content?: ContentBlock[];
}

/** Build an MCPL image block (uri the host fetches from the bridge) plus any
 *  alt-text / transcription as adjacent text. */
function imageBlocks(bridge: BridgeClient, media: BridgeMedia[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const m of media) {
    if (m.type && m.type !== 'photo' && m.type !== 'animated_gif') continue;
    blocks.push({ type: 'image', uri: bridge.mediaUrl(m.media_id) } as ContentBlock);
    const caption = m.alt_text || m.transcription;
    if (caption) blocks.push(textContent(`[${m.media_id}] ${caption}`));
  }
  return blocks;
}

export async function handleToolCall(
  bridge: BridgeClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'lookup_tweet': {
        const t = await bridge.getTweet(String(args.tweetId), Boolean(args.fresh), Boolean(args.transcribe));
        return t ? { ok: true, data: t } : { ok: false, error: 'not found / not cached' };
      }
      case 'get_thread': {
        const tweets = await bridge.getThread(String(args.conversationId), Boolean(args.transcribe));
        return { ok: true, data: { count: tweets.length, tweets } };
      }
      case 'get_image': {
        let media: BridgeMedia[] = [];
        if (args.mediaId) {
          // Resolve the one media row via any tweet that carries it.
          const mid = String(args.mediaId);
          // get_image by mediaId: we need the tweet to read alt/transcription;
          // simplest is to fetch transcription (which also caches) and synthesize.
          const transcription = await bridge.transcribeImage(mid);
          media = [{ media_id: mid, url: null, type: 'photo', width: null, height: null,
                     transcription, alt_text: null }];
        } else if (args.tweetId) {
          const t = await bridge.getTweet(String(args.tweetId), false, true);
          if (!t) return { ok: false, error: 'tweet not found / not cached' };
          media = t.media;
        } else {
          return { ok: false, error: 'provide mediaId or tweetId' };
        }
        const blocks = imageBlocks(bridge, media);
        if (!blocks.length) return { ok: false, error: 'no displayable images' };
        return { ok: true, content: blocks, data: { images: media.length } };
      }
      case 'transcribe_image': {
        const text = await bridge.transcribeImage(String(args.mediaId));
        return text
          ? { ok: true, data: { media_id: args.mediaId, transcription: text } }
          : { ok: false, error: 'transcription unavailable (no credential or fetch failed)' };
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
          Boolean(args.transcribe),
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
