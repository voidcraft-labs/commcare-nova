"""A run without the readers serves no state, runs no test that starts a reader, and cannot start one unmarked.

Contracts (``proof.lane.readers``, ``proof.observe.unit.hooks``,
``proof.observe.services``, ``proof/conftest.py``): with ``PROOF_READERS=0``
the unit calls no ``served`` hook, so no part declares the browser's code at
A and every part of a configuration is keyed apart from the run with the
readers; a test whose fixtures start a served reader, or that is marked
``reader`` by hand, is deselected; and asking the session's services for a
served reader raises, so a test that starts one unmarked fails rather than
running half. With the readers every test runs, and a test marked by hand
that asks for no reader fails, so none leaves the pull request lane for a
reader it never starts. The validation Formplayer, HQ's own, is never
refused.

The plausible failures: a served hook still called (every document's group
pays for the readers in the pull request lane), its records kept under the
other profile's keys, a reader test that is left in and fails on what it no
longer observes, one that starts a reader through a helper rather than a
fixture and runs half, and a test marked by hand that never needed a reader,
quietly gone from the pull request lane.

The deselection and the hand-marked hold run in a child pytest over a session
of its own that takes the root conftest's hooks, once with the readers and
once without.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

import pytest

from proof.checks import cases, sharding
from proof.lane import readers
from proof.observe import services, unit

_SESSION = {
    "conftest.py": """
import pytest

from proof.conftest import (  # noqa: F401 - the root conftest's hooks and services, as the lane's sessions take them
    lane_services,
    pytest_collection_modifyitems,
    pytest_fixture_setup,
    pytest_runtest_call,
    pytest_runtest_setup,
)


def pytest_configure(config):
    config.addinivalue_line("markers", "reader: starts a served reader")


@pytest.fixture(scope="session")
def formplayer_runner(lane_services):
    \"\"\"Stands in for the session's Formplayer: the root conftest marks a test by the fixture's name.\"\"\"
    return None


@pytest.fixture(scope="module")
def standing_formplayer(lane_services):
    \"\"\"A runner standing in for the session's Formplayer, so asking for it starts no JVM.\"\"\"
    from proof.observe import services

    services._SESSION["formplayer"] = object()
    yield services.formplayer
    services._SESSION["formplayer"] = None
""",
    "test_session.py": """
import pytest


def test_plain():
    pass


def test_by_fixture(formplayer_runner):
    pass


@pytest.mark.reader("webapps")
def test_by_fixture_and_another_reader_by_hand(formplayer_runner):
    pass


@pytest.mark.reader
def test_by_hand_asks(standing_formplayer):
    standing_formplayer()


@pytest.mark.reader
def test_by_hand_asks_nothing():
    pass


@pytest.fixture(scope="module")
def asked_once(standing_formplayer):
    return standing_formplayer()


@pytest.mark.reader
def test_by_hand_through_a_module_fixture_first(asked_once):
    pass


@pytest.mark.reader
def test_by_hand_through_a_module_fixture_after(asked_once):
    pass


def test_unmarked_asks(standing_formplayer):
    standing_formplayer()
