/**
 * The tools, and what they answer.
 *
 * Reading (x.read) asks the bridge and renders text. The feed (x.feed) keeps
 * an agent's sources and how far it has read in each (feed.ts). The three
 * tools that change the feed's sources form the toolset `sources`, which a
 * host that knows toolsets keeps out of the agent's standing tool list.
 */
import { BridgeError, type BridgeClient, type BridgeMedia, type BridgeTweet } from './bridge-client.js';
import {
  FEED_MODES, SOURCE_KINDS, addSource, findSource, markRead, removeSource, renderItems, renderSources, setMode, sourceName, startFromNow, unreadOf,
  type FeedMode, type FeedSource, type FeedSourceKind, type FeedState, type FeedStore,
} from './feed.js';
import { renderList, renderThread, renderThreadPreview, renderTimelinePreview, renderTweet, renderUser } from './render.js';
import { layoutThread, selectForView } from './thread.js';

export const FS_READ = 'x.read';
export const FS_FEED = 'x.feed';
export const FS_EVENTS = 'x.events';
/** The toolset holding the tools that change the feed's sources. */
export const SOURCES_TOOLSET = 'sources';
/** Added to feed_show's description for a host that keeps that toolset out of the tool list. */
export const SOURCES_POINTER = ` The tools that change the list (feed_add, feed_remove, feed_set) are in the toolset "${SOURCES_TOOLSET}".`;

export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult { content: ContentBlock[]; isError?: boolean }

export interface ToolContext {
  bridge: BridgeClient;
  feeds: FeedStore;
  log: (...a: unknown[]) => void;
}

/** Who is calling, and whether new tweets can be sent to it as events. */
export interface Caller { client: string; eventsOn: boolean }

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  featureSet: string;
  toolset?: string;
}

/** The most unread tweets of one source that are looked at. */
const UNREAD_CAP = 200;

