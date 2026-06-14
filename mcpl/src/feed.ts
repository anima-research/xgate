/**
 * Curated feed — a persistent, agent-owned set of sources (user timelines,
 * searches, mentions) with per-source read cursors.
 *
 * State lives HOST-side: the MCPL host injects the current state into every
 * `tools/call` as `params.state`, and persists whatever `state` checkpoint a
 * tool returns (see x-bridge/DESIGN.md and agent-framework's CheckpointManager).
 * So this module is deliberately PURE — a reducer + renderer over the state
 * object. No I/O, no clock dependence beyond timestamps the caller passes in.
 * The actual tweet fetching lives in handlers.ts (it needs the bridge).
 */

import type { BridgeTweet } from './bridge-client.js';
import { renderTweet, fmtTime } from './render.js';

export type FeedSourceKind = 'timeline' | 'search' | 'mentions';

export interface FeedSource {
  id: string;
  kind: FeedSourceKind;
  value: string;
  label?: string;
  muted?: boolean;
}

export interface FeedCursor {
  lastSeenId?: string;
  lastSeenAt?: string;
}

export interface FeedState {
  version: 1;
  /** Monotonic counter; drives checkpoint id + parent chaining. */
  seq: number;
  sources: FeedSource[];
  cursors: Record<string, FeedCursor>;
}

export function emptyState(): FeedState {
  return { version: 1, seq: 0, sources: [], cursors: {} };
}

/** Coerce whatever the host injected (undefined / partial / old) into a valid state. */
export function normalizeState(injected: unknown): FeedState {
  const s = (injected ?? {}) as Partial<FeedState>;
  const sources = Array.isArray(s.sources)
    ? s.sources.filter((x): x is FeedSource => !!x && typeof (x as FeedSource).id === 'string')
    : [];
  const cursors = s.cursors && typeof s.cursors === 'object' ? { ...s.cursors } : {};
  const seq = typeof s.seq === 'number' && s.seq >= 0 ? s.seq : 0;
  return { version: 1, seq, sources, cursors };
}

/** Stable id for a source so re-adding the same thing is idempotent. */
export function sourceId(kind: FeedSourceKind, value: string): string {
  return `${kind}:${value.replace(/^@/, '').toLowerCase().trim()}`;
}

export function findSource(state: FeedState, ref: string): FeedSource | undefined {
  const r = ref.toLowerCase().replace(/^@/, '').trim();
  return state.sources.find(
    (s) => s.id === ref || s.id.toLowerCase() === ref.toLowerCase() ||
      s.value.toLowerCase().replace(/^@/, '') === r,
  );
}

// ── Reducers (each returns a NEW state; callers bump() to checkpoint) ──

export function addSource(
  state: FeedState,
  input: { kind: FeedSourceKind; value: string; label?: string },
): { state: FeedState; source: FeedSource; added: boolean } {
  const value = input.value.replace(/^@/, '').trim();
  const id = sourceId(input.kind, value);
  const existing = state.sources.find((s) => s.id === id);
  if (existing) return { state, source: existing, added: false };
  const source: FeedSource = { id, kind: input.kind, value, label: input.label };
  return { state: { ...state, sources: [...state.sources, source] }, source, added: true };
}

export function removeSource(state: FeedState, ref: string): { state: FeedState; removed: FeedSource | undefined } {
  const src = findSource(state, ref);
  if (!src) return { state, removed: undefined };
  const cursors = { ...state.cursors };
  delete cursors[src.id];
  return {
    state: { ...state, sources: state.sources.filter((s) => s.id !== src.id), cursors },
    removed: src,
  };
}

export function setMuted(state: FeedState, ref: string, muted: boolean): { state: FeedState; source: FeedSource | undefined } {
  const src = findSource(state, ref);
  if (!src) return { state, source: undefined };
  return {
    state: { ...state, sources: state.sources.map((s) => (s.id === src.id ? { ...s, muted } : s)) },
    source: { ...src, muted },
  };
}

/** Advance a source's cursor to the newest of the given tweets. */
export function advanceCursor(state: FeedState, sourceId: string, newest: BridgeTweet | undefined): FeedState {
  if (!newest) return state;
  return {
    ...state,
    cursors: {
      ...state.cursors,
      [sourceId]: { lastSeenId: newest.tweet_id, lastSeenAt: newest.created_at ?? undefined },
    },
  };
}

/** Increment seq — every mutation that should be persisted bumps it. */
export function bump(state: FeedState): FeedState {
  return { ...state, seq: state.seq + 1 };
}

/** Build the StateCheckpoint a stateful tool returns alongside its content. */
export function checkpointFor(prevSeq: number, newState: FeedState): {
  checkpoint: string;
  parent: string | null;
  data: FeedState;
} {
  return {
    checkpoint: String(newState.seq),
    parent: prevSeq > 0 ? String(prevSeq) : null,
    data: newState,
  };
}

/** Tweets newer than a source's cursor (created_at strictly after lastSeenAt). */
export function newSince(cursor: FeedCursor | undefined, tweets: BridgeTweet[]): BridgeTweet[] {
  if (!cursor?.lastSeenAt) return tweets;
  return tweets.filter((t) => (t.created_at ?? '') > cursor.lastSeenAt!);
}

// ── Rendering ──

export function renderSources(
  state: FeedState,
  unread: Record<string, number | undefined>,
): string {
  if (!state.sources.length) {
    return 'feed is empty. Add sources with feed_add (e.g. {kind:"timeline", value:"@handle"}).';
  }
  const lines = state.sources.map((s) => {
    const n = unread[s.id];
    const badge = s.muted ? 'muted' : n === undefined ? '?' : n > 0 ? `${n} new` : 'up to date';
    const cur = state.cursors[s.id]?.lastSeenAt;
    const seen = cur ? ` · last seen ${fmtTime(cur)}` : '';
    const label = s.label ? ` "${s.label}"` : '';
    return `• ${s.kind}:${s.value}${label} — ${badge}${seen}`;
  });
  return `feed — ${state.sources.length} source(s):\n${lines.join('\n')}`;
}

/** Render fetched-new items grouped by source, each block newest-first. */
export function renderItems(
  groups: { source: FeedSource; tweets: BridgeTweet[] }[],
): string {
  const nonEmpty = groups.filter((g) => g.tweets.length);
  if (!nonEmpty.length) return 'No new items across the feed.';
  const total = nonEmpty.reduce((a, g) => a + g.tweets.length, 0);
  const blocks = nonEmpty.map((g) => {
    const head = `── ${g.source.kind}:${g.source.value} (${g.tweets.length} new) ──`;
    const body = g.tweets.map((t, i) => renderTweet(t, { index: i + 1 })).join('\n\n');
    return `${head}\n${body}`;
  });
  return `${total} new item(s) across ${nonEmpty.length} source(s):\n\n${blocks.join('\n\n')}`;
}
