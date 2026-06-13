#!/usr/bin/env python3
"""Seed x-cache.db from the archivist corpus and apply the additive schema.

Copies SEED_DB -> CACHE_DB (never writes to the source) and runs schema.sql.
Idempotent: re-running re-applies the schema; pass --reseed to recopy the
corpus (overwrites the cache, discarding any read-through writes/freshness).

Usage:
  python3 scripts/init_cache_db.py            # copy seed if cache absent, apply schema
  python3 scripts/init_cache_db.py --reseed   # force recopy from seed
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bridge import config  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reseed", action="store_true", help="overwrite cache with a fresh copy of seed")
    args = ap.parse_args()

    cache, seed = config.CACHE_DB, config.SEED_DB
    if not seed.exists():
        sys.exit(f"seed DB not found: {seed}")

    if args.reseed or not cache.exists():
        # checkpoint any WAL on the seed first so the copy is complete.
        src = sqlite3.connect(str(seed))
        src.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        src.close()
        print(f"copying {seed} -> {cache}")
        shutil.copy2(str(seed), str(cache))
    else:
        print(f"cache exists, keeping it: {cache} (use --reseed to overwrite)")

    print(f"applying {config.SCHEMA_SQL}")
    con = sqlite3.connect(str(cache))
    con.executescript(config.SCHEMA_SQL.read_text())
    con.commit()
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    n = con.execute("SELECT COUNT(*) FROM tweets").fetchone()[0]
    con.close()
    print(f"done. {n} tweets cached. tables: {', '.join(tables)}")


if __name__ == "__main__":
    main()
