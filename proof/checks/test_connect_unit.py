"""A Connect document's unit keeps what Connect made of every state it serves, the same bytes each time.

Contract (``proof.observe.connect``, through ``proof.observe.unit``): for a
document whose app holds Connect blocks, the unit makes one opportunity in
Connect while A is served and every state forwards to it: the records hold
what Connect made of A's submissions, of the local archive's (as it arranges
them, and under the app's id), of B-edit's and of each editor save that is
served, Formplayer's submissions and each device's alike. The same inputs give the
same bytes, whichever address Connect answered at; and a part observed under
an ``a`` the store holds comes out byte for byte the part observed with
nothing stored, the opportunity made again as it was made. A document
whose app holds no Connect block is given no opportunity and no record.

The plausible failures: a state that forwards nowhere (its record then
silently holds nothing to compare); a run reading what another's submission
left in Connect; an id Formplayer, HQ or Connect drew, a clock, or Connect's
address in a record; an opportunity made from another release where the
store held ``a`` (so a stored part would stand for another observation);
Connect started for an app that has nothing to do with it.
"""

from __future__ import annotations

import json

import pytest

from proof.checks import cases
from proof.checks import connect as judge
from proof.checks.test_record_determinism import DictStore, _store_of
from proof.observe import unit

# Every test here holds what the unit's served hook made of Connect (proof.observe.connect), which only a run with
# the readers observes (proof.lane.readers).
pytestmark = pytest.mark.reader

DOCUMENT = "targeted-connect-deliver-rename"
PLAIN = "connect-absent"
CONFIGURATION = "minimum"


def _document(document_id):
    return next(document for document in cases.load_corpus().emitted if document.id == document_id)


def _observe(document, core_runner, editor_driver, store=None):
    more = {} if store is None else {"store": store}
    return unit.observe_document(
        document, core_runner=core_runner, editor_driver=editor_driver, configurations=[CONFIGURATION], **more
    )


@pytest.fixture(scope="module")
def observed(hq, core_runner, editor_driver):
    return _observe(_document(DOCUMENT), core_runner, editor_driver)


def _states(records):
    """Each state's Connect record of the configuration, by the state: A, the local archive, B's and B-edit's
    baselines, and each served save's."""
    held = records.configurations[CONFIGURATION]
    blobs = records.blobs
    found = {"A": blobs.get_json(held.a["hooks"]["served"]["A"]["connect"])}
    served = held.b_aligned["served"]
    for state in ("B", "local"):
        if (served.get(state) or {}).get("connect"):
            found[state] = blobs.get_json(served[state]["connect"])
    for part in ("b", "b_edit"):
        proof4 = held.part(part)["proof4"]
        found[part] = blobs.get_json(proof4["served"]["connect"])
        saves = []

        def walk(value, saves=saves):
            if isinstance(value, dict):
                if isinstance(value.get("served"), dict) and isinstance(value["served"].get("connect"), str):
                    saves.append(blobs.get_json(value["served"]["connect"]))
                for item in value.values():
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        walk({name: entry for name, entry in proof4.items() if name != "served"})
        found[f"{part}:saves"] = saves
    return found


def _answers(record, reader):
    return [post["status"] for run in record["runs"].get(reader) or [] for post in run["posts"]]


def _every(statuses, status):
    """Whether a reader's posts all got ``status``, and it made at least one."""
    return bool(statuses) and set(statuses) == {status}


# The document's two forms as each reader names its runs of them: the deliver form first, and the task's form,
# which holds the task in a form of its own (finding 61). Formplayer's walk submits them in order; a device names
# a run by the form's command, a tablet's run with ``@tablet`` after it.
DELIVER_FORM = ("walk-0", "m0/m0-f0")
TASK_FORM = ("walk-1", "m0/m0-f1")


def _form(run):
    """Which of the document's forms a run is of: ``DELIVER_FORM``, ``TASK_FORM``, or None for any other run."""
    name = run["run"].split("@", 1)[0]
    return next((form for form in (DELIVER_FORM, TASK_FORM) if name in form), None)


def _device_answers(record, form):
    """The statuses of every post of each device's runs of ``form``."""
    return [
        post["status"] for run in record["runs"].get("android") or [] if _form(run) == form for post in run["posts"]
    ]


