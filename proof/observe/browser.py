"""The browser's code as a part's key names it: the editor driver's files, fingerprinted.

The editor driver (``proof/editors/driver``) is what node and Chromium run:
HQ's editor pages for proof 4's saves, and HQ's Web Apps client for a served
state's screens. It is fingerprinted apart from the observation partition
(``proof.observe.partition.OBSERVATION_EXCLUDED``), and each observation that
drives a browser declares this fingerprint among what it reads
(``proof.observe.proof4.inputs``, ``proof.observe.served.inputs``), so the
parts it joins are observed again when the driver changes and no other is.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from proof.observe.record import canonical

WORKTREE = Path(__file__).resolve().parents[2]
BROWSER_PARTITION = "proof/editors/driver"


def browser_fingerprint(root=WORKTREE):
    """The sha256 of the editor driver's files (``proof/editors/driver/**``): each path and its bytes' digest."""
    base = Path(root, BROWSER_PARTITION)
    entries = [
        [path.relative_to(root).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()]
        for path in sorted(base.rglob("*"))
        if path.is_file() and "__pycache__" not in path.parts
    ]
    return "sha256:" + hashlib.sha256(canonical(entries)).hexdigest()
