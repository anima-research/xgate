/**
 * XMcplServer — MCPL 0.5 server orchestrator for X/Twitter.
 *
 * initialize handshake, JSON-RPC main loop, tools/list + tools/call (feature-set
 * gated), and channels (open/close/list) backed by the bridge's per-resource SSE
 * stream. New tweets are delivered with `channels/incoming` as a **Request**
 * (SPEC §14.3), so the per-message acceptance results are observable.
 *
 * Authorization model (SPEC §5.4): the host-computed capability grant is the only
 * thing that decides what this server may do. The server starts with the empty
 * grant and stays there until the host's `featureSets/update` Request arrives
 * (§5.3) — it never grants itself anything, and it never treats a rejection as a
 * grant (§6.6).
 *
 * The bridge is the source of truth and is user-agnostic; read/unread cursors
 * live host-side (see x-bridge/DESIGN.md), so this server keeps no per-user
 * state — only the set of open channels and their live SSE subscriptions.
 */

import {
  McplConnection,
  textContent,
  method,
} from '@animalabs/mcpl-core';
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  ContentBlock,
  ChannelsListResult,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  StateRollbackParams,
  StateRollbackResult,
} from '@animalabs/mcpl-core';

import type { BridgeClient, BridgeTweet } from './bridge-client.js';
import { toolDefinitions } from './tools.js';
import { handleToolCall, type ToolStateCheckpoint } from './handlers.js';
import {
  featureSets,
  featureSetForTool,
  isEnabled,
  deriveEnabledFeatureSets,
} from './feature-sets.js';
import { CapabilityGrant, MalformedPolicyError } from './capabilities.js';
import type {
  ChannelsIncomingParams,
  ChannelsIncomingResult,
  DegradationReceipt,
  FeatureSetsUpdateParams,
  IncomingChannelMessage,
  XMcplAdvertisement,
} from './protocol.js';
import {
  ChannelManager,
  addressFromOpen,
  resourceKeyFor,
  tagsFor,
  toDescriptor,
  type XChannelAddress,
} from './channels.js';
import { SseSubscription } from './sse.js';

export interface XMcplServerOptions {
  /** Backfill the channel with this many recent cached tweets on open (0 = none). */
  backfillOnOpen?: number;
}

/** JSON-RPC invalid-params; used when a policy message is malformed (§5.4). */
const INVALID_PARAMS = -32602;

export class XMcplServer {
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  /**
   * The host-computed grant. Empty until the initial policy Request lands: until
   * then every capability-dependent behavior is unavailable (§5.3).
   */
  private grant = CapabilityGrant.empty();
  /**
   * Set only by the Request form of `featureSets/update` — a Notification cannot
   * establish a ready state (§6.7).
   */
  private policyEstablished = false;
  private enabledFeatureSets = new Set<string>();
  private readonly channelManager = new ChannelManager();
  private readonly channelAddresses = new Map<string, XChannelAddress>();
  private readonly subscriptions = new Map<string, SseSubscription>();
  private readonly warned = new Set<string>();
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
    const params = msg.request.params as
      | { capabilities?: { experimental?: { mcpl?: unknown } } }
      | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;

