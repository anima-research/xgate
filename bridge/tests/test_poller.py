"""Poller pub/sub fan-out — pure unit test, no API calls (no spend).

    python3 tests/test_poller.py
"""

from __future__ import annotations

import queue
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge.poller import Poller  # noqa: E402


class FakeCache:
    """Stand-in so the poller never touches the network."""
    def __init__(self):
        self.calls = []
        self.queued = {}

    def refresh(self, resource_key, force=False):
        self.calls.append((resource_key, force))
        return self.queued.pop(resource_key, [])


def test_subscribe_publish_fanout():
    p = Poller(cache=FakeCache(), interval=999)
    q1 = p.subscribe("timeline:foo")
    q2 = p.subscribe("timeline:foo")
    n = p._publish("timeline:foo", [{"tweet_id": "1"}, {"tweet_id": "2"}])
    assert n == 4, f"2 tweets x 2 subscribers = 4 puts, got {n}"
    assert q1.get_nowait()["tweet_id"] == "1"
    assert q1.get_nowait()["tweet_id"] == "2"
    assert q2.get_nowait()["tweet_id"] == "1"


def test_unsubscribe_cleans_up():
    p = Poller(cache=FakeCache(), interval=999)
    q = p.subscribe("search:bar")
    assert "search:bar" in p.active_resources()
    p.unsubscribe("search:bar", q)
    assert "search:bar" not in p.active_resources()


def test_poll_now_fetches_and_fans_out():
    fc = FakeCache()
    fc.queued["timeline:baz"] = [{"tweet_id": "99"}]
    p = Poller(cache=fc, interval=999)
    q = p.subscribe("timeline:baz")
    out = p.poll_now("timeline:baz", force=True)
    assert out == [{"tweet_id": "99"}]
    assert fc.calls == [("timeline:baz", True)]
    assert q.get_nowait()["tweet_id"] == "99"


def test_publish_to_no_subscribers_is_noop():
    p = Poller(cache=FakeCache(), interval=999)
    assert p._publish("nobody:here", [{"tweet_id": "1"}]) == 0


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn(); print(f"  ok   {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1; print(f"  FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)