const FORMAT = {
  format: { type: 'string', enum: ['compact', 'full'], description: 'compact: readable text (the default). full: the tweets as JSON, with every field.' },
} as const;
const TWEET = 'A tweet\'s id, or its address on x.com or twitter.com.';
const SOURCE = { type: 'string', description: 'A source as feed_show lists it ("timeline:@handle"), or its handle or query alone.' } as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'lookup_tweet',
    featureSet: FS_READ,
    description:
      'One tweet, with what it answers and how much of its thread is cached. A cached tweet costs nothing; one that is not cached is fetched from X, ' +
      'which is paid for (a cent or two). fresh: true fetches it again even so: for when a current count of likes matters. ' +
      'transcribe: true has its images described in words first.',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: TWEET },
        fresh: { type: 'boolean', description: 'Ask X again instead of answering from the cache.' },
        transcribe: { type: 'boolean', description: 'Describe the tweet\'s images in words (a vision model reads them).' },
        ...FORMAT,
      },
      required: ['tweetId'],
    },
  },
  {
    name: 'get_thread',
    featureSet: FS_READ,
    description:
      'The thread a tweet belongs to, as a tree: each tweet under the one it answers. tweetId is any tweet of the thread, its first or a reply deep inside. ' +
      'It shows what the cache holds, which is often not the whole conversation: replies nobody fetched are missing, and a tweet that answers a missing one says so. ' +
      'A thread longer than limit is cut to the tweet you named, the tweets it answers, its replies, then the earliest of the rest. ' +
      'fresh: true first asks X for the conversation\'s tweets of the last seven days, paid for per tweet returned (up to a hundred).',
    inputSchema: {
      type: 'object',
      properties: {
        tweetId: { type: 'string', description: `${TWEET} Any tweet of the thread.` },
        limit: { type: 'number', description: 'The most tweets to show (default 60, at most 500).' },
        fresh: { type: 'boolean', description: 'Ask X for the conversation\'s recent tweets first.' },
        transcribe: { type: 'boolean', description: 'Describe every image in the thread in words.' },
        ...FORMAT,
      },
      required: ['tweetId'],
    },
  },
  {
    name: 'peek_thread',
    featureSet: FS_READ,
    description: 'How big a thread is, without its tweets: how many are cached, by whom, over what time, how many images. tweetId is any tweet of it.',
    inputSchema: { type: 'object', properties: { tweetId: { type: 'string', description: `${TWEET} Any tweet of the thread.` } }, required: ['tweetId'] },
  },
  {
    name: 'user_timeline',
    featureSet: FS_READ,
    description:
      'An account\'s tweets, newest first, replies included. What it posted since the cache last looked is fetched from X first, ' +
      'at most every quarter hour, and paid for per new tweet. before and since page through the cache or pick a stretch of time ' +
      '(since: "2024-01-01", before: "2024-02-01"); with either, only the cache answers.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '@handle (with or without the @) or a numeric user id.' },
        limit: { type: 'number', description: 'The most tweets to return (default 30, at most 200).' },
        before: { type: 'string', description: 'Only tweets older than this time (ISO date or timestamp).' },
        since: { type: 'string', description: 'Only tweets at or after this time (ISO date or timestamp).' },
        transcribe: { type: 'boolean', description: 'Describe the images of the returned tweets in words.' },
        ...FORMAT,
      },
      required: ['handle'],
    },
  },
  {
    name: 'peek_timeline',
    featureSet: FS_READ,
    description: 'How much of an account is cached, without its tweets: how many, over what time, the newest one\'s time.',
    inputSchema: { type: 'object', properties: { handle: { type: 'string', description: '@handle or a numeric user id.' } }, required: ['handle'] },
  },
  {
    name: 'get_user',
    featureSet: FS_READ,
    description: 'An account\'s profile: name, description, followers, when it joined. Where X\'s profile was never fetched, what the cached tweets show instead.',
    inputSchema: { type: 'object', properties: { handle: { type: 'string', description: '@handle or a numeric user id.' } }, required: ['handle'] },
  },
  {
    name: 'search_tweets',
    featureSet: FS_READ,
    description:
      'Search the cached tweets and the descriptions of their images, which costs nothing. query is full-text syntax: words are all required, OR and NOT work, ' +
      'and a phrase, a handle or anything with punctuation goes in double quotes ("@handle", "c++"). With a query the best matches come first, ' +
      'or the newest with order: "recent"; without one, the filters alone pick tweets, newest first. At least one of query, author, since, until and tier is needed. ' +
      'tier is a label only the original curated archive carries (about 130,000 tweets): spine is @repligate, cast is fifteen accounts close to them, ' +
      'context and bridge are other people\'s tweets around those. ' +
      'fresh: true has X search its last seven days for the query first and adds what it finds to the cache: that is paid for per tweet found and per author, ' +
      'about a dollar for the hundred tweets one search can return, so it is for when the cache is not enough. It takes a query alone, no filters, ' +
      'and X reads the query by its own rules: plain words or one quoted phrase work in both.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for (full-text syntax).' },
        author: { type: 'string', description: 'Only this account\'s tweets (@handle).' },
        since: { type: 'string', description: 'Only tweets at or after this time (ISO date or timestamp).' },
        until: { type: 'string', description: 'Only tweets before this time (ISO date or timestamp).' },
        tier: { type: 'string', enum: ['spine', 'cast', 'context', 'bridge'], description: 'Only tweets with this label of the curated archive.' },
        order: { type: 'string', enum: ['relevance', 'recent'], description: 'With a query: best matches first (the default) or newest first.' },
        fresh: { type: 'boolean', description: 'Have X search the last seven days for the query first (paid, about a dollar a search). A query alone, no filters.' },
        limit: { type: 'number', description: 'The most tweets to return (default 30, at most 200).' },
        ...FORMAT,
      },
    },
  },
  {
    name: 'get_image',
    featureSet: FS_READ,
    description: 'An image itself, for you to look at. mediaId is the id in a tweet\'s [image …] line; tweetId gives every image of that tweet.',
    inputSchema: {
      type: 'object',
      properties: {
        mediaId: { type: 'string', description: 'One image\'s id, as a tweet\'s [image …] line shows it.' },
        tweetId: { type: 'string', description: `${TWEET} All of its images.` },
      },
    },
  },
  {
    name: 'transcribe_image',
    featureSet: FS_READ,
    description: 'An image described in words by a vision model, kept after the first time. For when the text or a description is enough and the picture itself is not needed.',
    inputSchema: { type: 'object', properties: { mediaId: { type: 'string', description: 'The image\'s id, as a tweet\'s [image …] line shows it.' } }, required: ['mediaId'] },
  },
  {
    name: 'feed_show',
    featureSet: FS_FEED,
    description:
      'Your feed: the sources you follow, how each is treated (notify, quiet or muted), how many unread tweets each has and how far you have read. Marks nothing read.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'feed_read',
    featureSet: FS_FEED,
    description:
      'The unread tweets of your feed, source by source, newest first, and marks them read: they do not come back. Muted sources are left out. ' +
      'keep_unread: true shows them without marking them. latest: true shows each source\'s latest tweets whether read or not, and marks nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'The most tweets per source (default 20, at most 200).' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Only these sources (as feed_show lists them, or a handle or query alone). Default: every source that is not muted.' },
        keep_unread: { type: 'boolean', description: 'Show the unread tweets and leave them unread.' },
        latest: { type: 'boolean', description: 'Show the latest tweets of each source, read or not; marks nothing.' },
      },
    },
  },
  {
    name: 'feed_add',
    featureSet: FS_FEED,
    toolset: SOURCES_TOOLSET,
    description:
      'Follow an account, a search or a handle\'s mentions in your feed. kind "timeline" is an account\'s tweets, kept current from X (paid per new tweet). ' +
      '"search" is a query as search_tweets takes it, and "mentions" is tweets that name a handle: both show what the cache has, which grows as timelines are read ' +
      'and when someone runs a fresh search, and cost nothing. A new source starts quiet: its tweets wait for feed_read. Adding one you already follow changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...SOURCE_KINDS] },
        value: { type: 'string', description: 'The @handle (timeline, mentions) or the query (search).' },
        label: { type: 'string', description: 'A note of your own, shown beside the source.' },
        mode: { type: 'string', enum: [...FEED_MODES], description: 'How to treat it, as feed_set explains (default quiet).' },
      },
      required: ['kind', 'value'],
    },
  },
  {
    name: 'feed_remove',
    featureSet: FS_FEED,
    toolset: SOURCES_TOOLSET,
    description: 'Stop following a source of your feed. What you had read in it is forgotten with it.',
    inputSchema: { type: 'object', properties: { source: SOURCE }, required: ['source'] },
  },
  {
    name: 'feed_set',
    featureSet: FS_FEED,
    toolset: SOURCES_TOOLSET,
    description:
      'Set a source to notify (its new tweets are sent to you), quiet (they wait for feed_read) or muted (feed_read leaves it out). ' +
      'A notifying timeline is checked against X, so its tweets reach you within about twenty minutes of being posted; a notifying search or mentions source tells you ' +
      'what reaches the cache. Tweets sent to you count as read. A muted source stays in the list.',
    inputSchema: { type: 'object', properties: { source: SOURCE, mode: { type: 'string', enum: [...FEED_MODES] } }, required: ['source', 'mode'] },
  },
];

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 1));

