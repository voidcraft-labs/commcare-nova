"""The Android reader's own checks import nothing beyond the standard library.

Contract (``.github/actions/proof-android-runtime``, "The reader's own
checks"): ``proof.android.selfcheck`` and ``proof.android.predicates`` run
where the reader's runtime is built or restored, on the runner's own
``python3`` with no image, so they, and the judge ``selfcheck`` imports when
its test runs (``proof.checks.android``), import nothing beyond the standard
library and the proof's own standard-library modules. The plausible failure:
a module the judge imports reaching lxml or HQ (``proof.checks.hq_own_reports``
once imported lxml for the Connect judge's reading of forms), which passes
every test of the image and fails the runtime's job, and with it every lane
with the readers, before any shard starts. The refusal is paired with what
the same interpreter refuses: it cannot import lxml, so a module that did
would fail here too.

The test runs the imports in a child interpreter started with ``-S -I`` (no
site-packages, no environment) and a ``sys.path`` of the worktree and the
standard library alone, as ``proof/lane/test_gate.py`` runs the gate.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[2]

# Runs in the child: imports the reader's own checks and the judge, and reports what was imported.
CHILD = """
import json, sys, sysconfig
sys.path[:] = [{worktree!r}] + [path for path in sys.path if path.startswith(sysconfig.get_paths()["stdlib"])]
import proof.android.predicates
import proof.android.selfcheck
import proof.checks.android
standard = sysconfig.get_paths()["stdlib"]
outside = sorted(
    name for name, module in sys.modules.items()
    if getattr(module, "__file__", None)
    and not module.__file__.startswith(standard)
    and not module.__file__.startswith({proof!r})
)
try:
    import lxml
    refused = False
except ModuleNotFoundError:
    refused = True
flags = [sys.flags.no_site, sys.flags.isolated]
print(json.dumps({{"outside": outside, "lxml_refused": refused, "flags": flags}}))
"""


def test_the_android_readers_own_checks_import_only_the_standard_library(tmp_path):
    program = CHILD.format(worktree=str(WORKTREE), proof=str(WORKTREE / "proof") + "/")
    completed = subprocess.run(
        [sys.executable, "-S", "-I", "-c", program],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert completed.returncode == 0, (
        "The Android reader's own checks did not import on a Python with nothing but its standard library, as"
        f" the runtime's job runs them:\n{completed.stderr[-4000:]}"
    )
    report = json.loads(completed.stdout.strip().splitlines()[-1])
    assert report["flags"] == [1, 1]
    assert report["lxml_refused"], "The child interpreter imported lxml, so it would not catch a module that does."
    assert report["outside"] == [], f"The Android reader's own checks imported beyond the standard library: {report}"
