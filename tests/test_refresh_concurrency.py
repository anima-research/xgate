"""Concurrency: a forced poll and the background loop must not double-fetch the
same resource. Verifies the per-resource lock + under-lock freshness recheck.
No network — _refresh_timeline is stubbed. Uses a throwaway freshness key.

    python3 tests/test_refresh_concurrency.py
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge.cache import Cache  # noqa: E402

KEY = "timeline:__concurrency_test__"


class CountingCache(Cache):
    def __init__(self):
        super().__init__()
        self.fetches = 0

    def _maybe_client(self):
        return object()  # non-None: pretend fetching is enabled

    def _refresh_timeline(self, key, value, mentions=False):
        self.fetches += 1
        time.sleep(0.3)               # hold the lock long enough to overlap
        self.repo.mark_fresh(key, "timeline", 999)
        return [{"tweet_id": "x"}]


def test_concurrent_refresh_fetches_once():
    c = CountingCache()
    # ensure the key starts stale
    con = c.repo._con()
    con.execute("DELETE FROM resource_freshness WHERE resource_key = ?", (KEY,))
    con.commit(); con.close()

    results = []

    def worker(force):
        results.append(c.refresh(KEY, force=force))

    # One "forced poll" + one "background loop" hitting the same key at once.
    threads = [threading.Thread(target=worker, args=(False,)) for _ in range(3)]
    for t in threads: t.start()
    for t in threads: t.join()

    assert c.fetches == 1, f"expected exactly one fetch, got {c.fetches}"
    non_empty = [r for r in results if r]
    assert len(non_empty) == 1, f"exactly one caller should get the new tweets, got {len(non_empty)}"

    # cleanup
    con = c.repo._con()
    con.execute("DELETE FROM resource_freshness WHERE resource_key = ?", (KEY,))
    con.commit(); con.close()


if __name__ == "__main__":
    try:
        test_concurrent_refresh_fetches_once()
        print("  ok   test_concurrent_refresh_fetches_once")
        print("\n1/1 passed")
    except AssertionError as e:
        print(f"  FAIL {e}")
        sys.exit(1)