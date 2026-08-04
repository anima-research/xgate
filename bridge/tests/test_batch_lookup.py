"""Batch tweet lookup: cache-first, one upstream call for misses, negative
caching of deletions. No network — XClient.lookup_tweets is stubbed.

    python3 tests/test_batch_lookup.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge.cache import Cache  # noqa: E402
from bridge.db import Repo  # noqa: E402

MISSING_ID = "990000000000000001"
DELETED_ID = "990000000000000002"


class StubClient:
    def __init__(self, tweets: dict):
        self.tweets = tweets
        self.calls = []

    def lookup_tweets(self, ids):
        self.calls.append(list(ids))
        return {
            "tweets": {i: self.tweets[i] for i in ids if i in self.tweets},
            "users": {}, "media": {},
        }


class StubbedCache(Cache):
    def __init__(self, client):
        super().__init__()
        self._stub = client

    def _maybe_client(self):
        return self._stub


def _cleanup(repo: Repo):
    con = repo._con()
    for tid in (MISSING_ID, DELETED_ID):
        con.execute("DELETE FROM tweets WHERE tweet_id = ?", (tid,))
        con.execute("DELETE FROM negative_cache WHERE resource_key = ?", (f"tweet:{tid}",))
        con.execute("DELETE FROM resource_freshness WHERE resource_key = ?", (f"tweet:{tid}",))
    con.commit(); con.close()


def test_batch_cache_first_and_negative():
    repo = Repo()
    _cleanup(repo)
    # a real cached tweet from the seed DB
    seeded = repo._con().execute("SELECT tweet_id FROM tweets LIMIT 1").fetchone()[0]

    stub = StubClient({
        MISSING_ID: {"id": MISSING_ID, "text": "fetched live", "author_id": "1",
                     "created_at": "2026-01-01T00:00:00.000Z", "conversation_id": MISSING_ID},
    })
    c = StubbedCache(stub)

    r = c.get_tweets_batch([seeded, MISSING_ID, DELETED_ID, seeded])
    assert r["requested"] == 3, "dupes collapse"
    assert r["from_cache"] == 1, "seeded tweet served from cache"
    assert r["fetched"] == 1, "one live fetch ingested"
    assert r["missing"] == [DELETED_ID]
    assert stub.calls == [[MISSING_ID, DELETED_ID]], "cached id must not be re-fetched"
    assert c.repo.negative(f"tweet:{DELETED_ID}") == "notfound"

    # second call: fetched id now cached, deleted id negative-cached -> zero upstream ids
    r2 = c.get_tweets_batch([seeded, MISSING_ID, DELETED_ID])
    assert r2["from_cache"] == 2
    assert r2["fetched"] == 0
    assert len(stub.calls) == 1, "no second upstream call"

    _cleanup(repo)


def test_batch_cache_only_token():
    """No client (cache-only) -> serves hits, misses stay missing, no error."""
    repo = Repo()
    seeded = repo._con().execute("SELECT tweet_id FROM tweets LIMIT 1").fetchone()[0]

    c = Cache()
    c._maybe_client = lambda: None
    r = c.get_tweets_batch([seeded, "990000000000000009"])
    assert r["from_cache"] == 1 and r["fetched"] == 0
    assert r["missing"] == ["990000000000000009"]


if __name__ == "__main__":
    test_batch_cache_first_and_negative()
    test_batch_cache_only_token()
    print("ok")
