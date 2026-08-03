/**
 * MCPL 0.5 wire shapes this server touches, written against the SPEC text.
 *
 * `@animalabs/mcpl-core` is not released at a 0.5 version and its working tree is
 * mid-migration, so the shapes the 0.5 change actually moves — the recursive
 * advertisement (§5.1), `featureSets/update` and its degradation receipt (§5.3,
 * §6.7), and `channels/incoming` as a Request (§14.3) — are defined here rather
 * than imported. The stable 0.4 channel-lifecycle types are still imported from
 * core.
 */

import type { ContentBlock } from '@animalabs/mcpl-core';
import type { UnavailableFeature } from './feature-sets.js';

// ── §5.1 Advertisement (recursive; members mirror the §6.2 capability paths) ──

export interface ChannelsAdvertisement {
  register?: boolean;
  lifecycle?: boolean;
  publish?: boolean;
  incoming?: boolean;
  streaming?: boolean;
  acknowledge?: boolean;
  typing?: boolean;
}

/**
 * The server's manifest (§5.1). Every member is either a §6.2 capability node or
 * a §8.1 state-management flag; nothing here is invented.
 */
export interface XMcplAdvertisement {
  version: string;
  channels?: ChannelsAdvertisement;
  /** §8.1 rollback support. Not a §6.2 capability path — it grants nothing. */
  rollback?: boolean;
  featureSets?: unknown;
}

// ── §5.3 / §6.7 featureSets/update ──

export interface FeatureSetsUpdateParams {
  /** §5.4: the sole normative allowlist. Absence of a path is denial. */
  effectiveCapabilities?: string[];
  /** §5.4: derived diagnostic data only; MUST NOT authorize anything. */
  deniedCapabilities?: string[];
  enabled?: string[];
  disabled?: string[];
}

/**
 * The degradation receipt (§6.7). It reports what this server *will do*; it never
 * asserts what this server is *entitled to*, and the host MUST NOT widen any grant
 * in response to it.
 */
export interface DegradationReceipt {
  accepted: boolean;
  mode?: 'full' | 'degraded';
  unavailableFeatures?: UnavailableFeature[];
  notes?: string[];
  fallback?: 'mcp-only' | 'close';
  reason?: string;
}

// ── §14.3 channels/incoming (Server → Host, Request) ──

export interface MessageAuthor {
  id: string;
  name: string;
}

export interface IncomingChannelMessage {
  channelId: string;
  messageId: string;
  threadId?: string;
  author: MessageAuthor;
  timestamp: string;
  content: ContentBlock[];
  metadata?: unknown;
  /** §16: producer-authored labels. Never authority; namespaced always. */
  tags?: string[];
}

export interface ChannelsIncomingParams {
  messages: IncomingChannelMessage[];
}

export interface IncomingMessageResult {
  messageId: string;
  accepted: boolean;
  conversationId?: string;
  reason?: string;
}

/** §14.3: per-message results, so partial acceptance is observable. */
export interface ChannelsIncomingResult {
  results?: IncomingMessageResult[];
}
