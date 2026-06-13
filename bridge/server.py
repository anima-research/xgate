"""HTTP server for the bridge — stdlib only, threaded.

Implements the full read contract from DESIGN.md plus the Phase 3 SSE stream.
Routes are matched with small regexes; JSON handlers return (status, body),
while /stream/:resource is handled specially as a long-lived SSE response.
"""

from __future__ import annotations

import json
import queue
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from . import config
from .cache import Cache
from .db import Repo
from .poller import Poller

_repo = Repo()
_cache = Cache(_repo)
_poller = Poller(_cache)

JSON_ROUTES = [
    ("GET", re.compile(r"^/health/?$"), "health"),
    ("GET", re.compile(r"^/budget/?$"), "budget"),
    ("GET", re.compile(r"^/tweet/(?P<id>\d+)/?$"), "tweet"),
    ("GET", re.compile(r"^/thread/(?P<cid>\d+)/?$"), "thread"),
    ("GET", re.compile(r"^/user/(?P<handle>[^/]+)/?$"), "user"),
    ("GET", re.compile(r"^/timeline/(?P<who>[^/]+)/?$"), "timeline"),
    ("GET", re.compile(r"^/search/?$"), "search"),
]
STREAM_RE = re.compile(r"^/stream/(?P<resource>.+?)/?$")


def _truthy(qs: dict, key: str) -> bool:
    return qs.get(key, ["0"])[0].lower() in ("1", "true", "yes", "force")


def _int(qs: dict, key: str, default: int) -> int:
    try:
        return int(qs.get(key, [default])[0])
    except (TypeError, ValueError):
        return default


class Handler(BaseHTTPRequestHandler):
    server_version = "x-bridge/0.1"
    protocol_version = "HTTP/1.1"  # keep-alive; required for chunked SSE

    def log_message(self, fmt, *args):  # noqa: A003
        pass

    def _send(self, status: int, body) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):  # noqa: N802
        # Test-only hook: delete an author's newest cached tweet and clear the
        # timeline freshness, so a subsequent poll re-discovers it deterministically.
        m = re.match(r"^/__test_make_stale/(?P<id>\d+)/?$", urlparse(self.path).path)
        if not m:
            self._send(404, {"error": "no such route"})
            return
        author_id = m.group("id")
        con = self._repo_con()
        try:
            row = con.execute(
                "SELECT tweet_id FROM tweets WHERE author_id = ? ORDER BY created_at DESC LIMIT 1",
                (author_id,),
            ).fetchone()
            deleted = row["tweet_id"] if row else None
            if deleted:
                con.execute("DELETE FROM tweets WHERE tweet_id = ?", (deleted,))
                con.execute("INSERT INTO tweets_fts(tweets_fts) VALUES('rebuild')")
            con.execute("DELETE FROM resource_freshness WHERE resource_key = ?", (f"timeline:{author_id}",))
            con.commit()
        finally:
            con.close()
        self._send(200, {"made_stale": author_id, "deleted_tweet": deleted})

    def _repo_con(self):
        from .db import connect
        return connect(config.CACHE_DB)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)

        sm = STREAM_RE.match(path)
        if sm:
            self._handle_stream(unquote(sm.group("resource")), qs)
            return

        for _method, pat, name in JSON_ROUTES:
            m = pat.match(path)
            if m:
                try:
                    status, body = getattr(self, f"h_{name}")(m, qs)
                except Exception as e:  # noqa: BLE001
                    status, body = 500, {"error": str(e)}
                self._send(status, body)
                return
        self._send(404, {"error": "no such route", "path": path})

    # ----- JSON handlers -----

    def h_health(self, m, qs):
        return 200, {
            "ok": True, "version": "0.1.0", "db": str(config.CACHE_DB),
            "allow_fetch": config.ALLOW_FETCH, "bearer_configured": bool(config.BEARER),
            "active_streams": _poller.active_resources(), **_repo.counts(),
        }

    def h_budget(self, m, qs):
        return 200, _repo.budget()

    def h_tweet(self, m, qs):
        t = _cache.get_tweet(m.group("id"), fresh=_truthy(qs, "fresh"))
        return (200, t) if t else (404, {"cached": False, "tweet_id": m.group("id")})

    def h_thread(self, m, qs):
        if _truthy(qs, "fresh"):
            _cache.refresh(f"thread:{m.group('cid')}", force=True)
        tweets = _repo.get_thread(m.group("cid"))
        return 200, {"conversation_id": m.group("cid"), "count": len(tweets), "tweets": tweets}

    def h_user(self, m, qs):
        u = _cache.get_user(unquote(m.group("handle")), fresh=_truthy(qs, "fresh"))
        return (200, u) if u else (404, {"cached": False, "handle": unquote(m.group("handle"))})

    def h_timeline(self, m, qs):
        who = unquote(m.group("who"))
        tweets = _cache.timeline(who, limit=_int(qs, "limit", 50), fresh=_truthy(qs, "fresh"))
        return 200, {"who": who, "count": len(tweets), "tweets": tweets}

    def h_search(self, m, qs):
        q = qs.get("q", [""])[0]
        if not q:
            return 400, {"error": "q (query) is required"}
        tweets = _cache.search(q, limit=_int(qs, "limit", 50), fresh=_truthy(qs, "fresh"))
        return 200, {"query": q, "count": len(tweets), "tweets": tweets}

    # ----- SSE stream -----

    def _handle_stream(self, resource_key: str, qs: dict) -> None:
        q = _poller.subscribe(resource_key)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self._sse_comment(f"subscribed {resource_key}")

            # Optionally trigger an immediate poll so brand-new items arrive at
            # once. force=False (poll-if-stale): the per-resource lock + freshness
            # recheck guarantee this never double-fetches against the loop.
            if _truthy(qs, "poll"):
                for t in _poller.poll_now(resource_key, force=False):
                    self._sse_event("tweet", t)

            last_ping = time.time()
            while True:
                try:
                    tweet = q.get(timeout=5)
                    self._sse_event("tweet", tweet)
                except queue.Empty:
                    if time.time() - last_ping >= 15:
                        self._sse_comment("ping")
                        last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            _poller.unsubscribe(resource_key, q)

    def _sse_event(self, event: str, data) -> None:
        payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        self.wfile.write(payload.encode("utf-8"))
        self.wfile.flush()

    def _sse_comment(self, text: str) -> None:
        self.wfile.write(f": {text}\n\n".encode("utf-8"))
        self.wfile.flush()


def serve(host: str = None, port: int = None) -> None:
    host = host or config.HOST
    port = port or config.PORT
    _poller.start()
    httpd = ThreadingHTTPServer((host, port), Handler)
    counts = _repo.counts()
    print(f"x-bridge listening on http://{host}:{port}")
    print(f"  cache: {config.CACHE_DB}  ({counts['tweets']} tweets, {counts['media']} media)")
    print(f"  allow_fetch={config.ALLOW_FETCH}  bearer={'set' if config.BEARER else 'unset'}"
          f"  poll_interval={config.POLL_INTERVAL}s")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        _poller.stop()
        httpd.shutdown()
