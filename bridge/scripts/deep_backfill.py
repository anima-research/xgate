#!/usr/bin/env python3
"""Deep timeline backfill through the bridge's own client + ingest.

Pages a user's timeline back in time (API max ~3200) up to --max-tweets,
ingesting into the shared cache; every page's spend lands in api_cost_ledger
via XClient. Run ON the bridge host with the bridge env loaded.

  python3 scripts/deep_backfill.py --max-tweets 1000 handle1 handle2 ...

Idempotent: already-cached tweets are upserted, not duplicated.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge import config  # noqa: E402
from bridge.db import Repo, connect  # noqa: E402
from bridge.ingest import ingest_page  # noqa: E402
from bridge.xapi import XApiError, XClient  # noqa: E402


def _rfc3339(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def backfill(client: XClient, repo: Repo, handle: str, max_tweets: int, years: float) -> int:
    h = handle.lstrip("@").lower()
    author_id = repo.resolve_handle(h)
    if not author_id:
        try:
            profile = client.user_by_username(h)
        except XApiError as e:
            print(f"  {h}: profile lookup failed ({e.status})")
            return 0
        if not profile:
            print(f"  {h}: no such user")
            return 0
        repo.upsert_user(profile)
        author_id = profile.get("id")
    start = _rfc3339(datetime.now(timezone.utc) - timedelta(days=int(years * 365)))
    end = _rfc3339(datetime.now(timezone.utc) - timedelta(seconds=30))
    total, token = 0, None
    while total < max_tweets:
        try:
            page, token = client.user_timeline(author_id, start, end, token=token)
        except XApiError as e:
            print(f"  {h}: API error {e.status} after {total} tweets")
            break
        con = connect(repo.db_path)
        try:
            new_ids = ingest_page(con, page, source="deep_backfill")
        finally:
            con.close()
        n_page = len(page.get("data", []) or [])
        total += n_page
        if not token or n_page == 0:
            break
    print(f"  {h}: {total} tweets ingested")
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("handles", nargs="+")
    ap.add_argument("--max-tweets", type=int, default=1000)
    ap.add_argument("--years", type=float, default=6.0, help="how far back start_time reaches")
    args = ap.parse_args()

    if not (config.ALLOW_FETCH and config.BEARER):
        sys.exit("fetching disabled: need X_BRIDGE_ALLOW_FETCH=1 and a bearer")
    repo = Repo()
    client = XClient(config.BEARER, repo)
    grand = 0
    for h in args.handles:
        grand += backfill(client, repo, h, args.max_tweets, args.years)
    print(f"total: {grand} tweets")


if __name__ == "__main__":
    main()
