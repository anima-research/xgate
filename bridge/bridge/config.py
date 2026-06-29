"""Configuration — paths, TTLs, and money-safety flags, all env-overridable."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no dependency). Does not override real env vars."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip("'").strip('"')
        os.environ.setdefault(k, v)


_load_dotenv(REPO_ROOT / ".env")

# Cache DB. Defaults to a copy living beside the repo — NOT the source
# archive.db, which we never write to. Seed it with scripts/init_cache_db.py.
CACHE_DB = Path(os.environ.get("X_BRIDGE_DB", str(REPO_ROOT / "x-cache.db")))

# Source corpus used by the init script to seed the cache.
SEED_DB = Path(os.environ.get("X_BRIDGE_SEED_DB", "/Users/antra/archivist/archive.db"))

SCHEMA_SQL = REPO_ROOT / "schema.sql"

# --- Freshness tiers (seconds) ---
METRICS_TTL = int(os.environ.get("X_BRIDGE_METRICS_TTL", str(6 * 3600)))
COLLECTION_TTL = int(os.environ.get("X_BRIDGE_COLLECTION_TTL", str(15 * 60)))
NEGATIVE_TTL = int(os.environ.get("X_BRIDGE_NEGATIVE_TTL", str(24 * 3600)))

# Poller cadence (seconds). The background poller refreshes each subscribed
# resource at most this often; on-demand polls (SSE ?poll=force) bypass it.
POLL_INTERVAL = float(os.environ.get("X_BRIDGE_POLL_INTERVAL", "60"))

# --- Money safety ---
# The bridge only spends on the X API when ALLOW_FETCH is truthy AND a bearer is
# present. Default OFF: a cache miss costs nothing.
ALLOW_FETCH = os.environ.get("X_BRIDGE_ALLOW_FETCH", "").lower() in ("1", "true", "yes")
BEARER = os.environ.get("X_BRIDGE_BEARER") or os.environ.get("BEARER")

# --- Server ---
HOST = os.environ.get("X_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("X_BRIDGE_PORT", "8810"))

# Gate token. When set, every endpoint requires `Authorization: Bearer <token>`
# EXCEPT GET /health (liveness) and GET /media/:id raw bytes (already-public
# tweet images). Lets the bridge sit safely behind a public HTTPS vhost without
# exposing the money/data endpoints. Unset = open (localhost-only deployments).
GATE_TOKEN = os.environ.get("X_BRIDGE_TOKEN")

# X API v2 per-resource pricing (confirmed 2026-04), from twitter_backfill.py.
PRICE = {"post": 0.005, "user": 0.010, "media": 0.005}
API_BASE = "https://api.twitter.com/2"

# --- Media ---
# Cached image/video bytes live here (lazy-downloaded on first /media request).
MEDIA_DIR = Path(os.environ.get("X_BRIDGE_MEDIA_DIR", str(REPO_ROOT / "media-cache")))

# On-demand image transcription (vision). Gated on an Anthropic credential —
# absent one, /media/:id/transcription degrades to a 503, like fetch-disabled.
TRANSCRIBE_MODEL = os.environ.get("X_BRIDGE_TRANSCRIBE_MODEL", "claude-haiku-4-5")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
TRANSCRIBE_ENABLED = bool(ANTHROPIC_KEY)
# Bounded concurrency for batch transcription — when a bot reads a whole thread,
# all its untranscribed images are transcribed in parallel up to this many at once.
TRANSCRIBE_PARALLEL = int(os.environ.get("X_BRIDGE_TRANSCRIBE_PARALLEL", "5"))

# --- Multi-token access ---
# The owner token (GATE_TOKEN, above) has full access — including live X fetch and
# transcription, subject to ALLOW_FETCH. Additional per-consumer tokens live in a
# JSON file so they can be added/revoked without code changes (hot-reloaded on
# mtime change). Shape: [{"token": "...", "label": "alice-bot", "allow_fetch": false}]
# `allow_fetch` defaults to FALSE → cache-only: the consumer reads the existing
# cache but cannot trigger any new X API or transcription spend.
TOKENS_FILE = Path(os.environ.get("X_BRIDGE_TOKENS_FILE", str(REPO_ROOT / "tokens.json")))


class TokenInfo:
    """A resolved caller identity + its spend policy."""
    __slots__ = ("label", "allow_fetch")

    def __init__(self, label: str, allow_fetch: bool):
        self.label = label
        self.allow_fetch = allow_fetch


class _TokenRegistry:
    """Owner token (env) + per-consumer tokens (JSON file, hot-reloaded)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._file_tokens: dict[str, TokenInfo] = {}
        self._mtime: float | None = None

    def _reload_if_changed(self) -> None:
        try:
            mtime = TOKENS_FILE.stat().st_mtime
        except OSError:
            if self._file_tokens:
                self._file_tokens = {}
            self._mtime = None
            return
        if mtime == self._mtime:
            return
        try:
            raw = json.loads(TOKENS_FILE.read_text())
        except (OSError, ValueError):
            return  # keep the previous good set on a read/parse error
        entries = raw if isinstance(raw, list) else raw.get("tokens", [])
        toks: dict[str, TokenInfo] = {}
        for e in entries:
            if not isinstance(e, dict):
                continue
            tok = (e.get("token") or "").strip()
            if not tok:
                continue
            toks[tok] = TokenInfo(e.get("label") or "unnamed", bool(e.get("allow_fetch", False)))
        self._file_tokens = toks
        self._mtime = mtime

    def resolve(self, bearer: str) -> TokenInfo | None:
        """Map a bearer value to its TokenInfo, or None if it is not valid."""
        if GATE_TOKEN and bearer == GATE_TOKEN:
            return TokenInfo("owner", True)
        with self._lock:
            self._reload_if_changed()
            return self._file_tokens.get(bearer)

    def any_configured(self) -> bool:
        with self._lock:
            self._reload_if_changed()
            return bool(GATE_TOKEN) or bool(self._file_tokens)

    def count(self) -> int:
        """Number of per-consumer (file) tokens — excludes the owner token."""
        with self._lock:
            self._reload_if_changed()
            return len(self._file_tokens)


TOKENS = _TokenRegistry()

# --- Per-request context (thread-local) ---
# ThreadingHTTPServer runs each request in its own thread. The handler stamps the
# caller's spend permission + label here so the cache, transcription, and cost
# layers can honor them without threading params through every call. Background
# threads (the poller) never set it → they default to full (owner) behavior.
_request_ctx = threading.local()


def set_request_context(allow_spend: bool, actor: str) -> None:
    _request_ctx.allow_spend = allow_spend
    _request_ctx.actor = actor


def clear_request_context() -> None:
    _request_ctx.allow_spend = True
    _request_ctx.actor = "system"


def request_allows_spend() -> bool:
    """True if the current caller may incur API spend (X fetch / transcription).
    Defaults True for non-request threads (poller, startup)."""
    return getattr(_request_ctx, "allow_spend", True)


def request_actor() -> str:
    return getattr(_request_ctx, "actor", "system")
