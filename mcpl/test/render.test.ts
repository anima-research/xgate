/**
 * Unit tests for the compact renderer (no bridge needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTweet, renderList, renderThreadPreview, renderTimelinePreview, fmtTime } from '../src/render.js';
import type { BridgeTweet } from '../src/bridge-client.js';

function tweet(over: Partial<BridgeTweet> = {}): BridgeTweet {
  return {
    tweet_id: '1', author_id: 'a', author_username: 'alice', text: 'hello world',
    created_at: '2026-06-14T14:03:00Z', reply_to_tweet_id: null, reply_to_username: null,
    conversation_id: '1', retweet_count: 0, favorite_count: 0, source: null, media: [], urls: [],
    ...over,
  };
}

test('fmtTime formats ISO to UTC minute precision', () => {
  assert.equal(fmtTime('2026-06-14T14:03:09Z'), '2026-06-14 14:03');
  assert.equal(fmtTime(null), '');
  assert.equal(fmtTime('not-a-date'), 'not-a-date');
});

test('renderTweet omits null/empty fields', () => {
  const out = renderTweet(tweet());
  assert.match(out, /@alice/);
  assert.match(out, /2026-06-14 14:03/);
  assert.match(out, /hello world/);
  // no counts, no reply, no media, no links
  assert.doesNotMatch(out, /♥|♺|↳|🖼|🔗/);
});

test('renderTweet shows counts, reply, media caption and links when present', () => {
  const out = renderTweet(tweet({
    favorite_count: 12, retweet_count: 3, reply_to_username: 'bob',
    media: [{ media_id: 'm1', url: null, type: 'photo', width: null, height: null, transcription: null, alt_text: 'a cat' }],
    urls: [{ url: 'https://t.co/x', expanded_url: 'https://example.com/post' }],
  }), { index: 2 });
  assert.match(out, /\[2\]/);
  assert.match(out, /♥12/);
  assert.match(out, /♺3/);
  assert.match(out, /↳ reply to @bob/);
  assert.match(out, /🖼1 a cat/);
  assert.match(out, /🔗 https:\/\/example\.com\/post/);
});

test('renderList builds a participant + span header', () => {
  const out = renderList([
    tweet({ tweet_id: '1', author_username: 'alice', created_at: '2026-06-10T00:00:00Z' }),
    tweet({ tweet_id: '2', author_username: 'bob', created_at: '2026-06-12T00:00:00Z' }),
    tweet({ tweet_id: '3', author_username: 'alice', created_at: '2026-06-11T00:00:00Z' }),
  ], { title: 'thread 1' });
  assert.match(out, /thread 1 · 3 tweets/);
  assert.match(out, /@alice\(2\)/);
  assert.match(out, /@bob\(1\)/);
  assert.match(out, /2026-06-10 → 2026-06-12/);
  assert.match(out, /\[1\][\s\S]*\[2\][\s\S]*\[3\]/);
});

test('renderList handles empty', () => {
  assert.match(renderList([], { title: 'x' }), /no tweets/);
});

test('renderThreadPreview and renderTimelinePreview are compact', () => {
  const tp = renderThreadPreview({
    conversation_id: '100', count: 4, participants: [{ handle: 'alice', count: 2 }, { handle: 'bob', count: 2 }],
    first: '2026-06-10T10:00:00Z', last: '2026-06-11T09:00:00Z', media_count: 2, root_author: 'alice',
  });
  assert.match(tp, /thread 100: 4 tweets/);
  assert.match(tp, /root @alice/);
  assert.match(tp, /🖼2/);
  assert.match(tp, /@alice\(2\) @bob\(2\)/);

  const tl = renderTimelinePreview({
    handle: 'alice', author_id: 'a', count: 30, first: '2026-06-01T00:00:00Z',
    last: '2026-06-14T00:00:00Z', last_tweet_at: '2026-06-14T00:00:00Z', media_count: 5,
  });
  assert.match(tl, /@alice: 30 cached tweets/);
  assert.match(tl, /🖼5/);
});
