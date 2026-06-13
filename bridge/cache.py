"""Read-through cache policy.

Cache-first by default. Live X API fetch happens ONLY when all hold:
  - the caller asked for it (cache miss, or fresh=True), AND
  - config.ALLOW_FETCH is set, AND
  - a bearer is configured.
Otherwise a miss is just a miss and costs nothing. Negative-cached resources
short-circuit so we never re-pay to rediscover an absence.
"""

from __future__ import annotations

from typing import Optional

from . import config
from .db import Repo, connect
from .ingest import ingest_lookup


class Cache:
    def __init__(self, repo: Optional[Repo] = None):
        self.repo = repo or Repo()
        self._client = None

    def _maybe_client(self):
        if not (config.ALLOW_FETCH and config.BEARER):
            return None
        if self._client is None:
            from .xapi import XClient  # local import: only when fetching is enabled
            self._client = XClient(config.BEARER, self.repo)
        return self._client

    def get_tweet(self, tweet_id: str, fresh: bool = False) -> Optional[dict]:
        key = f"tweet:{tweet_id}"
        cached = self.repo.get_tweet(tweet_id)
        if cached and not fresh:
            return cached
        if self.repo.negative(key) and not fresh:
            return None

        client = self._maybe_client()
        if client is None:
            return cached  # cache-only mode: serve what we have (maybe None)

        from .xapi import XApiError
        try:
            result = client.lookup_tweets([tweet_id])
        except XApiError as e:
            if e.status in (403, 404):
                reason = {403: "protected", 404: "notfound"}.get(e.status, "error")
                self.repo.mark_negative(key, reason)
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
