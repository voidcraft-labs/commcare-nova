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
"""

from __future__ import annotations

import pytest

from proof.formplayer.walk import screen_kind
from proof.observe.unit import observe_document

DOCUMENT = "targeted-form-link-hidden-target"


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
