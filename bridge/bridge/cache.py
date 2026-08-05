"""Read-through cache policy and the live refresh used by both on-demand reads
and the background poller.

Cache-first by default. Live X API fetch happens ONLY when all hold:
  - the caller asked for it (cache miss, fresh=True, or a forced poll), AND
  - config.ALLOW_FETCH is set, AND
  - a bearer is configured.
Otherwise reads are served purely from cache and cost nothing. Negative-cached
resources short-circuit so we never re-pay to rediscover an absence.

Freshness tiers (DESIGN.md):
  - immutable tweet content: cached forever
  - mutable metrics: METRICS_TTL on the per-tweet resource key
  - collections (timeline/search/thread): membership + cursor with COLLECTION_TTL
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

from . import config
from .db import Repo, connect
from .ingest import ingest_lookup, ingest_page


def _rfc3339(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_resource_key(resource_key: str) -> tuple[str, str]:
    """'timeline:repligate' -> ('timeline', 'repligate'). Value may contain ':'."""
    kind, _, value = resource_key.partition(":")
    return kind, value


class Cache:
    def __init__(self, repo: Optional[Repo] = None):
        self.repo = repo or Repo()
        self._client = None
        # Per-resource locks serialize refreshes so a forced poll and the
        # background loop can't double-fetch (and double-emit) the same key.
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _resource_lock(self, key: str) -> threading.Lock:
        with self._locks_guard:
            lk = self._locks.get(key)
            if lk is None:
                lk = threading.Lock()
                self._locks[key] = lk
            return lk

    def _maybe_client(self):
        # Global money-safety (ALLOW_FETCH + bearer) AND the current caller's
        # per-token spend permission (owner/poller = allowed; cache-only token =
        # denied → returns None, so the call is served purely from cache).
        if not (config.ALLOW_FETCH and config.BEARER and config.request_allows_spend()):
            return None
        if self._client is None:
            from .xapi import XClient
            self._client = XClient(config.BEARER, self.repo)
        return self._client

    # ----- single tweet -----

    def get_tweet(self, tweet_id: str, fresh: bool = False) -> Optional[dict]:
        key = f"tweet:{tweet_id}"
        cached = self.repo.get_tweet(tweet_id)
        if cached and not fresh:
            return cached
        if self.repo.negative(key) and not fresh:
            return None
        client = self._maybe_client()
        if client is None:
            return cached
        from .xapi import XApiError
        try:
            result = client.lookup_tweets([tweet_id])
        except XApiError as e:
            if e.status in (403, 404):
                self.repo.mark_negative(key, {403: "protected", 404: "notfound"}.get(e.status, "error"))
            return cached
        if not result.get("tweets"):
            self.repo.mark_negative(key, "notfound")
            return cached
        con = connect(self.repo.db_path)
        try:
            ingest_lookup(con, result, source="x_bridge_readthrough")
        finally:
            con.close()
        self.repo.mark_fresh(key, "tweet", config.METRICS_TTL)
        return self.repo.get_tweet(tweet_id)

    # ----- batch tweet lookup -----

    def get_tweets_batch(self, ids: list[str], fresh: bool = False) -> dict:
        """Cache-first batch lookup. One upstream /2/tweets call for the misses
        (caller should send <=100 ids). Missing ids are negative-cached so we
        never re-pay to rediscover deletions."""
        seen: set[str] = set()
        ordered = [i for i in ids if not (i in seen or seen.add(i))]
        out: dict[str, dict] = {}
        to_fetch: list[str] = []
        for tid in ordered:
            cached = self.repo.get_tweet(tid)
            if cached and not fresh:
                out[tid] = cached
            elif self.repo.negative(f"tweet:{tid}") and not fresh:
                continue
            else:
                to_fetch.append(tid)
        n_cached = len(out)
        fetched = 0
        api_error = None
        client = self._maybe_client() if to_fetch else None
        if client is not None:
            from .xapi import XApiError
            try:
                result = client.lookup_tweets(to_fetch)
            except XApiError as e:
                result = None
                api_error = e.status
            if result is not None:
                con = connect(self.repo.db_path)
                try:
                    ingest_lookup(con, result, source="x_bridge_batch")
                finally:
                    con.close()
                got = set(result.get("tweets", {}))
                for tid in to_fetch:
                    if tid in got:
                        self.repo.mark_fresh(f"tweet:{tid}", "tweet", config.METRICS_TTL)
                        t = self.repo.get_tweet(tid)
                        if t:
                            out[tid] = t
                            fetched += 1
                    else:
                        self.repo.mark_negative(f"tweet:{tid}", "notfound")
        return {
            "tweets": [out[t] for t in ordered if t in out],
            "missing": [t for t in ordered if t not in out],
            "requested": len(ordered), "from_cache": n_cached, "fetched": fetched,
            "api_error": api_error,
        }

    # ----- user profile -----

    def get_user(self, handle_or_id: str, fresh: bool = False) -> Optional[dict]:
        stored = self.repo.get_stored_user(handle_or_id)
        if stored and not fresh:
            return _shape_user(stored)
        client = self._maybe_client()
        if client is not None:
            from .xapi import XApiError
            try:
                profile = client.user_by_username(handle_or_id)
                if profile:
                    self.repo.upsert_user(profile)
                    return _shape_user(self.repo.get_stored_user(profile.get("username") or handle_or_id))
            except XApiError:
                pass
        # Fall back to the cache-derived profile.
        return stored and _shape_user(stored) or self.repo.get_user(handle_or_id)

    # ----- collections (read-through) -----

    def timeline(self, handle_or_id: str, limit: int = 50, fresh: bool = False,
                 before: str = None, since: str = None) -> list[dict]:
        h = handle_or_id.lstrip("@")
        author_id = h if h.isdigit() else self.repo.resolve_handle(h)
        key = f"timeline:{author_id or h}"
        # A range query (before/since given) is served purely from cache — never
        # trigger a live fetch for historical browsing.
        is_range = before is not None or since is not None
        if not is_range and (fresh or not self.repo.is_fresh(key)) and self._maybe_client():
            self.refresh(key, force=fresh)
        return self.repo.get_timeline(handle_or_id, limit=limit, before=before, since=since)

    def search(self, query: str = None, limit: int = 50, fresh: bool = False,
               author: str = None, since: str = None, until: str = None,
               tier: str = None) -> list[dict]:
        # Live read-through only for a plain recent text search; filtered/range
        # queries (or query-less filters) are served from cache, no spend.
        filtered = any((author, since, until, tier)) or not query
        if query and not filtered and (fresh or not self.repo.is_fresh(f"search:{query}")) and self._maybe_client():
            self.refresh(f"search:{query}", force=fresh)
        return self.repo.search(query, limit=limit, author=author, since=since, until=until, tier=tier)

    # ----- the shared live refresh (poller + on-demand) -----

    def refresh(self, resource_key: str, force: bool = False) -> list[dict]:
        """Fetch new items for a resource, ingest them, and return the tweets
        that were NEW to the cache (normalized). No-op (──[]) when fetching is
        disabled, the resource is still fresh (and not forced), or unsupported.
        """
        client = self._maybe_client()
        if client is None:
            return []
        # Serialize per resource; re-check freshness *under* the lock so a
        # concurrent refresh that just completed short-circuits this one.
        with self._resource_lock(resource_key):
            if not force and self.repo.is_fresh(resource_key):
                return []
            kind, value = parse_resource_key(resource_key)
            if kind in ("timeline", "mentions"):
                return self._refresh_timeline(resource_key, value, mentions=(kind == "mentions"))
            if kind == "search":
                return self._refresh_search(resource_key, value)
            if kind == "thread":
                return self._refresh_search(resource_key, f"conversation_id:{value}")
            return []

    def _refresh_timeline(self, key: str, value: str, mentions: bool = False) -> list[dict]:
        from .xapi import XApiError
        client = self._maybe_client()
        h = value.lstrip("@")
        author_id = h if h.isdigit() else self.repo.resolve_handle(h)
        if not author_id:
            # Resolve the id via a live profile lookup (and cache the profile).
            try:
                profile = client.user_by_username(h)
                if profile:
                    self.repo.upsert_user(profile)
                    author_id = profile.get("id")
            except XApiError:
                return []
        if not author_id:
            return []
        if mentions:
            # /users/:id/mentions needs user-context OAuth — out of scope here.
            return []
        last = self.repo.max_created_at(author_id, h)
        start = last if last else _rfc3339(datetime.now(timezone.utc) - timedelta(days=30))
        start = start.replace("+00:00", "Z")
        end = _rfc3339(datetime.now(timezone.utc) - timedelta(seconds=30))
        try:
            page, _next = client.user_timeline(author_id, start, end)
        except XApiError:
            self.repo.mark_fresh(key, "timeline", 300)  # back off briefly
            return []
        con = connect(self.repo.db_path)
        try:
            new_ids = ingest_page(con, page, source="x_bridge_poll")
        finally:
            con.close()
        newest = page.get("meta", {}).get("newest_id")
        self.repo.mark_fresh(key, "timeline", config.COLLECTION_TTL, cursor=newest)
        return [t for t in (self.repo.get_tweet(i) for i in new_ids) if t]

    def _refresh_search(self, key: str, query: str) -> list[dict]:
        from .xapi import XApiError
        client = self._maybe_client()
        try:
            page, _next = client.search_recent(query, max_results=100)
        except XApiError:
            # Recent search may be unavailable on this API tier — back off, don't loop.
            self.repo.mark_fresh(key, "search", 600)
            return []
        con = connect(self.repo.db_path)
        try:
            new_ids = ingest_page(con, page, source="x_bridge_search")
        finally:
            con.close()
        self.repo.mark_fresh(key, "search", config.COLLECTION_TTL,
                             cursor=page.get("meta", {}).get("newest_id"))
        return [t for t in (self.repo.get_tweet(i) for i in new_ids) if t]


def _shape_user(row: Optional[dict]) -> Optional[dict]:
    if not row:
        return None
    if "followers" in row:  # stored API profile
        return {
            "author_id": row.get("author_id"),
            "handle": row.get("handle"),
            "name": row.get("name"),
            "description": row.get("description"),
            "followers": row.get("followers"),
            "following": row.get("following"),
            "tweet_count": row.get("tweet_count"),
            "created_at": row.get("created_at"),
            "verified": bool(row.get("verified")),
            "location": row.get("location"),
            "url": row.get("url"),
            "fetched_at": row.get("fetched_at"),
            "source": "x-api",
        }
    return row
