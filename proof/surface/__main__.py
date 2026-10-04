"""``python -m proof.surface --out <path>``: extract the surface and write it to ``<path>``.

It runs inside the proof image, which holds the checkouts at their pins
(``/opt/hq``, ``/opt/core``, ``/opt/android``). It prints what it wrote, its
size and how long each family took on standard error.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from proof.surface.extract import extract


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m proof.surface", description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help="where to write the surface JSON")
    parser.add_argument("--timings", type=Path, help="where to write how long each family took, as JSON")
    arguments = parser.parse_args(argv)
    extraction = extract()
    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    arguments.out.write_text(extraction.text, encoding="utf-8")
    size = len(extraction.text.encode("utf-8"))
    if arguments.timings:
        arguments.timings.parent.mkdir(parents=True, exist_ok=True)
        arguments.timings.write_text(
            json.dumps({"seconds": extraction.seconds, "items": extraction.items, "bytes": size}, indent="\t") + "\n",
            encoding="utf-8",
        )
    print(
        f"Wrote {extraction.items} surface items ({size} bytes) to {arguments.out}.",
        file=sys.stderr,
    )
    print(
        "Seconds: " + ", ".join(f"{name} {value}" for name, value in extraction.seconds.items()),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
