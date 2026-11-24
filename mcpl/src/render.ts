/**
 * How tweets, threads and profiles read as text.
 *
 * Every tweet shows its id, because every other tool takes one: get_thread and
 * lookup_tweet a tweet's, get_image and transcribe_image an image's. A reply
 * says what it answers. Empty fields are left out.
 */
import type { BridgeMedia, BridgeThreadPreview, BridgeTimelinePreview, BridgeTweet, BridgeUser } from './bridge-client.js';
import type { Parent, ThreadLayout } from './thread.js';

/** "2026-06-14 14:03Z" (UTC, and marked so) from an ISO string; anything unparseable passes through. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

const fmtDate = (iso: string | null | undefined) => fmtTime(iso).slice(0, 10);
const oneLine = (s: string, max: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const isImage = (m: BridgeMedia) => !m.type || m.type === 'photo' || m.type === 'animated_gif';

/** A link to a tweet, as X writes it. */
const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status(?:es)?\/(\d+)/;

function mediaLines(media: BridgeMedia[] | undefined): string[] {
  return (media ?? []).map((m) => {
    if (!isImage(m)) return `[${m.type} ${m.media_id}]`;
    const said = m.alt_text || m.transcription;
    return said ? `[image ${m.media_id}] ${oneLine(said, 200)}` : `[image ${m.media_id}]`;
  });
}

function linkLines(t: BridgeTweet): string[] {
  const lines: string[] = [];
  if (t.quoted_tweet_id) lines.push(`quotes tweet ${t.quoted_tweet_id}`);
  for (const u of t.urls ?? []) {
    const url = u.expanded_url || u.url;
    if (!url) continue;
    const status = STATUS_URL.exec(url);
    if (!status) lines.push(`link: ${url}`);
    else if (status[2] !== t.quoted_tweet_id && status[2] !== t.tweet_id) lines.push(`links tweet ${status[2]} by @${status[1]}`);
  }
  return lines;
}

function parentMark(p: Parent): string {
  switch (p.kind) {
    case 'none': case 'above': return '';
    case 'row': return ` ↳[${p.index}]`;
    case 'absent': {
      const who = p.username ? ` by @${p.username}` : '';
      const state = p.cached === false ? ', not cached' : p.cached === true ? ', not shown here' : '';
      return ` ↳ tweet ${p.id}${who}${state}`;
    }
  }
}

/**
 * One tweet. `index` numbers it in a list; `mark` is what it answers, already
 * worded (a thread row), and without it a reply names its parent itself.
 */
export function renderTweet(t: BridgeTweet, opts: { index?: number; mark?: string; focus?: boolean; indent?: string } = {}): string {
  const pad = opts.indent ?? '';
  const replies = opts.mark !== undefined ? opts.mark
    : t.reply_to_tweet_id ? ` ↳ ${t.reply_to_username ? `@${t.reply_to_username}, ` : ''}tweet ${t.reply_to_tweet_id}` : '';
  const who = `${t.author_username ? `@${t.author_username}` : '(unknown author)'}${replies}`;
  const head = [
    `${opts.focus ? '▶' : ''}${opts.index !== undefined ? `[${opts.index}] ` : ''}${who}`,
    fmtTime(t.created_at),
    [t.favorite_count ? `♥${t.favorite_count}` : '', t.retweet_count ? `♺${t.retweet_count}` : ''].filter(Boolean).join(' '),
    `id ${t.tweet_id}`,
  ].filter(Boolean).join(' · ');
  const body = [...(t.text ?? '').trim().split('\n'), ...mediaLines(t.media), ...linkLines(t)].filter((l, i) => i > 0 || l !== '');
  return [`${pad}${head}`, ...body.map((l) => (l ? `${pad}    ${l}` : ''))].join('\n');
}

function summary(tweets: BridgeTweet[]): string[] {
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
  const people = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, n]) => `@${h}(${n})`);
  return [
    people.length ? `${people.join(' ')}${counts.size > 6 ? ' …' : ''}` : '',
    first && last ? (fmtDate(first) === fmtDate(last) ? fmtDate(first) : `${fmtDate(first)} → ${fmtDate(last)}`) : '',
  ].filter(Boolean);
}

