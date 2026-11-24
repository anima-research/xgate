import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderThread, renderTweet, renderUser } from '../src/render.js';
import { layoutThread, selectForView } from '../src/thread.js';
import { image, tweet } from './stub-bridge.js';

const at = (min: number) => `2026-03-01T10:${String(min).padStart(2, '0')}:00.000Z`;
const reply = (id: string, author: string, to: string, min: number) => tweet(id, author, `text of ${id}`, at(min), { reply_to_tweet_id: to });

test('a chain stays at one depth, and each tweet answers the one above', () => {
  const tweets = [tweet('1', 'a', 'root', at(0)), reply('2', 'a', '1', 1), reply('3', 'b', '2', 2)];
  const { rows, orphans } = layoutThread(tweets, tweets, undefined, true);
  assert.deepEqual(rows.map((r) => [r.tweet.tweet_id, r.depth, r.parent.kind]), [['1', 0, 'none'], ['2', 0, 'above'], ['3', 0, 'above']]);
  assert.equal(orphans, 0);
});

test('where a tweet has several answers, each branch is indented and a later branch names its parent', () => {
  //  1 ─ 2 ─ 4
  //    └ 3
  const tweets = [tweet('1', 'a', 'root', at(0)), reply('2', 'b', '1', 1), reply('3', 'c', '1', 2), reply('4', 'a', '2', 3)];
  const { rows } = layoutThread(tweets, tweets, undefined, true);
  assert.deepEqual(rows.map((r) => [r.tweet.tweet_id, r.depth, r.parent]), [
    ['1', 0, { kind: 'none' }],
    ['2', 1, { kind: 'above' }],
    ['4', 1, { kind: 'above' }],
    ['3', 1, { kind: 'row', index: 1 }],
  ]);
});

test('a tweet whose parent is missing says so, and whether that parent is cached at all', () => {
  const orphan = tweet('5', 'd', 'late', at(5), { reply_to_tweet_id: '99', reply_to_username: 'gone' });
  const tweets = [tweet('1', 'a', 'root', at(0)), orphan];
  const whole = layoutThread(tweets, tweets, undefined, true);
  assert.deepEqual(whole.rows[1]!.parent, { kind: 'absent', id: '99', username: 'gone', cached: false });
  assert.equal(whole.orphans, 1);
  // The bridge cut the thread: a parent outside what it sent may still be cached.
  assert.deepEqual(layoutThread(tweets, tweets, undefined, false).rows[1]!.parent, { kind: 'absent', id: '99', username: 'gone', cached: null });
  // The parent was fetched but left out of this view.
  const cut = layoutThread([orphan], [...tweets, tweet('99', 'gone', 'parent', at(4))], undefined, true);
  assert.deepEqual(cut.rows[0]!.parent, { kind: 'absent', id: '99', username: 'gone', cached: true });
  assert.equal(cut.orphans, 0);
});

test('a long thread is cut to the tweet asked for, what it answers and its replies', () => {
  const noise = Array.from({ length: 30 }, (_, i) => reply(`n${i}`, 'x', '1', 10 + i));
  const tweets = [tweet('1', 'a', 'root', at(0)), reply('2', 'a', '1', 1), ...noise, reply('3', 'b', '2', 50), reply('4', 'c', '3', 51), reply('5', 'd', '3', 52)];
  const shown = selectForView(tweets, '3', 6).map((t) => t.tweet_id);
  assert.deepEqual(shown, ['1', '2', 'n0', '3', '4', '5']);
  assert.equal(selectForView(tweets, undefined, 3).map((t) => t.tweet_id).join(), '1,2,n0');
  assert.equal(selectForView(tweets, '3', 100).length, tweets.length);
});

test('a tweet shows its id, what it answers, its images by id and the tweets it links', () => {
  const t = tweet('200', 'bob', 'look at this\n\nsecond paragraph', '2026-03-01T10:05:00+00:00', {
    reply_to_tweet_id: '100', reply_to_username: 'alice', favorite_count: 3,
    media: [image('3_77', 'a chart of things'), image('3_78'), { ...image('7_1'), type: 'video' }],
    urls: [{ url: 'https://t.co/a', expanded_url: 'https://x.com/carol/status/555?s=20' }, { url: 'https://t.co/b', expanded_url: 'https://example.org/paper' }],
  });
  assert.equal(renderTweet(t, { index: 2 }), [
    '[2] @bob ↳ @alice, tweet 100 · 2026-03-01 10:05Z · ♥3 · id 200',
    '    look at this',
    '',
    '    second paragraph',
    '    [image 3_77] a chart of things',
    '    [image 3_78]',
    '    [video 7_1]',
    '    links tweet 555 by @carol',
    '    link: https://example.org/paper',
  ].join('\n'));
  assert.match(renderTweet(tweet('300', 'bob', 'q', at(0), { quoted_tweet_id: '555', urls: [{ url: null, expanded_url: 'https://twitter.com/carol/status/555' }] })), /quotes tweet 555$/);
});

test('a thread reads as a tree with its gaps said', () => {
  const tweets = [
    tweet('1', 'a', 'root', at(0)), reply('2', 'b', '1', 1), reply('3', 'c', '1', 2),
    tweet('4', 'd', 'answer to someone unseen', at(3), { reply_to_tweet_id: '99' }),
  ];
  const text = renderThread(layoutThread(tweets, tweets, '3', true), 4, tweets);
  assert.deepEqual(text.split('\n').filter((l) => !l.startsWith('    ')), [
    'thread of 4 cached tweets · @a(1) @b(1) @c(1) @d(1) · 2026-03-01',
    'Each tweet answers the one directly above it, unless ↳ names another.',
    '1 of these answers a tweet that is not cached, so the thread has gaps.',
    '',
    '[1] @a · 2026-03-01 10:00Z · id 1',
    '  [2] @b · 2026-03-01 10:01Z · id 2',
    '  ▶[3] @c ↳[1] · 2026-03-01 10:02Z · id 3',
    '[4] @d ↳ tweet 99, not cached · 2026-03-01 10:03Z · id 4',
  ]);
  const cut = renderThread(layoutThread(tweets.slice(0, 2), tweets, '2', true), 4, tweets);
  assert.match(cut, /^Showing 2 of 4: the tweet you asked for \(▶\), the tweets it answers, its replies, then the earliest of the rest\./m);
});

test('a profile from X and one known only from cached tweets read differently', () => {
  assert.match(renderUser({ author_id: '7', handle: 'bob', source: 'x-api', name: 'Bob', description: 'writes\nthings', followers: 10, following: 2, tweet_count: 99, created_at: '2020-01-02T00:00:00Z', verified: true }),
    /^Bob \(@bob\) ✓ · id 7\nwrites things\n10 followers · 2 following · 99 tweets · joined 2020-01-02$/);
  assert.match(renderUser({ author_id: '7', handle: 'bob', source: 'derived-from-cache', cached_tweet_count: 3, first_seen: at(0), last_seen: at(5) }),
    /No profile from X is stored for this account\. The cache holds 3 of its tweets/);
});
