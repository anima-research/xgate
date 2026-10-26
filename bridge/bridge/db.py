"""Repository layer over the SQLite cache.

All data access goes through `Repo`, so the storage engine stays swappable
(SQLite today, Postgres later if syndication demands it). The bridge is the
single writer; readers open short-lived connections in WAL mode.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from . import config


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def connect(path=None) -> sqlite3.Connection:
    con = sqlite3.connect(str(path or config.CACHE_DB), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA busy_timeout = 5000")
    con.execute("PRAGMA foreign_keys = ON")
    # So rows deleted by an INSERT OR REPLACE conflict fire the tweets_fts
    # delete trigger too (SQLite skips delete triggers there otherwise).
    con.execute("PRAGMA recursive_triggers = ON")
    return con


class Repo:
    """Thin, intention-revealing accessors over the cache tables.

    A connection is opened per call (cheap under WAL) so the repo is safe to
    share across the threading HTTP server without per-thread state.
    """

    def __init__(self, db_path=None):
        self.db_path = db_path or config.CACHE_DB

    def _con(self) -> sqlite3.Connection:
        return connect(self.db_path)

    # ----- normalization -----

    @staticmethod
    def _tweet_row(row: sqlite3.Row) -> dict:
        return {
            "tweet_id": row["tweet_id"],
            "author_id": row["author_id"],
            "author_username": row["author_username"],
            "text": row["full_text"],
            "created_at": row["created_at"],
            "reply_to_tweet_id": row["reply_to_tweet_id"],
            "reply_to_username": row["reply_to_username"],
            "conversation_id": row["conversation_id"],
            "retweet_count": row["retweet_count"],
            "favorite_count": row["favorite_count"],
            "source": row["source"],
            "media": [],
            "urls": [],
        }

    def _hydrate(self, con: sqlite3.Connection, tweets: list[dict]) -> list[dict]:
        """Attach media + urls to a batch of normalized tweets."""
        if not tweets:
            return tweets
        by_id = {t["tweet_id"]: t for t in tweets}
        ids = list(by_id)
        marks = ",".join("?" * len(ids))
        for m in con.execute(
            f"SELECT media_id, tweet_id, media_url, media_type, width, height, transcription, alt_text "
            f"FROM media WHERE tweet_id IN ({marks})", ids
        ):
            by_id[m["tweet_id"]]["media"].append({
                "media_id": m["media_id"], "url": m["media_url"], "type": m["media_type"],
                "width": m["width"], "height": m["height"],
                "transcription": m["transcription"], "alt_text": m["alt_text"],
            })
        for u in con.execute(
            f"SELECT tweet_id, url, expanded_url FROM tweet_urls WHERE tweet_id IN ({marks})", ids
        ):
            by_id[u["tweet_id"]]["urls"].append({"url": u["url"], "expanded_url": u["expanded_url"]})
        return tweets

    # ----- reads -----

    def get_tweet(self, tweet_id: str) -> Optional[dict]:
        con = self._con()
        try:
            row = con.execute("SELECT * FROM tweets WHERE tweet_id = ?", (tweet_id,)).fetchone()
            if not row:
                return None
            return self._hydrate(con, [self._tweet_row(row)])[0]
        finally:
            con.close()

    def get_thread(self, conversation_id: str) -> list[dict]:
        con = self._con()
        try:
            rows = con.execute(
                "SELECT * FROM tweets WHERE conversation_id = ? ORDER BY created_at ASC",
                (conversation_id,),
            ).fetchall()
            return self._hydrate(con, [self._tweet_row(r) for r in rows])
        finally:
            con.close()

    def resolve_handle(self, handle: str) -> Optional[str]:
        """Map @handle -> author_id using the most recent tweet we have."""
        con = self._con()
        try:
            row = con.execute(
                "SELECT author_id FROM tweets WHERE author_username = ? AND author_id IS NOT NULL "
                "ORDER BY created_at DESC LIMIT 1",
                (handle.lstrip("@"),),
            ).fetchone()
            return row["author_id"] if row else None
        finally:
            con.close()

    def max_created_at(self, author_id: Optional[str], handle: str) -> Optional[str]:
        """Newest cached tweet time for an author — the incremental fetch boundary."""
        con = self._con()
        try:
            row = con.execute(
                "SELECT MAX(created_at) AS m FROM tweets WHERE author_id = ? OR author_username = ?",
                (author_id, handle.lstrip("@")),
            ).fetchone()
            return row["m"] if row else None
        finally:
            con.close()

    def upsert_user(self, profile: dict) -> None:
        """Persist an API user profile into the users table."""
        pm = profile.get("public_metrics") or {}
        con = self._con()
        try:
            con.execute(
                "INSERT OR REPLACE INTO users "
                "(author_id, handle, name, description, followers, following, tweet_count, "
                " created_at, verified, location, url, fetched_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (profile.get("id"), profile.get("username"), profile.get("name"),
                 profile.get("description"), pm.get("followers_count"), pm.get("following_count"),
                 pm.get("tweet_count"), profile.get("created_at"),
                 1 if profile.get("verified") else 0, profile.get("location"), profile.get("url"),
                 _iso(_utcnow())),
            )
            con.commit()
        finally:
            con.close()

    def get_stored_user(self, handle_or_id: str) -> Optional[dict]:
        """Return a persisted API profile (users table), if present."""
        h = handle_or_id.lstrip("@")
        con = self._con()
        try:
            row = con.execute(
                "SELECT * FROM users WHERE handle = ? OR author_id = ?", (h, h)
            ).fetchone()
            return dict(row) if row else None
        finally:
            con.close()

    def get_user(self, handle_or_id: str) -> Optional[dict]:
        """Profile derived from cached tweets. Full profile needs an API fetch
        (Phase 1+ once /users is wired); for now we return what the cache knows."""
        h = handle_or_id.lstrip("@")
        con = self._con()
        try:
            row = con.execute(
                "SELECT author_id, author_username, COUNT(*) AS n, "
                "MIN(created_at) AS first_seen, MAX(created_at) AS last_seen "
                "FROM tweets WHERE author_username = ? OR author_id = ? "
                "GROUP BY author_id, author_username ORDER BY n DESC LIMIT 1",
                (h, h),
            ).fetchone()
            if not row or row["author_id"] is None and row["author_username"] is None:
                return None
            return {
                "author_id": row["author_id"],
                "handle": row["author_username"],
                "cached_tweet_count": row["n"],
                "first_seen": row["first_seen"],
                "last_seen": row["last_seen"],
                "source": "derived-from-cache",
            }
        finally:
            con.close()

    def get_timeline(self, handle_or_id: str, limit: int = 50, before: Optional[str] = None,
                     since: Optional[str] = None) -> list[dict]:
        """Author timeline, newest-first. `before` is an exclusive upper bound and
        `since` an inclusive lower bound (ISO timestamps) — together a time range."""
        h = handle_or_id.lstrip("@")
        author_id = h if h.isdigit() else self.resolve_handle(h)
        con = self._con()
        try:
            sql = ("SELECT * FROM tweets WHERE (author_id = ? OR author_username = ?)")
            params: list[Any] = [author_id, h]
            if before:
                sql += " AND created_at < ?"
                params.append(before)
            if since:
                sql += " AND created_at >= ?"
                params.append(since)
            sql += " ORDER BY created_at DESC LIMIT ?"
            params.append(min(limit, 200))
            rows = con.execute(sql, params).fetchall()
            return self._hydrate(con, [self._tweet_row(r) for r in rows])
        finally:
            con.close()

    def search(self, query: Optional[str] = None, limit: int = 50, include_media: bool = True,
               author: Optional[str] = None, since: Optional[str] = None,
               until: Optional[str] = None, tier: Optional[str] = None) -> list[dict]:
        """Query the archive. `query` (FTS5) is optional — omit it for a pure
        filter/range query. Optional filters (applied in all modes): `author`
        (username), `since` (inclusive ISO lower bound), `until` (exclusive ISO
        upper bound), `tier` (spine/cast/context/bridge). With a query, results
        are relevance-ranked over tweet text + media transcriptions; without one,
        newest-first."""
        con = self._con()
        try:
            limit = min(limit, 200)
            conds: list[str] = []
            fparams: list[Any] = []
            if author:
                conds.append("t.author_username = ?"); fparams.append(author.lstrip("@"))
            if since:
                conds.append("t.created_at >= ?"); fparams.append(since)
            if until:
                conds.append("t.created_at < ?"); fparams.append(until)
            if tier:
                conds.append("t.tier = ?"); fparams.append(tier)
            extra = (" AND " + " AND ".join(conds)) if conds else ""

            if query:
                seen: dict[str, dict] = {}
                for r in con.execute(
                    "SELECT t.* FROM tweets t JOIN tweets_fts f ON f.tweet_id = t.tweet_id "
                    f"WHERE tweets_fts MATCH ?{extra} ORDER BY rank LIMIT ?",
                    [query, *fparams, limit],
                ):
                    seen.setdefault(r["tweet_id"], self._tweet_row(r))
                if include_media and len(seen) < limit:
                    for r in con.execute(
                        "SELECT t.* FROM tweets t JOIN media m ON m.tweet_id = t.tweet_id "
                        "JOIN media_fts f ON f.media_id = m.media_id AND f.tweet_id = m.tweet_id "
                        f"WHERE media_fts MATCH ?{extra} ORDER BY rank LIMIT ?",
                        [query, *fparams, limit],
                    ):
                        seen.setdefault(r["tweet_id"], self._tweet_row(r))
                return self._hydrate(con, list(seen.values())[:limit])

            # No query → pure filter/range query, newest-first.
            where = (" WHERE " + " AND ".join(conds)) if conds else ""
            rows = con.execute(
                f"SELECT t.* FROM tweets t{where} ORDER BY t.created_at DESC LIMIT ?",
                [*fparams, limit],
            ).fetchall()
            return self._hydrate(con, [self._tweet_row(r) for r in rows])
        finally:
            con.close()

    # ----- media -----

    def get_media(self, media_id: str) -> Optional[dict]:
        con = self._con()
        try:
            r = con.execute(
                "SELECT media_id, tweet_id, media_url, media_type, transcription, alt_text "
                "FROM media WHERE media_id = ? LIMIT 1", (media_id,),
            ).fetchone()
            return dict(r) if r else None
        finally:
            con.close()

    def set_transcription(self, media_id: str, text: str) -> None:
        con = self._con()
        try:
            con.execute("UPDATE media SET transcription = ? WHERE media_id = ?", (text, media_id))
            con.execute("INSERT INTO media_fts(media_fts) VALUES('rebuild')")
            con.commit()
        finally:
            con.close()

    def untranscribed_media(self, tweet_ids: list[str]) -> list[dict]:
        """Media rows (with a URL) for these tweets that lack a transcription."""
        if not tweet_ids:
            return []
        con = self._con()
        try:
            marks = ",".join("?" * len(tweet_ids))
            rows = con.execute(
                f"SELECT media_id, tweet_id, media_url, media_type FROM media "
                f"WHERE tweet_id IN ({marks}) AND media_url IS NOT NULL "
                f"AND (transcription IS NULL OR transcription = '')", tweet_ids,
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            con.close()

    def thread_context(self, tweet_id: str, n: int = 3) -> str:
        """Render the n tweets before/after this one in its conversation, as
        plain text — context for transcribing an image in a thread."""
        con = self._con()
        try:
            row = con.execute(
                "SELECT conversation_id, created_at FROM tweets WHERE tweet_id = ?", (tweet_id,)
            ).fetchone()
            if not row or not row["conversation_id"]:
                return ""
            cid, ts = row["conversation_id"], row["created_at"]
            before = con.execute(
                "SELECT created_at, author_username, full_text FROM tweets "
                "WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?",
                (cid, ts, n),
            ).fetchall()
            after = con.execute(
                "SELECT created_at, author_username, full_text FROM tweets "
                "WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?",
                (cid, ts, n),
            ).fetchall()
            lines = []
            for r in list(reversed(before)) + list(after):
                lines.append(f"@{r['author_username']}: {(r['full_text'] or '')[:280]}")
            return "\n".join(lines)
        finally:
            con.close()

    # ----- freshness / negative cache -----

    def is_fresh(self, resource_key: str) -> bool:
        con = self._con()
        try:
            row = con.execute(
                "SELECT expires_at FROM resource_freshness WHERE resource_key = ?", (resource_key,)
            ).fetchone()
            if not row or not row["expires_at"]:
                return False
            return row["expires_at"] > _iso(_utcnow())
        finally:
            con.close()

    def mark_fresh(self, resource_key: str, kind: str, ttl: int, cursor: Optional[str] = None) -> None:
        con = self._con()
        try:
            now = _utcnow()
            con.execute(
                "INSERT OR REPLACE INTO resource_freshness "
                "(resource_key, kind, last_fetched, cursor, expires_at) VALUES (?,?,?,?,?)",
                (resource_key, kind, _iso(now), cursor, _iso(now + timedelta(seconds=ttl))),
            )
            con.commit()
        finally:
            con.close()

    def negative(self, resource_key: str) -> Optional[str]:
        con = self._con()
        try:
            row = con.execute(
                "SELECT reason, expires_at FROM negative_cache WHERE resource_key = ?", (resource_key,)
            ).fetchone()
            if not row:
                return None
            if row["expires_at"] and row["expires_at"] <= _iso(_utcnow()):
                return None
            return row["reason"]
        finally:
            con.close()

    def mark_negative(self, resource_key: str, reason: str, ttl: int = config.NEGATIVE_TTL) -> None:
        con = self._con()
        try:
            now = _utcnow()
            con.execute(
                "INSERT OR REPLACE INTO negative_cache (resource_key, reason, seen_at, expires_at) "
                "VALUES (?,?,?,?)",
                (resource_key, reason, _iso(now), _iso(now + timedelta(seconds=ttl))),
            )
            con.commit()
        finally:
            con.close()

    # ----- cost ledger -----

    def migrate(self) -> None:
        """Idempotent schema upkeep for an already-running bridge (the init script
        handles fresh seeds). Adds api_cost_ledger.actor for per-token attribution,
        and applies schema.sql (indexes + the tweets_fts sync triggers)."""
        con = self._con()
        try:
            cols = {r[1] for r in con.execute("PRAGMA table_info(api_cost_ledger)")}
            if "actor" not in cols:
                con.execute("ALTER TABLE api_cost_ledger ADD COLUMN actor TEXT")
                con.commit()
            had_triggers = con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='tweets_fts_ai'"
            ).fetchone()
            con.executescript(config.SCHEMA_SQL.read_text())
            if not had_triggers:
                # First run with triggers: resync once so they start from a
                # consistent index. Later writes stay in sync incrementally.
                con.execute("INSERT INTO tweets_fts(tweets_fts) VALUES('rebuild')")
                con.commit()
        finally:
            con.close()

    def record_cost(self, call: dict) -> None:
        con = self._con()
        try:
            r = call.get("resources", {})
            con.execute(
                "INSERT INTO api_cost_ledger "
                "(ts, endpoint, kind, status, posts, users, media, cost_usd, "
                " rate_limit, rate_remaining, rate_reset, actor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (call.get("ts"), call.get("endpoint"), call.get("kind"), call.get("status"),
                 r.get("posts_data", 0) + r.get("posts_includes", 0), r.get("users", 0),
                 r.get("media", 0), call.get("cost_usd", 0),
                 call.get("rate_limit"), call.get("rate_remaining"), call.get("rate_reset"),
                 call.get("actor") or config.request_actor()),
            )
            con.commit()
        finally:
            con.close()

    def budget(self, by_actor: bool = False) -> dict:
        con = self._con()
        try:
            row = con.execute(
                "SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS total_usd, "
                "COALESCE(SUM(posts),0) AS posts, COALESCE(SUM(users),0) AS users, "
                "COALESCE(SUM(media),0) AS media, MAX(ts) AS last_call FROM api_cost_ledger"
            ).fetchone()
            out = dict(row)
            if by_actor:
                rows = con.execute(
                    "SELECT COALESCE(actor,'system') AS actor, COUNT(*) AS calls, "
                    "COALESCE(SUM(cost_usd),0) AS total_usd FROM api_cost_ledger "
                    "GROUP BY COALESCE(actor,'system') ORDER BY total_usd DESC"
                ).fetchall()
                out["by_actor"] = [dict(r) for r in rows]
            return out
        finally:
            con.close()

    def counts(self) -> dict:
        con = self._con()
        try:
            tweets = con.execute("SELECT COUNT(*) AS n FROM tweets").fetchone()["n"]
            media = con.execute("SELECT COUNT(*) AS n FROM media").fetchone()["n"]
            return {"tweets": tweets, "media": media}
        finally:
            con.close()

    # ----- previews (cheap aggregates, no bodies) -----

    def thread_stats(self, conversation_id: str) -> dict:
        """Summarize a cached thread without returning tweet bodies: size,
        participants (by tweet count), time span, image count, root author."""
        con = self._con()
        try:
            rows = con.execute(
                "SELECT author_username AS handle, COUNT(*) AS n "
                "FROM tweets WHERE conversation_id = ? "
                "GROUP BY author_username ORDER BY n DESC",
                (conversation_id,),
            ).fetchall()
            participants = [
                {"handle": r["handle"], "count": r["n"]} for r in rows if r["handle"]
            ]
            count = sum(r["n"] for r in rows)
            span = con.execute(
                "SELECT MIN(created_at) AS first, MAX(created_at) AS last "
                "FROM tweets WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            media_count = con.execute(
                "SELECT COUNT(*) AS n FROM media m JOIN tweets t ON t.tweet_id = m.tweet_id "
                "WHERE t.conversation_id = ?",
                (conversation_id,),
            ).fetchone()["n"]
            root = con.execute(
                "SELECT author_username FROM tweets "
                "WHERE conversation_id = ? AND (tweet_id = ? OR reply_to_tweet_id IS NULL) "
                "ORDER BY created_at ASC LIMIT 1",
                (conversation_id, conversation_id),
            ).fetchone()
            return {
                "conversation_id": conversation_id,
                "count": count,
                "participants": participants,
                "first": span["first"] if span else None,
                "last": span["last"] if span else None,
                "media_count": media_count,
                "root_author": root["author_username"] if root else None,
            }
        finally:
            con.close()

    def timeline_stats(self, handle_or_id: str) -> dict:
        """Summarize what we have cached for an author's timeline."""
        h = handle_or_id.lstrip("@")
        author_id = h if h.isdigit() else self.resolve_handle(h)
        con = self._con()
        try:
            row = con.execute(
                "SELECT author_id, author_username, COUNT(*) AS n, "
                "MIN(created_at) AS first, MAX(created_at) AS last "
                "FROM tweets WHERE author_id = ? OR author_username = ? "
                "GROUP BY author_id, author_username ORDER BY n DESC LIMIT 1",
                (author_id, h),
            ).fetchone()
            media_count = con.execute(
                "SELECT COUNT(*) AS n FROM media m JOIN tweets t ON t.tweet_id = m.tweet_id "
                "WHERE t.author_id = ? OR t.author_username = ?",
                (author_id, h),
            ).fetchone()["n"]
            return {
                "handle": (row["author_username"] if row else None) or h,
                "author_id": row["author_id"] if row else author_id,
                "count": row["n"] if row else 0,
                "first": row["first"] if row else None,
                "last": row["last"] if row else None,
                "last_tweet_at": row["last"] if row else None,
                "media_count": media_count,
            }
        finally:
            con.close()
