"""CLI entry: python -m bridge [--host H] [--port P]"""

from __future__ import annotations

import argparse

from . import config
from .server import serve


def main() -> None:
    ap = argparse.ArgumentParser(prog="bridge", description="x-bridge daemon")
    ap.add_argument("--host", default=config.HOST)
    ap.add_argument("--port", type=int, default=config.PORT)
    args = ap.parse_args()
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
