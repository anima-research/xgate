/**
 * Image tools against the live bridge: get_image returns image content blocks
 * (uri the host fetches from the bridge), transcribe_image returns text.
 * Uses an already-transcribed seed media id so it adds no vision spend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeClient } from '../src/bridge-client.js';
import { handleToolCall } from '../src/handlers.js';

const baseUrl = process.env.X_BRIDGE_URL ?? 'http://127.0.0.1:8810';
const bridge = new BridgeClient({ baseUrl });
const SEED_MEDIA = '3_2043555399249600512'; // KV-cache figure, transcribed in the seed work

async function up(): Promise<boolean> {
  try { await bridge.health(); return true; } catch { return false; }
}

test('mediaUrl builds a stable bridge URL', () => {
  assert.equal(bridge.mediaUrl('3_x'), `${baseUrl}/media/3_x`);
});

test('live: get_image returns an image content block + caption', async (t) => {
  if (!(await up())) return t.skip('bridge not reachable');
  const r = await handleToolCall(bridge, 'get_image', { mediaId: SEED_MEDIA });
  assert.ok(r.ok, r.error);
  assert.ok(r.content && r.content.length >= 1, 'should return content blocks');
  const img = r.content!.find((b) => b.type === 'image') as { type: string; uri: string } | undefined;
  assert.ok(img, 'has an image block');
  assert.match(img!.uri, /\/media\/3_2043555399249600512$/);
});

test('live: the served media URL returns real image bytes', async (t) => {
  if (!(await up())) return t.skip('bridge not reachable');
  const res = await fetch(bridge.mediaUrl(SEED_MEDIA));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^image\//);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.ok(buf.length > 1000, 'non-trivial image payload');
});

test('live: transcribe_image returns cached transcription (no new spend)', async (t) => {
  if (!(await up())) return t.skip('bridge not reachable');
  const r = await handleToolCall(bridge, 'transcribe_image', { mediaId: SEED_MEDIA });
  assert.ok(r.ok, r.error);
  const d = r.data as { transcription: string };
  assert.ok(d.transcription && d.transcription.length > 0);
});
