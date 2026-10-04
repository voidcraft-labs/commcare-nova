"""The harvested self-check apps are the apps HQ's own tests build and accept.

Contract: each harvested app is the object HQ's test built and ran its own
assertions over, with a source per form that carries every form path the
form's case configuration reads, written as HQ's app source serves it.
The plausible failures: a stand-in (an app the harvester assembled, or one
of several a test built that its assertions never read), a test that failed
under the harness so its app is not one HQ accepted, a generated source
missing a path the case configuration reads (HQ's build would then report
the missing question, not the app's own shape), and a written app whose
forms lost their sources (HQ's import would then receive blank forms).
"""

from __future__ import annotations

import json

import pytest
from lxml import etree

from proof.checks.configurations import wrap
from proof.corpus.hq import harvest

TESTS = {test.id: test for test in harvest.TESTS}


@pytest.fixture(scope="module")
def harvested(hq):
    return {test.id: harvest.run_test(test) for test in harvest.TESTS}


@pytest.mark.parametrize("test_id", sorted(TESTS))
def test_the_captured_app_is_the_one_hqs_test_built_and_asserted_over(harvested, test_id):
    result = harvested[test_id]
    # HQ's test built the suite of exactly this object while it ran its
    # assertions: an app the harvester assembled or copied is another object.
    assert any(app is result.app for app in result.suites_built_for), (
        f"{result.test.node_id} never built the suite of the captured app"
    )
    if result.factories:
        assert result.captured_from == "factory0"
        assert result.app is result.factories[0].app
    else:
        assert result.captured_from == "self.app"


def test_a_failing_hq_test_harvests_nothing(hq):
    """The harvester refuses an app whose test HQ's own assertions rejected."""
    from corehq.apps.app_manager.tests.test_suite_split_screen_case_search import SplitScreenCaseSearchTest

    accepted = TESTS["harvest-SplitScreenCaseSearchTest-test_split_screen_case_search_removes_search_again"]
    assert harvest.run_test(accepted).app is not None

    def fail(self):
        self.fail("HQ's assertion failed")

    SplitScreenCaseSearchTest.test_harvest_control_that_fails = fail
    try:
        failing = harvest.HarvestTest(accepted.module, accepted.cls, "test_harvest_control_that_fails", "errors")
        with pytest.raises(harvest.HarvestFailed, match="did not pass"):
            harvest.run_test(failing)
    finally:
        del SplitScreenCaseSearchTest.test_harvest_control_that_fails


@pytest.mark.parametrize("test_id", sorted(TESTS))
def test_each_form_gets_a_question_for_every_path_its_case_configuration_reads(harvested, test_id):
    result = harvested[test_id]
    app = harvest.with_sources(result)
    xmlns = []
    for form in app.get_forms():
        if form.form_type == "shadow_form":
            continue
        xform = form.wrapped_xform()
        questions = {q["value"] for q in xform.get_questions(app.langs, include_triggers=True)}
        read = {path for path in harvest._read_paths(form.actions.to_json()) if path.startswith("/data/")}
        assert read | {"/data/question1"} <= questions, form.unique_id
        translations = {node.get("lang") for node in xform.findall("{h}head/{f}model/{f}itext/{f}translation")}
        assert translations == set(app.langs)
        xmlns.append(form.xmlns)
    assert len(xmlns) == len(set(xmlns)), "two forms share an xmlns"


@pytest.mark.parametrize("test_id", sorted(TESTS))
def test_the_written_app_carries_every_form_source_hqs_import_reads(harvested, test_id):
    result = harvested[test_id]
    app = harvest.with_sources(result)
    written = json.loads(json.dumps(harvest.source_json(app)))
    imported = wrap(written)
    sources = [form.source for form in app.get_forms()]
    read_back = [form.source for form in imported.get_forms()]
    assert len(read_back) == len(sources)
    for original, received in zip(sources, read_back, strict=True):
        if not original:
            assert not received
            continue
        assert etree.tostring(etree.fromstring(received.encode())) == etree.tostring(
            etree.fromstring(original.encode())
        )
