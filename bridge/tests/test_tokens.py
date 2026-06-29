"""Multi-token access: registry resolution + per-request spend gating.

Self-contained (no seeded cache needed). Run standalone:
    python3 tests/test_tokens.py
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _fresh_config(owner: str, tokens: list):
    d = tempfile.mkdtemp()
    tf = Path(d) / "tokens.json"
    tf.write_text(json.dumps(tokens))
    os.environ["X_BRIDGE_TOKEN"] = owner
    os.environ["X_BRIDGE_TOKENS_FILE"] = str(tf)
    import bridge.config as config  # noqa: PLC0415
    importlib.reload(config)
    return config, tf


def test_owner_is_full_access():
    config, _ = _fresh_config("OWNER", [])
    info = config.TOKENS.resolve("OWNER")
    assert info is not None and info.label == "owner" and info.allow_fetch is True


def test_consumer_tokens_default_cache_only():
    config, _ = _fresh_config("OWNER", [
        {"token": "A", "label": "alice"},
        {"token": "B", "label": "bob", "allow_fetch": True},
    ])
    a = config.TOKENS.resolve("A")
    b = config.TOKENS.resolve("B")
    assert a.label == "alice" and a.allow_fetch is False, "file tokens default to cache-only"
    assert b.allow_fetch is True
    assert config.TOKENS.resolve("UNKNOWN") is None
    assert config.TOKENS.count() == 2


def test_request_context_gating():
    config, _ = _fresh_config("OWNER", [])
    config.clear_request_context()
    assert config.request_allows_spend() is True  # poller/default = owner behavior
    config.set_request_context(False, "alice")
    assert config.request_allows_spend() is False and config.request_actor() == "alice"
    config.set_request_context(True, "bob")
    assert config.request_allows_spend() is True
    config.clear_request_context()
    assert config.request_allows_spend() is True


def test_hot_reload_on_file_change():
    config, tf = _fresh_config("OWNER", [{"token": "A", "label": "alice"}])
    assert config.TOKENS.resolve("A") is not None
    tf.write_text(json.dumps([{"token": "C", "label": "carol"}]))  # revoke A, add C
    # force a different mtime so the registry reloads
    import time
    os.utime(tf, (time.time() + 1, time.time() + 1))
    assert config.TOKENS.resolve("A") is None, "revoked token rejected after file change"
    assert config.TOKENS.resolve("C") is not None


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
