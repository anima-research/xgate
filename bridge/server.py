"""HTTP server for the bridge — stdlib only, threaded.

Implements the Phase 1 read contract from DESIGN.md. Routes are matched with
small regexes; handlers return (status, json-able body).
"""

from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from . import config
from .cache import Cache
from .db import Repo

_repo = Repo()
_cache = Cache(_repo)

# (method, compiled-pattern, handler-name)
ROUTES = [
    ("GET", re.compile(r"^/health/?$"), "health"),
    ("GET", re.compile(r"^/budget/?$"), "budget"),
    ("GET", re.compile(r"^/tweet/(?P<id>\d+)/?$"), "tweet"),
    ("GET", re.compile(r"^/thread/(?P<cid>\d+)/?$"), "thread"),
    ("GET", re.compile(r"^/user/(?P<handle>[^/]+)/?$"), "user"),
    ("GET", re.compile(r"^/timeline/(?P<who>[^/]+)/?$"), "timeline"),
    ("GET", re.compile(r"^/search/?$"), "search"),
]


def _truthy(qs: dict, key: str) -> bool:
    return qs.get(key, ["0"])[0].lower() in ("1", "true", "yes")


def _int(qs: dict, key: str, default: int) -> int:
    try:
        return int(qs.get(key, [default])[0])
    except (TypeError, ValueError):
        return default


class Handler(BaseHTTPRequestHandler):
    server_version = "x-bridge/0.1"

    # quieter logging
    def log_message(self, fmt, *args):  # noqa: A003
        pass

    def _send(self, status: int, body) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)
        for method, pat, name in ROUTES:
            if method != "GET":
                continue
            m = pat.match(path)
            if m:
                try:
                    status, body = getattr(self, f"h_{name}")(m, qs)
                except Exception as e:  # noqa: BLE001
                    status, body = 500, {"error": str(e)}
                self._send(status, body)
                return
        self._send(404, {"error": "no such route", "path": path})

    # ----- handlers -----

    def h_health(self, m, qs):
        return 200, {
            "ok": True, "version": "0.1.0",
            "db": str(config.CACHE_DB),
            "allow_fetch": config.ALLOW_FETCH,
            "bearer_configured": bool(config.BEARER),
            **_repo.counts(),
        }

    def h_budget(self, m, qs):
        return 200, _repo.budget()

    def h_tweet(self, m, qs):
        t = _cache.get_tweet(m.group("id"), fresh=_truthy(qs, "fresh"))
        if not t:
            return 404, {"cached": False, "tweet_id": m.group("id")}
        return 200, t

    def h_thread(self, m, qs):
        tweets = _repo.get_thread(m.group("cid"))
        return 200, {"conversation_id": m.group("cid"), "count": len(tweets), "tweets": tweets}

    def h_user(self, m, qs):
        u = _repo.get_user(unquote(m.group("handle")))
        if not u:
            return 404, {"cached": False, "handle": unquote(m.group("handle"))}
        return 200, u

    def h_timeline(self, m, qs):
        who = unquote(m.group("who"))
        tweets = _repo.get_timeline(who, limit=_int(qs, "limit", 50),
                                    before=qs.get("before", [None])[0])
        return 200, {"who": who, "count": len(tweets), "tweets": tweets}

    def h_search(self, m, qs):
        q = qs.get("q", [""])[0]
        if not q:
            return 400, {"error": "q (query) is required"}
        tweets = _repo.search(q, limit=_int(qs, "limit", 50))
        return 200, {"query": q, "count": len(tweets), "tweets": tweets}


def serve(host: str = None, port: int = None) -> None:
    host = host or config.HOST
    port = port or config.PORT
    httpd = ThreadingHTTPServer((host, port), Handler)
    counts = _repo.counts()
    print(f"x-bridge listening on http://{host}:{port}")
    print(f"  cache: {config.CACHE_DB}  ({counts['tweets']} tweets, {counts['media']} media)")
    print(f"  allow_fetch={config.ALLOW_FETCH}  bearer={'set' if config.BEARER else 'unset'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        httpd.shutdown()
