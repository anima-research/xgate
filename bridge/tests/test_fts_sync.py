"""tweets_fts stays in sync with `tweets` via triggers (no per-ingest rebuild):
insert, UPSERT re-ingest, INSERT OR REPLACE from outside scripts, and delete
are all reflected in search, and FTS5's integrity-check agrees. Re-ingest
must not erase columns the API doesn't carry. No network.

    python3 tests/test_fts_sync.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge.db import Repo, connect  # noqa: E402
from bridge.ingest import ingest_lookup  # noqa: E402

repo = Repo()
repo.migrate()
TID = "990000000000000777"


def _api_result(text: str, username: str = "fts_sync_probe") -> dict:
    return {
        "tweets": {TID: {"id": TID, "author_id": "990000000000000001", "text": text,
                         "created_at": "2026-10-26T00:00:00.000Z", "conversation_id": TID}},
        "users": {"990000000000000001": {"username": username}},
        "media": {},
    }


def _hits(term: str) -> set[str]:
    return {t["tweet_id"] for t in repo.search(term, limit=50, include_media=False)}


def _integrity(con) -> None:
    con.execute("INSERT INTO tweets_fts(tweets_fts, rank) VALUES('integrity-check', 1)")


def _cleanup() -> None:
    con = connect()
    con.execute("DELETE FROM tweets WHERE tweet_id = ?", (TID,))
    con.commit()
    con.close()


def test_insert_is_searchable():
    con = connect()
    ingest_lookup(con, _api_result("zyxwquortle first version"), source="test")
    _integrity(con)
    con.close()
    assert TID in _hits("zyxwquortle")


def test_upsert_reindexes_and_preserves_extra_columns():
    con = connect()
    con.execute("UPDATE tweets SET reply_to_username = 'kept_by_upsert' WHERE tweet_id = ?", (TID,))
    con.commit()
    ingest_lookup(con, _api_result("plimbrastic second version"), source="test")
    _integrity(con)
    row = con.execute("SELECT reply_to_username, full_text FROM tweets WHERE tweet_id = ?", (TID,)).fetchone()
    con.close()
    assert row["reply_to_username"] == "kept_by_upsert", "re-ingest must not wipe non-API columns"
    assert TID in _hits("plimbrastic")
    assert TID not in _hits("zyxwquortle"), "old text must leave the index"


def test_blank_username_does_not_erase_known_one():
    con = connect()
    ingest_lookup(con, _api_result("plimbrastic third", username=""), source="test")
    name = con.execute("SELECT author_username FROM tweets WHERE tweet_id = ?", (TID,)).fetchone()[0]
    con.close()
    assert name == "fts_sync_probe"


def test_insert_or_replace_from_scripts_stays_in_sync():
    con = connect()
    con.execute("INSERT OR REPLACE INTO tweets (tweet_id, author_username, full_text) "
                "VALUES (?, 'fts_sync_probe', 'gronfeldic replaced version')", (TID,))
    con.commit()
    _integrity(con)
    con.close()
    assert TID in _hits("gronfeldic")
    assert TID not in _hits("plimbrastic")


def test_delete_leaves_index():
    _cleanup()
    con = connect()
    _integrity(con)
    con.close()
    assert TID not in _hits("gronfeldic")


if __name__ == "__main__":
    _cleanup()
    tests = [v for k, v in list(globals().items()) if k.startswith("test_")]
    passed = 0
    try:
        for fn in tests:
            try:
                fn()
                print(f"  ok   {fn.__name__}")
                passed += 1
            except Exception as e:  # noqa: BLE001
                print(f"  FAIL {fn.__name__}: {e!r}")
    finally:
        _cleanup()
    print(f"\n{passed}/{len(tests)} passed")
    sys.exit(0 if passed == len(tests) else 1)
