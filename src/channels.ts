/**
 * MCPL channel management for X. Mirrors discord-mcpl/src/channels.ts.
 *
 * X channels are subscribable resources rather than static rooms:
 *   x:timeline:<handleOrId>   a user's timeline
 *   x:search:<query>          a search query
 *   x:thread:<conversationId> a conversation thread
 *   x:mentions:<handle>       mentions of an account (needs poller; Phase 3+)
 *
 * The value segment is percent-encoded so queries with spaces/colons are safe.
 */

import type { ChannelDescriptor } from '@connectome/mcpl-core';

export type XChannelKind = 'timeline' | 'search' | 'thread' | 'mentions';

export interface XChannelAddress {
  kind: XChannelKind;
  value: string;
}

export function mcplChannelId(kind: XChannelKind, value: string): string {
  return `x:${kind}:${encodeURIComponent(value)}`;
}

export function parseMcplChannelId(id: string): XChannelAddress | null {
  const m = /^x:(timeline|search|thread|mentions):(.*)$/.exec(id);
  if (!m) return null;
  return { kind: m[1] as XChannelKind, value: decodeURIComponent(m[2]) };
}

/** The bridge resource_key for a channel (what /stream/:resource expects). */
export function resourceKeyFor(addr: XChannelAddress): string {
  return `${addr.kind}:${addr.value}`;
}

const KIND_LABEL: Record<XChannelKind, (v: string) => string> = {
  timeline: (v) => `@${v.replace(/^@/, '')} timeline`,
  search: (v) => `search “${v}”`,
  thread: (v) => `thread ${v}`,
  mentions: (v) => `@${v.replace(/^@/, '')} mentions`,
};

export function toDescriptor(addr: XChannelAddress): ChannelDescriptor {
  return {
    id: mcplChannelId(addr.kind, addr.value),
    type: `x.${addr.kind}`,
    label: KIND_LABEL[addr.kind](addr.value),
    direction: addr.kind === 'mentions' || addr.kind === 'timeline' ? 'inbound' : 'inbound',
    address: { kind: addr.kind, value: addr.value },
  };
}

/** Build an address from a channels/open request's (type, address). */
export function addressFromOpen(type: string, address: unknown): XChannelAddress | null {
  const kind = type.startsWith('x.') ? (type.slice(2) as XChannelKind) : (type as XChannelKind);
  if (!['timeline', 'search', 'thread', 'mentions'].includes(kind)) return null;
  const a = (address ?? {}) as Record<string, unknown>;
  const value =
    typeof a.value === 'string' ? a.value
    : typeof a.handle === 'string' ? a.handle
    : typeof a.query === 'string' ? a.query
    : typeof a.conversationId === 'string' ? a.conversationId
    : undefined;
  if (!value) return null;
  return { kind, value };
}

/** Same registered/open bookkeeping as discord-mcpl's ChannelManager. */
export class ChannelManager {
  private registered = new Map<string, ChannelDescriptor>();
  private openChannels = new Set<string>();

  register(descriptor: ChannelDescriptor): void {
    this.registered.set(descriptor.id, descriptor);
  }

  open(id: string): ChannelDescriptor | undefined {
    const desc = this.registered.get(id);
    if (desc) this.openChannels.add(id);
    return desc;
  }

  close(id: string): boolean {
    return this.openChannels.delete(id);
  }

  isOpen(id: string): boolean {
    return this.openChannels.has(id);
  }

  get(id: string): ChannelDescriptor | undefined {
    return this.registered.get(id);
  }

  getAll(): ChannelDescriptor[] {
    return [...this.registered.values()];
  }

  getOpen(): ChannelDescriptor[] {
    return [...this.openChannels]
      .map((id) => this.registered.get(id))
      .filter((d): d is ChannelDescriptor => d !== undefined);
  }
}
