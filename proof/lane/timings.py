"""What each group cost one worker, without what the worker's session shares.

``GroupTimings`` is a pytest plugin a lane worker registers
(``proof.lane.worker``): it adds up what each group's items took, and when the
session finishes writes ``{"workers": k, "groups": {<group>: <seconds>},
"shared": <seconds>}``. ``node proof/run.mjs --timings`` turns those into
``proof/timings.json``'s box-seconds (each group's seconds divided by the
workers that shared its box).

A group is credited with its items' setup, call and teardown, except the
setup and teardown of a fixture wider than one test that it does not own:

- a fixture every test sees (the root conftest's services: HQ, the Core
  runner, the editor driver) is the session's, set up for whichever item
  first asks for it and torn down after the last;
- a wider fixture a corpus document or control sets up serves every document
  the session runs (``manifest`` in ``proof/checks/test_manifest.py`` reads
  the manifest every document's check uses), so it is the session's too;
- any other wider fixture is the group's that set it up (a package's own
  session fixture, such as ``proof/surface``'s extraction), torn down
  whenever the session tears it down.

What is the session's is written as ``shared``. A fixture's time is its own,
without the wider fixtures set up inside it; a teardown is timed up to each
fixture's finish (``pytest_fixture_post_finalizer``). The session's own
teardown after its last item, when the lane's plugin ends a session it kept
up for a group that never came (``proof.lane.plugin``), is timed the same
way (``session_teardown``).
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from pathlib import Path

import pytest

from proof.checks.sharding import DOCUMENT_KINDS

# The owner of what a session's groups share: its services, and what serves every document it runs.
_SHARED = object()


class GroupTimings:
    """The pytest plugin; ``groups`` maps each collected item's node id to its group."""

    def __init__(self, groups, path: Path, label: dict, *, clock=None):
        self.groups = groups
        self._path = Path(path)
        self._label = label
        self._clock = clock or time.perf_counter
        self.seconds: dict[str, float] = {}
        self.shared = 0.0
        self._group = None
        # This phase's seconds that belong to another owner (a group, or _SHARED).
        self._moved: dict = {}
        # Each wider fixture's owner, from its latest setup.
        self._owners: dict = {}
        # The seconds of wider fixtures set up inside each wider fixture being set up.
        self._nested: list[float] = []
        # In a teardown: when the latest fixture finished.
        self._mark = None

    def _credit(self, owner, seconds):
        if owner is _SHARED:
            self.shared += seconds
        elif owner is not None:
            self.seconds[owner] = self.seconds.get(owner, 0.0) + seconds

    def _move(self, owner, seconds):
        if owner != self._group:
            self._moved[owner] = self._moved.get(owner, 0.0) + seconds

    @contextmanager
    def _phase(self):
        started = self._clock()
        self._moved = {}
        try:
            yield
        finally:
            took = self._clock() - started
            for owner, seconds in self._moved.items():
                self._credit(owner, seconds)
            self._credit(self._group, took - sum(self._moved.values()))
            self._moved = {}

    @pytest.hookimpl(wrapper=True)
    def pytest_runtest_protocol(self, item, nextitem):
        self._group = self.groups.get(item.nodeid)
        try:
            return (yield)
        finally:
            self._group = None

    @pytest.hookimpl(wrapper=True)
    def pytest_runtest_setup(self, item):
        with self._phase():
            return (yield)

    @pytest.hookimpl(wrapper=True)
    def pytest_runtest_call(self, item):
        with self._phase():
            return (yield)

    @pytest.hookimpl(wrapper=True)
    def pytest_runtest_teardown(self, item, nextitem):
        with self._phase():
            self._mark = self._clock()
            try:
                return (yield)
            finally:
                self._mark = None

    @contextmanager
    def session_teardown(self):
        """The session's teardown outside any item's: each fixture's stop credited to its owner, as in a teardown."""
        self._group = None
        with self._phase():
            self._mark = self._clock()
            try:
                yield
            finally:
                self._mark = None

    @pytest.hookimpl(wrapper=True)
    def pytest_fixture_setup(self, fixturedef, request):
        if fixturedef.scope == "function":
            return (yield)
        if fixturedef.baseid == "" or str(self._group or "").startswith(DOCUMENT_KINDS):
            owner = _SHARED
        else:
            owner = self._group
        self._owners[fixturedef] = owner
        self._nested.append(0.0)
        started = self._clock()
        try:
            return (yield)
        finally:
            took = self._clock() - started
            self._move(owner, took - self._nested.pop())
            if self._nested:
                self._nested[-1] += took

    def pytest_fixture_post_finalizer(self, fixturedef, request):
        if self._mark is None:
            return
        now = self._clock()
        self._move(self._owners.get(fixturedef, self._group), now - self._mark)
        self._mark = now

    def record(self) -> dict:
        return {
            **self._label,
            "groups": {group: round(seconds, 3) for group, seconds in sorted(self.seconds.items())},
            "shared": round(self.shared, 3),
        }

    def pytest_sessionfinish(self, session):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(self.record(), indent="\t") + "\n", encoding="utf-8")