    // §5.1: advertisement mirrors the capability paths and is recursive. Declare
    // only what this server actually exercises — advertisement is an input to the
    // host's grant computation (§5.4), so over-declaring widens the computed grant
    // for nothing. This server has no push/event call site, no channels/publish
    // handler, no outgoing streaming, no acknowledge and no typing, so none of
    // those are advertised.
    const advertisement: XMcplAdvertisement = {
      version: '0.5',
      channels: {
        register: true, // channels/list
        lifecycle: true, // channels/open, channels/close
        incoming: true, // channels/incoming
      },
      rollback: true, // §8.1 state management; not a §6.2 capability path
      featureSets,
    };
    const result = {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        ...(this.mcplEnabled && { experimental: { mcpl: advertisement } }),
      },
      serverInfo: { name: 'x-mcpl', version: '0.1.0' },
    };
    conn.sendResponse(msg.request.id, result);

    const inited = await conn.nextMessage();
    if (inited.type === 'notification' && inited.notification.method === 'notifications/initialized') {
      console.error(`[x-mcpl] client initialized (${this.mcplEnabled ? 'MCPL' : 'MCP'} mode)`);
    }
    // Deliberately nothing is enabled here. §5.4: absence of a capability is
    // denial, never a default-allow, and a server may not supply the key its own
    // requests are authorised against.
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
            await this.handleToolCall(
              params.name as string,
              (params.arguments ?? {}) as Record<string, unknown>,
              params.state, // host-injected state for stateful (x.feed) tools
            ),
          );
          break;
        case method.FEATURE_SETS_UPDATE:
          // §6.7 dual-mode: the Request form is how initial policy and every grant
          // change arrive, and its response is a degradation receipt.
          this.handlePolicyRequest(req, params as FeatureSetsUpdateParams);
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
          this.channelAddresses.delete(p.channelId);
          conn.sendResponse(req.id, { closed: this.channelManager.close(p.channelId) } as ChannelsCloseResult);
          break;
        }
        case method.STATE_ROLLBACK:
          conn.sendResponse(req.id, this.handleRollback(params as unknown as StateRollbackParams));
          break;
        default:
          // §6.6: a method that will never be answered MUST return an error.
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
      this.handlePolicyNotification((notif.params ?? {}) as FeatureSetsUpdateParams);
    }
    // Read-only server: no outgoing channel publishes to handle.
  }

  // ── Negotiated policy (§5.3, §5.4, §6.4, §6.7) ──

  private handlePolicyRequest(req: JsonRpcRequest, params: FeatureSetsUpdateParams): void {
    const conn = this.conn!;
    let grant: CapabilityGrant;
    try {
      grant = CapabilityGrant.fromPolicy(params.effectiveCapabilities, params.deniedCapabilities);
    } catch (err) {
      if (!(err instanceof MalformedPolicyError)) throw err;
      // §5.4: a path in both lists ⇒ fail closed and reject the message as malformed.
      this.failClosed();
      conn.sendError(req.id, INVALID_PARAMS, `Malformed capability policy: ${err.message}`);
      return;
    }
    // §6.7: a reduction takes effect atomically before the receipt is sent;
    // security cannot wait on consent. Applying before responding satisfies both
    // orderings, since an expansion is not acted on until the host has our receipt.
    const receipt = this.applyGrant(grant, params);
    this.policyEstablished = true;
    this.warned.clear();
    conn.sendResponse(req.id, receipt);
  }

  private handlePolicyNotification(params: FeatureSetsUpdateParams): void {
    let grant: CapabilityGrant;
    try {
      grant = CapabilityGrant.fromPolicy(params.effectiveCapabilities, params.deniedCapabilities);
    } catch (err) {
      if (!(err instanceof MalformedPolicyError)) throw err;
      console.error(`[x-mcpl] malformed featureSets/update notification: ${(err as Error).message}`);
      this.failClosed();
      return;
    }
    // §6.7: Notifications are valid only for changes that do not alter the grant.
    // A reduction is safe to honour from either form; an expansion is not, so it is
    // ignored rather than acted on, and never establishes a ready state.
    if (!grant.isNoWiderThan(this.grant)) {
      console.error(
        '[x-mcpl] featureSets/update Notification would widen the grant; ignoring the ' +
          'capability change (SPEC §6.7 requires the Request form for any grant change)',
      );
      return;
    }
    this.applyGrant(grant, params);
  }

  /**
   * Install a grant and re-derive feature sets from it (§6.4), returning the
   * degradation receipt (§6.7).
   *
   * The receipt is consequence testimony only: it reports what this server will
   * do, never what it is entitled to, and nothing in it asks the host to widen
   * anything.
   */
  private applyGrant(grant: CapabilityGrant, params: FeatureSetsUpdateParams): DegradationReceipt {
    this.grant = grant;
    const { enabled, unavailable } = deriveEnabledFeatureSets(
      featureSets,
      grant,
      params.enabled,
      params.disabled,
    );
    this.enabledFeatureSets = enabled;
    console.error(
      `[x-mcpl] policy applied: grant=[${grant.entries.join(', ') || 'none'}] ` +
        `enabled=[${[...enabled].join(', ') || 'none'}]`,
    );
    return {
      accepted: true,
      mode: unavailable.length > 0 ? 'degraded' : 'full',
      unavailableFeatures: unavailable,
      notes: [],
    };
  }

  /** Drop to the empty grant: deny everything until a well-formed policy arrives. */
  private failClosed(): void {
    this.grant = CapabilityGrant.empty();
    this.enabledFeatureSets = new Set();
    this.policyEstablished = false;
  }

  // ── Tools ──

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    injectedState?: unknown,
  ): Promise<{ content: ContentBlock[]; isError?: boolean; state?: ToolStateCheckpoint }> {
    const fs = featureSetForTool(name);
    if (fs && this.mcplEnabled && !isEnabled(fs, this.enabledFeatureSets)) {
      return { content: [textContent(`Feature set '${fs}' is not enabled`)], isError: true };
    }
    const result = await handleToolCall(this.bridge, name, args, injectedState);
    if (!result.ok) {
      return { content: [textContent(result.error ?? 'tool error')], isError: true };
    }
    // A stateful (x.feed) tool may return a checkpoint for the host to persist.
    const stateField = result.state ? { state: result.state } : {};
    // Some tools (get_image) return ready content blocks (e.g. image blocks).
    if (result.content) return { content: result.content, ...stateField };
    // Prefer the tool's compact rendering; fall back to raw JSON.
    const text = result.text ?? JSON.stringify(result.data);
    return { content: [textContent(text)], ...stateField };
  }

  // ── Channels ──

  private async handleChannelOpen(params: ChannelsOpenParams): Promise<ChannelsOpenResult> {
    const addr = addressFromOpen(params.type, params.address);
    if (!addr) throw new Error(`Cannot open channel: bad type/address (${params.type})`);

    const descriptor = toDescriptor(addr);
    this.channelManager.register(descriptor);
    this.channelManager.open(descriptor.id);
    this.channelAddresses.set(descriptor.id, addr);

    // The host asked for this channel, so it is opened; whether anything may be
    // delivered on it is decided per message, at send time, against the current
    // grant (§14.5 receipt-time validation).
    this.canDeliverIncoming(descriptor.id);

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
        (tweet) => void this.deliverIncoming(descriptor.id, addr, tweet),
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
    // Oldest-first so the host sees chronological backscroll, and one at a time so
    // the host's per-message results stay attributable.
    for (const t of [...tweets].reverse()) await this.deliverIncoming(channelId, addr, t);
  }

  /**
   * May we send `channels/incoming` right now?
   *
   * §14.1: `channels/incoming` is server→host content injection plus wake
   * authority — a write, and one of the most consequential a server has. It
   * requires `channels.incoming` in the current grant, and §5.3 forbids it before
   * the initial policy exchange completes.
   */
  private canDeliverIncoming(channelId: string): boolean {
    if (!this.mcplEnabled) return false;
    if (!this.policyEstablished) {
      this.warnOnce(
        'no-policy',
        'withholding channels/incoming: no featureSets/update Request received yet ' +
          '(SPEC §5.3 — capability-dependent behavior is unavailable until initial policy)',
      );
      return false;
    }
    if (!this.grant.allows('channels.incoming')) {
      this.warnOnce(
        'no-incoming',
        `withholding channels/incoming on ${channelId}: capability 'channels.incoming' ` +
          'is not in the effective grant',
      );
      return false;
    }
    return true;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.error(`[x-mcpl] ${message}`);
  }

  private toIncomingMessage(
    channelId: string,
    addr: XChannelAddress,
    tweet: BridgeTweet,
  ): IncomingChannelMessage {
    // Text first, then any images as image blocks (uri the host can fetch from
    // the bridge), each followed by its alt-text/transcription as text so a
    // text-only bot still gets the content.
    const content: ContentBlock[] = [textContent(tweet.text)];
    let hasImage = false;
    for (const m of tweet.media ?? []) {
      if (m.type && m.type !== 'photo' && m.type !== 'animated_gif') continue;
      hasImage = true;
      content.push({ type: 'image', uri: this.bridge.mediaUrl(m.media_id) } as ContentBlock);
      const caption = m.alt_text || m.transcription;
      if (caption) content.push(textContent(`[image] ${caption}`));
    }
    return {
      channelId,
      messageId: tweet.tweet_id,
      threadId: tweet.conversation_id ?? undefined,
      author: { id: tweet.author_id ?? '', name: tweet.author_username ?? 'unknown' },
      // Fall back to the current time (not the 1970 epoch) when a tweet has no
      // timestamp, so undated items don't sort to the beginning of time.
      timestamp: tweet.created_at ?? new Date().toISOString(),
      content,
      // §16: producer-authored treatment hints. Never authority (§16.6).
      tags: tagsFor(addr, hasImage),
      metadata: {
        url: tweet.author_username
          ? `https://x.com/${tweet.author_username}/status/${tweet.tweet_id}`
          : undefined,
        reply_to: tweet.reply_to_tweet_id,
        retweet_count: tweet.retweet_count,
        favorite_count: tweet.favorite_count,
        // (media is already delivered as image blocks in `content`; not duplicated here)
      },
    };
  }

  /**
   * Deliver one inbound item with `channels/incoming` as a **Request** (§14.3).
   *
   * The response carries per-message `results`, so partial acceptance is visible;
   * sending this as a Notification discards that contract. Results and errors are
   * logged as diagnostics only — §6.6: rejection is diagnostics, not
   * authorization. Nothing here re-enables, re-grants or renegotiates anything in
   * response to what the host says about a rejected message.
   */
  private async deliverIncoming(
    channelId: string,
    addr: XChannelAddress,
    tweet: BridgeTweet,
  ): Promise<void> {
    if (!this.conn || this.conn.isClosed) return;
    if (!this.canDeliverIncoming(channelId)) return;

    const params: ChannelsIncomingParams = {
      messages: [this.toIncomingMessage(channelId, addr, tweet)],
    };
    try {
      const result = (await this.conn.sendRequest(
        method.CHANNELS_INCOMING,
        params,
      )) as ChannelsIncomingResult | undefined;
      for (const r of result?.results ?? []) {
        if (r.accepted) continue;
        console.error(
          `[x-mcpl] host did not accept ${r.messageId} on ${channelId}` +
            (r.reason ? `: ${r.reason}` : ''),
        );
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === 'ConnectionClosedError') return;
      console.error(`[x-mcpl] channels/incoming failed on ${channelId}: ${e.message}`);
    }
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
