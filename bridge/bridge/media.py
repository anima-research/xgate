"""Media subsystem: lazy byte caching + on-demand, bounded-parallel transcription.

- Bytes: downloaded from the X CDN on first request, cached under MEDIA_DIR so
  URL rot doesn't lose the image and repeat reads are free. The bridge serves
  them from /media/:id (stable URL a bot/host can fetch).
- Transcription: Haiku 4.5 (configurable), with thread context, idempotent
  (skip if already transcribed). Batch transcription runs up to
  TRANSCRIBE_PARALLEL images at once — a bot reading a whole thread gets every
  image transcribed concurrently in the one tool call. Gated on an Anthropic
  credential; absent one, transcription is a no-op.
"""

from __future__ import annotations

import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from . import config
from .db import Repo

_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}
_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
         ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4"}

# Compact form of the archivist's image_transcribe_twitter.md prompt.
TRANSCRIBE_PROMPT = """You are transcribing an image from a Twitter/X thread. Output a faithful, literal transcription — no interpretation.

- SCREENSHOT OF TEXT (chat, terminal, code, paper, web page): transcribe the visible text verbatim, preserving structure. One short line naming the UI, then the content. Keep code as code.
- PLOT / CHART / FIGURE: describe only structure — plot type, axis labels (+units if legible), what the variables are, colors/legend, reference lines/annotations, panel count, title. Do NOT describe what the data shows (no trends, correlations, which is higher/lower).
- PHOTO / MEME / DIAGRAM / OTHER: one or two plain sentences of what it depicts.

Use the thread context only to disambiguate; do not add facts not visible in the image."""


def _media_mime(media_type: Optional[str], path: Path) -> str:
    return _MIME.get(path.suffix.lower(), "image/jpeg" if media_type == "photo" else "application/octet-stream")


class MediaStore:
    def __init__(self, repo: Optional[Repo] = None):
        self.repo = repo or Repo()
        config.MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        self._client = None

    # ----- bytes -----

    def _path_for(self, media_id: str, url: str) -> Path:
        ext = Path(url.split("?")[0]).suffix.lower() or ".bin"
        return config.MEDIA_DIR / f"{media_id}{ext}"

    def ensure_bytes(self, media_id: str) -> Optional[Path]:
        """Return a local path to the cached bytes, downloading on first use."""
        m = self.repo.get_media(media_id)
        if not m or not m.get("media_url"):
            return None
        path = self._path_for(media_id, m["media_url"])
        if path.exists() and path.stat().st_size > 0:
            return path
        req = urllib.request.Request(m["media_url"], headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
        except Exception:
            return None
        path.write_bytes(data)
        return path

    def serve(self, media_id: str) -> Optional[tuple[bytes, str]]:
        """Return (bytes, mime) for a media id, or None."""
        path = self.ensure_bytes(media_id)
        if not path:
            return None
        m = self.repo.get_media(media_id) or {}
        return path.read_bytes(), _media_mime(m.get("media_type"), path)

    # ----- transcription -----

    def _anthropic(self):
        if not config.TRANSCRIBE_ENABLED:
            return None
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic(api_key=config.ANTHROPIC_KEY)
        return self._client

    def transcribe_one(self, media_id: str, force: bool = False) -> Optional[str]:
        """Transcribe a single image (idempotent). Returns the transcription or None."""
        m = self.repo.get_media(media_id)
        if not m:
            return None
        if m.get("transcription") and not force:
            return m["transcription"]
        if m.get("media_type") not in (None, "photo", "animated_gif"):
            return None  # only still images; video frames out of scope
        client = self._anthropic()
        if client is None:
            return None
        path = self.ensure_bytes(media_id)
        if not path:
            return None
        import base64
        b64 = base64.standard_b64encode(path.read_bytes()).decode("ascii")
        mime = _media_mime(m.get("media_type"), path)
        if mime not in _EXT and mime not in _EXT.values():
            mime = "image/jpeg"
        ctx = self.repo.thread_context(m["tweet_id"], n=3)
        user_blocks = [
            {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}},
        ]
        if ctx:
            user_blocks.append({"type": "text", "text": f"Thread context:\n{ctx}"})
        user_blocks.append({"type": "text", "text": "Transcribe the image above."})
        try:
            resp = client.messages.create(
                model=config.TRANSCRIBE_MODEL,
                max_tokens=1500,
                system=TRANSCRIBE_PROMPT,
                messages=[{"role": "user", "content": user_blocks}],
            )
            text = "".join(b.text for b in resp.content if b.type == "text").strip()
        except Exception:
            return None
        if text:
            self.repo.set_transcription(media_id, text)
        return text or None

    def transcribe_many(self, media_ids: list[str], force: bool = False) -> dict[str, Optional[str]]:
        """Transcribe a batch concurrently, bounded by TRANSCRIBE_PARALLEL.

        A bot reading a whole thread gets every image transcribed in parallel
        within the single tool call, rather than serially.
        """
        ids = list(dict.fromkeys(media_ids))  # dedupe, preserve order
        if not ids:
            return {}
        workers = max(1, min(config.TRANSCRIBE_PARALLEL, len(ids)))
        out: dict[str, Optional[str]] = {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(self.transcribe_one, mid, force): mid for mid in ids}
            for fut in futs:
                mid = futs[fut]
                try:
                    out[mid] = fut.result()
                except Exception:
                    out[mid] = None
        return out

    def transcribe_for_tweets(self, tweet_ids: list[str]) -> int:
        """Transcribe all untranscribed images across these tweets (parallel).
        Returns the count newly transcribed."""
        pending = self.repo.untranscribed_media(tweet_ids)
        if not pending:
            return 0
        results = self.transcribe_many([m["media_id"] for m in pending])
        return sum(1 for v in results.values() if v)
