/**
 * SSE subscription to the bridge's /stream/:resource endpoint.
 *
 * The bridge's per-resource poller fetches new tweets and fans them out as
 * Server-Sent Events; this class consumes one such stream and invokes a
 * callback per item. The MCPL server (server.ts) turns those into
 * channels/incoming notifications for the host.
 */

import type { BridgeTweet } from './bridge-client.js';

export interface SseEvent {
  /** SSE event type, e.g. "tweet" or "heartbeat". */
  event: string;
  /** Parsed JSON payload (a BridgeTweet for "tweet" events). */
  data: unknown;
}

export class SseSubscription {
  private ctrl: AbortController | null = null;
  private stopped = false;

  constructor(
    private readonly baseUrl: string,
    private readonly resourceKey: string,
    private readonly onTweet: (t: BridgeTweet) => void,
    private readonly onError?: (e: Error) => void,
  ) {}

  /** Open the stream and pump events until stop() or the connection drops. */
  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.ctrl?.abort();
  }

  private async run(): Promise<void> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/stream/${encodeURIComponent(this.resourceKey)}`;
    while (!this.stopped) {
      this.ctrl = new AbortController();
      try {
        const res = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal: this.ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${this.resourceKey} -> HTTP ${res.status}`);
        await this.pump(res.body);
      } catch (e) {
        if (this.stopped) return;
        this.onError?.(e as Error);
      }
      // Reconnect with a small backoff unless stopped.
      if (!this.stopped) await sleep(2000);
    }
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.dispatch(frame);
      }
    }
  }

  private dispatch(frame: string): void {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // comment / heartbeat
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (event === 'tweet' && data && typeof data === 'object') {
      this.onTweet(data as BridgeTweet);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
