"""A group is credited with what its own items and fixtures took, and the session with what its groups share.

Contract (``proof.lane.timings.GroupTimings``): a group's seconds are its
items' setup, call and teardown, plus the wider fixtures the group set up
(a package's session fixture), minus what the session's groups share (the
root conftest's services, and what serves every document), which is written
as ``shared``; ``node proof/run.mjs --timings`` divides a group's seconds by
the workers sharing its box. The plausible failure: a group credited with a
service its first item happened to set up, or with another group's
teardown, which would mislead every estimate the queue is packed by.

A session in miniature runs in a child pytest, its time read from a clock its
fixtures and tests advance.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

_TIMED_SESSION = {
    "clockwork.py": """
class Clock:
    now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


CLOCK = Clock()
""",
    "conftest.py": """
import os
from pathlib import Path

import pytest
from clockwork import CLOCK
from proof.checks.sharding import item_group
from proof.lane.timings import GroupTimings


def pytest_collection_modifyitems(config, items):
    groups = {item.nodeid: item_group(item) for item in items}
    timings = GroupTimings(
        groups, Path(os.environ["PROOF_OUT"], "timings.json"), {"worker": 3, "workers": 4}, clock=CLOCK
    )
    config.pluginmanager.register(timings, "group-timings")


@pytest.fixture(scope="session")
def service():
    \"\"\"A service every test sees, for the whole session, as HQ and the Core runner are.\"\"\"
    CLOCK.advance(100)
    yield
    CLOCK.advance(200)


@pytest.fixture(scope="session")
def catalog():
    \"\"\"Another service, first set up inside a fixture of the session's.\"\"\"
    CLOCK.advance(11)
""",
    "pkg/__init__.py": "",
    "pkg/conftest.py": """
import pytest
from clockwork import CLOCK


@pytest.fixture(scope="session")
def extraction(service):
    \"\"\"A package's own session fixture, over the service.\"\"\"
    CLOCK.advance(50)
    yield
    CLOCK.advance(30)
""",
    "pkg/test_pkg.py": """
from clockwork import CLOCK


def test_extract(extraction):
    CLOCK.advance(5)
""",
    "test_docs.py": """
import pytest
from clockwork import CLOCK


class Document:
    def __init__(self, group, call):
        self.group, self.call = group, call


@pytest.fixture(scope="module")
def every_document(service, request):
    \"\"\"What serves every document the session runs, asking for a service as it runs (as proof/native's
    session asks for the Core runner).\"\"\"
    request.getfixturevalue("catalog")
    CLOCK.advance(7)
    yield
    CLOCK.advance(4)


@pytest.fixture
def own():
    CLOCK.advance(1)
    yield
    CLOCK.advance(0.5)


@pytest.mark.parametrize("document", [Document("corpus:a", 2), Document("corpus:b", 3)], ids=["a", "b"])
def test_document(document, every_document, own):
    CLOCK.advance(document.call)
""",
}


def test_a_group_is_credited_with_its_own_items_and_fixtures_and_the_session_with_what_they_share(tmp_path):
    """The session's services land on no group, though its first item sets them up and its last tears them down."""
    session = tmp_path / "session"
    for name, text in _TIMED_SESSION.items():
        (session / name).parent.mkdir(parents=True, exist_ok=True)
        (session / name).write_text(text)
    out = tmp_path / "out"
    out.mkdir()
    completed = subprocess.run(
        [sys.executable, "-m", "pytest", "--rootdir", str(session), "-p", "no:cacheprovider", "-q", str(session)],
        cwd=session,
        env={**os.environ, "PROOF_OUT": str(out)},
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stdout[-3000:] + completed.stderr[-3000:]
    assert json.loads((out / "timings.json").read_text()) == {
        "worker": 3,
        "workers": 4,
        # The package's extraction (50 to set up, 30 to tear down after the last document) and its test (5).
        # Each document: its own fixture (1 + 0.5) and its call.
        "groups": {str(session / "pkg"): 85.0, "corpus:a": 3.5, "corpus:b": 4.5},
        # The services (100 + 200, and 11) and what served every document (7 + 4, without the 11 inside it).
        "shared": 322.0,
    }
