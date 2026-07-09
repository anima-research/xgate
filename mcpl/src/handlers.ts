/**
 * Tool dispatch — maps an MCP tool call to the BridgeClient and returns a
 * result. Kept separate from server.ts so it's testable against a live bridge
 * without an MCPL host (see test/handlers.test.ts).
 *
 * Read tools render compact, readable text by default (format:"compact") and
 * fall back to raw JSON only when asked (format:"full"). Feed tools (x.feed)
 * are stateful: they read the host-injected feed state and return an updated
 * state checkpoint the host persists.
 */

import type { ContentBlock } from '@connectome/mcpl-core';
import { textContent } from '@connectome/mcpl-core';
import type { BridgeClient, BridgeMedia, BridgeTweet } from './bridge-client.js';
import {
  renderTweet,
  renderList,
  renderThreadPreview,
  renderTimelinePreview,
} from './render.js';
import {
  type FeedState,
  type FeedSource,
  normalizeState,
  addSource,
  removeSource,
  setMuted,
  findSource,
  advanceCursor,
  bump,
  checkpointFor,
  newSince,
  renderSources,
  renderItems,
} from './feed.js';

export interface ToolStateCheckpoint {
  checkpoint: string;
  parent: string | null;
  data: unknown;
  /** Owning feature set — the authoritative signal hosts use to attribute this
   *  checkpoint to the right set when recording (wins over any tool tag). */
  featureSet?: string;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** When set, the server uses these blocks verbatim as the tool result content
   *  (e.g. image blocks for get_image) instead of JSON-encoding `data`. */
  content?: ContentBlock[];
  /** Rendered compact text; the server prefers this over JSON.stringify(data). */
  text?: string;
  /** State checkpoint for stateful (x.feed) tools; the host persists it. */
  state?: ToolStateCheckpoint;
}

