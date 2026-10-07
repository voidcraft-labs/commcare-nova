"""Formplayer's sessions as part of a document's observation: the record the lane's unit writes.

Contract (``proof.observe.unit.observe_document`` with a Formplayer runner,
``proof.formplayer.observe``): each configuration's ``b_aligned`` record
holds Formplayer's sessions beside Core's, over the same build and restore,
as blobs of canonical JSON, and observing the document again gives the same
record. Such an observation is refused a store, since a part's key does not
yet say whether Formplayer's sessions were observed.

Plausible failures: the walk run outside the unit's operations (HQ's answers
would draw unseeded values and the record would differ run to run), a record
that names an id Formplayer drew, or a Formplayer walk that silently did not
run where Core's did.
"""

from __future__ import annotations

import pytest

from proof.formplayer.walk import screen_kind
from proof.observe.unit import observe_document

DOCUMENT = "targeted-form-link-hidden-target"


def _formplayer(found):
    return found.configurations["minimum"].b_aligned["sessions"].get("formplayer")


def test_a_documents_observation_holds_formplayers_sessions_beside_cores_and_the_same_on_every_run(
    hq, core_runner, editor_driver, formplayer_runner, formplayer_documents
):
    document = formplayer_documents[DOCUMENT]
    runners = dict(core_runner=core_runner, editor_driver=editor_driver, formplayer_runner=formplayer_runner)
    first = observe_document(document, **runners)
    recorded = _formplayer(first)
    assert recorded is not None
    assert recorded["runtime"] == formplayer_runner.ready["formplayer"]
    # Formplayer walked A where Core's sessions ran on it, and HQ received every form it submitted.
    sessions = first.configurations["minimum"].b_aligned["sessions"]
    core = first.blobs.get_json(sessions["baseline"]["trace"])
    trace = first.blobs.get_json(recorded["A"]["trace"])
    assert len(trace["runs"]) == len(core["runs"]) == 4
    assert [run["end"] for run in trace["runs"]] == ["submitted"] * 4
    assert recorded["A"]["submissions"] == 4
    # Every run, and every menu the derivation branched at, started from a fresh restore.
    assert recorded["A"]["asked"]["restore"] == 7 and recorded["A"]["asked"]["submission"] == 4
    assert "archive" not in recorded["A"]["asked"]
    forms = [
        step["response"]["title"]
        for run in trace["runs"]
        for step in run["steps"]
        if screen_kind(step.get("response")) == "form"
    ]
    assert forms == [run["trace"][-1]["title"] for run in core["runs"]]

    again = observe_document(document, **runners)
    assert _formplayer(again) == recorded


def test_an_observation_with_formplayers_sessions_is_refused_a_store(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    """The accepted case is the test above: the same observation with no store."""
    document = formplayer_documents[DOCUMENT]
    with pytest.raises(ValueError, match="kept in no store yet"):
        observe_document(document, core_runner=core_runner, formplayer_runner=formplayer_runner, store=object())
