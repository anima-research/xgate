/**
 * One connection: one agent. Handshake and policy follow gmail-mcpl and
 * exa-mcpl (SPEC 0.5 §5–6, via mcpl05.ts).
 *
 *   x.read    the reading tools
 *   x.feed    the feed tools; the three that change its sources are the
 *             toolset `sources` (SPEC §21) for a host that advertised toolHints
 *   x.events  new tweets of the sources an agent set to notify, as push events
 *
 * A plain MCP client negotiates no MCPL: it has every tool and no events.
 */
import { McplConnection, method } from '@animalabs/mcpl-core';
import type { JsonRpcId, PushEventParams } from '@animalabs/mcpl-core';
import type { BridgeTweet } from './bridge-client.js';
import { markRead, sourceName, type FeedSource } from './feed.js';
import { EMPTY_GRANT, buildReceipt, deriveFeatureSetState, narrowGrant, parsePolicy } from './mcpl05.js';
import type { FeatureSetMap, FeatureSetWireEntry, Grant } from './mcpl05.js';
import { renderTweet } from './render.js';
import { FS_EVENTS, FS_FEED, FS_READ, SOURCES_POINTER, SOURCES_TOOLSET, TOOLS, callTool, feedOverview, unreadFor, type ToolContext, type ToolResult } from './tools.js';

export const SERVER_NAME = 'x-mcpl';
export const VERSION = '0.2.0';

export const DECLARATIONS: FeatureSetMap = {
  [FS_READ]: { description: 'Read X/Twitter through a shared cache: tweets, threads, timelines, profiles, search and images.', uses: ['tools'], rollback: false },
  [FS_FEED]: { description: 'A feed of your own: the accounts, searches and mentions you follow, and what is unread in each. Kept on the server between sessions.', uses: ['tools'], rollback: false },
  [FS_EVENTS]: {
    description: 'New tweets from the feed sources you set to notify, sent as they are found.',
    uses: ['pushEvents'],
    rollback: false,
    tagOntology: {
      tags: {
        'x:new-tweets': { desc: 'New tweets from an account whose timeline you set to notify in your feed. Carries x:from:<handle>. They count as read in the feed once this event is taken.', facet: 'kind' },
        'x:has-media': { desc: 'At least one of the tweets has an image or a video.', facet: 'content' },
      },
      suggestedTreatment: [
        { tagsAny: ['x:new-tweets'], behavior: { debounce: 60_000 }, rationale: 'You asked to be told when these accounts post. An account often posts several tweets in a row, which this turns into one wake a minute after the last. Without this, they sit in your context until something else wakes you.' },
      ],
      open: true,
    },
  },
};

const SOURCES_TITLE = 'Feed sources';
const SOURCES_DECLARATION = { title: SOURCES_TITLE, summary: 'Follow and unfollow accounts, searches and mentions in your feed, and set which of them notify you', default: 'closed' };
const SOURCES_TOOLS = TOOLS.filter((t) => t.toolset === SOURCES_TOOLSET).map((t) => t.name);

/** The most tweets one event shows. */
const EVENT_TWEETS = 20;

/** What every session shares. */
export interface App extends ToolContext {
  /** Agents whose `sources` toolset is open: a toolset belongs to the principal, not to a connection (§21.5.6). */
  sourcesOpen: Set<string>;
  /** How often a session looks for new tweets in its agent's notify sources. */
  checkEveryMs: number;
}

interface ReqMsg { id: JsonRpcId; method: string; params?: unknown }
interface NotifMsg { method: string; params?: unknown }
class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }

export class Session {
  private mcplEnabled = false;
  /** The host advertised experimental.mcpl.toolHints: it gets hints and the toolset. */
  private toolHints = false;
  private grant: Grant = EMPTY_GRANT;
  private policyReady = false;
  /** §21.6: the number of the last hint change this connection sent. */
  private rev = 0;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(
    private readonly conn: McplConnection,
    private readonly app: App,
    readonly client: string,
  ) {}

