/**
 * Laying a thread out as a tree. Pure.
 *
 * The bridge returns a thread's cached tweets oldest-first; who answers whom
 * is in each tweet's `reply_to_tweet_id`. The layout orders them so that a
 * tweet follows the one it answers, and says for each row how it relates to
 * the rows above it, so a reader never has to guess a parent from the order.
 */
import type { BridgeTweet } from './bridge-client.js';

/** What a row answers. */
export type Parent =
  | { kind: 'none' }
  /** the row directly above */
  | { kind: 'above' }
  /** an earlier row, by its number */
  | { kind: 'row'; index: number }
  /** a tweet that is not in this view: `cached` says whether it is cached at all, where that is known */
  | { kind: 'absent'; id: string; username: string | null; cached: boolean | null };

export interface ThreadRow {
  tweet: BridgeTweet;
  /** 1-based position in the view */
  index: number;
  /** grows by one at each tweet with several answers; a lone answer stays at its parent's depth */
  depth: number;
  focus: boolean;
  parent: Parent;
}

export interface ThreadLayout {
  rows: ThreadRow[];
  /** tweets whose parent is not cached (only counted when the whole thread was fetched) */
  orphans: number;
}

const byTime = (a: BridgeTweet, b: BridgeTweet) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.tweet_id.localeCompare(b.tweet_id);

/**
 * Which tweets to show when there are more than `limit`: the focus, the
 * tweets it answers up to the root, its replies (nearest first), then the
 * earliest of the rest.
 */
export function selectForView(tweets: BridgeTweet[], focusId: string | undefined, limit: number): BridgeTweet[] {
  if (tweets.length <= limit) return tweets;
  const byId = new Map(tweets.map((t) => [t.tweet_id, t]));
  const picked = new Set<string>();
  const focus = focusId ? byId.get(focusId) : undefined;
  if (focus) {
    for (let t: BridgeTweet | undefined = focus; t && !picked.has(t.tweet_id); t = t.reply_to_tweet_id ? byId.get(t.reply_to_tweet_id) : undefined) picked.add(t.tweet_id);
    const repliesTo = new Map<string, BridgeTweet[]>();
    for (const t of tweets) if (t.reply_to_tweet_id) (repliesTo.get(t.reply_to_tweet_id) ?? repliesTo.set(t.reply_to_tweet_id, []).get(t.reply_to_tweet_id)!).push(t);
    let layer = [focus];
    while (layer.length && picked.size < limit) {
      const next = layer.flatMap((t) => repliesTo.get(t.tweet_id) ?? []).filter((t) => !picked.has(t.tweet_id));
      for (const t of next) if (picked.size < limit) picked.add(t.tweet_id);
      layer = next;
    }
  }
  for (const t of tweets) { if (picked.size >= limit) break; picked.add(t.tweet_id); }
  return tweets.filter((t) => picked.has(t.tweet_id));
}

/**
 * Lay out `shown` (a subset of `fetched`, or all of it). `complete`: `fetched`
 * is every cached tweet of the thread, so a parent missing from it is not cached.
 */
export function layoutThread(shown: BridgeTweet[], fetched: BridgeTweet[], focusId: string | undefined, complete: boolean): ThreadLayout {
  const inView = new Map(shown.map((t) => [t.tweet_id, t]));
  const inFetch = new Set(fetched.map((t) => t.tweet_id));
  const children = new Map<string, BridgeTweet[]>();
  const tops: BridgeTweet[] = [];
  for (const t of [...shown].sort(byTime)) {
    const p = t.reply_to_tweet_id;
    if (p && inView.has(p)) (children.get(p) ?? children.set(p, []).get(p)!).push(t);
    else tops.push(t);
  }

  const rows: ThreadRow[] = [];
  const indexOf = new Map<string, number>();
  let orphans = 0;
  // Explicit stack: a reply chain can be hundreds of tweets deep.
  const stack: Array<{ tweet: BridgeTweet; depth: number }> = tops.reverse().map((tweet) => ({ tweet, depth: 0 }));
  while (stack.length) {
    const { tweet, depth } = stack.pop()!;
    const index = rows.length + 1;
    const p = tweet.reply_to_tweet_id;
    let parent: Parent;
    if (!p) parent = { kind: 'none' };
    else if (indexOf.has(p)) parent = rows[rows.length - 1]!.tweet.tweet_id === p ? { kind: 'above' } : { kind: 'row', index: indexOf.get(p)! };
    else {
      const cached = inFetch.has(p) ? true : complete ? false : null;
      if (cached === false) orphans++;
      parent = { kind: 'absent', id: p, username: tweet.reply_to_username, cached };
    }
    indexOf.set(tweet.tweet_id, index);
    rows.push({ tweet, index, depth, focus: tweet.tweet_id === focusId, parent });
    const kids = children.get(tweet.tweet_id) ?? [];
    const kidDepth = kids.length > 1 ? depth + 1 : depth;
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ tweet: kids[i]!, depth: kidDepth });
  }
  return { rows, orphans };
}
