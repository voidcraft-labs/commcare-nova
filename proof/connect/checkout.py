"""commcare-connect at its pin, fetched when a proof runs.

Connect's checkout carries no license file, so the harness image holds none
of its source (``proof/image/Dockerfile``): a proof that runs Connect fetches
exactly the pinned commit (``proof/pins.json``), shallowly, with the image
recipe's own ``fetch-commit.sh``. ``git`` runs as a child process, so HQ's
network guard (which refuses this Python process's sockets) does not stand in
its way; this is the lane's only network reach.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from proof import processes

WORKTREE = Path(__file__).resolve().parents[2]
PINS = WORKTREE / "proof" / "pins.json"
FETCH_COMMIT = WORKTREE / "proof" / "image" / "fetch-commit.sh"
# One shallow fetch of one commit.
CHECKOUT_TIMEOUT_SECONDS = 300


class CheckoutFailed(RuntimeError):
    """An upstream the proofs read at run time could not be fetched at its pin."""


@dataclass(frozen=True)
class Checkout:
    path: Path
    commit: str


def pinned_commit() -> str:
    return json.loads(PINS.read_text())["commcare-connect"]["commit"]


def fetch(directory: Path, log: Path) -> Checkout:
    """Connect at its pin in ``directory`` (which must not exist), the fetch's output in ``log``."""
    pin = json.loads(PINS.read_text())["commcare-connect"]
    command = ["sh", str(FETCH_COMMIT), pin["repository"], pin["commit"], str(directory)]
    try:
        with log.open("wb") as output:
            returncode = processes.run(
                command, timeout=CHECKOUT_TIMEOUT_SECONDS, stdout=output, stderr=subprocess.STDOUT
            )
    except processes.TimedOut:
        raise CheckoutFailed(
            f"Fetching commcare-connect at {pin['commit']} took more than {CHECKOUT_TIMEOUT_SECONDS} s and was "
            f"stopped, with every process it started. The Connect proofs run Connect's code at that pin; "
            f"check the lane's network. The fetch's output is in {log}."
        ) from None
    if returncode != 0:
        raise CheckoutFailed(
            f"The Connect proofs could not fetch commcare-connect at its pin {pin['commit']} from "
            f"{pin['repository']} (fetch-commit.sh exited with status {returncode}). The lane needs "
            f"network for this one fetch; its output ({log}) ends:\n{log.read_text(errors='replace')[-2000:]}"
        )
    return Checkout(directory, pin["commit"])