  async serve(): Promise<void> {
    try {
      if (!(await this.handleInitialize())) return;
      while (!this.conn.isClosed) {
        const msg = await this.conn.nextMessage();
        if (msg.type === 'request') await this.handleRequest(msg.request as ReqMsg);
        else this.handleNotification(msg.notification as NotifMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') this.app.log(`[${this.client}] connection error:`, (e as Error).message);
    } finally {
      if (this.timer) clearTimeout(this.timer);
    }
  }

  private async handleInitialize(): Promise<boolean> {
    const msg = await this.conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') { this.app.log(`[${this.client}] expected initialize`); this.conn.close(); return false; }
    const mcpl = (msg.request.params as { capabilities?: { experimental?: { mcpl?: { toolHints?: unknown } } } } | undefined)?.capabilities?.experimental?.mcpl;
    this.mcplEnabled = mcpl !== undefined;
    this.toolHints = mcpl?.toolHints === true;
    const featureSets: FeatureSetWireEntry[] = Object.entries(DECLARATIONS).map(([name, d]) => ({ name, ...d }));
    const serverCaps = {
      version: '0.5', pushEvents: true, featureSets,
      ...(this.toolHints ? { toolHints: true, toolsets: { [SOURCES_TOOLSET]: SOURCES_DECLARATION } } : {}),
    };
    this.conn.sendResponse(msg.request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) },
      serverInfo: { name: SERVER_NAME, version: VERSION },
    });
    this.app.log(`[${this.client}] initialized (${this.mcplEnabled ? `MCPL${this.toolHints ? ', toolsets' : ''}` : 'plain MCP'})`);
    return true;
  }

  /**
   * tools/list. Every tool is a `web` tool (RFC-008). To a host that advertised
   * toolHints each also says whether it is static or one of the toolset's, and
   * whether the toolset's are visible now (§21.4.1).
   */
  listedTools() {
    const open = this.app.sourcesOpen.has(this.client);
    return TOOLS.map(({ name, description, inputSchema, toolset }) => ({
      name, description: this.toolHints && name === 'feed_show' ? description + SOURCES_POINTER : description, inputSchema,
      annotations: { readOnlyHint: !toolset && name !== 'feed_read', openWorldHint: true },
      _meta: {
        'mcpl/class': ['web'],
        ...(!this.toolHints ? {} : toolset ? { 'mcpl/presence': 'dynamic', 'mcpl/toolset': toolset, 'mcpl/visible': open } : { 'mcpl/presence': 'static' }),
      },
    }));
  }

  private async handleRequest(req: ReqMsg): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list': this.conn.sendResponse(req.id, { tools: this.listedTools(), ...(this.toolHints ? { _meta: { 'mcpl/rev': this.rev } } : {}) }); break;
        case 'tools/call': this.conn.sendResponse(req.id, await this.toolCall(String(params.name ?? ''), params.arguments)); break;
        case 'ping': this.conn.sendResponse(req.id, {}); break;
        case method.FEATURE_SETS_UPDATE: this.featureSetsUpdateRequest(req); break;
        case 'toolsets/open': case 'toolsets/close': case 'toolsets/list':
          if (!this.toolHints) this.conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
          else this.conn.sendResponse(req.id, await this.toolsets(req.method, params));
          break;
        default: this.conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      if (!(e instanceof RpcError)) this.app.log(`[${this.client}] ${req.method} failed:`, e);
      this.conn.sendError(req.id, e instanceof RpcError ? e.code : -32000, (e as Error).message);
    }
  }

  private handleNotification(n: NotifMsg): void {
    if (n.method !== method.FEATURE_SETS_UPDATE) return;
    const parsed = parsePolicy(n.params);
    if (!parsed.ok) { this.app.log(`[${this.client}] featureSets/update notification malformed: ${parsed.error}`); return; }
    this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities);
  }

  private featureSetsUpdateRequest(req: ReqMsg): void {
    const parsed = parsePolicy(req.params);
    if (!parsed.ok) {
      this.grant = EMPTY_GRANT; this.policyReady = false;
      this.conn.sendError(req.id, -32602, `Invalid featureSets/update: ${parsed.error}`);
      return;
    }
    this.grant = parsed.grant; this.policyReady = true;
    const receipt = buildReceipt(DECLARATIONS, this.grant);
    this.app.log(`[${this.client}] policy: ${receipt.mode}${receipt.unavailableFeatures.length ? ` (off: ${receipt.unavailableFeatures.map((u) => u.featureSet).join(', ')})` : ''}`);
    this.conn.sendResponse(req.id, receipt);
    // The first look comes soon after the host is ready, for what was posted while the agent was away.
    if (this.eventsOn() && !this.timer) this.schedule(Math.min(10_000, this.app.checkEveryMs));
  }

  /** The next look. The timer never holds the process open: the connection does. */
  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), ms);
    this.timer.unref();
  }

  private active(fs: string): boolean {
    return deriveFeatureSetState(fs, DECLARATIONS[fs]!, this.grant).active;
  }

  private eventsOn(): boolean {
    return !this.conn.isClosed && this.mcplEnabled && this.policyReady && this.active(FS_EVENTS);
  }

  async toolCall(name: string, args: unknown): Promise<ToolResult> {
    const tool = TOOLS.find((t) => t.name === name);
    const deny = (why: string): ToolResult => ({ content: [{ type: 'text', text: why }], isError: true });
    if (!tool) return deny(`Unknown tool: ${name}`);
    if (this.mcplEnabled && this.policyReady && !this.active(tool.featureSet)) return deny(`${name}: feature set ${tool.featureSet} is not enabled for this connection.`);
    // §21.4.1: a tool of a declared toolset that is not open answers with an ordinary error that says why.
    if (this.toolHints && tool.toolset && !this.app.sourcesOpen.has(this.client)) return deny(`${name} belongs to the toolset "${tool.toolset}", which is not open. Opening it lists your sources and makes its tools available.`);
    return callTool(this.app, { client: this.client, eventsOn: this.eventsOn() }, name, args);
  }

  // ── The `sources` toolset (SPEC §21.5): no instances, and every tool of it visible while it is open ──

  private hints(visible: boolean, state?: 'open' | 'closed') {
    return {
      rev: ++this.rev,
      tools: SOURCES_TOOLS.map((name) => ({ name, visible })),
      ...(state ? { toolsets: [{ toolset: SOURCES_TOOLSET, state, ...(state === 'open' ? { title: SOURCES_TITLE } : {}) }] } : {}),
    };
  }

  private async toolsets(what: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const open = this.app.sourcesOpen.has(this.client);
    if (what === 'toolsets/list') {
      // §21.5.3: the open toolsets and their tools' hint state in full; it always takes a rev.
      return { open: open ? [{ toolset: SOURCES_TOOLSET, title: SOURCES_TITLE }] : [], _meta: { 'mcpl/hints': { rev: ++this.rev, tools: open ? SOURCES_TOOLS.map((name) => ({ name, visible: true })) : [] } } };
    }
    if (params.toolset !== SOURCES_TOOLSET) throw new RpcError(-32602, `No toolset "${String(params.toolset ?? '')}" here; there is "${SOURCES_TOOLSET}".`);
    if (params.instance !== undefined) throw new RpcError(-32602, `The toolset "${SOURCES_TOOLSET}" has no instances: open it without one.`);
    if (what === 'toolsets/close') {
      if (!open) return {};
      this.app.sourcesOpen.delete(this.client);
      return { _meta: { 'mcpl/hints': this.hints(false, 'closed') } };
    }
    const content = [{ type: 'text', text: await feedOverview(this.app.bridge, this.app.feeds.get(this.client)) }];
    if (open) return { toolset: SOURCES_TOOLSET, title: SOURCES_TITLE, adopted: true, content };
    this.app.sourcesOpen.add(this.client);
    return { toolset: SOURCES_TOOLSET, title: SOURCES_TITLE, content, _meta: { 'mcpl/hints': this.hints(true, 'open') } };
  }

  // ── Events: new tweets in the sources this agent set to notify ──

  /**
   * Look once at every notify source. What is unread there is sent as one
   * event per source and, once the host takes it, marked read: the feed and
   * the events share one notion of unread, so nothing is told twice and
   * nothing is skipped while the agent is away.
   */
  async check(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.eventsOn()) return;
    if (!this.checking) {
      this.checking = true;
      try {
        for (const source of this.app.feeds.get(this.client).sources.filter((s) => s.mode === 'notify')) {
          const unread = await unreadFor(this.app.bridge, this.app.feeds.get(this.client), source, 0)
            .catch((e) => { this.app.log(`[${this.client}] checking ${sourceName(source)} failed:`, (e as Error).message); return [] as BridgeTweet[]; });
          if (unread.length && (await this.push(source, unread))) {
            // Read again: the agent may have changed its feed while this waited.
            const now = this.app.feeds.get(this.client);
            if (now.sources.some((s) => s.id === source.id)) this.app.feeds.set(this.client, markRead(now, source, unread));
          }
        }
      } finally {
        this.checking = false;
      }
    }
    if (this.eventsOn()) this.schedule(this.app.checkEveryMs);
  }

  /** One event: a source's new tweets, oldest first. True if the host took it. */
  private async push(source: FeedSource, unread: BridgeTweet[]): Promise<boolean> {
    const shown = unread.slice(0, EVENT_TWEETS).reverse();
    const left = unread.length - shown.length;
    const text = [
      `[xgate] ${unread.length} new tweet${unread.length === 1 ? '' : 's'} from @${source.value}${source.label ? ` ("${source.label}")` : ''}`,
      shown.map((t) => renderTweet(t)).join('\n\n'),
      `${left > 0 ? `${left} earlier one${left === 1 ? ' is' : 's are'} not shown: user_timeline reads them. ` : ''}${unread.length === 1 ? 'It is' : 'They are'} marked read in your feed.`,
    ].join('\n\n');
    const params: PushEventParams = {
      featureSet: FS_EVENTS,
      eventId: `tweets_${source.value}_${unread[0]!.tweet_id}`,
      timestamp: new Date().toISOString(),
      origin: { server: SERVER_NAME, source: source.id, tweets: shown.map((t) => t.tweet_id) },
      tags: ['x:new-tweets', `x:from:${source.value.toLowerCase()}`, ...(shown.some((t) => t.media?.length) ? ['x:has-media'] : [])],
      payload: { content: [{ type: 'text', text }] },
    };
    try {
      const r = (await this.conn.sendRequest(method.PUSH_EVENT, params)) as { accepted?: unknown } | null;
      if (r?.accepted === false) { this.app.log(`[${this.client}] event ${params.eventId} not accepted`); return false; }
      this.app.log(`[${this.client}] event ${params.eventId}: ${unread.length} tweet(s)`);
      return true;
    } catch (e) {
      this.app.log(`[${this.client}] event ${params.eventId} failed:`, (e as Error).message);
      return false;
    }
  }
}