function isFull(args: Record<string, unknown>): boolean {
  return args.format === 'full';
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
  injectedState?: unknown,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'lookup_tweet': {
        const t = await bridge.getTweet(String(args.tweetId), Boolean(args.fresh), Boolean(args.transcribe));
        if (!t) return { ok: false, error: 'not found / not cached' };
        return { ok: true, data: t, text: isFull(args) ? undefined : renderTweet(t) };
      }
      case 'get_thread': {
        const tweets = await bridge.getThread(String(args.conversationId), Boolean(args.transcribe));
        return {
          ok: true,
          data: { count: tweets.length, tweets },
          text: isFull(args) ? undefined : renderList(tweets, { title: `thread ${args.conversationId}` }),
        };
      }
      case 'user_timeline': {
        const tweets = await bridge.userTimeline(
          String(args.handle),
          typeof args.limit === 'number' ? args.limit : 50,
          args.before ? String(args.before) : undefined,
          Boolean(args.transcribe),
          args.since ? String(args.since) : undefined,
        );
        return {
          ok: true,
          data: { count: tweets.length, tweets },
          text: isFull(args) ? undefined : renderList(tweets, { title: `@${String(args.handle).replace(/^@/, '')}` }),
        };
      }
      case 'search_tweets': {
        const query = args.query ? String(args.query) : undefined;
        const filters = {
          author: args.author ? String(args.author) : undefined,
          since: args.since ? String(args.since) : undefined,
          until: args.until ? String(args.until) : undefined,
          tier: args.tier ? String(args.tier) : undefined,
        };
        if (!query && !filters.author && !filters.since && !filters.until && !filters.tier) {
          return { ok: false, error: 'provide query and/or a filter (author, since, until, tier)' };
        }
        const tweets = await bridge.search(
          query,
          typeof args.limit === 'number' ? args.limit : 50,
          filters,
        );
        const parts = [
          query ? `search “${query}”` : 'archive query',
          filters.author ? `@${filters.author.replace(/^@/, '')}` : '',
          filters.tier ? `tier:${filters.tier}` : '',
          filters.since || filters.until ? `${filters.since ?? '…'}→${filters.until ?? 'now'}` : '',
        ].filter(Boolean);
        return {
          ok: true,
          data: { count: tweets.length, tweets },
          text: isFull(args) ? undefined : renderList(tweets, { title: parts.join(' · ') }),
        };
      }
      case 'peek_thread': {
        const p = await bridge.threadPreview(String(args.conversationId));
        if (!p || !p.count) return { ok: false, error: 'thread not found / not cached' };
        return { ok: true, data: p, text: isFull(args) ? undefined : renderThreadPreview(p) };
      }
      case 'peek_timeline': {
        const p = await bridge.timelinePreview(String(args.handle));
        if (!p) return { ok: false, error: 'no preview available' };
        return { ok: true, data: p, text: isFull(args) ? undefined : renderTimelinePreview(p) };
      }
      case 'get_image': {
        let media: BridgeMedia[] = [];
        if (args.mediaId) {
          const mid = String(args.mediaId);
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
          ? { ok: true, data: { media_id: args.mediaId, transcription: text }, text }
          : { ok: false, error: 'transcription unavailable (no credential or fetch failed)' };
      }
      case 'get_user': {
        const u = await bridge.getUser(String(args.handle));
        return u ? { ok: true, data: u } : { ok: false, error: 'unknown user (not in cache)' };
      }

      // ── x.feed (stateful) ──
      case 'feed_show':
      case 'feed_add':
      case 'feed_remove':
      case 'feed_mute':
      case 'feed_unmute':
      case 'feed_read':
        return handleFeedCall(bridge, name, args, normalizeState(injectedState));

      default:
        return { ok: false, error: `unknown or not-yet-implemented tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** The host-managed feature set these stateful tools belong to. */
const FEED_FEATURE_SET = 'x.feed';

/** Wrap a mutated feed state as a tool result carrying the persist-able checkpoint. */
function committed(prev: FeedState, mutated: FeedState, text: string): ToolResult {
  const next = bump(mutated);
  // Tag the checkpoint with its feature set so the host attributes it correctly
  // even when the server has multiple stateful sets (it never has to guess).
  return { ok: true, text, state: { ...checkpointFor(prev.seq, next), featureSet: FEED_FEATURE_SET } };
}

async function handleFeedCall(
  bridge: BridgeClient,
  name: string,
  args: Record<string, unknown>,
  state: FeedState,
): Promise<ToolResult> {
  switch (name) {
    case 'feed_show': {
      const unread = await computeUnread(bridge, state, state.sources);
      return { ok: true, text: renderSources(state, unread), data: state };
    }
    case 'feed_add': {
      const kind = String(args.kind) as FeedSource['kind'];
      if (!['timeline', 'search', 'mentions'].includes(kind)) {
        return { ok: false, error: `bad kind: ${kind}` };
      }
      const { state: next, source, added } = addSource(state, {
        kind,
        value: String(args.value),
        label: args.label ? String(args.label) : undefined,
      });
      if (!added) return { ok: true, text: `already in feed: ${source.kind}:${source.value}`, data: state };
      // Prime the source so the feed has content right away — and so the agent
      // learns immediately if nothing is cached / fetching is disabled. This is
      // the same read-through a feed_read would do, just earlier; no extra cost.
      let note = '';
      if (args.prime !== false) {
        try {
          const warm = await fetchSource(bridge, next, source, 20, false);
          note = warm.length
            ? ` — ${warm.length} recent tweet(s) available; run feed_read to see them`
            : ' — but 0 tweets are cached for it yet (the bridge may have fetching disabled, or has not seen this source)';
        } catch (e) {
          note = ` — (could not prime: ${(e as Error).message})`;
        }
      }
      return committed(state, next, `added ${source.kind}:${source.value} to feed (${next.sources.length} source(s))${note}`);
    }
    case 'feed_remove': {
      const { state: next, removed } = removeSource(state, String(args.source));
      if (!removed) return { ok: false, error: `no such source: ${args.source}` };
      return committed(state, next, `removed ${removed.kind}:${removed.value} from feed`);
    }
    case 'feed_mute':
    case 'feed_unmute': {
      const muted = name === 'feed_mute';
      const { state: next, source } = setMuted(state, String(args.source), muted);
      if (!source) return { ok: false, error: `no such source: ${args.source}` };
      return committed(state, next, `${muted ? 'muted' : 'unmuted'} ${source.kind}:${source.value}`);
    }
    case 'feed_read': {
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const peek = Boolean(args.peek);
      const unreadOnly = args.unread_only !== false; // default: only items past the cursor
      const filter = Array.isArray(args.sources)
        ? new Set((args.sources as unknown[]).map((s) => findSource(state, String(s))?.id).filter(Boolean) as string[])
        : null;
      const targets = state.sources.filter(
        (s) => !s.muted && (!filter || filter.has(s.id)),
      );
      const groups = await Promise.all(
        targets.map(async (s) => ({ source: s, tweets: await fetchSource(bridge, state, s, limit, unreadOnly) })),
      );
      const text = renderItems(groups);
      // Cursors advance only on a true unread catch-up (the default). A
      // latest-regardless browse (unread_only:false) or peek is non-destructive.
      const advance = unreadOnly && !peek;
      if (!advance) return { ok: true, text, data: { groups: groups.map((g) => ({ id: g.source.id, count: g.tweets.length })) } };
      let next = state;
      for (const g of groups) next = advanceCursor(next, g.source.id, g.tweets[0]);
      const changed = groups.some((g) => g.tweets.length > 0);
      if (!changed) return { ok: true, text, data: { new: 0 } };
      return committed(state, next, text);
    }
    default:
      return { ok: false, error: `unknown feed tool: ${name}` };
  }
}

/**
 * Fetch tweets for a source, newest-first (bounded by limit). When `unreadOnly`,
 * keep only items past the source's read cursor; otherwise return the latest
 * regardless of read state (a browse). Both go through the bridge's cache-first
 * read-through, so a stale source is refreshed if the bridge has fetch enabled.
 */
async function fetchSource(
  bridge: BridgeClient,
  state: FeedState,
  source: FeedSource,
  limit: number,
  unreadOnly: boolean,
): Promise<BridgeTweet[]> {
  let tweets: BridgeTweet[] = [];
  if (source.kind === 'timeline') {
    tweets = await bridge.userTimeline(source.value, limit);
  } else if (source.kind === 'search') {
    tweets = await bridge.search(source.value, limit);
  } else if (source.kind === 'mentions') {
    tweets = await bridge.search(`@${source.value.replace(/^@/, '')}`, limit);
  }
  // Search is rank-ordered, timelines are time-ordered. Normalize to strictly
  // newest-first so the rendered list AND the cursor (advanced to tweets[0])
  // are both chronological — otherwise newer-by-time items leak across reads.
  const selected = unreadOnly ? newSince(state.cursors[source.id], tweets) : tweets;
  return selected
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .slice(0, limit);
}

/** Per-source unread counts for feed_show. Best-effort; uses previews/cache only. */
async function computeUnread(
  bridge: BridgeClient,
  state: FeedState,
  sources: FeedSource[],
): Promise<Record<string, number | undefined>> {
  const out: Record<string, number | undefined> = {};
  await Promise.all(
    sources.map(async (s) => {
      if (s.muted) {
        out[s.id] = undefined;
        return;
      }
      try {
        out[s.id] = (await fetchSource(bridge, state, s, 50, true)).length;
      } catch {
        out[s.id] = undefined;
      }
    }),
  );
  return out;
}