const STATUS_URL = /(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status(?:es)?\/(\d+)/;

/** A tweet id from an id or a tweet's address. */
export function tweetIdOf(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (/^\d+$/.test(s)) return s;
  return STATUS_URL.exec(s)?.[1] ?? null;
}

const handleOf = (value: unknown) => String(value ?? '').trim().replace(/^@/, '');
const clamp = (value: unknown, dflt: number, max: number) => (typeof value === 'number' && value >= 1 ? Math.min(Math.floor(value), max) : dflt);
const isImage = (m: BridgeMedia) => !m.type || m.type === 'photo' || m.type === 'animated_gif';

/**
 * The latest tweets of a source, newest first. A timeline is refreshed from X
 * first where the bridge may and its copy is old (paid per new tweet). A search
 * or a handle's mentions are read from the cache alone: asking X to search
 * again is paid for in full every time, so a feed never does it.
 */
async function latestOf(bridge: BridgeClient, s: FeedSource, limit: number): Promise<BridgeTweet[]> {
  if (s.kind === 'timeline') return bridge.userTimeline(s.value, limit);
  return bridge.search(queryOf(s), limit, { recent: true });
}

/** A search source's query. A handle is not a word to the full-text index: it has to be quoted. */
const queryOf = (s: FeedSource) => (s.kind === 'mentions' ? `"@${s.value}"` : s.value);

/**
 * A source's unread tweets, newest first, at most UNREAD_CAP of them. In a
 * source never read, its latest `first` tweets: its whole past is not a backlog.
 */
export async function unreadFor(bridge: BridgeClient, state: FeedState, s: FeedSource, first: number): Promise<BridgeTweet[]> {
  const readTo = state.readTo[s.id];
  if (!readTo) return latestOf(bridge, s, first);
  if (s.kind !== 'timeline') return unreadOf(state, s, await bridge.search(queryOf(s), UNREAD_CAP, { since: readTo, recent: true }));
  // The plain read lets the bridge refresh the timeline from X; the read from
  // `readTo` on is answered by the cache alone, and is the complete one.
  await bridge.userTimeline(s.value, 1);
  return unreadOf(state, s, await bridge.userTimeline(s.value, UNREAD_CAP, undefined, false, readTo));
}

function bridgeFailure(tool: string, e: unknown): ToolResult {
  if (!(e instanceof BridgeError)) return fail(`${tool}: xgate's bridge could not be reached (${(e as Error).message}).`);
  let said = e.body;
  try { said = String((JSON.parse(e.body) as { error?: unknown }).error ?? e.body); } catch { /* not JSON: as it came */ }
  if (/fts5|unterminated string|no such column/i.test(said)) {
    return fail(`${tool}: the query is not valid full-text syntax (${said.slice(0, 120)}). Put a phrase, a handle or anything with punctuation in double quotes: "@handle", "c++".`);
  }
  if (e.status === 401) return fail(`${tool}: xgate's bridge refused this server's token. Its operator has to fix that.`);
  return fail(`${tool}: xgate's bridge answered ${e.status}: ${said.slice(0, 200)}`);
}

export async function callTool(ctx: ToolContext, who: Caller, name: string, rawArgs: unknown): Promise<ToolResult> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  try {
    return await run(ctx, who, name, args);
  } catch (e) {
    return bridgeFailure(name, e);
  }
}

