/**
 * XMcplServer — MCPL server orchestrator for X/Twitter.
 *
 * Mirrors discord-mcpl/src/server.ts: initialize handshake, JSON-RPC main loop,
 * tools/list + tools/call (feature-set gated), and channels (open/close/list)
 * backed by the bridge's per-resource SSE stream. New tweets arrive as
 * channels/incoming notifications.
 *
 * The bridge is the source of truth and is user-agnostic; read/unread cursors
 * live host-side (see x-bridge/DESIGN.md), so this server keeps no per-user
 * state — only the set of open channels and their live SSE subscriptions.
 */

import {
  McplConnection,
  textContent,
  method,
} from '@connectome/mcpl-core';
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  McplCapabilities,
  McplInitializeParams,
  McplInitializeResult,
  InitializeCapabilities,
  ContentBlock,
  ChannelDescriptor,
  ChannelsListResult,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsIncomingParams,
  FeatureSetsUpdateParams,
  StateRollbackParams,
  StateRollbackResult,
} from '@connectome/mcpl-core';

import type { BridgeClient, BridgeTweet } from './bridge-client.js';
import { toolDefinitions } from './tools.js';
import { handleToolCall } from './handlers.js';
import { featureSets, featureSetForTool, isEnabled } from './feature-sets.js';
import {
  ChannelManager,
  addressFromOpen,
  resourceKeyFor,
  toDescriptor,
  parseMcplChannelId,
  type XChannelAddress,
} from './channels.js';
import { SseSubscription } from './sse.js';

export interface XMcplServerOptions {
  /** Backfill the channel with this many recent cached tweets on open (0 = none). */
  backfillOnOpen?: number;
}

export class XMcplServer {
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  private readonly enabledFeatureSets = new Set<string>();
  private readonly channelManager = new ChannelManager();
  private readonly subscriptions = new Map<string, SseSubscription>();
  private readonly backfillOnOpen: number;

