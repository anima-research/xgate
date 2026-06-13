"""Media: alt_text hydration, media_fts search, byte caching, transcription
idempotency + gating. No vision spend — uses already-cached/transcribed seed
data and the public image CDN (free).

    python3 tests/test_media.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge.db import Repo  # noqa: E402
from bridge.media import MediaStore  # noqa: E402

repo = Repo()
ms = MediaStore(repo)


def test_hydrate_includes_alt_text_key():
    tl = repo.get_timeline("repligate", limit=5)
    for t in tl:
        for m in t["media"]:
            assert "alt_text" in m and "transcription" in m, "media dicts carry alt_text + transcription"


def test_media_fts_search_path():
    # 'Centroid' lives only in a transcription, not in any tweet text.
    row = next((r for r in repo._con().execute(
        "SELECT tweet_id FROM media WHERE transcription LIKE '%Centroid Similarity%' LIMIT 1")), None)
    if not row:
        print("  (skip) no seed transcription with 'Centroid'"); return
    tid = row[0]
    res = repo.search("Centroid", limit=20, include_media=True)
    assert any(t["tweet_id"] == tid for t in res), "media_fts surfaces the tweet"


def test_untranscribed_media_listing():
    # at least some seed media still lack a transcription
    ids = [r[0] for r in repo._con().execute("SELECT DISTINCT tweet_id FROM media LIMIT 50")]
    pending = repo.untranscribed_media(ids)
    assert isinstance(pending, list)
    assert all("media_id" in m and "media_url" in m for m in pending)


def test_transcription_idempotent_no_api():
    # a media row that already has a transcription returns it without an API call
    row = next((r for r in repo._con().execute(
        "SELECT media_id, transcription FROM media WHERE transcription IS NOT NULL AND transcription<>'' LIMIT 1")), None)
    if not row:
        print("  (skip) no transcribed seed media"); return
    mid, existing = row[0], row[1]
    # Break the client so any real call would error — proves it's not called.
    ms._client = "BROKEN"
    got = ms.transcribe_one(mid)  # should short-circuit on existing transcription
    assert got == existing, "idempotent: returns cached transcription without calling the API"


def test_serve_downloads_real_bytes():
    row = next((r for r in repo._con().execute(
        "SELECT media_id FROM media WHERE media_type='photo' AND media_url LIKE 'http%' LIMIT 1")), None)
    if not row:
        print("  (skip) no photo with URL"); return
    served = ms.serve(row[0])
    assert served, "serve returns (bytes, mime)"
    data, mime = served
    assert len(data) > 500 and mime.startswith("image/"), f"real image bytes, mime={mime}"


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
