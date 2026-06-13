"""Smoke tests for the Phase 1 read path. Runs against the seeded cache.

    python3 -m pytest tests/   # if pytest present
    python3 tests/test_read.py # plain stdlib runner (no deps)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge.db import Repo  # noqa: E402

repo = Repo()


def test_counts_nonempty():
    c = repo.counts()
    assert c["tweets"] > 0, "seed cache should have tweets"


def test_timeline_repligate():
    tl = repo.get_timeline("repligate", limit=5)
    assert tl, "repligate timeline should be non-empty"
    assert tl[0]["created_at"] >= tl[-1]["created_at"], "newest-first ordering"
    assert all("media" in t and "urls" in t for t in tl), "hydrated shape"


def test_search_fts():
    res = repo.search("the", limit=3)
    assert isinstance(res, list)


def test_thread_roundtrip():
    tl = repo.get_timeline("repligate", limit=1)
    cid = tl[0]["conversation_id"]
    if cid:
        thread = repo.get_thread(cid)
        assert any(t["conversation_id"] == cid for t in thread)


def test_negative_cache_roundtrip():
    repo.mark_negative("tweet:doesnotexist", "notfound", ttl=60)
    assert repo.negative("tweet:doesnotexist") == "notfound"


def test_missing_user_is_none():
    assert repo.get_user("___no_such_handle_xyz___") is None


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok   {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  ERR  {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
