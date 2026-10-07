"""A Connect document's unit keeps what Connect made of every state it serves, the same bytes each time.

Contract (``proof.observe.connect``, through ``proof.observe.unit``): for a
document whose app holds Connect blocks, the unit makes one opportunity in
Connect while A is served and every state forwards to it: the records hold
what Connect made of A's submissions, of the local archive's (as it arranges
them, and under the app's id), of B-edit's and of each editor save that is
served, Formplayer's submissions and Core's alike. The same inputs give the
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


@pytest.mark.under_determinism
def test_every_state_of_a_connect_app_reaches_the_one_opportunity(observed):
    """The opportunity holds what the document authors, read by Connect from HQ's own archive view; and each
    state's submissions, Formplayer's and Core's, reached Connect's receiver."""
    opportunity = observed.configurations[CONFIGURATION].a["hooks"]["served"]["connect"]
    assert {asked["view"] for asked in opportunity["asked"]} == {"direct_ccz"}
    assert [unit["slug"] for unit in opportunity["catalog"]["deliverUnits"]] == ["home_visit"]
    states = _states(observed)
    for state in ("A", "b"):
        assert (_answers(states[state], "formplayer"), _answers(states[state], "core")) == ([200], [200]), state
    # The local archive: Formplayer cannot submit from it (finding 59), and a device's post names no app.
    assert sorted(states["local"]["runs"]) == ["core", "core@app"]
    assert (_answers(states["local"], "core"), _answers(states["local"], "core@app")) == ([400], [200])
    # After the edit that renames the deliver unit, the opportunity made before it refuses each delivery.
    assert (_answers(states["b_edit"], "formplayer"), _answers(states["b_edit"], "core")) == ([400], [400])
    # A served save forwards too, and Connect holds of it what it held of the state it was saved over.
    assert states["b:saves"], "no editor save over B was served, so no save's submissions reached Connect"
    for save in states["b:saves"]:
        assert judge.differences(states["b"], save, check="proof4", document="d", artifact="connect") == []


@pytest.mark.under_determinism
def test_each_run_met_the_opportunity_as_it_stood(observed):
    """Formplayer's delivery and Core's each left one visit: neither run read the other's."""
    for run in [run for runs in _states(observed)["A"]["runs"].values() for run in runs]:
        assert len(run["state"]["visits"]) == 1, run["run"]


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
