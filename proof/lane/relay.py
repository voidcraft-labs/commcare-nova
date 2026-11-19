"""``python -m proof.lane.relay --requests DIR --answers DIR (claim BLOCK | wait)``: a lane command run on the host.

A CI shard's claim and wait commands (``proof/ci/claim.mjs``,
``proof/ci/wait.mjs``) use the job's artifact-service credentials, and this
container runs HQ and every other upstream at its pins, so the commands run
on the host (``proof/ci/hostCommands.mjs``) and the lane's server runs this
relay in their place (``proof.lane.serve``'s ``--claim`` and ``--wait-for``).
The relay names its request as an empty file in the requests directory
(``claim-<block>.request`` or ``wait.request``, moved into place whole) and
waits for the host's answer in the answers directory: ``<name>.log``, the
command's output, which it prints, and ``<name>.code``, its exit status, with
which it exits. The server reads that status as it read the command's own:
for a claim 0 claimed and 1 taken, for the wait 0 in place and 3 the corpus
emission failed; anything else is a failure, and the host answers a request
it will not run with 2.

Standard library only; it waits with ``time.sleep``, a C-level wait.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

BLOCK = re.compile(r"[0-9a-f]{64}")
POLL_SECONDS = 0.2
REFUSED = 2


def request(requests: Path, name: str) -> None:
    """The request ``name`` made, as an empty file moved into place whole."""
    staged = requests / f".{name}.{os.getpid()}"
    staged.write_bytes(b"")
    os.replace(staged, requests / f"{name}.request")


def answered(answers: Path, name: str) -> int | None:
    """The host's exit status for ``name``, or None while it has not answered."""
    try:
        text = (answers / f"{name}.code").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    return int(text) if re.fullmatch(r"-?[0-9]{1,3}", text) else REFUSED


def relay(requests: Path, answers: Path, name: str, *, poll: float = POLL_SECONDS) -> int:
    """Ask the host to run ``name`` and wait for its answer; the command's output printed, its status returned."""
    request(requests, name)
    while (code := answered(answers, name)) is None:
        time.sleep(poll)
    try:
        sys.stdout.write((answers / f"{name}.log").read_text(encoding="utf-8", errors="replace"))
    except FileNotFoundError:
        sys.stdout.write(f"The host answered {name} without its output.\n")
    sys.stdout.flush()
    return code


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m proof.lane.relay", description=__doc__.splitlines()[0])
    parser.add_argument("--requests", type=Path, required=True)
    parser.add_argument("--answers", type=Path, required=True)
    parser.add_argument("kind", choices=("claim", "wait"))
    parser.add_argument("block", nargs="?")
    arguments = parser.parse_args(argv)
    if arguments.kind == "claim":
        if arguments.block is None or not BLOCK.fullmatch(arguments.block):
            print(f"A claim names its block's id, a sha256 in hex; got {arguments.block!r}.", file=sys.stderr)
            return REFUSED
        name = f"claim-{arguments.block}"
    else:
        if arguments.block is not None:
            print(f"The wait names no block; got {arguments.block!r}.", file=sys.stderr)
            return REFUSED
        name = "wait"
    return relay(arguments.requests, arguments.answers, name)


if __name__ == "__main__":
    sys.exit(main())
