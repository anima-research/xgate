/**
 * XMcplServer — MCPL server orchestrator for X/Twitter.
 *
 * Mirrors discord-mcpl/src/server.ts: initialize handshake, JSON-RPC main loop,
 * tools/list + tools/call (feature-set gated), and channels (open/close/list)
 * backed by the bridge's per-resource SSE stream. New tweets are delivered with
 * `channels/incoming` — a Server → Host **Request** (SPEC §4.1, §14.3), whose
 * per-message `results` are the only way this server learns which items the host
 * accepted.
 *
 * Authorization is the connection grant (§5.4), carried by `featureSets/update`
 * (§5.3, §6.7). Absence of a capability is denial: until the initial policy
 * Request arrives this server holds an empty grant and treats every
 * capability-dependent behavior as unavailable (§5.3).
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
  ChannelsIncomingResult,
  StateRollbackParams,
  StateRollbackResult,
} from '@animalabs/mcpl-core';

import type { BridgeClient, BridgeTweet } from './bridge-client.js';
import { toolDefinitions } from './tools.js';
import { handleToolCall, type ToolStateCheckpoint } from './handlers.js';
import { featureSets, featureSetForTool, isEnabled } from './feature-sets.js';
import {
  CapabilityGrant,
  deriveFeatureSet,
  validatePolicy,
  type CapabilityPath,
  type DegradationReceipt,
  type McplAdvertisement,
  type PolicyParams,
  type UnavailableFeature,
} from './grant.js';
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
  /** Feature sets the host has explicitly switched on (§6.1, wildcards per §6.3). */
  private readonly enabledFeatureSets = new Set<string>();
  /**
   * The effective grant (§5.4). Starts empty: §5.3 requires that until the
   * initial policy exchange completes, every capability-dependent behavior is
   * unavailable. Absence is denial, so an empty grant denies everything.
   */
  private grant: CapabilityGrant = CapabilityGrant.EMPTY;
  /** Set only by a `featureSets/update` **Request** — a Notification cannot establish it (§6.7). */
  private policyEstablished = false;
  private readonly channelManager = new ChannelManager();
  private readonly subscriptions = new Map<string, SseSubscription>();
  private readonly backfillOnOpen: number;
  /**
   * Serializes outbound `channels/incoming` Requests so batches keep their
   * order and only one is in flight at a time.
   */
  private incomingQueue: Promise<void> = Promise.resolve();

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

    // §5.1: the advertisement mirrors the §6.2 capability paths, as a nested
    // object whose members are leaves. It advertises what this server *can* do;
    // it is an input to the host's grant computation and never an authorization
    // (§5.4). Every member below is exercised by code in this file:
    //
    //   tools                — tools/list + tools/call
    //   channels.register    — the inbound channels/list handler (§14.1 table)
    //   channels.lifecycle   — the inbound channels/open + channels/close handlers
    //   channels.incoming    — the outbound channels/incoming Request (§14.3)
    //
    // Deliberately absent:
    //   pushEvents           — no push/event is sent anywhere in this server
    //   channels.publish     — there is no channels/publish handler
    //   channels.streaming / .acknowledge / .typing — not implemented
    //   contextHooks.* / inferenceRequest / inferenceLifecycle / modelInfo — not implemented
    //   rollback             — not a §6.2 capability path; §8.1 keeps rollback on
    //                          the feature set, which is where it is declared
    const serverCaps: McplAdvertisement = {
      version: '0.5',
      tools: true,
      channels: { register: true, lifecycle: true, incoming: true },
      featureSets,
    };
    const capabilities: InitializeCapabilities = {
      tools: {},
      // The published core still types `experimental.mcpl` as the 0.4
      // `McplCapabilities` (channels: boolean, no recursive tree). The wire shape
      // is what §5.1 specifies; the cast is only to satisfy the stale type.
      ...(this.mcplEnabled && { experimental: { mcpl: serverCaps as unknown as McplCapabilities } }),
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
    // No feature set is switched on here. §5.3: "Until the initial policy
    // exchange completes, a server MUST treat every capability-dependent
    // behavior as unavailable", and hosts MUST send `featureSets/update` as a
    // Request "even when nothing is enabled or disabled — a server defaulted to
    // fully disabled has to be told." Pre-enabling everything at init was a
    // default-allow; absence of a grant is denial (§5.4).
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
        // §6.7: `featureSets/update` is dual-mode. The Request form is what
        // hosts MUST use for any change to the effective grant, and its response
        // is a degradation receipt.
        case method.FEATURE_SETS_UPDATE: {
          const receipt = this.applyPolicy(params as PolicyParams, 'request');
          if (receipt === null) {
            // Malformed policy (§5.4): reject rather than answer with a result
            // carrying a failure flag (§6.6).
            conn.sendError(req.id, -32602, 'Malformed featureSets/update: see server log');
          } else {
            conn.sendResponse(req.id, receipt);
          }
          break;
        }
        case method.CHANNELS_LIST:
          // §14.1: channels/list, in either direction, requires channels.register.
          if (!this.authorize(conn, req, 'channels.register')) break;
          conn.sendResponse(req.id, { channels: this.channelManager.getAll() } as ChannelsListResult);
          break;
        case method.CHANNELS_OPEN:
          if (!this.authorize(conn, req, 'channels.lifecycle')) break;
          conn.sendResponse(req.id, await this.handleChannelOpen(params as unknown as ChannelsOpenParams));
          break;
        case method.CHANNELS_CLOSE: {
          if (!this.authorize(conn, req, 'channels.lifecycle')) break;
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
      // §6.7 keeps the Notification form legal for descriptive feature metadata.
      // It cannot establish the grant or a ready state — see applyPolicy.
      this.applyPolicy(notif.params as PolicyParams, 'notification');
    }
    // Read-only server: no outgoing channel publishes to handle.
  }

  /**
   * §5.4: "A denied capability behaves as if never advertised" — the host "MUST
   * reject an inbound method requiring one". This server mirrors that on its own
   * inbound surface rather than acting on authority it was not granted.
   *
   * §6.6 requires a JSON-RPC error object with the documented code, never a
   * result carrying a failure flag, and forbids leaving a request unanswered.
   */
  private authorize(conn: McplConnection, req: JsonRpcRequest, capability: CapabilityPath): boolean {
    if (!this.mcplEnabled) {
      // Plain-MCP mode: this server advertised no channel surface at all, so the
      // method does not exist here.
      conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      return false;
    }
    if (this.grant.has(capability)) return true;
    // -32002 Capability denied (§14.6). The documented `data: { capability }`
    // rides in the message: the published mcpl-core `sendError` takes no `data`.
    conn.sendError(req.id, -32002, `Capability denied: ${capability}`);
    return false;
  }

  // ── Negotiated policy (§5.3, §5.4, §6.7) ──

  /**
   * Apply a `featureSets/update` in either form.
   *
   * Returns the degradation receipt, or `null` when the message was malformed
   * and must be rejected (§5.4).
   */
  private applyPolicy(params: PolicyParams | undefined, form: 'request' | 'notification'): DegradationReceipt | null {
    const v = validatePolicy(params);
    if (v.malformed) {
      console.error(`[x-mcpl] rejecting featureSets/update as malformed: ${v.malformed}`);
      // §5.4 requires failing closed. We no longer know what we may do, so we
      // hold nothing and go back to the pre-policy state of §5.3.
      this.grant = CapabilityGrant.EMPTY;
      this.policyEstablished = false;
      return null;
    }

    if (form === 'request') {
      // §6.7: the Request form is the only thing that establishes the grant and
      // a ready state. An absent `effectiveCapabilities` is an empty allowlist,
      // not a default-allow (§5.4).
      this.grant = new CapabilityGrant(v.effectiveCapabilities);
      this.policyEstablished = true;
    } else if (params !== undefined && params.effectiveCapabilities !== undefined) {
      // §6.7: "Notifications remain valid only for purely descriptive feature
      // metadata that does not alter the grant, and a Notification cannot
      // establish a ready state." A grant-bearing Notification is non-conforming;
      // we apply it only where it narrows and never to widen.
      console.error(
        '[x-mcpl] featureSets/update Notification carried effectiveCapabilities; ' +
          'applied as narrowing only, ready state not established (SPEC 6.7)',
      );
      this.grant = this.grant.intersect(new CapabilityGrant(v.effectiveCapabilities));
    }

    // Host feature-set toggles (§6.1, §6.3). These are switches, not authority:
    // §6.4's derivation below still has to pass.
    for (const n of v.enabled) this.enabledFeatureSets.add(n);
    for (const n of v.disabled) this.enabledFeatureSets.delete(n);

    return this.buildReceipt();
  }

  /**
   * The degradation receipt of §6.7 — what this server *will do* under the
   * grant it was given.
   *
   * It never states what this server is entitled to. §6.7 bars the host from
   * widening any grant in response to a receipt, and a receipt that asked for
   * capabilities would be exactly the coercion lever that rule removes.
   */
  private buildReceipt(): DegradationReceipt {
    const unavailableFeatures: UnavailableFeature[] = [];
    const notes: string[] = [];

    for (const fs of featureSets) {
      const d = deriveFeatureSet(fs, this.grant);
      if (d.enabled) continue;
      if (d.reason === 'invalid_uses') {
        unavailableFeatures.push({ featureSet: fs.name, missingCapabilities: [], effect: 'disabled' });
        notes.push(`${fs.name}: invalid_uses — declared 'uses' is outside the SPEC 6.2 vocabulary; disabled.`);
      } else {
        unavailableFeatures.push({
          featureSet: fs.name,
          missingCapabilities: d.missingCapabilities,
          effect: 'disabled',
        });
      }
    }

    if (!this.grant.has('channels.incoming')) {
      notes.push(
        'channels.incoming not granted: inbound tweets will not be delivered and open channels stay silent.',
      );
    }

    // Always accepted: this server degrades rather than refusing, so §6.7's
    // `fallback` never applies.
    return {
      accepted: true,
      mode: unavailableFeatures.length > 0 ? 'degraded' : 'full',
      unavailableFeatures,
      notes,
    };
  }

  /**
   * A feature set is usable only when the host switched it on (§6.1, §6.3) AND
   * §6.4's derivation from the current grant permits it. Both must hold.
   */
  private isFeatureSetActive(name: string): boolean {
    if (!isEnabled(name, this.enabledFeatureSets)) return false;
    const decl = featureSets.find((f) => f.name === name);
    if (!decl) return false; // unknown set: deny (§5.4, absence is denial)
    return deriveFeatureSet(decl, this.grant).enabled;
  }

  // ── Tools ──

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    injectedState?: unknown,
  ): Promise<{ content: ContentBlock[]; isError?: boolean; state?: ToolStateCheckpoint }> {
    const fs = featureSetForTool(name);
    if (fs && this.mcplEnabled && !this.isFeatureSetActive(fs)) {
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
        (tweet) => this.enqueueIncoming(descriptor.id, tweet),
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
    for (const t of [...tweets].reverse()) this.enqueueIncoming(channelId, t);
  }

  /**
   * Queue one tweet for delivery. Enqueueing is synchronous so callers keep
   * their ordering; the queue keeps one `channels/incoming` Request in flight at
   * a time and swallows nothing.
   */
  private enqueueIncoming(channelId: string, tweet: BridgeTweet): void {
    this.incomingQueue = this.incomingQueue
      .then(() => this.sendIncoming(channelId, tweet))
      .catch((err) => {
        const e = err as Error;
        console.error(`[x-mcpl] channels/incoming failed for ${channelId}:`, e.message);
      });
  }

  /**
   * Deliver one message with `channels/incoming` — a Server → Host **Request**
   * (§4.1 table, §14.3), not a Notification. The response carries per-message
   * `results` for partial acceptance, which is the only way this server learns
   * which items the host took and under which conversation.
   */
  private async sendIncoming(channelId: string, tweet: BridgeTweet): Promise<void> {
    if (!this.conn || this.conn.isClosed) return;

    // §5.3: before the initial policy exchange completes every
    // capability-dependent behavior is unavailable. §5.4: a denied capability
    // behaves as if never advertised. `channels/incoming` is server→host content
    // injection plus wake authority (§14.1) — one of the most consequential
    // writes a server has — so it is gated on the grant, fail-closed.
    if (!this.policyEstablished || !this.grant.has('channels.incoming')) return;

    // §14.5 puts receipt-time validation against the actually registered channel
    // on the host. Mirroring it here keeps this server from claiming a channel
    // it no longer holds open.
    if (!this.channelManager.isOpen(channelId)) return;

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
          // Fall back to the current time (not the 1970 epoch) when a tweet has
          // no timestamp, so undated items don't sort to the beginning of time.
          timestamp: tweet.created_at ?? new Date().toISOString(),
          content,
          metadata: {
            url: tweet.author_username
              ? `https://x.com/${tweet.author_username}/status/${tweet.tweet_id}`
              : undefined,
            reply_to: tweet.reply_to_tweet_id,
            retweet_count: tweet.retweet_count,
            favorite_count: tweet.favorite_count,
            // (media is already delivered as image blocks in `content`; not duplicated here)
          },
        },
      ],
    };
    let result: ChannelsIncomingResult;
    try {
      result = (await this.conn.sendRequest(method.CHANNELS_INCOMING, msg)) as ChannelsIncomingResult;
    } catch (err) {
      // §6.6: rejection is diagnostics, not authorization. An error here tells us
      // what happened to this message; it does not re-grant, revoke, or
      // renegotiate anything. The grant is changed only by a `featureSets/update`
      // Request (§6.7), so nothing below touches it.
      const e = err as Error & { code?: number };
      console.error(
        `[x-mcpl] channels/incoming rejected for ${channelId} (${tweet.tweet_id}):`,
        e.code !== undefined ? `${e.code} ${e.message}` : e.message,
      );
      return;
    }

    // §14.3: per-message results express partial acceptance. Sending this as a
    // Notification discarded them — the server could not learn which messages
    // were accepted, or that any were rejected.
    const results = Array.isArray(result?.results) ? result.results : [];
    if (results.length === 0) {
      console.error(`[x-mcpl] channels/incoming for ${channelId}: host returned no per-message results`);
      return;
    }
    for (const r of results) {
      if (!r.accepted) {
        console.error(`[x-mcpl] host did not accept ${channelId}/${r.messageId}`);
      }
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
