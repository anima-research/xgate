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
  alt_text: string | null;
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
  /** Gate token — sent as `Authorization: Bearer <token>` when the bridge requires it. */
  token?: string;
}

/** Thrown for non-2xx bridge responses (404 cache-miss is surfaced as null, not thrown). */
export class BridgeError extends Error {
  constructor(public status: number, public body: string) {
    super(`bridge error ${status}: ${body.slice(0, 200)}`);
    this.name = 'BridgeError';
  }
}

export class BridgeClient {
  /** Public so the SSE subscriber can derive the /stream URL from the same base. */
  readonly baseUrl: string;
  /** Public so the SSE subscriber can send the same auth header. */
  readonly token?: string;
  private readonly timeoutMs: number;

  constructor(config: BridgeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.token = config.token;
  }

  /** Auth headers for bridge requests (empty when no token configured). */
  authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /** Low-level GET returning parsed JSON, or null on 404 (cache miss). */
  private async get<T>(path: string): Promise<T | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        signal: ctrl.signal,
        headers: this.authHeaders(),
      });
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

  /** Single tweet. `fresh` forces a live refetch; `transcribe` transcribes its images. */
  async getTweet(tweetId: string, fresh = false, transcribe = false): Promise<BridgeTweet | null> {
    const params = new URLSearchParams();
    if (fresh) params.set('fresh', '1');
    if (transcribe) params.set('transcribe', '1');
    const qs = params.toString() ? `?${params}` : '';
    return this.get<BridgeTweet>(`/tweet/${encodeURIComponent(tweetId)}${qs}`);
  }

  /** Stable URL for an image's original bytes (bridge caches + serves them). */
  mediaUrl(mediaId: string): string {
    return `${this.baseUrl}/media/${encodeURIComponent(mediaId)}`;
  }

  /** On-demand transcription of one image (Haiku on the bridge). null if unavailable. */
  async transcribeImage(mediaId: string): Promise<string | null> {
    const r = await this.get<{ transcription: string }>(
      `/media/${encodeURIComponent(mediaId)}/transcription`,
    );
    return r?.transcription ?? null;
  }

  /** All cached tweets in a conversation, oldest-first. `transcribe` triggers a
   *  bounded-parallel batch transcription of every image in the thread. */
  async getThread(conversationId: string, transcribe = false): Promise<BridgeTweet[]> {
    const qs = transcribe ? '?transcribe=1' : '';
    const r = await this.get<{ tweets: BridgeTweet[] }>(
      `/thread/${encodeURIComponent(conversationId)}${qs}`,
    );
    return r?.tweets ?? [];
  }

  /** Profile derived from cached tweets (full profile is a later bridge feature). */
  async getUser(handleOrId: string): Promise<BridgeUser | null> {
    return this.get<BridgeUser>(`/user/${encodeURIComponent(handleOrId)}`);
  }

  /** Author timeline, newest-first. `before` is an ISO timestamp for paging. */
  async userTimeline(handleOrId: string, limit = 50, before?: string, transcribe = false): Promise<BridgeTweet[]> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) qs.set('before', before);
    if (transcribe) qs.set('transcribe', '1');
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

  /** Cheap thread summary (size, participants, span, image count) — no bodies. */
  async threadPreview(conversationId: string): Promise<BridgeThreadPreview | null> {
    return this.get<BridgeThreadPreview>(`/thread/${encodeURIComponent(conversationId)}/preview`);
  }

  /** Cheap timeline summary for an author — no bodies. */
  async timelinePreview(handleOrId: string): Promise<BridgeTimelinePreview | null> {
    return this.get<BridgeTimelinePreview>(`/timeline/${encodeURIComponent(handleOrId)}/preview`);
  }
}

export interface BridgeThreadPreview {
  conversation_id: string;
  count: number;
  participants: { handle: string; count: number }[];
  first: string | null;
  last: string | null;
  media_count: number;
  root_author: string | null;
}

export interface BridgeTimelinePreview {
  handle: string;
  author_id: string | null;
  count: number;
  first: string | null;
  last: string | null;
  last_tweet_at: string | null;
  media_count: number;
}
