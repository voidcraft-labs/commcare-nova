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
standard library alone, as ``proof/lane/test_gate.py`` runs the gate. The child
also calls the judge's function the reader's checks call
(``app_differences``), so an import made inside it is held too, and it imports
``proof.checks.hq_own_reports`` by name, whose docstring makes the same promise.
It is a ``unittest`` case, so the runtime's job runs it on the runner's own
``python3`` beside the checks it guards (``.github/actions/proof-android-runtime``),
and the image's pytest collects it on every pull request.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[2]

# Runs in the child: imports the reader's own checks and the judge, calls the judge as the reader's checks do, and
# reports every module loaded from outside the standard library and the proof.
CHILD = """
import json, os, sys, sysconfig
standard = os.path.join(sysconfig.get_paths()["stdlib"], "")
def is_standard(path):
    return path.startswith(standard) and "site-packages" not in path and "dist-packages" not in path
sys.path[:] = [{worktree!r}] + [path for path in sys.path if is_standard(os.path.join(path, ""))]
import proof.android.predicates
import proof.android.ready
import proof.android.selfcheck
import proof.checks.android as judges
import proof.checks.hq_own_reports
judges.app_differences(
    {{"install": "refused"}}, {{"install": "refused"}}, check="proof3", document="guard", artifact=judges.LOCAL
)
outside = sorted(
    name for name, module in sys.modules.items()
    if getattr(module, "__file__", None)
    and not is_standard(module.__file__)
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


class StandardLibraryOnly(unittest.TestCase):
    def test_the_android_readers_own_checks_import_only_the_standard_library(self):
        program = CHILD.format(worktree=str(WORKTREE), proof=str(WORKTREE / "proof") + "/")
        with tempfile.TemporaryDirectory(prefix="proof-android-stdlib-") as scratch:
            completed = subprocess.run(
                [sys.executable, "-S", "-I", "-c", program],
                cwd=scratch,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
        self.assertEqual(
            completed.returncode,
            0,
            "The Android reader's own checks did not import on a Python with nothing but its standard library, as"
            f" the runtime's job runs them:\n{completed.stderr[-4000:]}",
        )
        report = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(report["flags"], [1, 1])
        self.assertTrue(
            report["lxml_refused"], "The child interpreter imported lxml, so it would not catch a module that does."
        )
        self.assertEqual(
            report["outside"], [], f"The Android reader's own checks imported beyond the standard library: {report}"
        )


if __name__ == "__main__":
    unittest.main()
