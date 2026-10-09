"""Every section saved from one load of its view, its save held, equals the same section saved from a fresh page.

Contract: ``run_view`` loads an app-manager view once on the driver's reused
page, arms and clicks every offered section with its save held, and releases
the saves one at a time, each into its own fork of the view's state. For
every section that must be what ``fresh_section_save`` gives (a fresh browser
context, the page loaded for that section alone, every request routed
through Playwright) over the same state: the same save request body, the same
answer from HQ, the same Save button state, the same alerts added, the same
page errors and dialogs, and the same messages from HQ's views. The plausible
failures: an earlier section's answer reaching a later section's request or
verdict through the shared page (a success handler touching another section,
an alert counted for the wrong section); the reused page carrying something
from the view before it (storage, cookies, a document the driver did not
leave); the HTTP origin answering a request differently from the routing it
replaces; a request the page makes after a save answered outside that save's
fork.

The views are those of HQ's own test apps (basic and advanced modules, case
search, UI translations, a two-language app) and of a sample of corpus
documents covering the three views, case management, user properties, a
module with search, a multilingual app (Nova emits no advanced module) and
a form whose settings save HQ's view raises on. Views whose saves HQ does
not take are compared too, beside a section HQ takes on the same view: a
save HQ's view raises on (answered 500), one it refuses with an alert
(answered 400, on the same save view as the next section's), and two
sections that each add the same alert. On both pages an HQ view that raised
is the section's answer, as the page saw it, not a failure of the run.
Each runs in the order a lane runs them, one view after another on the same
reused page. HQ runs under its determinism (``proof.editors.units``) and
draws a page render's CSRF token from the page's request
(``proof.editors.hq.csrf_drawn_from``), so the token is the same on both
pages and the bodies are compared byte for byte; with the determinism off
(``PROOF_HQ_DETERMINISM=0``) the token is Django's own draw and is masked
(``pages.section_differences``).

The in-band audit (``PROOF_EDITOR_AUDIT``) reruns a fraction of sections the
fresh way and fails on a difference; it is checked to rerun what it chose, to
fail on a difference it is shown, and to keep a section HQ's view raised on
as that section's answer, as the view without the audit keeps it.
"""

from __future__ import annotations

from contextlib import nullcontext

import pytest

from proof.editors import pages
from proof.editors.conftest import (
    TWO_LANGUAGE_APP,
    advanced_app,
    app_views,
    form_view_hq_raises_on,
    module_view_hq_refuses,
    proof4_offers,
    publish_hq_app,
    record_timing,
    suite_app,
    user_properties_form,
)
from proof.editors.hq import HQAnswers
from proof.editors.units import CheckUnit
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
# The User Properties tab is on the form page only when the project has
# USERCASE (form_view.html), and HQ's suite app's first form, whose user case
# actions name no question, breaks the page's case configuration there
# (case_config_ui.js::to_case_transaction); its follow-up form is the one a
# user property is written from.
USERCASE_CONFIGURATION = Configuration(privileges={"CLOUDCARE", "USERCASE"})

# Corpus documents whose views together cover the app settings, module and
# form views, case management, user properties, a module that searches, a
# multilingual app, and form settings HQ's save view raises on
# (case-extension-multiple-repeat's forms: proof 4 reports them broken).
CORPUS_SAMPLE = (
    "case-operation-scalar",
    "case-worker-followup",
    "search-parent",
    "tile",
    "localization-bilingual",
    "case-extension-multiple-repeat",
)
# What the page shows when a save's answer is an error without a message of
# its own (hqwebapp/js/bootstrap3/main.js, SaveButton.message.ERROR_SAVING).
ERROR_SAVING = "There was an error saving"
SAVED = "savebtn-bar-saved"
RETRY = "savebtn-bar-retry"


