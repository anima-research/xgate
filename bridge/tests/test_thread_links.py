"""A thread is found from any of its tweets, over reply links as well as X's
conversation id (which archive-imported rows lack), and a reply names the
author it answers when its parent is cached. No network.

    python3 tests/test_thread_links.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge.db import THREAD_CAP, Repo, connect  # noqa: E402

repo = Repo()
P = "9911000000000000"  # probe id prefix
R, A, B, C, D, E, Z = (P + s for s in ("01", "02", "03", "04", "05", "06", "09"))
MISSING, Q, F, G = (P + s for s in ("10", "20", "21", "22"))
BIG = "9922000000000000"  # the big thread's root; its replies are BIG + 1 ...

#   R ─ A ─ B          archive rows: no conversation id
#   └─ C               an API row: conversation id = R
#   (MISSING) ─ D ─ E  D's parent is not cached; D carries the conversation id, E doesn't
#   Z                  unrelated
#   (Q) ─ F ─ G        a conversation whose root is not cached
ROWS = [
    (R, "root_author", None, None, "2026-01-01T00:00:00Z"),
    (A, "alice", R, None, "2026-01-01T00:01:00Z"),
    (B, "bob", A, None, "2026-01-01T00:02:00Z"),
    (C, "carol", R, R, "2026-01-01T00:03:00Z"),
    (D, "dave", MISSING, R, "2026-01-01T00:04:00Z"),
    (E, "erin", D, None, "2026-01-01T00:05:00Z"),
    (Z, "zed", None, None, "2026-01-01T00:06:00Z"),
    (F, "fay", Q, Q, "2026-01-02T00:00:00Z"),
    (G, "gus", F, Q, "2026-01-02T00:01:00Z"),
]


def _insert(con, rows) -> None:
    con.executemany(
        "INSERT OR REPLACE INTO tweets (tweet_id, author_username, full_text, reply_to_tweet_id, "
        "conversation_id, created_at, source) VALUES (?, ?, 'thread link probe', ?, ?, ?, 'test')",
        [(tid, who, parent, conv, at) for tid, who, parent, conv, at in rows])
    con.commit()


def _cleanup() -> None:
    con = connect()
    con.execute("DELETE FROM tweets WHERE tweet_id LIKE ? OR tweet_id LIKE ?", (P + "%", BIG[:8] + "%"))
    con.commit()
    con.close()


def _ids(tweet_id: str) -> set[str]:
    return {t["tweet_id"] for t in repo.get_thread(tweet_id)["tweets"]}


def test_thread_from_any_member():
    con = connect()
    _insert(con, ROWS)
    con.close()
    whole = {R, A, B, C, D, E}
    for start in (R, A, B, C, D, E):
        assert _ids(start) == whole, f"from {start[-2:]}: {sorted(i[-2:] for i in _ids(start))}"
    assert repo.get_thread(B)["count"] == 6
    assert [t["tweet_id"] for t in repo.get_thread(B)["tweets"]] == [R, A, B, C, D, E], "oldest first"


def test_conversation_without_its_root():
    assert _ids(Q) == {F, G}
    assert _ids(G) == {F, G}


def test_unknown_id_is_empty():
    assert repo.get_thread(P + "99") == {"count": 0, "tweets": []}


def test_reply_names_the_author_it_answers():
    by_id = {t["tweet_id"]: t for t in repo.get_thread(R)["tweets"]}
    assert by_id[C]["reply_to_username"] == "root_author"
    assert by_id[B]["reply_to_username"] == "alice"
    assert by_id[D]["reply_to_username"] is None, "its parent is not cached"
    assert repo.get_tweet(E)["reply_to_username"] == "dave"


def test_stats_cover_the_same_thread():
    s = repo.thread_stats(E)
    assert s["count"] == 6
    assert s["root_author"] == "root_author"
    assert {p["handle"] for p in s["participants"]} == {"root_author", "alice", "bob", "carol", "dave", "erin"}


def test_a_big_thread_keeps_the_tweet_asked_for():
    n = THREAD_CAP + 40
    rows = [(BIG, "big_root", None, None, "2026-02-01T00:00:00Z")]
    rows += [(str(int(BIG) + i), "replier", BIG, None, f"2026-02-01T{i // 60:02d}:{i % 60:02d}:01Z") for i in range(1, n)]
    late, child = rows[-1][0], str(int(BIG) + n)
    rows.append((child, "replier", late, None, "2026-02-02T00:00:00Z"))
    con = connect()
    _insert(con, rows)
    con.close()
    t = repo.get_thread(late)
    got = {x["tweet_id"] for x in t["tweets"]}
    assert t["count"] == n + 1
    assert len(got) == THREAD_CAP
    assert {BIG, late, child} <= got, "the ancestors and replies of the tweet asked for come first"


if __name__ == "__main__":
    _cleanup()
    try:
        fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
        # Definition order: the first test inserts what the others read.
        fns.sort(key=lambda f: f.__code__.co_firstlineno)
        for fn in fns:
            fn()
            print(f"ok  {fn.__name__}")
        print(f"\n{len(fns)} passed")
    finally:
        _cleanup()
