"""Search filters (author/since/until/tier) + timeline ranges. Self-contained.
    python3 tests/test_search_filters.py
"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge.db import Repo  # noqa: E402


def _fixture() -> str:
    p = str(Path(tempfile.mkdtemp()) / "f.db")
    con = sqlite3.connect(p)
    con.executescript(
        """
        CREATE TABLE tweets (tweet_id TEXT PRIMARY KEY, author_id TEXT, author_username TEXT,
          full_text TEXT, created_at TEXT, reply_to_tweet_id TEXT, reply_to_username TEXT,
          conversation_id TEXT, retweet_count INTEGER, favorite_count INTEGER, source TEXT,
          quoted_tweet_id TEXT, reply_to_user_id TEXT, tier TEXT);
        CREATE VIRTUAL TABLE tweets_fts USING fts5(tweet_id UNINDEXED, full_text);
        CREATE TABLE media (media_id TEXT, tweet_id TEXT, media_url TEXT, media_type TEXT,
          width INTEGER, height INTEGER, transcription TEXT, source TEXT, alt_text TEXT);
        CREATE VIRTUAL TABLE media_fts USING fts5(media_id UNINDEXED, tweet_id UNINDEXED, transcription, alt_text);
        CREATE TABLE tweet_urls (id INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT, url TEXT, expanded_url TEXT);
        """
    )
    rows = [
        ("1", "r", "repligate", "alpha beta", "2024-01-15T00:00:00Z", "spine"),
        ("2", "r", "repligate", "gamma delta", "2024-06-15T00:00:00Z", "cast"),
        ("3", "a", "alice", "alpha epsilon", "2024-06-20T00:00:00Z", "spine"),
        ("4", "r", "repligate", "zeta alpha", "2025-01-10T00:00:00Z", "cast"),
    ]
    for tid, aid, u, txt, ts, tier in rows:
        con.execute("INSERT INTO tweets (tweet_id,author_id,author_username,full_text,created_at,"
                    "retweet_count,favorite_count,source,tier) VALUES (?,?,?,?,?,0,0,'test',?)",
                    (tid, aid, u, txt, ts, tier))
        con.execute("INSERT INTO tweets_fts(tweet_id,full_text) VALUES (?,?)", (tid, txt))
    con.commit(); con.close()
    return p


R = Repo(_fixture())
ids = lambda rows: sorted(t["tweet_id"] for t in rows)


def test_fts_plain():
    assert ids(R.search("alpha")) == ["1", "3", "4"]


def test_fts_plus_author():
    assert ids(R.search("alpha", author="repligate")) == ["1", "4"]


def test_fts_plus_tier():
    assert ids(R.search("alpha", tier="spine")) == ["1", "3"]


def test_filter_only_range_no_query():
    # repligate in [2024-06-01, 2025-01-01): only tweet 2
    assert ids(R.search(author="repligate", since="2024-06-01", until="2025-01-01")) == ["2"]


def test_tier_only():
    assert ids(R.search(tier="spine")) == ["1", "3"]


def test_timeline_range():
    got = R.get_timeline("repligate", since="2024-06-01", before="2025-06-01")
    assert [t["tweet_id"] for t in got] == ["4", "2"], "newest-first within range"


def test_timeline_since_only():
    assert ids(R.get_timeline("repligate", since="2024-06-01")) == ["2", "4"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn(); print(f"  ok   {fn.__name__}")
        except AssertionError as e:
            failed += 1; print(f"  FAIL {fn.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1; print(f"  ERR  {fn.__name__}: {e}")
    print(f"\n{len(fns)-failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
