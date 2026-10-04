"""The browser's fixed clock: the instant every editor page's ``Date`` reads.

It is HQ's own epoch, the HQ pin's commit time, so the browser's dates
follow the pins as HQ's do. It is read, in order, from:

1. ``proof.hq.determinism.EPOCH``, HQ's clock at depth 0, when that module
   is present;
2. ``/opt/hq-pin-time``, the pin's commit time the image records
   (``git log -1 --format=%cI``);
3. the HQ checkout's own git history at ``/opt/hq`` (``PROOF_HQ``).

When none can be read it fails, naming each place it looked: a clock that
silently became the machine's would make every transcript key unstable.
"""

from __future__ import annotations

import importlib
import os
import subprocess
from datetime import datetime
from functools import cache
from pathlib import Path

PIN_TIME = Path(os.environ.get("PROOF_HQ_PIN_TIME", "/opt/hq-pin-time"))
HQ_CHECKOUT = Path(os.environ.get("PROOF_HQ", "/opt/hq"))


class EpochUnknown(RuntimeError):
    """None of the places the HQ pin's commit time is kept could be read."""


@cache
def epoch_ms() -> int:
    """The HQ pin's commit time, in milliseconds since 1970."""
    looked = []
    try:
        determinism = importlib.import_module("proof.hq.determinism")
    except ImportError:
        looked.append("proof.hq.determinism is not present")
    else:
        epoch = getattr(determinism, "EPOCH", None)
        if isinstance(epoch, datetime) and epoch.tzinfo is not None:
            return int(epoch.timestamp() * 1000)
        looked.append(f"proof.hq.determinism.EPOCH is {epoch!r}, not an aware datetime")
    if PIN_TIME.is_file():
        return int(datetime.fromisoformat(PIN_TIME.read_text().strip()).timestamp() * 1000)
    looked.append(f"{PIN_TIME} does not exist")
    try:
        text = subprocess.run(
            ["git", "-C", str(HQ_CHECKOUT), "log", "-1", "--format=%cI"],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        ).stdout.strip()
        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        looked.append(f"git could not read {HQ_CHECKOUT}'s commit time ({error})")
    raise EpochUnknown(
        "The browser's clock is the HQ pin's commit time, and it could not be read: " + "; ".join(looked)
    )
