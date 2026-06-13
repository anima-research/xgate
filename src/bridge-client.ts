/**
 * BridgeClient — typed HTTP client for the x-bridge daemon.
 *
 * This is the X analog of discord-mcpl's discord-adapter.ts: it wraps the
 * external service (here, the bridge's HTTP read contract) behind a clean,
 * typed async interface that the MCPL server (server.ts, next phase) drives.
 *
 * The bridge owns the cache, the token, the cost budget, and (later) the
 * poller; this client just speaks its contract. Read path only for Phase 2.
 */

/** A normalized tweet as returned by the bridge. */
export interface BridgeTweet {
  tweet_id: string;
  author_id: string | null;
  author_username: string | null;
  text: string;
  created_at: string | null;
  reply_to_tweet_id: string | null;
  reply_to_username: string | null;
  conversation_id: string | null;
  retweet_count: number;
  favorite_count: number;
  source: string | null;
  media: BridgeMedia[];
  urls: BridgeUrl[];
}

export interface BridgeMedia {
  media_id: string;
  url: string | null;
  type: string | null;
  width: number | null;
  height: number | null;
  transcription: string | null;
}

export interface BridgeUrl {
  url: string | null;
  expanded_url: string | null;
}

export interface BridgeUser {
  author_id: string | null;
  handle: string | null;
  cached_tweet_count: number;
  first_seen: string | null;
  last_seen: string | null;
  source: string;
}

export interface BridgeHealth {
  ok: boolean;
  version: string;
  db: string;
  allow_fetch: boolean;
  bearer_configured: boolean;
  tweets: number;
  media: number;
}

export interface BridgeBudget {
  calls: number;
  total_usd: number;
  posts: number;
  users: number;
  media: number;
  last_call: string | null;
}

export interface BridgeClientConfig {
  /** Base URL of the bridge daemon, e.g. http://127.0.0.1:8810 */
  baseUrl: string;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
}

/** Thrown for non-2xx bridge responses (404 cache-miss is surfaced as null, not thrown). */
export class BridgeError extends Error {
  constructor(public status: number, public body: string) {
    super(`bridge error ${status}: ${body.slice(0, 200)}`);
    this.name = 'BridgeError';
  }
}

export class BridgeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: BridgeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  /** Low-level GET returning parsed JSON, or null on 404 (cache miss). */
  private async get<T>(path: string): Promise<T | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: ctrl.signal });
      if (res.status === 404) return null;
      const body = await res.text();
      if (!res.ok) throw new BridgeError(res.status, body);
      return JSON.parse(body) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<BridgeHealth> {
    const h = await this.get<BridgeHealth>('/health');
    if (!h) throw new BridgeError(500, 'no health response');
    return h;
  }

  async budget(): Promise<BridgeBudget> {
    const b = await this.get<BridgeBudget>('/budget');
    if (!b) throw new BridgeError(500, 'no budget response');
    return b;
  }

  /** Single tweet. `fresh` forces a live refetch (costs money on the bridge). */
  async getTweet(tweetId: string, fresh = false): Promise<BridgeTweet | null> {
    return this.get<BridgeTweet>(`/tweet/${encodeURIComponent(tweetId)}${fresh ? '?fresh=1' : ''}`);
  }

  /** All cached tweets in a conversation, oldest-first. */
  async getThread(conversationId: string): Promise<BridgeTweet[]> {
    const r = await this.get<{ tweets: BridgeTweet[] }>(`/thread/${encodeURIComponent(conversationId)}`);
    return r?.tweets ?? [];
  }

  /** Profile derived from cached tweets (full profile is a later bridge feature). */
  async getUser(handleOrId: string): Promise<BridgeUser | null> {
    return this.get<BridgeUser>(`/user/${encodeURIComponent(handleOrId)}`);
  }

  /** Author timeline, newest-first. `before` is an ISO timestamp for paging. */
  async userTimeline(handleOrId: string, limit = 50, before?: string): Promise<BridgeTweet[]> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) qs.set('before', before);
    const r = await this.get<{ tweets: BridgeTweet[] }>(
      `/timeline/${encodeURIComponent(handleOrId)}?${qs.toString()}`,
    );
    return r?.tweets ?? [];
  }

  /** Full-text search over cached tweets (FTS5 on the bridge). */
  async search(query: string, limit = 50): Promise<BridgeTweet[]> {
    const qs = new URLSearchParams({ q: query, limit: String(limit) });
    const r = await this.get<{ tweets: BridgeTweet[] }>(`/search?${qs.toString()}`);
    return r?.tweets ?? [];
  }
}
