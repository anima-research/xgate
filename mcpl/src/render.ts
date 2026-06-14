/**
 * Compact, agent-friendly rendering of tweets and previews.
 *
 * The read tools used to return `JSON.stringify(fullTweet)` — a wall of
 * null-filled fields. For a long-lived agent reading threads/timelines, that's
 * mostly noise. These helpers render the same data as terse, scannable text and
 * omit any empty/null field. Callers that genuinely need the raw object can ask
 * for `format: "full"`.
 */

import type { BridgeTweet, BridgeMedia } from './bridge-client.js';

export interface ThreadPreview {
  conversation_id: string;
  count: number;
  participants: { handle: string; count: number }[];
  first: string | null;
  last: string | null;
  media_count: number;
  root_author: string | null;
}

export interface TimelinePreview {
  handle: string;
  author_id: string | null;
  count: number;
  first: string | null;
  last: string | null;
  last_tweet_at: string | null;
  media_count: number;
}

/** "2026-06-14 14:03" from an ISO string; passes through anything unparseable. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "2026-06-14" (date only). */
function fmtDate(iso: string | null | undefined): string {
  const t = fmtTime(iso);
  return t ? t.slice(0, 10) : '';
}

function mediaSummary(media: BridgeMedia[] | undefined): string {
  if (!media?.length) return '';
  const shown = media.filter((m) => !m.type || m.type === 'photo' || m.type === 'animated_gif');
  if (!shown.length) return '';
  const captions = shown
    .map((m) => m.alt_text || m.transcription)
    .filter((c): c is string => Boolean(c));
  const head = `🖼${shown.length}`;
  if (!captions.length) return head;
  // One-line, truncated caption preview.
  const joined = captions.join(' | ').replace(/\s+/g, ' ').trim();
  return `${head} ${joined.length > 200 ? joined.slice(0, 197) + '…' : joined}`;
}

/**
 * Render one tweet as 1–3 compact lines. Empty fields are dropped entirely.
 * `index` (if given) prefixes the header as `[n]`.
 */
export function renderTweet(t: BridgeTweet, opts: { index?: number } = {}): string {
  const handle = t.author_username ? `@${t.author_username}` : '(unknown)';
  const meta: string[] = [];
  if (t.favorite_count) meta.push(`♥${t.favorite_count}`);
  if (t.retweet_count) meta.push(`♺${t.retweet_count}`);
  const time = fmtTime(t.created_at);
  const headParts = [
    opts.index !== undefined ? `[${opts.index}]` : '',
    handle,
    time,
    ...meta,
  ].filter(Boolean);
  const lines = [headParts.join(' · ')];

  const text = (t.text ?? '').trim();
  if (text) lines.push(indent(text));

  const tail: string[] = [];
  if (t.reply_to_username) tail.push(`↳ reply to @${t.reply_to_username}`);
  const ms = mediaSummary(t.media);
  if (ms) tail.push(ms);
  const links = (t.urls ?? [])
    .map((u) => u.expanded_url || u.url)
    .filter((u): u is string => Boolean(u));
  if (links.length) tail.push(`🔗 ${links.join(' ')}`);
  if (tail.length) lines.push(indent(tail.join('   ')));

  return lines.join('\n');
}

/** Render a list of tweets with a summary header. */
export function renderList(
  tweets: BridgeTweet[],
  opts: { title?: string } = {},
): string {
  if (!tweets.length) return `${opts.title ? opts.title + ' — ' : ''}no tweets`;
  const header = listHeader(tweets, opts.title);
  const body = tweets.map((t, i) => renderTweet(t, { index: i + 1 })).join('\n\n');
  return `${header}\n\n${body}`;
}

function listHeader(tweets: BridgeTweet[], title?: string): string {
  const counts = new Map<string, number>();
  let first: string | null = null;
  let last: string | null = null;
  for (const t of tweets) {
    if (t.author_username) counts.set(t.author_username, (counts.get(t.author_username) ?? 0) + 1);
    if (t.created_at) {
      if (first === null || t.created_at < first) first = t.created_at;
      if (last === null || t.created_at > last) last = t.created_at;
    }
  }
  const people = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([h, n]) => `@${h}(${n})`);
  const parts = [`${tweets.length} tweets`];
  if (people.length) parts.push(`by ${people.join(' ')}${counts.size > 6 ? ' …' : ''}`);
  if (first && last) parts.push(`${fmtDate(first)} → ${fmtDate(last)}`);
  return `${title ? title + ' · ' : ''}${parts.join(' · ')}`;
}

export function renderThreadPreview(p: ThreadPreview): string {
  const people = p.participants.map((x) => `@${x.handle}(${x.count})`).join(' ');
  const span = p.first && p.last ? ` · ${fmtDate(p.first)} → ${fmtDate(p.last)}` : '';
  const media = p.media_count ? ` · 🖼${p.media_count}` : '';
  const root = p.root_author ? ` · root @${p.root_author}` : '';
  return `thread ${p.conversation_id}: ${p.count} tweets${root}${media}${span}\nparticipants: ${people || '(none)'}`;
}

export function renderTimelinePreview(p: TimelinePreview): string {
  const span = p.first && p.last ? ` · ${fmtDate(p.first)} → ${fmtDate(p.last)}` : '';
  const media = p.media_count ? ` · 🖼${p.media_count}` : '';
  return `@${p.handle}: ${p.count} cached tweets${media}${span}`;
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
