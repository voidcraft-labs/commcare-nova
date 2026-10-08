"""The served states as part of a document's observation: the records the lane's unit writes.

Contract (``proof.observe.unit.observe_document``, ``proof.observe.served``):
each configuration's ``a`` record holds what Formplayer and the Web Apps
client made of A (the ``served`` hook), its ``b_aligned`` record Formplayer's
walk of Nova's local archive over HQ's state, and proof 4's record what they
made of B, each as blobs of canonical JSON; observing the document again
gives the same records.

Plausible failures: a served state observed outside the unit's operations
and requests (HQ would draw unseeded values and the record would differ run
to run), a record that names an id Formplayer, HQ or the browser drew, or a
walk that silently did not run where Core's did.

And what a run asks HQ does not depend on the runs before it: Formplayer
keeps what a query fetched for five minutes of the machine's time
(``caching.specs.*``), which a worker's ``clear_user_data`` leaves, so a
second observation of ``search-hidden-link`` started within five minutes of
the first read the case its end-of-form link fetches (HQ's
``case_fixture``) from the first's cache and asked HQ nothing, while one
started later asked: a hosted run recorded both for one key. Each run starts
with Formplayer's caches empty (``FormplayerRunner.forget_caches``), so both
observations ask.
"""

from __future__ import annotations

import pytest

from proof.formplayer.walk import screen_kind
from proof.observe.unit import observe_document

DOCUMENT = "targeted-form-link-hidden-target"
# A search whose results a form's end-of-form link fetches again by the case chosen (HQ's case_fixture).
FETCHED_AGAIN = "search-hidden-link"


def _served(found):
    held = found.configurations["minimum"]
    return held.a["hooks"]["served"], held.b_aligned["served"], held.b["proof4"]["served"]


@pytest.mark.under_determinism
def test_a_documents_observation_holds_what_formplayer_and_the_client_made_of_each_state_and_the_same_on_every_run(
    hq, core_runner, editor_driver, formplayer_runner, formplayer_documents
):
    document = formplayer_documents[DOCUMENT]
    first = observe_document(document, core_runner=core_runner, editor_driver=editor_driver)
    at_a, aligned, at_b = _served(first)
    assert at_a["served"] and at_a["runtime"] == formplayer_runner.ready["formplayer"]
    # Formplayer walked A where Core's sessions ran on it, and HQ's receiver took every form it submitted.
    sessions = first.configurations["minimum"].b_aligned["sessions"]
    core = first.blobs.get_json(sessions["baseline"]["trace"])
    trace = first.blobs.get_json(at_a["A"]["formplayer"]["trace"])
    assert len(trace["runs"]) == len(core["runs"]) == 4
    assert [run["end"] for run in trace["runs"]] == ["submitted"] * 4
    assert at_a["A"]["formplayer"]["asked"]["receiver_post_with_app_id"] == 4
    assert at_a["A"]["formplayer"]["hq"] == [] and "releaseDiffers" not in at_a["A"]
    forms = [
        step["response"]["title"]
        for run in trace["runs"]
        for step in run["steps"]
        if screen_kind(step.get("response")) == "form"
    ]
    assert forms == [run["trace"][-1]["title"] for run in core["runs"]]
    # The client showed the same walk, the local archive was walked over HQ's state, and B was served for proof 4.
    assert len(first.blobs.get_json(at_a["A"]["webapps"])["runs"]) == 4
    assert len(first.blobs.get_json(aligned["local"]["formplayer"]["trace"])["runs"]) == 4
    assert at_b["served"] and len(first.blobs.get_json(at_b["formplayer"]["trace"])["runs"]) == 4

    again = observe_document(document, core_runner=core_runner, editor_driver=editor_driver)
    assert _served(again) == (at_a, aligned, at_b)
    assert again.digests() == first.digests()


@pytest.mark.under_determinism
def test_what_a_run_asks_hq_does_not_depend_on_an_earlier_observation_of_the_same_document(
    hq, core_runner, editor_driver, formplayer_runner, formplayer_documents
):
    document = formplayer_documents[FETCHED_AGAIN]
    first = observe_document(document, core_runner=core_runner, editor_driver=editor_driver)
    at_a = _served(first)[0]
    assert at_a["A"]["formplayer"]["asked"].get("case_fixture", 0) >= 1, at_a["A"]["formplayer"]["asked"]
    again = observe_document(document, core_runner=core_runner, editor_driver=editor_driver)
    assert _served(again) == _served(first)


def test_a_trace_names_formplayers_own_address_by_a_mark_so_every_runner_records_it_alike():
    """Formplayer writes the URL it was asked at into an error's answer, and each runner's web server listens on
    a port drawn as it starts: two lane runs kept different records for every such answer until the address was
    written as a mark. Another address in the same answer is kept as it is."""
    from types import SimpleNamespace

    from proof.formplayer import observe

    served = SimpleNamespace(hq=SimpleNamespace(restores=[]), build_id="build", usercase_id=None)

    def recorded(port, other="http://127.0.0.1:9/navigate_menu"):
        trace = {"runs": [{"steps": [{"response": {"url": f"http://127.0.0.1:{port}/navigate_menu", "other": other}}]}]}
        return observe.marked(trace, served=served, runner=SimpleNamespace(ready={"port": port}))

    assert recorded(41000) == recorded(42000)
    assert recorded(41000)["runs"][0]["steps"][0]["response"] == {
        "url": f"{observe.FORMPLAYER}/navigate_menu",
        "other": "http://127.0.0.1:9/navigate_menu",
    }
