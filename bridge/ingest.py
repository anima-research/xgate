"""Ingest X API v2 payloads into the cache. Lifted from twitter_backfill.py,
adapted to take a live connection and be idempotent (INSERT OR REPLACE).
"""

from __future__ import annotations

import sqlite3


def tweet_text(t: dict) -> str:
    return t.get("note_tweet", {}).get("text") or t.get("text", "")


def insert_tweet(cur: sqlite3.Cursor, t: dict, username: str, source: str) -> None:
    reply_to = None
    for r in (t.get("referenced_tweets") or []):
        if r.get("type") == "replied_to":
            reply_to = r["id"]
            break
    pm = t.get("public_metrics") or {}
    cur.execute(
        "INSERT OR REPLACE INTO tweets "
        "(tweet_id, author_id, author_username, full_text, created_at, "
        " reply_to_tweet_id, reply_to_username, conversation_id, "
        " retweet_count, favorite_count, source) "
        "VALUES (?,?,?,?,?,?,NULL,?,?,?,?)",
        (t["id"], t.get("author_id"), username, tweet_text(t), t.get("created_at"),
         reply_to, t.get("conversation_id"),
         pm.get("retweet_count", 0), pm.get("like_count", 0), source),
    )


def insert_media(cur: sqlite3.Cursor, t: dict, media_by_key: dict, source: str) -> None:
    for mk in (t.get("attachments") or {}).get("media_keys", []):
        m = media_by_key.get(mk)
        if not m:
            continue
        url = m.get("url") or m.get("preview_image_url")
        cur.execute(
            "INSERT OR REPLACE INTO media "
            "(media_id, tweet_id, media_url, media_type, width, height, transcription, source) "
            "VALUES (?,?,?,?,?,?,NULL,?)",
            (mk, t["id"], url, m.get("type"), m.get("width"), m.get("height"), source),
        )


def insert_urls(cur: sqlite3.Cursor, t: dict) -> None:
    ents = t.get("entities") or {}
    cur.execute("DELETE FROM tweet_urls WHERE tweet_id = ?", (t["id"],))
    for u in (ents.get("urls") or []):
        exp = u.get("expanded_url", "") or ""
        if "/photo/" in exp or "pic.x.com" in exp or "pic.twitter.com" in exp or u.get("media_key"):
            continue
        cur.execute("INSERT INTO tweet_urls (tweet_id, url, expanded_url) VALUES (?,?,?)",
                    (t["id"], u.get("url"), exp))


def ingest_page(con: sqlite3.Connection, page: dict, source: str) -> list[str]:
    """Ingest a raw timeline/search API page ({data, includes}). Idempotent.

    Returns the list of tweet ids that were NEW to the cache (not present
    before this call) — the poller uses this to decide what to fan out.
    """
    inc = page.get("includes", {}) or {}
    users = {u["id"]: u for u in inc.get("users", [])}
    media = {m["media_key"]: m for m in inc.get("media", [])}

    # data tweets, plus any referenced tweets carried in includes.
    tweets: dict[str, dict] = {}
    for t in page.get("data", []) or []:
        tweets[t["id"]] = t
    for t in inc.get("tweets", []) or []:
        tweets.setdefault(t["id"], t)
    if not tweets:
        return []

    cur = con.cursor()
    marks = ",".join("?" * len(tweets))
    existing = {r[0] for r in cur.execute(
        f"SELECT tweet_id FROM tweets WHERE tweet_id IN ({marks})", list(tweets)).fetchall()}
    new_ids = [tid for tid in tweets if tid not in existing]

    for tid, t in tweets.items():
        uname = (users.get(t.get("author_id")) or {}).get("username", "")
        insert_tweet(cur, t, uname, source)
        insert_media(cur, t, media, source)
        insert_urls(cur, t)
    cur.execute("INSERT INTO tweets_fts(tweets_fts) VALUES('rebuild')")
    con.commit()
    return new_ids


def ingest_lookup(con: sqlite3.Connection, result: dict, source: str) -> int:
    """Write a lookup_tweets() result ({tweets,users,media}) into the cache."""
    users, media = result.get("users", {}), result.get("media", {})
    cur = con.cursor()
    n = 0
    for tid, t in result.get("tweets", {}).items():
        uname = (users.get(t.get("author_id")) or {}).get("username", "")
        insert_tweet(cur, t, uname, source)
        insert_media(cur, t, media, source)
        insert_urls(cur, t)
        n += 1
    if n:
        cur.execute("INSERT INTO tweets_fts(tweets_fts) VALUES('rebuild')")
    con.commit()
    return n
