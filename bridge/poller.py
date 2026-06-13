"""Per-resource poller + pub/sub fan-out.

A single background thread polls each resource that currently has at least one
subscriber, on an adaptive interval, and pushes newly-cached tweets to every
subscriber's queue. SSE handlers (server.py) own one queue each.

The bridge polls per *resource*, never per *user* — one poll of repligate's
timeline serves every subscribed bot. Dedup is the cache itself: Cache.refresh()
returns only tweets that were new to the DB, so each tweet fans out once.
"""

from __future__ import annotations

import queue
import threading
import time
from typing import Optional

from . import config
from .cache import Cache


class Poller:
    def __init__(self, cache: Optional[Cache] = None, interval: float = None):
        self.cache = cache or Cache()
        self.interval = interval if interval is not None else config.POLL_INTERVAL
        # resource_key -> set of subscriber queues
        self._subs: dict[str, set[queue.Queue]] = {}
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._stop = False

    # ----- lifecycle -----

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop = False
        self._thread = threading.Thread(target=self._loop, name="x-bridge-poller", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop = True
        self._wake.set()

    # ----- subscription -----

    def subscribe(self, resource_key: str) -> "queue.Queue":
        q: queue.Queue = queue.Queue(maxsize=1000)
        with self._lock:
            self._subs.setdefault(resource_key, set()).add(q)
        self._wake.set()  # let the loop pick up the new resource promptly
        return q

    def unsubscribe(self, resource_key: str, q: "queue.Queue") -> None:
        with self._lock:
            subs = self._subs.get(resource_key)
            if subs:
                subs.discard(q)
                if not subs:
                    del self._subs[resource_key]

    def active_resources(self) -> list[str]:
        with self._lock:
            return list(self._subs)

    def _publish(self, resource_key: str, tweets: list[dict]) -> int:
        if not tweets:
            return 0
        with self._lock:
            subs = list(self._subs.get(resource_key, ()))
        n = 0
        for q in subs:
            for t in tweets:
                try:
                    q.put_nowait(t)
                    n += 1
                except queue.Full:
                    pass
        return n

    # ----- on-demand (used by SSE ?poll=force and tests) -----

    def poll_now(self, resource_key: str, force: bool = True) -> list[dict]:
        """Refresh one resource immediately and fan out new tweets. Returns them."""
        new = self.cache.refresh(resource_key, force=force)
        self._publish(resource_key, new)
        return new

    # ----- background loop -----

    def _loop(self) -> None:
        while not self._stop:
            for rk in self.active_resources():
                if self._stop:
                    break
                try:
                    new = self.cache.refresh(rk, force=False)
                    pushed = self._publish(rk, new)
                    if new:
                        print(f"[poller] {rk}: {len(new)} new, fanned to {pushed}", flush=True)
                except Exception as e:  # noqa: BLE001
                    print(f"[poller] {rk} error: {e}", flush=True)
            # Sleep until interval elapses or a new subscription wakes us.
            self._wake.wait(timeout=self.interval)
            self._wake.clear()
