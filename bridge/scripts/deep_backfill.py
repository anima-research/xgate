#!/usr/bin/env python3
"""Deep timeline backfill through the bridge's own client + ingest.

Pages a user's timeline back in time, ingesting into the shared cache; every
page's spend lands in api_cost_ledger via XClient. Run ON the bridge host.

  python3 scripts/deep_backfill.py --max-tweets 300 --lean handle1 handle2 ...

COST SAFETY (added after a 20x overspend incident, 2026-08-06):
  --lean         drop referenced_tweets/media expansions. Non-lean pages bill
                 ~175 objects each instead of ~100 — nearly 2x for data the
                 corpus does not use. Default ON; pass --rich to restore.
  --max-pages    hard per-handle page cap (default 4). The old loop counted
                 only primary `data` items toward --max-tweets, so sparse
                 pages paginated 20+ times per handle.
  --budget       abort the whole run if projected or actual ledger spend
                 exceeds this many dollars. Default 50.
Pre-flight projection is printed and must be confirmed with --yes in scripts.
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

POSTS_PER_PAGE_LEAN = 100
POSTS_PER_PAGE_RICH = 175
PRICE_PER_POST = 0.005


def _rfc3339(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def spent(repo: Repo) -> float:
    con = repo._con()
    try:
        row = con.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM api_cost_ledger").fetchone()
        return float(row[0] or 0.0)
    finally:
        con.close()


def backfill(client, repo, handle, max_tweets, years, lean, max_pages):
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
    total, token, pages = 0, None, 0
    while total < max_tweets and pages < max_pages:
        try:
            page, token = client.user_timeline(author_id, start, end, token=token, lean=lean)
        except XApiError as e:
            print(f"  {h}: API error {e.status} after {total} tweets")
            break
        pages += 1
        con = connect(repo.db_path)
        try:
            ingest_page(con, page, source="deep_backfill")
        finally:
            con.close()
        n_page = len(page.get("data", []) or [])
        total += n_page
        if not token or n_page == 0:
            break
    print(f"  {h}: {total} tweets in {pages} page(s)")
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("handles", nargs="+")
    ap.add_argument("--max-tweets", type=int, default=300)
    ap.add_argument("--max-pages", type=int, default=4)
    ap.add_argument("--years", type=float, default=6.0)
    ap.add_argument("--rich", action="store_true", help="restore costly expansions")
    ap.add_argument("--budget", type=float, default=50.0, help="ledger $ ceiling for this run")
    ap.add_argument("--yes", action="store_true", help="skip interactive confirmation")
    args = ap.parse_args()

    if not (config.ALLOW_FETCH and config.BEARER):
        sys.exit("fetching disabled: need X_BRIDGE_ALLOW_FETCH=1 and a bearer")
    lean = not args.rich
    per_page = POSTS_PER_PAGE_RICH if args.rich else POSTS_PER_PAGE_LEAN
    pages = min(args.max_pages, max(1, -(-args.max_tweets // 100)))
    projected = len(args.handles) * pages * per_page * PRICE_PER_POST
    print(f"PRE-FLIGHT: {len(args.handles)} handles x up to {pages} page(s) x ~{per_page} "
          f"billable objects = ~${projected:,.2f} ledger (~${projected * 0.65:,.2f} real est.)")
    print(f"mode: {'LEAN' if lean else 'RICH'}  budget ceiling: ${args.budget:,.2f}")
    if projected > args.budget:
        sys.exit(f"ABORT: projection ${projected:,.2f} exceeds --budget ${args.budget:,.2f}")
    if not args.yes:
        if input("proceed? [y/N] ").strip().lower() != "y":
            sys.exit("aborted")

    repo = Repo()
    client = XClient(config.BEARER, repo)
    baseline = spent(repo)
    grand = 0
    for i, h in enumerate(args.handles):
        used = spent(repo) - baseline
        if used > args.budget:
            print(f"STOP: run spend ${used:,.2f} exceeded budget after {i} handles")
            break
        grand += backfill(client, repo, h, args.max_tweets, args.years, lean, args.max_pages)
    used = spent(repo) - baseline
    print(f"total: {grand} tweets | ledger spend this run: ${used:,.2f} "
          f"(${used / max(1, len(args.handles)):.2f}/handle)")


if __name__ == "__main__":
    main()
