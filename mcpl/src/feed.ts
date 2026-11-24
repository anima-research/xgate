/**
 * An agent's feed: the sources it follows (accounts, searches, mentions of a
 * handle), how each is treated, and how far it has read in each.
 *
 * The state lives on this server, one file per agent (FeedStore), so it
 * survives a restart of either side and asks nothing of the host. The
 * functions over it are pure.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeTweet } from './bridge-client.js';
import { fmtTime, renderTweet } from './render.js';

export type FeedSourceKind = 'timeline' | 'search' | 'mentions';
export const SOURCE_KINDS: readonly FeedSourceKind[] = ['timeline', 'search', 'mentions'];

/**
 * notify  new tweets are sent to the agent as events, and read by that
 * quiet   new tweets wait for feed_read
 * muted   kept in the list, left out of feed_read and feed_show's counts
 */
export type FeedMode = 'notify' | 'quiet' | 'muted';
export const FEED_MODES: readonly FeedMode[] = ['notify', 'quiet', 'muted'];

export interface FeedSource {
  id: string;
  kind: FeedSourceKind;
  value: string;
  label?: string;
  mode: FeedMode;
}

export interface FeedState {
  sources: FeedSource[];
  /** per source id: the time of the newest tweet read */
  readTo: Record<string, string>;
}

export const emptyFeed = (): FeedState => ({ sources: [], readTo: {} });

/** The same account or query, however it was typed, is one source. */
export function sourceId(kind: FeedSourceKind, value: string): string {
  return `${kind}:${value.replace(/^@/, '').trim().toLowerCase()}`;
}

/** A source by its id ("timeline:handle") or by its value alone ("@handle", a query). */
export function findSource(state: FeedState, ref: string): FeedSource | undefined {
  const r = ref.trim().toLowerCase();
  const bare = r.replace(/^@/, '');
  return state.sources.find((s) => s.id === r) ?? state.sources.find((s) => s.value.toLowerCase() === bare);
}

export function addSource(state: FeedState, input: { kind: FeedSourceKind; value: string; label?: string; mode: FeedMode }): { state: FeedState; source: FeedSource; added: boolean } {
  const value = input.value.replace(/^@/, '').trim();
  const id = sourceId(input.kind, value);
  const existing = state.sources.find((s) => s.id === id);
  if (existing) return { state, source: existing, added: false };
  const source: FeedSource = { id, kind: input.kind, value, mode: input.mode, ...(input.label ? { label: input.label } : {}) };
  return { state: { ...state, sources: [...state.sources, source] }, source, added: true };
}

export function removeSource(state: FeedState, source: FeedSource): FeedState {
  const { [source.id]: _gone, ...readTo } = state.readTo;
  return { sources: state.sources.filter((s) => s.id !== source.id), readTo };
}

export function setMode(state: FeedState, source: FeedSource, mode: FeedMode): FeedState {
  return { ...state, sources: state.sources.map((s) => (s.id === source.id ? { ...s, mode } : s)) };
}

/** Mark a source read up to the newest of `tweets`. */
export function markRead(state: FeedState, source: FeedSource, tweets: BridgeTweet[]): FeedState {
  const newest = tweets.reduce<string>((max, t) => (t.created_at && t.created_at > max ? t.created_at : max), state.readTo[source.id] ?? '');
  return newest ? { ...state, readTo: { ...state.readTo, [source.id]: newest } } : state;
}

/** Count a source as read up to now, if it was never read: what it notifies of starts from here. */
export function startFromNow(state: FeedState, source: FeedSource, now = new Date()): FeedState {
  return state.readTo[source.id] ? state : { ...state, readTo: { ...state.readTo, [source.id]: now.toISOString() } };
}

/** The tweets posted after what was last read in this source. */
export function unreadOf(state: FeedState, source: FeedSource, tweets: BridgeTweet[]): BridgeTweet[] {
  const readTo = state.readTo[source.id];
  return readTo ? tweets.filter((t) => (t.created_at ?? '') > readTo) : tweets;
}

export const sourceName = (s: FeedSource) => `${s.kind}:${s.kind === 'search' ? s.value : `@${s.value}`}`;

export function renderSources(state: FeedState, unread: Record<string, number | undefined>): string {
  if (!state.sources.length) return 'Your feed has no sources yet.';
  const lines = state.sources.map((s) => {
    const n = unread[s.id];
    const read = state.readTo[s.id] ? ` · read to ${fmtTime(state.readTo[s.id])}` : ' · not read yet';
    const news = s.mode === 'muted' || !state.readTo[s.id] ? '' : n === undefined ? ' · could not be checked' : n > 0 ? ` · ${n} unread` : ' · nothing unread';
    return `${sourceName(s)}${s.label ? ` "${s.label}"` : ''} · ${s.mode}${news}${read}`;
  });
  return `${state.sources.length} source${state.sources.length === 1 ? '' : 's'} in your feed:\n${lines.join('\n')}`;
}

export function renderItems(groups: Array<{ source: FeedSource; tweets: BridgeTweet[] }>, what: string): string {
  const withNews = groups.filter((g) => g.tweets.length);
  if (!withNews.length) return groups.length ? `Nothing ${what} in ${groups.length === 1 ? sourceName(groups[0]!.source) : `the ${groups.length} sources read`}.` : 'No source of your feed matches.';
  return withNews.map((g) => {
    const head = `── ${sourceName(g.source)}${g.source.label ? ` "${g.source.label}"` : ''} · ${g.tweets.length} ${what} ──`;
    return `${head}\n${g.tweets.map((t, i) => renderTweet(t, { index: i + 1 })).join('\n\n')}`;
  }).join('\n\n');
}

/** One JSON file per agent in `dir`. */
export class FeedStore {
  private readonly cache = new Map<string, FeedState>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private file(client: string): string {
    return join(this.dir, `feed-${client.replace(/[^A-Za-z0-9._@-]/g, '_')}.json`);
  }

  get(client: string): FeedState {
    let state = this.cache.get(client);
    if (!state) {
      const file = this.file(client);
      state = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as FeedState) : emptyFeed();
      this.cache.set(client, state);
    }
    return state;
  }

  set(client: string, state: FeedState): void {
    this.cache.set(client, state);
    writeFileSync(this.file(client), JSON.stringify(state, null, 1), { mode: 0o600 });
  }
}
