/**
 * Unit tests for the pure feed reducer + the host-state round-trip semantics.
 * No bridge needed for the reducer tests; the round-trip test mimics the host
 * loop (inject params.state → tool returns result.state → re-inject) and a
 * process "restart" (fresh server, last persisted state re-injected).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyState, normalizeState, addSource, removeSource, setMuted, findSource,
  advanceCursor, newSince, bump, checkpointFor,
} from '../src/feed.js';
import type { BridgeTweet } from '../src/bridge-client.js';
import { handleToolCall } from '../src/handlers.js';

function tw(id: string, at: string): BridgeTweet {
  return {
    tweet_id: id, author_id: 'a', author_username: 'alice', text: 't' + id, created_at: at,
    reply_to_tweet_id: null, reply_to_username: null, conversation_id: id,
    retweet_count: 0, favorite_count: 0, source: null, media: [], urls: [],
  };
}

test('normalizeState coerces undefined/partial to a valid state', () => {
  assert.deepEqual(normalizeState(undefined), emptyState());
  const n = normalizeState({ sources: [{ id: 'timeline:bob', kind: 'timeline', value: 'bob' }], seq: 4 });
  assert.equal(n.seq, 4);
  assert.equal(n.sources.length, 1);
  assert.deepEqual(normalizeState({ sources: 'garbage', cursors: 5 }).sources, []);
});

test('addSource is idempotent on (kind,value)', () => {
  let s = emptyState();
  const a = addSource(s, { kind: 'timeline', value: '@Alice' });
  assert.equal(a.added, true);
  assert.equal(a.source.id, 'timeline:alice');
  s = a.state;
  const b = addSource(s, { kind: 'timeline', value: 'alice' });
  assert.equal(b.added, false);
  assert.equal(b.state.sources.length, 1);
});

test('removeSource by value or id, and cleans the cursor', () => {
  let s = addSource(emptyState(), { kind: 'search', value: 'cats' }).state;
  s = advanceCursor(s, 'search:cats', tw('9', '2026-06-14T00:00:00Z'));
  assert.ok(s.cursors['search:cats']);
  const r = removeSource(s, 'cats');
  assert.equal(r.removed?.id, 'search:cats');
  assert.equal(r.state.sources.length, 0);
  assert.equal(r.state.cursors['search:cats'], undefined);
});

test('mute/unmute toggles the flag', () => {
  let s = addSource(emptyState(), { kind: 'timeline', value: 'bob' }).state;
  s = setMuted(s, 'bob', true).state;
  assert.equal(findSource(s, 'bob')?.muted, true);
  s = setMuted(s, 'bob', false).state;
  assert.equal(findSource(s, 'bob')?.muted, false);
});

test('newSince filters strictly newer than the cursor', () => {
  const tweets = [tw('3', '2026-06-14T00:00:03Z'), tw('2', '2026-06-14T00:00:02Z'), tw('1', '2026-06-14T00:00:01Z')];
  assert.equal(newSince(undefined, tweets).length, 3);
  const got = newSince({ lastSeenAt: '2026-06-14T00:00:02Z' }, tweets);
  assert.deepEqual(got.map((t) => t.tweet_id), ['3']);
});

test('checkpoint chaining: parent points at the previous seq', () => {
  const s0 = emptyState();
  const s1 = bump(addSource(s0, { kind: 'timeline', value: 'a' }).state);
  const cp1 = checkpointFor(s0.seq, s1);
  assert.equal(cp1.checkpoint, '1');
  assert.equal(cp1.parent, null); // root
  const s2 = bump(addSource(s1, { kind: 'timeline', value: 'b' }).state);
  const cp2 = checkpointFor(s1.seq, s2);
  assert.equal(cp2.checkpoint, '2');
  assert.equal(cp2.parent, '1');
});

test('handler round-trip: feed_add returns a persistable checkpoint that re-injects', async () => {
  const bridge = {} as never; // prime:false so no bridge is needed here
  // 1) first call: no injected state
  const r1 = await handleToolCall(bridge, 'feed_add', { kind: 'timeline', value: '@alice', prime: false }, undefined);
  assert.equal(r1.ok, true);
  assert.ok(r1.state, 'feed_add must return state to persist');
  assert.equal(r1.state!.featureSet, 'x.feed', 'checkpoint must be tagged so the host attributes it (no guessing)');
  assert.equal(r1.state!.parent, null);
  const persisted1 = r1.state!.data as { sources: unknown[]; seq: number };
  assert.equal(persisted1.sources.length, 1);

  // 2) host persists r1.state.data and injects it into the next call
  const r2 = await handleToolCall(bridge, 'feed_add', { kind: 'search', value: 'cats', prime: false }, persisted1);
  assert.ok(r2.state);
  assert.equal(r2.state!.parent, String(persisted1.seq)); // chained
  const persisted2 = r2.state!.data as { sources: unknown[] };
  assert.equal(persisted2.sources.length, 2);

  // 3) "restart": a brand-new call with only the last persisted state re-injected
  const r3 = await handleToolCall(bridge, 'feed_add', { kind: 'timeline', value: '@alice', prime: false }, persisted2);
  assert.equal(r3.ok, true);
  assert.equal(r3.state, undefined, 'idempotent re-add after restart is a no-op (no new checkpoint)');
});

test('feed_read advances by newest-by-time even when search is rank-ordered', async () => {
  // Bridge stub: search returns results in RANK order (not chronological), so the
  // first element is NOT the newest. A naive cursor (tweets[0]) would leak the
  // chronologically-newest item on the next read. This guards the fix.
  const rankOrdered = [tw('a', '2026-06-10T00:00:00Z'), tw('c', '2026-06-13T00:00:00Z'), tw('b', '2026-06-11T00:00:00Z')];
  const stub = {
    async userTimeline() { return []; },
    async search() { return rankOrdered.slice(); },
  } as unknown as Parameters<typeof handleToolCall>[0];

  let state: unknown = (await handleToolCall(stub, 'feed_add', { kind: 'search', value: 'x' }, undefined)).state!.data;
  const read1 = await handleToolCall(stub, 'feed_read', { limit: 10 }, state);
  state = read1.state!.data;
  assert.match(read1.text!, /3 new/);
  // newest-first display: c (06-13) before b (06-11) before a (06-10)
  assert.ok(read1.text!.indexOf('tc') < read1.text!.indexOf('tb'));
  assert.ok(read1.text!.indexOf('tb') < read1.text!.indexOf('ta'));

  const read2 = await handleToolCall(stub, 'feed_read', { limit: 10 }, state);
  assert.match(read2.text!, /No new items/);
  assert.equal(read2.state, undefined, 'nothing new -> no checkpoint');
});

test('feed_add primes the source and reports how many tweets are available', async () => {
  const tweets = [tw('1', '2026-06-14T00:00:01Z'), tw('2', '2026-06-14T00:00:02Z')];
  const stub = {
    async userTimeline() { return tweets.slice(); },
    async search() { return []; },
  } as unknown as Parameters<typeof handleToolCall>[0];

  const r = await handleToolCall(stub, 'feed_add', { kind: 'timeline', value: '@alice' }, undefined);
  assert.equal(r.ok, true);
  assert.match(r.text!, /2 recent tweet\(s\) available/);
  assert.ok(r.state, 'still persists the new source');

  // prime:false skips the fetch entirely (no count reported)
  const r2 = await handleToolCall(stub, 'feed_add', { kind: 'timeline', value: '@bob', prime: false }, r.state!.data);
  assert.doesNotMatch(r2.text!, /available/);
});

test('feed_add reports clearly when nothing is cached (fetch disabled / unseen source)', async () => {
  const stub = { async userTimeline() { return []; }, async search() { return []; } } as unknown as Parameters<typeof handleToolCall>[0];
  const r = await handleToolCall(stub, 'feed_add', { kind: 'timeline', value: '@ghost' }, undefined);
  assert.match(r.text!, /0 tweets are cached/);
});

test('feed_read unread_only:false browses latest without advancing cursors', async () => {
  const tweets = [tw('3', '2026-06-14T00:00:03Z'), tw('2', '2026-06-14T00:00:02Z'), tw('1', '2026-06-14T00:00:01Z')];
  const stub = {
    async userTimeline() { return tweets.slice(); },
    async search() { return []; },
  } as unknown as Parameters<typeof handleToolCall>[0];

  // Add and fully catch up so the cursor sits at the newest item.
  let state: unknown = (await handleToolCall(stub, 'feed_add', { kind: 'timeline', value: '@a', prime: false }, undefined)).state!.data;
  state = (await handleToolCall(stub, 'feed_read', { limit: 10 }, state)).state!.data;
  // Normal (unread) read now yields nothing.
  assert.match((await handleToolCall(stub, 'feed_read', { limit: 10 }, state)).text!, /No new items/);
  // unread_only:false still shows the latest, and does NOT advance the cursor.
  const browse = await handleToolCall(stub, 'feed_read', { limit: 10, unread_only: false }, state);
  assert.match(browse.text!, /3 new/);
  assert.equal(browse.state, undefined, 'browse is non-destructive — no checkpoint');
});
