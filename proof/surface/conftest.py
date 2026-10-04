"""Fixtures for the surface extractor's tests.

- ``extraction``: one run of ``python -m proof.surface`` in its own process,
  with the document it wrote, its timings, and its key (``extraction.json``:
  the image and the extractor code that made it, read before it runs,
  ``proof.lane.extraction``). ``PROOF_SURFACE_EXTRACTION`` names a directory
  an extraction already wrote those three files into (``npm run surface``
  leaves them in ``.proof/surface``), which the tests then read instead of
  extracting again, once its key is this run's; any other key fails every
  test that reads the extraction, naming both keys. With ``PROOF_OUT`` set,
  the extraction the tests read is in ``$PROOF_OUT/surface/`` (written there,
  or copied there from the directory named), which in the lane is the
  surface block's directory, where the gate compares it with the committed
  surface; the timings also go to ``$PROOF_OUT/surface-timings.json``.
- ``items``: that document's items.
- ``plant``: a temporary copy of an upstream file or directory with text
  planted into it, for the negative controls. Nothing under the checkouts is
  ever edited.

The tests' own independent readings of HQ (imports, Django's URL resolver)
use the whole harness's HQ boot, ``hq`` in ``proof/conftest.py``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from proof.lane import extraction as keyed
from proof.surface.model import Sources

EXTRACTION_DEADLINE_SECONDS = 900
# Names a directory holding an extraction already made (surface.json and timings.json).
EXTRACTION_ENVIRONMENT = "PROOF_SURFACE_EXTRACTION"


@dataclass(frozen=True)
class Run:
    text: str
    document: dict
    timings: dict
    # None for an extraction read from PROOF_SURFACE_EXTRACTION, whose wall time this session never saw.
    wall_seconds: float | None


def run_extractor(out: Path) -> Run:
    """Runs the extractor's command line once, writing into ``out``, and returns what it wrote."""
    out.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    finished = subprocess.run(
        [
            sys.executable,
            "-m",
            "proof.surface",
            "--out",
            str(out / "surface.json"),
            "--timings",
            str(out / "timings.json"),
        ],
        capture_output=True,
        timeout=EXTRACTION_DEADLINE_SECONDS,
        check=False,
    )
    wall = time.perf_counter() - started
    assert finished.returncode == 0, (
        "python -m proof.surface failed:\n" + finished.stderr.decode("utf-8", "replace")[-6000:]
    )
    text = (out / "surface.json").read_text(encoding="utf-8")
    timings = json.loads((out / "timings.json").read_text(encoding="utf-8"))
    return Run(text, json.loads(text), timings, round(wall, 2))


def read_extraction(directory: Path) -> Run:
    """An extraction ``python -m proof.lane.extraction --out <directory>`` already wrote, made by this run's image and
    extractor code."""
    problem = keyed.key_problem(directory, keyed.key())
    if problem is not None:
        raise AssertionError(problem)
    try:
        text = (directory / "surface.json").read_text(encoding="utf-8")
        timings = json.loads((directory / "timings.json").read_text(encoding="utf-8"))
    except OSError as error:
        raise AssertionError(
            f"PROOF_SURFACE_EXTRACTION names {directory}, which does not hold an extraction's surface.json and"
            f" timings.json ({error}). Name the directory `npm run surface` writes (.proof/surface), or unset it to"
            " extract here."
        ) from error
    return Run(text, json.loads(text), timings, None)


@pytest.fixture(scope="session")
def extraction(tmp_path_factory) -> Run:
    named = os.environ.get(EXTRACTION_ENVIRONMENT)
    out = os.environ.get("PROOF_OUT")
    if named:
        run = read_extraction(Path(named))
        if out:
            kept = Path(out, "surface")
            kept.mkdir(parents=True, exist_ok=True)
            for name in (keyed.SURFACE, keyed.TIMINGS, keyed.KEY):
                if not (kept / name).exists() or not (kept / name).samefile(Path(named, name)):
                    shutil.copyfile(Path(named, name), kept / name)
    else:
        made_by = keyed.key()
        directory = Path(out, "surface") if out else tmp_path_factory.mktemp("surface")
        run = run_extractor(directory)
        keyed.write_key(directory, made_by)
    if out:
        Path(out, "surface-timings.json").write_text(
            json.dumps({**run.timings, "wallSeconds": run.wall_seconds}, indent="\t", sort_keys=True) + "\n",
            encoding="utf-8",
        )
    return run


@pytest.fixture(scope="session")
def items(extraction) -> dict:
    return extraction.document["items"]


@pytest.fixture(scope="session")
def sources() -> Sources:
    return Sources()


@pytest.fixture
def plant(tmp_path):
    """``plant(source, relatives, edits)``: copies each ``source/<relative>`` (a file or a directory) under a
    temporary root at the same relative path, applies ``edits`` (``{file relative to the root: (old, new)}``) to
    the copies, and returns the root. Each ``old`` must occur in its file exactly once, so a planted reader lands
    where the test means it to."""

    def make(source: Path, relatives: list[str], edits: dict[str, tuple[str, str]]) -> Path:
        root = tmp_path / source.name
        for relative in relatives:
            origin = source / relative
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if origin.is_dir():
                shutil.copytree(origin, target)
            else:
                shutil.copy2(origin, target)
        for relative, (old, new) in edits.items():
            path = root / relative
            text = path.read_text(encoding="utf-8")
            assert text.count(old) == 1, f"The planted text's anchor occurs {text.count(old)} times in {relative}."
            path.write_text(text.replace(old, new), encoding="utf-8")
        return root

    return make