/** A flat list (a timeline, search results, a feed source), in the order given. */
export function renderList(tweets: BridgeTweet[], title: string): string {
  if (!tweets.length) return `${title}: no tweets`;
  const head = [title, `${tweets.length} tweet${tweets.length === 1 ? '' : 's'}`, ...summary(tweets)].join(' · ');
  return `${head}\n\n${tweets.map((t, i) => renderTweet(t, { index: i + 1 })).join('\n\n')}`;
}

/**
 * A thread as a tree. `total` is the thread's cached size; fewer rows than
 * that means the view was cut to the tweet asked for and what is nearest it.
 */
export function renderThread(layout: ThreadLayout, total: number, all: BridgeTweet[]): string {
  const { rows, orphans } = layout;
  if (!rows.length) return 'No tweets of this thread are cached.';
  const head = [`thread of ${total} cached tweet${total === 1 ? '' : 's'}`, ...summary(all)].join(' · ');
  const notes: string[] = [];
  if (rows.length < total) {
    notes.push(`Showing ${rows.length} of ${total}: ${rows.some((r) => r.focus) ? 'the tweet you asked for (▶), the tweets it answers, its replies, then the earliest of the rest' : 'the earliest'}. Another tweet's id shows the thread around that tweet.`);
  }
  if (rows.length > 1) notes.push('Each tweet answers the one directly above it, unless ↳ names another.');
  if (orphans) notes.push(`${orphans} of these answer${orphans === 1 ? 's a tweet' : ' tweets'} that ${orphans === 1 ? 'is' : 'are'} not cached, so the thread has gaps.`);
  const body = rows.map((r) => renderTweet(r.tweet, {
    index: r.index, mark: parentMark(r.parent), focus: r.focus, indent: '  '.repeat(Math.min(r.depth, 8)),
  })).join('\n');
  return [head, ...notes, '', body].join('\n');
}

export function renderThreadPreview(p: BridgeThreadPreview): string {
  const people = p.participants.map((x) => `@${x.handle}(${x.count})`).join(' ');
  return [
    `thread of ${p.count} cached tweet${p.count === 1 ? '' : 's'}`,
    p.root_author ? `started by @${p.root_author}` : '',
    p.media_count ? `${p.media_count} image${p.media_count === 1 ? '' : 's'} or video${p.media_count === 1 ? '' : 's'}` : '',
    p.first && p.last ? `${fmtDate(p.first)} → ${fmtDate(p.last)}` : '',
  ].filter(Boolean).join(' · ') + `\nby ${people || '(no named authors)'}`;
}

export function renderTimelinePreview(p: BridgeTimelinePreview): string {
  if (!p.count) return `@${p.handle}: no tweets cached`;
  return [
    `@${p.handle}: ${p.count} cached tweet${p.count === 1 ? '' : 's'}`,
    p.media_count ? `${p.media_count} with images or video` : '',
    p.first && p.last ? `${fmtDate(p.first)} → ${fmtDate(p.last)}` : '',
    p.last_tweet_at ? `newest ${fmtTime(p.last_tweet_at)}` : '',
  ].filter(Boolean).join(' · ');
}

export function renderUser(u: BridgeUser): string {
  const handle = u.handle ? `@${u.handle}` : `user ${u.author_id ?? '(unknown)'}`;
  if (u.source !== 'x-api') {
    return [
      `${handle} · id ${u.author_id ?? 'unknown'}`,
      `No profile from X is stored for this account. The cache holds ${u.cached_tweet_count ?? 0} of its tweets` +
        `${u.first_seen && u.last_seen ? `, ${fmtDate(u.first_seen)} → ${fmtDate(u.last_seen)}` : ''}.`,
    ].join('\n');
  }
  return [
    [`${u.name ? `${u.name} (${handle})` : handle}${u.verified ? ' ✓' : ''}`, `id ${u.author_id}`].join(' · '),
    u.description ? oneLine(u.description, 600) : '',
    [
      u.followers != null ? `${u.followers} followers` : '',
      u.following != null ? `${u.following} following` : '',
      u.tweet_count != null ? `${u.tweet_count} tweets` : '',
      u.created_at ? `joined ${fmtDate(u.created_at)}` : '',
      u.location ? oneLine(u.location, 80) : '',
      u.url ?? '',
    ].filter(Boolean).join(' · '),
    u.fetched_at ? `profile as of ${fmtTime(u.fetched_at)}` : '',
  ].filter(Boolean).join('\n');
}