async function run(ctx: ToolContext, who: Caller, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { bridge } = ctx;
  const full = args.format === 'full';
  switch (name) {
    case 'lookup_tweet': {
      const id = tweetIdOf(args.tweetId);
      if (!id) return fail('lookup_tweet: tweetId has to be a tweet\'s id or its address on x.com.');
      const t = await bridge.getTweet(id, args.fresh === true, args.transcribe === true);
      if (!t) return fail(`lookup_tweet: tweet ${id} is not cached, and it could not be fetched from X: it may be deleted or protected, or this server may not fetch.`);
      if (full) return json(t);
      const thread = await bridge.getThread(id);
      const parent = t.reply_to_tweet_id ? thread.tweets.find((x) => x.tweet_id === t.reply_to_tweet_id) : undefined;
      const replies = thread.tweets.filter((x) => x.reply_to_tweet_id === id).length;
      const around = [
        parent ? `It answers @${parent.author_username ?? 'unknown'} (tweet ${parent.tweet_id}): ${JSON.stringify(parent.text.replace(/\s+/g, ' ').trim().slice(0, 160))}` : '',
        t.reply_to_tweet_id && !parent ? `The tweet it answers (${t.reply_to_tweet_id}) is not cached.` : '',
        thread.count > 1
          ? `${replies ? `${replies} repl${replies === 1 ? 'y' : 'ies'} to it ${replies === 1 ? 'is' : 'are'} cached. ` : ''}Its thread has ${thread.count} cached tweets: get_thread shows it.`
          : 'Nothing else of its thread is cached.',
      ].filter(Boolean);
      return text(`${renderTweet(t)}\n\n${around.join('\n')}`);
    }
    case 'get_thread': {
      const id = tweetIdOf(args.tweetId ?? args.conversationId);
      if (!id) return fail('get_thread: tweetId has to be a tweet\'s id or its address on x.com.');
      const thread = await bridge.getThread(id, { fresh: args.fresh === true, transcribe: args.transcribe === true });
      if (full) return json(thread);
      if (!thread.count) return fail(`get_thread: nothing of a thread around tweet ${id} is cached. lookup_tweet fetches a single tweet where this server may fetch.`);
      const shown = selectForView(thread.tweets, id, clamp(args.limit, 60, 500));
      const layout = layoutThread(shown, thread.tweets, id, thread.count === thread.tweets.length);
      return text(renderThread(layout, thread.count, thread.tweets));
    }
    case 'peek_thread': {
      const id = tweetIdOf(args.tweetId ?? args.conversationId);
      if (!id) return fail('peek_thread: tweetId has to be a tweet\'s id or its address on x.com.');
      const p = await bridge.threadPreview(id);
      return p?.count ? text(renderThreadPreview(p)) : fail(`peek_thread: nothing of a thread around tweet ${id} is cached.`);
    }
    case 'user_timeline': {
      const handle = handleOf(args.handle);
      if (!handle) return fail('user_timeline: handle is needed.');
      const tweets = await bridge.userTimeline(handle, clamp(args.limit, 30, 200), args.before ? String(args.before) : undefined, args.transcribe === true, args.since ? String(args.since) : undefined);
      if (full) return json({ count: tweets.length, tweets });
      if (!tweets.length) return text(`@${handle}: no tweets ${args.before || args.since ? 'cached in that stretch of time' : 'cached, and none could be fetched: the handle may be misspelt, or this server may not fetch from X'}.`);
      return text(renderList(tweets, `@${handle}`));
    }
    case 'peek_timeline': {
      const handle = handleOf(args.handle);
      if (!handle) return fail('peek_timeline: handle is needed.');
      const p = await bridge.timelinePreview(handle);
      return text(p ? renderTimelinePreview(p) : `@${handle}: no tweets cached`);
    }
    case 'get_user': {
      const handle = handleOf(args.handle);
      if (!handle) return fail('get_user: handle is needed.');
      const u = await bridge.getUser(handle);
      return u ? text(renderUser(u)) : fail(`get_user: nothing is known of @${handle}: none of its tweets is cached and its profile could not be fetched.`);
    }
    case 'search_tweets': {
      const query = args.query ? String(args.query) : undefined;
      const filters = {
        author: args.author ? handleOf(args.author) : undefined,
        since: args.since ? String(args.since) : undefined,
        until: args.until ? String(args.until) : undefined,
        tier: args.tier ? String(args.tier) : undefined,
      };
      const recent = args.order === 'recent';
      const fresh = args.fresh === true;
      if (fresh && (!query || Object.values(filters).some(Boolean))) return fail('search_tweets: fresh takes a query alone. X is not asked when a filter is given, so drop the filters, or drop fresh.');
      if (!query && !Object.values(filters).some(Boolean)) return fail('search_tweets: give a query, or at least one of author, since, until and tier.');
      const tweets = await bridge.search(query, clamp(args.limit, 30, 200), { ...filters, recent, fresh });
      if (full) return json({ count: tweets.length, tweets });
      const title = [
        query ? `search: ${query}${recent ? ' (newest first)' : ''}${fresh ? ' (X searched first)' : ''}` : 'cached tweets',
        filters.author ? `by @${filters.author}` : '',
        filters.tier ? `tier ${filters.tier}` : '',
        filters.since || filters.until ? `${filters.since ?? 'the start'} → ${filters.until ?? 'now'}` : '',
      ].filter(Boolean).join(' · ');
      return text(renderList(tweets, title));
    }
    case 'get_image': {
      let media: BridgeMedia[];
      if (args.mediaId) media = [{ media_id: String(args.mediaId), url: null, type: 'photo', width: null, height: null, transcription: null, alt_text: null }];
      else {
        const id = tweetIdOf(args.tweetId);
        if (!id) return fail('get_image: give mediaId (one image) or tweetId (all of a tweet\'s images).');
        const t = await bridge.getTweet(id);
        if (!t) return fail(`get_image: tweet ${id} is not cached.`);
        media = t.media.filter(isImage);
        if (!media.length) return fail(`get_image: tweet ${id} has no images${t.media.length ? ' (its media is video, which this server does not show)' : ''}.`);
      }
      const content: ContentBlock[] = [];
      for (const m of media) {
        const bytes = await bridge.mediaBytes(m.media_id);
        if (!bytes) { content.push({ type: 'text', text: `[image ${m.media_id}] is not available: the bridge has no copy and could not fetch one.` }); continue; }
        content.push({ type: 'image', data: bytes.data.toString('base64'), mimeType: bytes.mimeType });
        const said = m.alt_text || m.transcription;
        content.push({ type: 'text', text: `[image ${m.media_id}]${said ? ` ${said.replace(/\s+/g, ' ').trim().slice(0, 300)}` : ''}` });
      }
      return { content, ...(content.some((c) => c.type === 'image') ? {} : { isError: true }) };
    }
    case 'transcribe_image': {
      const id = String(args.mediaId ?? '').trim();
      if (!id) return fail('transcribe_image: mediaId is needed.');
      try {
        const said = await bridge.transcribeImage(id);
        return said ? text(said) : fail(`transcribe_image: no image ${id} is known.`);
      } catch (e) {
        if (e instanceof BridgeError && (e.status === 403 || e.status === 503)) return fail(`transcribe_image: image ${id} has no description yet, and this server may not have one made. get_image shows the picture itself.`);
        throw e;
      }
    }
    case 'feed_show': {
      const state = ctx.feeds.get(who.client);
      return text(await feedOverview(bridge, state));
    }
    case 'feed_read': {
      const state = ctx.feeds.get(who.client);
      const limit = clamp(args.limit, 20, 200);
      if (!state.sources.length) return text('Your feed has no sources yet.');
      let targets = state.sources.filter((s) => s.mode !== 'muted');
      if (Array.isArray(args.sources)) {
        const named = args.sources.map((r) => ({ ref: String(r), source: findSource(state, String(r)) }));
        const unknown = named.filter((n) => !n.source).map((n) => n.ref);
        if (unknown.length) return fail(`feed_read: not in your feed: ${unknown.join(', ')}. feed_show lists your sources.`);
        targets = named.map((n) => n.source!);
      }
      if (args.latest === true) {
        const groups = await Promise.all(targets.map(async (source) => ({ source, tweets: await latestOf(bridge, source, limit) })));
        return text(renderItems(groups, 'latest'));
      }
      const groups = await Promise.all(targets.map(async (source) => ({ source, unread: await unreadFor(bridge, state, source, limit) })));
      const shown = groups.map((g) => ({ source: g.source, tweets: g.unread.slice(0, limit) }));
      const more = groups.filter((g) => g.unread.length > limit && state.readTo[g.source.id])
        .map((g) => `${sourceName(g.source)}: ${g.unread.length - limit}${g.unread.length >= UNREAD_CAP ? ' or more' : ''} older unread not shown`);
      const keep = args.keep_unread === true;
      if (!keep) {
        let next = state;
        for (const g of groups) next = markRead(next, g.source, g.unread);
        if (next !== state) ctx.feeds.set(who.client, next);
      }
      const tail = more.length ? `\n\n${more.join('\n')}${keep ? '' : '. They are marked read too; user_timeline with since and before reads them.'}` : '';
      return text(`${renderItems(shown, 'unread')}${tail}`);
    }
    case 'feed_add': {
      const kind = String(args.kind) as FeedSourceKind;
      const value = String(args.value ?? '').trim();
      const mode = (args.mode === undefined ? 'quiet' : String(args.mode)) as FeedMode;
      if (!SOURCE_KINDS.includes(kind)) return fail(`feed_add: kind is one of ${SOURCE_KINDS.join(', ')}.`);
      if (!value.replace(/^@/, '')) return fail('feed_add: value is needed: the @handle, or the query.');
      if (!FEED_MODES.includes(mode)) return fail(`feed_add: mode is one of ${FEED_MODES.join(', ')}.`);
      const state = ctx.feeds.get(who.client);
      const { state: next, source, added } = addSource(state, { kind, value, mode, label: args.label ? String(args.label) : undefined });
      if (!added) return text(`${sourceName(source)} is already in your feed (${source.mode}).`);
      // Reading it now tells the agent at once whether there is anything behind the name.
      const there = await latestOf(bridge, source, 20);
      ctx.feeds.set(who.client, mode === 'notify' ? startFromNow(next, source) : next);
      const found = there.length
        ? `${there.length === 20 ? 'At least 20' : there.length} tweet${there.length === 1 ? ' is' : 's are'} there to read with feed_read.`
        : 'Nothing is cached for it yet, and nothing could be fetched: the name may be misspelt, or this server may not fetch from X.';
      return text(`Added ${sourceName(source)} (${source.mode}). ${found}${notifyNote(mode, who)}`);
    }
    case 'feed_remove': {
      const state = ctx.feeds.get(who.client);
      const source = findSource(state, String(args.source ?? ''));
      if (!source) return fail(`feed_remove: ${JSON.stringify(String(args.source ?? ''))} is not in your feed. feed_show lists your sources.`);
      ctx.feeds.set(who.client, removeSource(state, source));
      return text(`Removed ${sourceName(source)} from your feed.`);
    }
    case 'feed_set': {
      const state = ctx.feeds.get(who.client);
      const source = findSource(state, String(args.source ?? ''));
      const mode = String(args.mode) as FeedMode;
      if (!source) return fail(`feed_set: ${JSON.stringify(String(args.source ?? ''))} is not in your feed. feed_show lists your sources.`);
      if (!FEED_MODES.includes(mode)) return fail(`feed_set: mode is one of ${FEED_MODES.join(', ')}.`);
      const next = setMode(state, source, mode);
      ctx.feeds.set(who.client, mode === 'notify' ? startFromNow(next, source) : next);
      return text(`${sourceName(source)} is now ${mode}.${notifyNote(mode, who)}`);
    }
    default:
      return fail(`Unknown tool: ${name}`);
  }
}

function notifyNote(mode: FeedMode, who: Caller): string {
  return mode === 'notify' && !who.eventsOn
    ? ' Your host does not take events from this server (its feature set x.events is off), so nothing will be sent until that changes; feed_read still shows what is new.'
    : '';
}

/** feed_show's text: also what opening the `sources` toolset shows. */
export async function feedOverview(bridge: BridgeClient, state: FeedState): Promise<string> {
  const unread: Record<string, number | undefined> = {};
  await Promise.all(state.sources.filter((s) => s.mode !== 'muted' && state.readTo[s.id]).map(async (s) => {
    unread[s.id] = await unreadFor(bridge, state, s, 0).then((t) => t.length, () => undefined);
  }));
  return renderSources(state, unread);
}
