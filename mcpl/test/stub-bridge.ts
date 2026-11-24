/**
 * A bridge for tests: the routes the frontend uses, over a handful of tweets
 * held in memory. It finds a thread the way the real bridge does (reply links
 * and conversation ids), and refuses an unquoted handle as FTS5 does.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BridgeMedia, BridgeTweet } from '../src/bridge-client.js';

export function tweet(id: string, author: string, text: string, at: string, more: Partial<BridgeTweet> = {}): BridgeTweet {
  return {
    tweet_id: id, author_id: `u_${author}`, author_username: author, text, created_at: at,
    reply_to_tweet_id: null, reply_to_username: null, conversation_id: null,
    retweet_count: 0, favorite_count: 0, source: 'test', media: [], urls: [], ...more,
  };
}

export const image = (id: string, said: string | null = null): BridgeMedia => ({ media_id: id, url: `https://pbs.example/${id}.png`, type: 'photo', width: 1, height: 1, transcription: said, alt_text: null });

/** A 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function threadOf(tweets: BridgeTweet[], id: string): BridgeTweet[] {
  const byId = new Map(tweets.map((t) => [t.tweet_id, t]));
  const convs = new Set([id]);
  const members = new Set<string>();
  for (let t = byId.get(id); t; t = t.reply_to_tweet_id ? byId.get(t.reply_to_tweet_id) : undefined) {
    members.add(t.tweet_id); convs.add(t.tweet_id);
    if (t.conversation_id) convs.add(t.conversation_id);
  }
  for (const t of tweets) if (convs.has(t.tweet_id) || (t.conversation_id && convs.has(t.conversation_id))) members.add(t.tweet_id);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of tweets) if (!members.has(t.tweet_id) && t.reply_to_tweet_id && members.has(t.reply_to_tweet_id)) { members.add(t.tweet_id); grew = true; }
  }
  return tweets.filter((t) => members.has(t.tweet_id)).sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
}

export interface StubBridge { url: string; tweets: BridgeTweet[]; requests: string[]; close: () => void }

export async function stubBridge(tweets: BridgeTweet[]): Promise<StubBridge> {
  const requests: string[] = [];
  const newest = (list: BridgeTweet[]) => [...list].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = decodeURIComponent(url.pathname);
    const q = url.searchParams;
    requests.push(`${path}${url.search}`);
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const limit = Number(q.get('limit') ?? 50);
    let m: RegExpExecArray | null;
    if (path === '/health') return send(200, { ok: true, version: 'stub', db: '', allow_fetch: false, bearer_configured: false, tweets: tweets.length, media: 0 });
    if (path === '/budget') return send(200, { calls: 0, total_usd: 0, posts: 0, users: 0, media: 0, last_call: null });
    if ((m = /^\/tweet\/(\d+)$/.exec(path))) { const t = tweets.find((x) => x.tweet_id === m![1]); return t ? send(200, t) : send(404, { cached: false }); }
    if ((m = /^\/thread\/(\d+)\/preview$/.exec(path))) {
      const th = threadOf(tweets, m[1]!);
      if (!th.length) return send(404, { cached: false });
      const by = new Map<string, number>();
      for (const t of th) by.set(t.author_username!, (by.get(t.author_username!) ?? 0) + 1);
      return send(200, { conversation_id: m[1], count: th.length, participants: [...by].map(([handle, count]) => ({ handle, count })), first: th[0]!.created_at, last: th.at(-1)!.created_at, media_count: th.reduce((n, t) => n + t.media.length, 0), root_author: th[0]!.author_username });
    }
    if ((m = /^\/thread\/(\d+)$/.exec(path))) { const th = threadOf(tweets, m[1]!); return send(200, { conversation_id: m[1], count: th.length, tweets: th }); }
    if ((m = /^\/timeline\/([^/]+)\/preview$/.exec(path))) {
      const mine = newest(tweets.filter((t) => t.author_username === m![1]));
      return send(200, { handle: m[1], author_id: null, count: mine.length, first: mine.at(-1)?.created_at ?? null, last: mine[0]?.created_at ?? null, last_tweet_at: mine[0]?.created_at ?? null, media_count: 0 });
    }
    if ((m = /^\/timeline\/([^/]+)$/.exec(path))) {
      const since = q.get('since'); const before = q.get('before');
      const mine = newest(tweets.filter((t) => t.author_username === m![1] && (!since || t.created_at! >= since) && (!before || t.created_at! < before)));
      return send(200, { who: m[1], count: mine.length, tweets: mine.slice(0, limit) });
    }
    if (path === '/search') {
      const query = q.get('q') ?? '';
      if (/^[^"]*[@+]/.test(query)) return send(500, { error: `fts5: syntax error near "${/[@+]/.exec(query)![0]}"` });
      const needle = query.replace(/"/g, '').toLowerCase();
      const since = q.get('since'); const author = q.get('author');
      let found = tweets.filter((t) => t.text.toLowerCase().includes(needle) && (!since || t.created_at! >= since) && (!author || t.author_username === author));
      if (q.get('order') === 'recent' || !query) found = newest(found);
      return send(200, { query, count: found.length, tweets: found.slice(0, limit) });
    }
    if ((m = /^\/user\/([^/]+)$/.exec(path))) {
      const mine = tweets.filter((t) => t.author_username === m![1]);
      return mine.length ? send(200, { author_id: `u_${m[1]}`, handle: m[1], cached_tweet_count: mine.length, first_seen: mine[0]!.created_at, last_seen: mine.at(-1)!.created_at, source: 'derived-from-cache' }) : send(404, { cached: false });
    }
    if ((m = /^\/media\/([\w-]+)\/transcription$/.exec(path))) {
      const media = tweets.flatMap((t) => t.media).find((x) => x.media_id === m![1]);
      if (!media) return send(404, { error: 'unknown media' });
      return media.transcription ? send(200, { media_id: m[1], transcription: media.transcription }) : send(403, { error: 'transcription requires a fetch-enabled token' });
    }
    if ((m = /^\/media\/([\w-]+)$/.exec(path))) {
      if (!tweets.some((t) => t.media.some((x) => x.media_id === m![1]))) return send(404, { error: 'media not available' });
      res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return;
    }
    send(404, { error: 'no such route', path });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tweets, requests, close: () => server.close() };
}
