"""X API v2 client — lifted from ~/archivist/scripts/twitter_backfill.py.

Read-only for Phase 1: tweet lookup (and timeline pagination, ready for the
poller in Phase 3). Every call tallies per-resource spend into the cost ledger
via the Repo. Posting/DMs (user-context OAuth) arrive in Phase 4.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from . import config


class XApiError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"X API error {status}: {body[:200]}")
        self.status = status
        self.body = body


class XClient:
    """Thin v2 client. Each `_call` records its cost to `repo` if provided."""

    def __init__(self, bearer: str, repo=None):
        self.bearer = bearer
        self.repo = repo

    def _call(self, endpoint: str, params: dict, kind: str) -> dict:
        url = f"{config.API_BASE}{endpoint}?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.bearer}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw, hdrs, status = r.read(), dict(r.headers), r.status
        except urllib.error.HTTPError as e:
            raw, hdrs, status = e.read(), dict(e.headers or {}), e.code

        parsed = {}
        if status < 400:
            parsed = json.loads(raw.decode("utf-8", errors="replace"), strict=False)

        inc = parsed.get("includes", {}) if isinstance(parsed, dict) else {}
        data = parsed.get("data") if isinstance(parsed, dict) else None
        n_data = len(data) if isinstance(data, list) else (1 if data else 0)
        n_inc = len(inc.get("tweets", []))
        n_users = len(inc.get("users", []))
        n_media = len(inc.get("media", []))
        cost = ((n_data + n_inc) * config.PRICE["post"]
                + n_users * config.PRICE["user"]
                + n_media * config.PRICE["media"])
        call = {
            "endpoint": endpoint, "kind": kind, "status": status,
            "resources": {"posts_data": n_data, "posts_includes": n_inc,
                          "users": n_users, "media": n_media},
            "cost_usd": round(cost, 4),
            "rate_limit": _int(hdrs.get("x-rate-limit-limit")),
            "rate_remaining": _int(hdrs.get("x-rate-limit-remaining")),
            "rate_reset": _int(hdrs.get("x-rate-limit-reset")),
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        if self.repo:
            self.repo.record_cost(call)
        if status >= 400:
            print(f"  ! {endpoint} -> {status} {raw[:200]!r}", file=sys.stderr)
            raise XApiError(status, raw.decode("utf-8", "replace"))
        return parsed

    def lookup_tweets(self, ids: list[str]) -> dict:
        all_tweets, all_users, all_media = {}, {}, {}
        for i in range(0, len(ids), 100):
            batch = ids[i:i + 100]
            page = self._call("/tweets", {
                "ids": ",".join(batch),
                "tweet.fields": "created_at,conversation_id,referenced_tweets,entities,note_tweet,"
                                "attachments,public_metrics,author_id",
                "expansions": "author_id,attachments.media_keys",
                "media.fields": "type,url,preview_image_url,width,height,alt_text",
                "user.fields": "username,name",
            }, kind="lookup")
            for t in page.get("data", []):
                all_tweets[t["id"]] = t
            for u in page.get("includes", {}).get("users", []):
                all_users[u["id"]] = u
            for m in page.get("includes", {}).get("media", []):
                all_media[m["media_key"]] = m
        return {"tweets": all_tweets, "users": all_users, "media": all_media}

    def user_by_username(self, username: str) -> dict:
        """GET /2/users/by/username/:username — full profile (one user resource)."""
        page = self._call(f"/users/by/username/{urllib.parse.quote(username.lstrip('@'))}", {
            "user.fields": "username,name,description,created_at,public_metrics,verified,location,url",
        }, kind="user")
        return page.get("data", {})

    def search_recent(self, query: str, max_results: int = 50, token: str = None):
        """GET /2/tweets/search/recent — last 7 days. Returns (page, next_token).
        May 403 on lower API tiers; callers should degrade gracefully."""
        params = {
            "query": query,
            "max_results": str(max(10, min(max_results, 100))),
            "tweet.fields": "created_at,conversation_id,referenced_tweets,entities,note_tweet,"
                            "attachments,public_metrics,author_id",
            "expansions": "author_id,attachments.media_keys",
            "media.fields": "type,url,preview_image_url,width,height,alt_text",
            "user.fields": "username,name",
        }
        if token:
            params["next_token"] = token
        page = self._call("/tweets/search/recent", params, kind="search")
        return page, page.get("meta", {}).get("next_token")

    def user_timeline(self, uid: str, start_time: str, end_time: str, token: str = None,
                      lean: bool = False):
        """One page of a user's timeline. Returns (page, next_token).

        lean=True drops the referenced_tweets.id and media expansions. Those
        expansions are billed as additional posts/media (~75 extra billable
        objects per page in practice), so corpus-building pulls that only need
        the author's own text should always use lean mode.
        """
        params = {
            "max_results": "100", "start_time": start_time, "end_time": end_time,
            "tweet.fields": "created_at,conversation_id,referenced_tweets,in_reply_to_user_id,"
                            "entities,note_tweet,attachments,public_metrics,author_id",
            "expansions": "author_id" if lean else "referenced_tweets.id,attachments.media_keys,author_id",
            "user.fields": "username,name",
        }
        if not lean:
            params["media.fields"] = "type,url,preview_image_url,width,height,alt_text"
        if token:
            params["pagination_token"] = token
        page = self._call(f"/users/{uid}/tweets", params, kind="timeline")
        return page, page.get("meta", {}).get("next_token")


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
