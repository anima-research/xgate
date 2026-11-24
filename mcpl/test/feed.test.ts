import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeedStore, addSource, emptyFeed, findSource, markRead, removeSource, renderSources, setMode, startFromNow, unreadOf } from '../src/feed.js';
import { tweet } from './stub-bridge.js';

const withDov = () => addSource(emptyFeed(), { kind: 'timeline', value: '@Dov', mode: 'quiet' });

test('the same account, however typed, is one source, found by its id or its handle', () => {
  const { state, source, added } = withDov();
  assert.equal(added, true);
  assert.deepEqual(source, { id: 'timeline:dov', kind: 'timeline', value: 'Dov', mode: 'quiet' });
  assert.equal(addSource(state, { kind: 'timeline', value: 'dov', mode: 'notify' }).added, false);
  for (const ref of ['timeline:dov', 'Timeline:Dov', '@dov', 'DOV']) assert.equal(findSource(state, ref)?.id, 'timeline:dov', ref);
  assert.equal(findSource(state, 'someone_else'), undefined);
  // A search for the same word is another source.
  assert.equal(addSource(state, { kind: 'search', value: 'dov', mode: 'quiet' }).added, true);
});

test('unread is what was posted after the newest tweet read', () => {
  const { state, source } = withDov();
  const tweets = [tweet('3', 'r', 'c', '2026-03-03T00:00:00.000Z'), tweet('2', 'r', 'b', '2026-03-02T00:00:00+00:00'), tweet('1', 'r', 'a', '2026-03-01T00:00:00.000Z')];
  assert.equal(unreadOf(state, source, tweets).length, 3);
  const read = markRead(state, source, tweets.slice(1));
  assert.equal(read.readTo[source.id], '2026-03-02T00:00:00+00:00');
  assert.deepEqual(unreadOf(read, source, tweets).map((t) => t.tweet_id), ['3']);
  // Reading older tweets again never moves the mark back.
  assert.equal(markRead(read, source, tweets.slice(2)).readTo[source.id], '2026-03-02T00:00:00+00:00');
  assert.equal(markRead(state, source, []), state);
});

test('a source set to notify starts from now if it was never read', () => {
  const { state, source } = withDov();
  const now = new Date('2026-03-05T12:00:00.000Z');
  assert.equal(startFromNow(state, source, now).readTo[source.id], '2026-03-05T12:00:00.000Z');
  const read = markRead(state, source, [tweet('1', 'r', 'a', '2026-03-01T00:00:00.000Z')]);
  assert.equal(startFromNow(read, source, now), read);
});

test('removing a source forgets what was read in it; the list shows mode and unread', () => {
  let { state, source } = withDov();
  state = markRead(state, source, [tweet('1', 'r', 'a', '2026-03-01T09:30:00.000Z')]);
  state = addSource(state, { kind: 'search', value: 'opus AND welfare', mode: 'muted', label: 'welfare' }).state;
  state = addSource(state, { kind: 'mentions', value: 'bea', mode: 'quiet' }).state;
  assert.equal(renderSources(setMode(state, source, 'notify'), { 'timeline:dov': 4 }), [
    '3 sources in your feed:',
    'timeline:@Dov · notify · 4 unread · read to 2026-03-01 09:30Z',
    'search:opus AND welfare "welfare" · muted · not read yet',
    'mentions:@bea · quiet · not read yet',
  ].join('\n'));
  const gone = removeSource(state, source);
  assert.deepEqual([gone.sources.map((s) => s.id), gone.readTo], [['search:opus and welfare', 'mentions:bea'], {}]);
  assert.equal(renderSources(emptyFeed(), {}), 'Your feed has no sources yet.');
});

test('each agent\'s feed is its own file, and is there again after a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xgate-feed-'));
  const store = new FeedStore(dir);
  store.set('agent:one@id.example', withDov().state);
  assert.deepEqual(store.get('agent:two@id.example'), emptyFeed());
  const again = new FeedStore(dir);
  assert.deepEqual(again.get('agent:one@id.example').sources.map((s) => s.id), ['timeline:dov']);
  assert.deepEqual(again.get('agent:two@id.example'), emptyFeed());
});