""",
}


def _child(tmp_path, readers_value):
    session = tmp_path / f"session-{readers_value}"
    session.mkdir()
    for name, text in _SESSION.items():
        (session / name).write_text(text)
    completed = subprocess.run(
        [sys.executable, "-m", "pytest", "--rootdir", str(session), "-p", "no:cacheprovider", "-rA", str(session)],
        cwd=session,
        env={**os.environ, readers.VARIABLE: readers_value},
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    outcomes = {}
    for outcome, name in re.findall(r"^(PASSED|FAILED|ERROR) \S+::(\w+)", completed.stdout, re.MULTILINE):
        outcomes[name] = outcome
    deselected = re.search(r"(\d+) deselected", completed.stdout)
    return outcomes, int(deselected.group(1)) if deselected else 0, completed.stdout


def test_a_run_without_the_readers_deselects_each_test_that_starts_one_and_refuses_one_left_unmarked(tmp_path):
    outcomes, deselected, output = _child(tmp_path, "0")
    # By its fixture and by hand: each left to the nightly.
    assert deselected == 6, output[-3000:]
    assert outcomes == {"test_plain": "PASSED", "test_unmarked_asks": "FAILED"}, output[-3000:]
    assert "ReadersOff" in output and "mark it reader" in output


def test_a_run_of_some_readers_runs_the_tests_of_those_alone(tmp_path):
    """PROOF_READERS=formplayer: the test whose fixture starts Formplayer runs, every test marked for every reader
    (a bare mark) is left out, so is the one whose fixture starts Formplayer and that names the client by hand
    (it reads the client's record too), and the services refuse the readers the run leaves out."""
    outcomes, deselected, output = _child(tmp_path, "formplayer")
    assert deselected == 5, output[-3000:]
    assert outcomes == {
        "test_plain": "PASSED",
        "test_by_fixture": "PASSED",
        "test_unmarked_asks": "PASSED",
    }, output[-3000:]


def test_the_readers_a_run_names_bring_formplayer_and_nothing_else_is_a_set_of_them():
    assert readers.parse(None) == readers.parse("all") == readers.parse(" ") == readers.EVERY
    assert readers.parse("0") == readers.NONE and not readers.served({readers.VARIABLE: "0"})
    assert readers.parse("android") == {"android", "formplayer"}
    assert readers.parse("webapps, connect") == {"webapps", "connect", "formplayer"}
    for refused in ("android,phone", ",", "none"):
        with pytest.raises(readers.ReadersError, match="comma list of formplayer, webapps, android, connect"):
            readers.parse(refused)
    # As the store's keys and a run's records write a set, and read it back.
    for value in ("all", "0", "android", "webapps,connect"):
        found = readers.parse(value)
        assert readers.from_record(readers.to_record(found)) == found
        assert readers.parse(readers.canonical(found)) == found
    assert readers.canonical(readers.parse("connect,android")) == "formplayer,android,connect"


def test_a_reader_reads_an_app_only_on_a_platform_it_declares():
    """The client reads an app that declares Web Apps and a device one that declares Android; Formplayer and
    Connect read every app. Catches a reader handed an app it does not run, or one withheld from an app it does."""
    both, web_apps, android = {"web-apps", "android"}, {"web-apps"}, {"android"}
    assert readers.reads_app("webapps", both) and readers.reads_app("webapps", web_apps)
    assert not readers.reads_app("webapps", android)
    assert readers.reads_app("android", both) and readers.reads_app("android", android)
    assert not readers.reads_app("android", web_apps)
    for reader in ("formplayer", "connect"):
        assert all(readers.reads_app(reader, platforms) for platforms in (both, web_apps, android))
    # The module stays on the standard library, so it spells the platforms itself; they are the corpus's.
    from proof.checks.corpus import PLATFORMS

    assert set(readers.PLATFORM_OF.values()) == set(PLATFORMS)


def test_a_run_with_the_readers_runs_every_test_and_holds_each_marked_by_hand_to_asking_for_one(tmp_path):
    outcomes, deselected, output = _child(tmp_path, "all")
    assert deselected == 0, output[-3000:]
    assert outcomes == {
        "test_plain": "PASSED",
        "test_by_fixture": "PASSED",
        "test_by_fixture_and_another_reader_by_hand": "PASSED",
        "test_by_hand_asks": "PASSED",
        "test_by_hand_asks_nothing": "FAILED",
        # The second reads the module's fixture the first set up, and asks through it.
        "test_by_hand_through_a_module_fixture_first": "PASSED",
        "test_by_hand_through_a_module_fixture_after": "PASSED",
        "test_unmarked_asks": "PASSED",
    }, output[-3000:]
    assert "neither it nor a fixture it reads asked for a served reader" in output


def test_the_services_refuse_every_served_reader_without_the_readers_and_count_each_ask(monkeypatch):
    # Outside the session's services (the lane's own session holds them open), so nothing here starts a JVM.
    monkeypatch.setitem(services._SESSION, "open", False)
    monkeypatch.setenv(readers.VARIABLE, "0")
    before = services.asked()
    for ask in (services.formplayer, services.client_browser, services.connect, services.android):
        with pytest.raises(services.ReadersOff, match="PROOF_READERS=0"):
            ask()
    assert services.asked() == before + 4
    # HQ's own form validation is not a reader's: outside a session it is refused for the session alone.
    with pytest.raises(services.NoSession):
        services.validator()
    monkeypatch.setenv(readers.VARIABLE, "all")
    with pytest.raises(services.NoSession):
        services.formplayer()
    assert services.asked() == before + 5
    # A slice of the readers: those it names are asked for as ever, the others refused.
    monkeypatch.setenv(readers.VARIABLE, "android")
    with pytest.raises(services.NoSession):
        services.android()
    with pytest.raises(services.ReadersOff, match="only formplayer, android"):
        services.client_browser()
    # Connect's forwarder is set up in the same browser, asked for as Connect's: a slice of Connect alone has it.
    monkeypatch.setenv(readers.VARIABLE, "connect")
    with pytest.raises(services.NoSession):
        services.client_browser("connect")
    with pytest.raises(services.ReadersOff, match="only formplayer, connect"):
        services.client_browser()


def test_a_slice_without_the_client_walks_formplayer_without_the_clients_browser(monkeypatch):
    """Formplayer's derived walk gives each location question the place the client's map gives, which it learns
    in the client's browser, only where the run hands its states to the client: a slice of a device alone walks
    Formplayer with the answer table's places and asks for no browser (it once did, and every such slice failed
    with ``ReadersOff``)."""
    from proof.formplayer import observe as formplayer_observe
    from proof.observe import served

    walked = []

    def walk(served_state, runner, blobs, *, script=None, places=None):
        walked.append(places)
        return "side", "trace"

    monkeypatch.setattr(formplayer_observe, "walked", walk)
    monkeypatch.setitem(services._SESSION, "open", False)
    held = served.Serving(object(), object(), object(), object())
    monkeypatch.setenv(readers.VARIABLE, "android")
    assert held.formplayer() == ("side", "trace") and walked == [None]
    monkeypatch.setenv(readers.VARIABLE, "all")
    with pytest.raises(services.NoSession, match="the Web Apps client's browser"):
        held.formplayer()


def test_without_the_readers_the_unit_calls_no_served_hook_and_every_part_is_keyed_apart():
    assert unit.SERVED in unit.hooks({}) and unit.hooks({}) == unit.EVERY_HOOK
    without = unit.hooks({readers.VARIABLE: "0"})
    assert unit.SERVED not in without and set(without) == set(unit.EVERY_HOOK) - {unit.SERVED}
    estimate = sharding.estimate(sharding.load_timings(readers=False))
    document = min(
        (document for document in cases.load_corpus().emitted if document.edit is not None),
        key=lambda document: (estimate(document.group), document.id),
    )
    held = unit.hook_inputs(document, unit.hooks({}))
    apart = unit.hook_inputs(document, without)
    assert "served" in held["A"] and "served" not in apart["A"]
    assert {state: hooks for state, hooks in held.items() if state != "A"} == {
        state: hooks for state, hooks in apart.items() if state != "A"
    }
    inputs, databases = unit.document_inputs(document), unit.case_databases(document)
    name = sorted(document.exports)[0]
    with_keys = unit.part_keys(inputs, name, databases, held)
    without_keys = unit.part_keys(inputs, name, databases, apart)
    assert set(with_keys) >= {"a", "b", "b_aligned"}
    assert all(with_keys[part] != without_keys[part] for part in with_keys)
