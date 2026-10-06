"""The harness's session-wide services (proof/README.md).

pytest owns the lifetime of each service the checks share, whichever package
they are in: one Core runner JVM for the whole session (``core_runner``), one
editor driver (node and Chromium) for the whole session (``editor_driver``),
and HQ booted once per process (``hq``). A service that fails to start fails
every check that needs it; nothing is skipped.

Under the lane's fork server (``proof.lane.serve``) each worker is one
session: HQ was booted, its template database restored and the Core runner
compiled by the server before it forked, so ``hq`` returns the server's boot
report, and each worker's Core runner starts from the server's compiled
classes (``PROOF_CORE_CLASSES``). The Core runner and the editor driver are
each worker's own.

- ``hq``: HQ booted once for the session (``proof.hq.boot``). At the end of
  the session it drops the databases this process made
  (``proof.hq.database.drop_template``): never a template the lane's server
  restored.
- ``network``: every test fails if HQ reached for the network during it,
  even where HQ caught the refusal itself, unless the test provoked that
  refusal on purpose (``network.expect``).
- ``record_timing`` / ``timed``: what the HQ side costs (the boot, the
  restore of HQ's migrated database, each database's clone and drop, the
  Core runner's and the editor driver's starts, and what HQ's own checks
  time), printed at the end of the session and written to
  ``$PROOF_OUT/hq-timings.json`` when ``PROOF_OUT`` names a directory.

Each group's items run together (``proof.checks.sharding.order_by_group``);
under the lane, the worker's plugin decides which groups run.

A test marked ``under_determinism`` states what holds only where the same inputs give
the same bytes: under HQ's determinism (``proof.hq.determinism``) and a
seeded emission. The weekly unseeded run leaves both real
(``PROOF_HQ_DETERMINISM=0``, ``PROOF_ENTROPY=real``) to compare what it
observes with a seeded run's, and there no request is answered alike twice
and no update sends its republish's bytes, so those tests are skipped.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from proof.core.client import CoreRunner
from proof.editors.client import EditorDriver
from proof.hq.boot import GUARD, BootReport, boot

# The name the lane's worker plugin registers under (proof.lane.plugin.LanePlugin).
LANE_PLUGIN = "proof-lane"
_HQ_TIMINGS: dict[str, list[float]] = {}


def record_timing(name: str, seconds: float) -> None:
    """Record one HQ-side cost for the session's summary."""
    _HQ_TIMINGS.setdefault(name, []).append(round(seconds, 3))


@contextmanager
def timed(name: str):
    started = time.perf_counter()
    try:
        yield
    finally:
        record_timing(name, time.perf_counter() - started)


@pytest.fixture(scope="session")
def core_runner() -> Iterator[CoreRunner]:
    """One runner JVM for the session, joined when the session ends."""
    with CoreRunner() as runner:
        if runner.timings.compile is not None:
            record_timing("core_runner_compile", runner.timings.compile)
        record_timing("core_runner_start", runner.timings.starts[0])
        yield runner


@pytest.fixture(scope="session")
def editor_driver() -> Iterator[EditorDriver]:
    """One editor driver (node and Chromium) for the session, joined when the session ends."""
    with EditorDriver() as driver:
        record_timing("editor_driver_start", driver.timings.starts[0])
        yield driver


@pytest.fixture(scope="session")
def hq(request) -> Iterator[BootReport]:
    """HQ, booted once for the process; the databases this process made are dropped when the session ends."""
    from proof.hq import database

    started = time.perf_counter()
    report = boot()
    if request.config.pluginmanager.get_plugin(LANE_PLUGIN) is None:
        # Under the lane the server booted HQ and records what it cost (serve.json).
        record_timing("boot", time.perf_counter() - started)
    try:
        yield report
    finally:
        database.drop_template()


class NetworkWatch:
    """The network reaches the guard saw during one test."""

    def __init__(self):
        self._start = len(GUARD.attempts)
        self._expected = []

    def refused(self):
        return [attempt for attempt in GUARD.attempts[self._start :] if not attempt.allowed]

    def expect(self, attempt):
        """Mark a refusal the test provoked on purpose."""
        self._expected.append(attempt)


@pytest.fixture(autouse=True)
def network():
    """Fails the test if HQ reached for the network, even where HQ caught the refusal."""
    watch = NetworkWatch()
    yield watch
    unexpected = [attempt for attempt in watch.refused() if attempt not in watch._expected]
    assert not unexpected, "HQ reached for the network during this test, which the harness refused:\n" + "\n".join(
        f"  {a.kind} {a.address} from {' <- '.join(reversed(a.where[-4:]))}" for a in unexpected
    )


def pytest_collection_modifyitems(config, items):
    """Each group's items together, groups in the order they first appear (``proof.checks.sharding``), and the
    ``under_determinism`` tests skipped where HQ's determinism is off or the corpus was emitted unseeded."""
    from proof.checks.sharding import order_by_group
    from proof.hq import determinism

    if not determinism.ENABLED or _emitted_unseeded():
        unseeded = pytest.mark.skip(
            reason="HQ's determinism is off (PROOF_HQ_DETERMINISM=0) or the corpus was emitted with real draws"
            " (PROOF_ENTROPY=real), so nothing done twice gives the same bytes."
        )
        for item in items:
            if item.get_closest_marker("under_determinism") is not None:
                item.add_marker(unseeded)
    items[:] = order_by_group(items)


def _emitted_unseeded() -> bool:
    """Whether the corpus this run reads was emitted with real draws (its index's ``entropy``); False where no
    corpus is named or emitted yet, which a run emitting its own seeds."""
    named = os.environ.get("PROOF_CORPUS")
    if not named:
        return False
    try:
        index = json.loads(Path(named, "index.json").read_text())
    except (OSError, ValueError):
        return False
    return index.get("entropy") == "real"


def pytest_terminal_summary(terminalreporter):
    if terminalreporter.config.option.collectonly:
        return
    from proof.hq.database import CLONE_SECONDS, DROP_SECONDS, RESTORE_SECONDS

    for name, values in (
        ("hq_schema_restore", RESTORE_SECONDS),
        ("database_clone", CLONE_SECONDS),
        ("database_drop", DROP_SECONDS),
    ):
        if values:
            _HQ_TIMINGS[name] = list(values)
    if not _HQ_TIMINGS:
        return
    terminalreporter.section("HQ harness timings (seconds)")
    for name, values in sorted(_HQ_TIMINGS.items()):
        terminalreporter.write_line(f"{name}: {values}")
    out = os.environ.get("PROOF_OUT")
    if out:
        Path(out, "hq-timings.json").write_text(json.dumps(_HQ_TIMINGS, indent="\t", sort_keys=True) + "\n")