  constructor(private readonly bridge: BridgeClient, opts: XMcplServerOptions = {}) {
    this.backfillOnOpen = opts.backfillOnOpen ?? 0;
  }

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    await this.handleInitialize();
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') await this.handleRequest(msg.request);
        else this.handleNotification(msg.notification);
      }
    } catch (err) {
      if ((err as Error).name !== 'ConnectionClosedError') {
        console.error('[x-mcpl] connection error:', err);
      }
    } finally {
      for (const sub of this.subscriptions.values()) sub.stop();
      this.subscriptions.clear();
      this.conn = null;
    }
  }

  // ── Handshake ──

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      console.error('[x-mcpl] expected initialize, got', msg);
      conn.close();
      return;
    }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;

    const serverCaps: McplCapabilities = {
      version: '0.4',
      pushEvents: true,
      channels: true,
      rollback: true,
      featureSets,
    };
    const capabilities: InitializeCapabilities = {
      tools: {},
      ...(this.mcplEnabled && { experimental: { mcpl: serverCaps } }),
    };
    const result: McplInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'x-mcpl', version: '0.1.0' },
    };
    conn.sendResponse(msg.request.id, result);

    const inited = await conn.nextMessage();
    if (inited.type === 'notification' && inited.notification.method === 'notifications/initialized') {
      console.error(`[x-mcpl] client initialized (${this.mcplEnabled ? 'MCPL' : 'MCP'} mode)`);
    }
    if (this.mcplEnabled) {
      for (const fs of featureSets) this.enabledFeatureSets.add(fs.name);
    }
  }

  // ── Request dispatch ──

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list':
          conn.sendResponse(req.id, { tools: toolDefinitions });
          break;
        case 'tools/call':
          conn.sendResponse(
            req.id,
            await this.handleToolCall(params.name as string, (params.arguments ?? {}) as Record<string, unknown>),
          );
          break;
        case method.CHANNELS_LIST:
          conn.sendResponse(req.id, { channels: this.channelManager.getAll() } as ChannelsListResult);
          break;
        case method.CHANNELS_OPEN:
          conn.sendResponse(req.id, await this.handleChannelOpen(params as unknown as ChannelsOpenParams));
          break;
        case method.CHANNELS_CLOSE: {
          const p = params as unknown as ChannelsCloseParams;
          this.subscriptions.get(p.channelId)?.stop();
          this.subscriptions.delete(p.channelId);
          conn.sendResponse(req.id, { closed: this.channelManager.close(p.channelId) } as ChannelsCloseResult);
          break;
        }
        case method.STATE_ROLLBACK:
          conn.sendResponse(req.id, this.handleRollback(params as unknown as StateRollbackParams));
          break;
        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      const e = err as Error;
      console.error(`[x-mcpl] handleRequest error: method=${req.method}`, e.stack ?? e.message);
      conn.sendError(req.id, -32603, e.message);
    }
  }

  private handleNotification(notif: JsonRpcNotification): void {
    if (notif.method === method.FEATURE_SETS_UPDATE) {
      const p = notif.params as FeatureSetsUpdateParams;
      p.enabled?.forEach((n) => this.enabledFeatureSets.add(n));
      p.disabled?.forEach((n) => this.enabledFeatureSets.delete(n));
    }
    // Read-only server: no outgoing channel publishes to handle.
  }

  // ── Tools ──

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: ContentBlock[]; isError?: boolean }> {
    const fs = featureSetForTool(name);
    if (fs && this.mcplEnabled && !isEnabled(fs, this.enabledFeatureSets)) {
      return { content: [textContent(`Feature set '${fs}' is not enabled`)], isError: true };
    }
    const result = await handleToolCall(this.bridge, name, args);
    if (!result.ok) {
      return { content: [textContent(result.error ?? 'tool error')], isError: true };
    }
    // Some tools (get_image) return ready content blocks (e.g. image blocks).
    if (result.content) return { content: result.content };
    return { content: [textContent(JSON.stringify(result.data))] };
  }

  // ── Channels ──

  private async handleChannelOpen(params: ChannelsOpenParams): Promise<ChannelsOpenResult> {
    const addr = addressFromOpen(params.type, params.address);
    if (!addr) throw new Error(`Cannot open channel: bad type/address (${params.type})`);

    const descriptor = toDescriptor(addr);
    this.channelManager.register(descriptor);
    this.channelManager.open(descriptor.id);

    // Optional backfill: deliver recent cached items so the channel isn't empty.
    if (this.backfillOnOpen > 0) {
      void this.backfill(descriptor.id, addr).catch((e) =>
        console.error('[x-mcpl] backfill failed:', (e as Error).message),
      );
    }

    // Subscribe to the bridge's per-resource stream for live new items.
    if (!this.subscriptions.has(descriptor.id)) {
      const sub = new SseSubscription(
        this.bridge.baseUrl,
        resourceKeyFor(addr),
        (tweet) => this.pushIncoming(descriptor.id, tweet),
        (e) => console.error(`[x-mcpl] stream ${descriptor.id} error:`, e.message),
        this.bridge.authHeaders(),
      );
      sub.start();
      this.subscriptions.set(descriptor.id, sub);
    }
    return { channel: descriptor };
  }

  private async backfill(channelId: string, addr: XChannelAddress): Promise<void> {
    let tweets: BridgeTweet[] = [];
    if (addr.kind === 'timeline' || addr.kind === 'mentions') {
      tweets = await this.bridge.userTimeline(addr.value, this.backfillOnOpen);
    } else if (addr.kind === 'search') {
      tweets = await this.bridge.search(addr.value, this.backfillOnOpen);
    } else if (addr.kind === 'thread') {
      tweets = await this.bridge.getThread(addr.value);
    }
    // Oldest-first so the host sees chronological backscroll.
    for (const t of [...tweets].reverse()) this.pushIncoming(channelId, t);
  }

  private pushIncoming(channelId: string, tweet: BridgeTweet): void {
    if (!this.conn || this.conn.isClosed) return;
    // Text first, then any images as image blocks (uri the host can fetch from
    // the bridge), each followed by its alt-text/transcription as text so a
    // text-only bot still gets the content.
    const content: ContentBlock[] = [textContent(tweet.text)];
    for (const m of tweet.media ?? []) {
      if (m.type && m.type !== 'photo' && m.type !== 'animated_gif') continue;
      content.push({ type: 'image', uri: this.bridge.mediaUrl(m.media_id) } as ContentBlock);
      const caption = m.alt_text || m.transcription;
      if (caption) content.push(textContent(`[image] ${caption}`));
    }
    const msg: ChannelsIncomingParams = {
      messages: [
        {
          channelId,
          messageId: tweet.tweet_id,
          threadId: tweet.conversation_id ?? undefined,
          author: { id: tweet.author_id ?? '', name: tweet.author_username ?? 'unknown' },
          timestamp: tweet.created_at ?? new Date(0).toISOString(),
          content,
          metadata: {
            url: tweet.author_username
              ? `https://x.com/${tweet.author_username}/status/${tweet.tweet_id}`
              : undefined,
            reply_to: tweet.reply_to_tweet_id,
            retweet_count: tweet.retweet_count,
            favorite_count: tweet.favorite_count,
            media: tweet.media,
          },
        },
      ],
    };
    this.conn.sendNotification(method.CHANNELS_INCOMING, msg);
  }

  // ── Rollback (read-only server: nothing to undo) ──

  private handleRollback(params: StateRollbackParams): StateRollbackResult {
    return {
      checkpoint: params.checkpoint,
      success: false,
      reason: `Feature set '${params.featureSet}' is read-only; nothing to roll back`,
    };
  }
}
