"""The held view's guards refuse what would make HQ's state depend on timing, and accept what would not.

Contract: an HQ request that writes must have been the only request the
driver had forwarded while it was answered (``pages._check_writes_alone``):
Python answers forwarded requests in the order they arrive, so a write
alongside another in flight would make the state depend on which arrived
first. And a request is answered only in the phase it was asked in
(``HQAnswers._check_phase``): a section's requests inside that section's
fork, the load's outside every section. An HQ view that raises on what one
section sent is that section's report (its save answered 500, its Save
button offering "Try Again"), and the view's other sections save; a request
the harness refuses fails the whole view. The plausible failures: a guard
that never fires (a write racing a read passes), one that fires on the
ordinary sequence (the navigation, then the page's reads, then each save
alone), one section's HQ failure taking the view's other sections with it,
and a harness refusal passing as HQ's answer.
"""

from __future__ import annotations

import pytest

from proof.editors import pages
from proof.editors.client import PageRequest
from proof.editors.conftest import form_view_hq_raises_on
from proof.editors.hq import Exchange, HQAnswers, PhaseMismatch


def _exchange(forwarded, wrote, path="/a/p/apps/x/"):
    return Exchange(
        method="POST",
        path=path,
        query="",
        url_name="x",
        view=None,
        status=200,
        seconds=0.0,
        phase="load",
        forwarded=forwarded,
        wrote=wrote,
    )


def test_a_write_alone_passes_and_a_write_beside_another_request_is_refused():
    # The navigation (1) wrote and was answered before the page asked anything else (2, 3 overlap but only read).
    alone = [{"forwarded": 1, "replied": 2}, {"forwarded": 3, "replied": 6}, {"forwarded": 4, "replied": 5}]
    pages._check_writes_alone([_exchange(1, True), _exchange(3, False), _exchange(4, False)], alone)
    # A save (7) that wrote while a read (8) was forwarded and unanswered.
    racing = alone + [{"forwarded": 7, "replied": 10}, {"forwarded": 8, "replied": 9}]
    with pytest.raises(pages.ConcurrentWrite, match="wrote while 1 other request"):
        pages._check_writes_alone([_exchange(7, True), _exchange(8, False)], racing)


def _asked(phase):
    return PageRequest(method="GET", url="http://hq.proof.test/a/p/", headers={}, body=None, phase=phase)


def test_a_request_is_answered_only_in_its_own_phase():
    answers = HQAnswers(state=None)
    answers._check_phase(_asked("load"))
    with pytest.raises(PhaseMismatch, match="no section"):
        answers._check_phase(_asked("followup:0"))
    answers.open_section(0)
    answers._check_phase(_asked("section:0"))
    answers._check_phase(_asked("followup:0"))
    with pytest.raises(PhaseMismatch, match="section 0"):
        answers._check_phase(_asked("load"))
    with pytest.raises(PhaseMismatch, match="section 0"):
        answers._check_phase(_asked("followup:1"))
    answers.close_section()
    answers._check_phase(_asked("load"))


# HQ's views failing, and the harness refusing --------------------------------------------------------


def test_an_hq_view_raising_on_one_section_is_that_sections_and_a_harness_refusal_fails_the_view(
    hq, core_runner, editor_driver
):
    from contextlib import nullcontext
    from unittest import mock

    from corehq.apps.app_manager.models import Application
    from corehq.apps.app_manager.views import forms

    from proof.editors.hq import HQRefusedPageRequest
    from proof.hq.check import hq_check
    from proof.hq.configuration import Configuration

    with hq_check(Configuration(privileges={"CLOUDCARE"}), validate=core_runner.validate_form) as (state, _):
        spec = form_view_hq_raises_on(state)
        view = pages.run_view(editor_driver, HQAnswers(state), spec, on_section=lambda _index: nullcontext())
        settings, management = view.sections
        assert settings.save.status == 500 and settings.save.raised == "jsonobject.exceptions.BadValueError"
        assert settings.save.refusal is None and settings.bar_state == "savebtn-bar-retry"
        assert management.save.status == 200 and management.bar_state == "savebtn-bar-saved"
        assert not [e for e in management.exchanges if e.error]

        held = forms.get_app

        def get_app_reading_a_view_the_harness_does_not_answer(domain, app_id, *args, **kwargs):
            list(Application.get_db().view("proof/not_answered", reduce=False))
            return held(domain, app_id, *args, **kwargs)

        # A Couch view the harness does not compute, reached by HQ's save view, is the harness's refusal.
        with (
            mock.patch.object(forms, "get_app", get_app_reading_a_view_the_harness_does_not_answer),
            pytest.raises(HQRefusedPageRequest) as refused,
        ):
            pages.run_view(editor_driver, HQAnswers(state), spec, on_section=lambda _index: nullcontext())
    # Both sections' save views read the app through it.
    assert {(e.url_name, e.raised) for e in refused.value.exchanges} == {
        ("edit_form_attr", "proof.hq.couch.UnansweredView"),
        ("edit_form_actions", "proof.hq.couch.UnansweredView"),
    }