@pytest.mark.under_determinism
def test_every_state_of_a_connect_app_reaches_the_one_opportunity(observed):
    """The opportunity holds what the document authors, read by Connect from HQ's own archive view; and each
    state's submissions of both forms, Formplayer's and each device's, reached Connect's receiver."""
    opportunity = observed.configurations[CONFIGURATION].a["hooks"]["served"]["connect"]
    assert {asked["view"] for asked in opportunity["asked"]} == {"direct_ccz"}
    assert [unit["slug"] for unit in opportunity["catalog"]["deliverUnits"]] == ["home_visit"]
    assert [task["slug"] for task in opportunity["catalog"]["taskTypes"]] == ["follow_up"]
    states = _states(observed)
    for state in ("A", "b"):
        assert _answers(states[state], "formplayer") == [200, 200], state
        assert _every(_answers(states[state], "android"), 200), state
    # The local archive, made for the deployment, names the app in its profile's PostURL: Formplayer submits from
    # it and every device on it posts there, so both readers reach Connect.
    assert sorted(states["local"]["runs"]) == ["android", "formplayer"]
    assert _answers(states["local"], "formplayer") == [200, 200]
    assert _every(_answers(states["local"], "android"), 200)
    # After the edit that renames the deliver unit in the first form and the task in the second, the opportunity
    # made before it refuses each delivery, and takes the task form's payload, which completes nothing.
    assert _answers(states["b_edit"], "formplayer") == [400, 200]
    assert _every(_device_answers(states["b_edit"], DELIVER_FORM), 400)
    assert _every(_device_answers(states["b_edit"], TASK_FORM), 200)
    # A served save forwards too, and Connect holds of it what it held of the state it was saved over.
    assert states["b:saves"], "no editor save over B was served, so no save's submissions reached Connect"
    for save in states["b:saves"]:
        assert judge.differences(states["b"], save, check="proof4", document="d", artifact="connect") == []


@pytest.mark.under_determinism
def test_each_run_met_the_opportunity_as_it_stood(observed):
    """At A, each run of the deliver form left one visit and completed no task, and each run of the task's form
    left no visit and completed the worker's assigned task: no run read another's."""
    record = _states(observed)["A"]
    assert [run["run"] for run in record["runs"]["formplayer"]] == ["walk-0", "walk-1"]
    runs = [run for runs in record["runs"].values() for run in runs]
    for run in runs:
        completed = [
            task["slug"] for task in run["state"].get("assignedTasks") or [] if task.get("status") == "completed"
        ]
        form = _form(run)
        assert form is not None, run["run"]
        if form == DELIVER_FORM:
            assert len(run["state"]["visits"]) == 1, run["run"]
            assert completed == [], run["run"]
        else:
            assert run["state"]["visits"] == [], run["run"]
            assert completed == ["follow_up"], run["run"]


@pytest.mark.under_determinism
def test_a_connect_record_names_no_address_and_no_drawn_id(observed):
    held = observed.configurations[CONFIGURATION]
    written = json.dumps([_states(observed), held.a["hooks"]["served"]["connect"]])
    assert "127." not in written and "http://" not in written.replace("http://commcareconnect.com", "")
    app_id = observed.blobs.get_json(held.a["state"]["doc"])["_id"]
    assert app_id not in written and "@app" in written and "@build" in written


@pytest.mark.under_determinism
def test_the_same_inputs_give_the_same_bytes_and_a_stored_a_gives_the_same_parts(
    observed, hq, core_runner, editor_driver
):
    """Observed again, every part is the same bytes. Under an ``a`` the store holds, the opportunity is made
    again while A is served, and B, the local archive, B-edit and their saves come out the same."""
    document = _document(DOCUMENT)
    again = _observe(document, core_runner, editor_driver)
    assert again.digests() == observed.digests()
    store = DictStore(_store_of(observed, {f"{CONFIGURATION}/a"}))
    under = _observe(document, core_runner, editor_driver, store)
    assert sorted(under.observed) == sorted(
        [f"{CONFIGURATION}/{part}" for part in ("b", "b_aligned", "b_edit")] + ["local"]
    )
    assert under.digests() == observed.digests()


@pytest.mark.under_determinism
def test_an_app_with_no_connect_block_is_given_no_opportunity(hq, core_runner, editor_driver):
    """The control: the same observation of an app that holds no Connect block makes no opportunity and keeps no
    Connect record."""
    records = _observe(_document(PLAIN), core_runner, editor_driver)
    served = records.configurations[CONFIGURATION].a["hooks"]["served"]
    assert served.get("served") is True
    assert "connect" not in served and "connect" not in served["A"]
