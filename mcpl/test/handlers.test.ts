/**
 * Live integration test: BridgeClient + handlers against a running bridge.
 *
 * Requires the bridge up at X_BRIDGE_URL (default http://127.0.0.1:8810).
 * Skips gracefully if the bridge isn't reachable, so `npm test` never hangs CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeClient } from '../src/bridge-client.js';
import { handleToolCall } from '../src/handlers.js';
import { toolDefinitions } from '../src/tools.js';
import { featureSetForTool, isEnabled } from '../src/feature-sets.js';

const baseUrl = process.env.X_BRIDGE_URL ?? 'http://127.0.0.1:8810';
const bridge = new BridgeClient({ baseUrl });

async function bridgeUp(): Promise<boolean> {
  try {
    await bridge.health();
    return true;
  } catch {
    return false;
  }
}

test('feature-set routing', () => {
  assert.equal(featureSetForTool('search_tweets'), 'x.read');
  assert.equal(featureSetForTool('post_tweet'), 'x.post');
  assert.ok(isEnabled('x.read', new Set(['x.*'])));
  assert.ok(!isEnabled('x.post', new Set(['x.read'])));
});

test('every tool definition routes to a feature set', () => {
  for (const t of toolDefinitions) {
    assert.ok(featureSetForTool(t.name), `tool ${t.name} has no owning feature set`);
  }
});

test('every tool is tagged with its featureSet in tools/list (so hosts never guess)', () => {
  for (const t of toolDefinitions) {
    assert.equal(
      (t as { featureSet?: string }).featureSet,
      featureSetForTool(t.name),
      `tool ${t.name} must carry a featureSet tag matching featureSetForTool`,
    );
  }
});

test('live: health reports a seeded cache', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const h = await bridge.health();
  assert.ok(h.ok);
  assert.ok(h.tweets > 0, 'cache should have tweets');
});

test('live: user_timeline via handler', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const r = await handleToolCall(bridge, 'user_timeline', { handle: 'repligate', limit: 3 });
  assert.ok(r.ok, r.error);
  const data = r.data as { count: number; tweets: unknown[] };
  assert.ok(data.count > 0);
});

test('live: search via handler', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const r = await handleToolCall(bridge, 'search_tweets', { query: 'consciousness', limit: 2 });
  assert.ok(r.ok, r.error);
});

test('output contract: compact text by default, raw JSON on format:full', async () => {
  // Stub bridge (no network) returning one tweet, so this runs without a seed.
  const tweet = {
    tweet_id: '5', author_id: 'a', author_username: 'alice', text: 'hello',
    created_at: '2026-06-14T00:00:00Z', reply_to_tweet_id: null, reply_to_username: null,
    conversation_id: '5', retweet_count: 0, favorite_count: 0, source: null, media: [], urls: [],
  };
  const stub = { async userTimeline() { return [tweet]; } } as unknown as Parameters<typeof handleToolCall>[0];

  const compact = await handleToolCall(stub, 'user_timeline', { handle: 'alice' });
  assert.ok(compact.text, 'compact mode sets rendered text');
  assert.match(compact.text!, /@alice/);
  assert.throws(() => JSON.parse(compact.text!), 'compact text is not JSON');

  const full = await handleToolCall(stub, 'user_timeline', { handle: 'alice', format: 'full' });
  assert.equal(full.text, undefined, 'full mode leaves text unset so the server emits JSON');
  assert.equal((full.data as { count: number }).count, 1);
});

test('live: get_user derives a profile', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const r = await handleToolCall(bridge, 'get_user', { handle: 'repligate' });
  assert.ok(r.ok, r.error);
  const u = r.data as { handle: string; cached_tweet_count: number };
  assert.equal(u.handle, 'repligate');
});

test('cache miss surfaces as a clean not-found, not a throw', async (t) => {
  if (!(await bridgeUp())) return t.skip('bridge not reachable');
  const r = await handleToolCall(bridge, 'lookup_tweet', { tweetId: '1' });
  // tweet id 1 won't be in cache; with fetch on the bridge may or may not resolve it,
  // but the handler must always return a structured result, never throw.
  assert.equal(typeof r.ok, 'boolean');
});