def held_and_fresh(driver, unit, spec):
    """The view's sections held from one load, and each saved from a fresh page, all over the same state.

    On both, an HQ view that raised is the section's answer (``harness_only``).
    """
    with unit.fork():
        view = pages.run_view(driver, HQAnswers(unit.state, unit), spec, on_section=lambda _index: unit.fork())
    fresh = []
    for page in spec.sections:
        with unit.fork():
            fresh.append(
                pages.fresh_section_save(
                    driver,
                    unit.state,
                    page,
                    spec.app_id,
                    spec.target,
                    unit=unit,
                    cookies=dict(spec.cookies),
                    harness_only=True,
                )
            )
    return view, fresh


def assert_equivalent(driver, unit, spec):
    view, fresh = held_and_fresh(driver, unit, spec)
    record_timing(f"view:{spec.view}", view.seconds["view"])
    assert [saved.page for saved in view.sections] == list(spec.sections)
    for held, alone in zip(view.sections, fresh, strict=True):
        assert pages.section_differences(held, alone) == [], held.page.name
        # The section reached HQ's save view and the page took the answer.
        assert held.save.url_name == held.page.save
        assert held.bar_state in (SAVED, RETRY)
    return view


# The advanced app's views are those the editors' own tests open
# (test_pages.py): its advanced module and that module's first form.
@pytest.mark.parametrize(
    ("prepare", "modules", "forms", "expected"),
    [
        pytest.param(
            suite_app,
            None,
            None,
            {
                "app settings",
                "add-ons",
                "UI translations",
                "module settings",
                "case list",
                "case detail",
                "form settings",
                "case management",
            },
            id="suite app",
        ),
        pytest.param(
            advanced_app,
            {1},
            {(1, 0)},
            {"module settings", "case list", "form settings", "case management (advanced)"},
            id="advanced app",
        ),
    ],
)
def test_held_sections_of_hqs_test_apps_equal_fresh_page_saves(
    hq, core_runner, editor_driver, prepare, modules, forms, expected
):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        app_id = prepare(state)
        app = operations.held_app(state, app_id)
        sections, frames = set(), []
        for spec in app_views(state, app, modules=modules, forms=forms):
            view = assert_equivalent(editor_driver, unit, spec)
            sections.update(saved.page.name for saved in view.sections)
            frames += [r["url"] for r in view.outputs["requests"] if r["answeredBy"] == "frame-not-loaded"]
            # A frame the page embeds never reaches HQ: the origin gives it an empty document.
            assert not [e for e in view.exchanges if e.url in frames]
    assert expected <= sections, sections
    # The pages embed App Preview, a frame the origin told from the page's own navigation.
    assert frames and all("/cloudcare/apps/preview_app/" in url for url in frames), frames


def test_held_user_properties_equal_fresh_page_saves(hq, core_runner, editor_driver):
    with hq_check(USERCASE_CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        app_id, form_id = user_properties_form(state)
        app = operations.held_app(state, app_id)
        offered = proof4_offers(state, app, "form", app.get_form(form_id))
        assert pages.USER_PROPERTIES in offered, offered
        spec = pages.ViewSpec("view_form", app_id, form_id, sections=(pages.USER_PROPERTIES,))
        assert_equivalent(editor_driver, unit, spec)


def test_a_two_language_app_held_in_its_second_language_equals_fresh_page_saves(hq, core_runner, editor_driver):
    """HQ's two-language test app, its pages opened with the second language as the display language."""
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        app = operations.held_app(state, app_id)
        assert app.langs == ["en", "es"]
        for spec in app_views(state, app, cookies={"lang": "es"}):
            view, fresh = held_and_fresh(editor_driver, unit, spec)
            for held, alone in zip(view.sections, fresh, strict=True):
                assert pages.section_differences(held, alone) == [], held.page.name


# Corpus documents ---------------------------------------------------------------------------------


def _corpus_document(document_id):
    from proof.checks import cases

    return cases.load_corpus().document(document_id)


@pytest.mark.parametrize("document_id", CORPUS_SAMPLE)
def test_held_sections_of_corpus_documents_equal_fresh_page_saves(hq, core_runner, editor_driver, document_id):
    from proof.observe import publish

    document = _corpus_document(document_id)
    export = document.exports["minimum"]
    with hq_check(export.configuration.hq()) as (state, _):
        unit = CheckUnit(state)
        # Nova's first publish of D, then its republish over it (B), as the unit applies them.
        app_id, refusal, _ = publish.create(state, export)
        assert app_id is not None, refusal
        refusal, _ = publish.update(state, app_id, export.republish, "B")
        assert refusal is None, refusal
        for spec in app_views(state, operations.held_app(state, app_id)):
            assert_equivalent(editor_driver, unit, spec)


# Saves HQ does not take ----------------------------------------------------------------------------


def test_a_section_hqs_view_raises_on_held_beside_one_it_takes_equals_fresh_page_saves(hq, core_runner, editor_driver):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        view = assert_equivalent(editor_driver, unit, form_view_hq_raises_on(state))
    settings, management = view.sections
    assert (settings.save.status, settings.save.raised) == (500, "jsonobject.exceptions.BadValueError")
    assert settings.bar_state == RETRY
    assert len(settings.alerts) == 1 and ERROR_SAVING in settings.alerts[0], settings.alerts
    assert (management.save.status, management.bar_state, management.alerts) == (200, SAVED, [])


def test_a_section_hqs_view_refuses_held_beside_one_on_the_same_save_view_equals_fresh_page_saves(
    hq, core_runner, editor_driver
):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        view = assert_equivalent(editor_driver, unit, module_view_hq_refuses(state))
    settings, case_list, case_detail = view.sections
    assert case_list.refused and case_list.save.status == 400 and case_list.bar_state == RETRY
    assert len(case_list.alerts) == 1, case_list.alerts
    assert "Please fix the errors in xpath expression" in case_list.alerts[0], case_list.alerts
    assert case_detail.save.url_name == case_list.save.url_name
    for saved in (settings, case_detail):
        assert (saved.save.status, saved.refused, saved.bar_state, saved.alerts) == (200, False, SAVED, [])


def test_two_sections_adding_the_same_alert_held_equal_fresh_page_saves(hq, core_runner, editor_driver):
    """Both of a form view's saves fail in HQ's views, so each section adds the same alert: held from one load,
    the second's is counted once, for the second, as a fresh page counts it."""
    from unittest import mock

    from corehq.apps.app_manager.views import forms

    def get_app_failing(*args, **kwargs):
        raise RuntimeError("HQ could not read the app")

    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        spec = form_view_hq_raises_on(state)
        # HQ's form save views (edit_form_attr, edit_form_actions) read the app through it; the page view does not.
        with mock.patch.object(forms, "get_app", get_app_failing):
            view = assert_equivalent(editor_driver, unit, spec)
    for saved in view.sections:
        assert (saved.save.status, saved.save.raised, saved.bar_state) == (500, "builtins.RuntimeError", RETRY)
        assert len(saved.alerts) == 1 and ERROR_SAVING in saved.alerts[0], saved.alerts
    # By the end the page showed the alert twice, once for each section.
    shown = view.outputs["sections"][-1]["after"]["alerts"]
    assert len([alert for alert in shown if ERROR_SAVING in alert]) == 2, shown


# The in-band audit -------------------------------------------------------------------------------


def test_the_audit_reruns_the_sections_it_chooses_and_fails_on_a_difference(
    hq, core_runner, editor_driver, monkeypatch
):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        app_id = suite_app(state)
        module = operations.held_app(state, app_id).modules[0]
        spec = pages.ViewSpec(
            "view_module", app_id, module.unique_id, sections=(pages.MODULE_SETTINGS, pages.CASE_LIST)
        )
        rerun = []
        fresh_save = pages.fresh_section_save

        def counted(*args, **kwargs):
            saved = fresh_save(*args, **kwargs)
            rerun.append(saved.page.name)
            return saved

        monkeypatch.setattr(pages, "fresh_section_save", counted)
        monkeypatch.setenv(pages.AUDIT_ENVIRONMENT, "1")
        with unit.fork():
            pages.run_view(editor_driver, HQAnswers(state, unit), spec, on_section=lambda _index: unit.fork())
        assert rerun == ["module settings", "case list"]

        def different(*args, **kwargs):
            saved = fresh_save(*args, **kwargs)
            saved.bar_state = RETRY
            return saved

        monkeypatch.setattr(pages, "fresh_section_save", different)
        with unit.fork(), pytest.raises(pages.EditorAuditMismatch, match="Save button state"):
            pages.run_view(editor_driver, HQAnswers(state, unit), spec, on_section=lambda _index: nullcontext())


def test_the_audit_keeps_a_section_hqs_view_raised_on_as_the_sections_answer(
    hq, core_runner, editor_driver, monkeypatch
):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        spec = form_view_hq_raises_on(state)
        rerun = []
        fresh_save = pages.fresh_section_save

        def counted(*args, **kwargs):
            saved = fresh_save(*args, **kwargs)
            rerun.append(saved.page.name)
            return saved

        monkeypatch.setattr(pages, "fresh_section_save", counted)
        monkeypatch.setenv(pages.AUDIT_ENVIRONMENT, "1")
        with unit.fork():
            view = pages.run_view(editor_driver, HQAnswers(state, unit), spec, on_section=lambda _index: unit.fork())
    assert rerun == ["form settings", "case management"]
    assert [(saved.save.status, saved.bar_state) for saved in view.sections] == [(500, RETRY), (200, SAVED)]


# A save that sends the page elsewhere ----------------------------------------------------------------


def _child_under_a_shadowed_parent(state, app_id):
    """A child module of module 0, and a shadow of module 0 that has no shadow of the child yet.

    Saving the child's settings (its parent unchanged) has HQ give the shadow
    the child it lacks and answer with ``redirect``
    (views/modules.py::edit_module_attr, ``handle_shadow_child_modules``).
    """
    from corehq.apps.app_manager.models import Module, ShadowModule

    app = operations.held_app(state, app_id)
    parent = app.modules[0]
    child = app.add_module(Module.new_module("Child", "en"))
    child.case_type = parent.case_type
    child.root_module_id = parent.unique_id
    child.case_details = type(parent.case_details).wrap(parent.case_details.to_json())
    shadow = app.add_module(ShadowModule.new_module("Shadow", "en"))
    shadow.source_module_id = parent.unique_id
    shadow.shadow_module_version = 2
    app.save()
    app = operations.held_app(state, app_id)
    app.ensure_module_unique_ids(should_save=True)
    return operations.held_app(state, app_id).modules[1].unique_id


def test_a_save_hq_answers_with_a_redirect_is_followed_and_the_held_sections_are_saved_from_their_own_loads(
    hq, core_runner, editor_driver
):
    with hq_check(CONFIGURATION) as (state, _):
        unit = CheckUnit(state)
        app_id = suite_app(state)
        child = _child_under_a_shadowed_parent(state, app_id)
        spec = pages.ViewSpec(
            "view_module", app_id, child, sections=(pages.MODULE_SETTINGS, pages.CASE_LIST, pages.CASE_DETAIL)
        )
        view, fresh = held_and_fresh(editor_driver, unit, spec)
    assert view.outputs["redirected"]["section"] == 0
    # The redirect is followed in the section's own phase: HQ renders the page again inside its fork.
    assert "view_module" in [e.url_name for e in view.sections[0].exchanges if e.phase == "followup:0"]
    assert view.redone == [1, 2] and view.transcript is None
    for held, alone in zip(view.sections, fresh, strict=True):
        assert pages.section_differences(held, alone) == [], held.page.name
        assert held.bar_state == SAVED
