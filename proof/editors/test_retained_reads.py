"""HQ's own reads of an app after each of its pages is saved with nothing changed, retained byte for byte
(``proof/hq-reads/``).

Contract: decision 7 of part 02 (Work item B: the drift check and its
baselines) states, page by page, what a save in CommCare HQ that changes no
value leaves in the app's source, and Nova's drift comparison
(``lib/deployment/hqSourceBaseline.ts::diffHqAppSource``) is proven to read
each save as that table says over HQ's own answers
(``lib/deployment/__tests__/hqSourceBaseline.test.ts``). This module makes
those answers: ``navigation-base`` as Nova's first publish leaves it (one
menu holding the follow-up form ``Visit`` and the registration form
``Register``), and in a fork of that state for each page, the page loaded
and saved through HQ's own view with nothing changed (``conftest.save_section``,
``vellum.open_and_save`` for the form builder), then the app's source read as
Nova reads it (``navigation-base/app-source-after-<page>-save.json``); and
the empty shell ``navigation-base``'s create makes, saved on its App Settings
page (``shell/app-source-after-app-settings-save.json``). The project space is
the document's configuration with the Web Apps privilege beside it, which the
pages need to offer every section. Each read is an operation of its own
(``proof.hq.determinism``), written to the run's output and held to the
committed file byte for byte, so a pin that changes what a save leaves fails
here (``proof/hq/test_retained_reads.py::Retained``).

The plausible failures: a page saved with a change in it (so the read shows
the change, not the save), a save that never reached HQ's view, a read made
in the state another page's save left, and a committed read left stale by a
pin move.
"""

from __future__ import annotations

import dataclasses

import pytest

from proof.editors import pages, vellum
from proof.editors.conftest import DOCUMENTS, corpus_document, save_section
from proof.editors.test_view_equivalence import CORPUS_SAMPLE
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.test_retained_reads import READS, Retained, _operation, _services

DOCUMENT = "navigation-base"
MEMBER = "member@example.org"
# The privilege the editors' pages need to offer every section of the app (``CLOUDCARE``).
WEB_APPS = "CLOUDCARE"


def _document():
    return corpus_document(DOCUMENT)


def _with_web_apps(export):
    configuration = export.configuration.hq()
    return dataclasses.replace(configuration, privileges=configuration.privileges | {WEB_APPS})


def _menu_and_forms(state, app_id):
    """The one menu's unique id, and its follow-up form's and its registration form's."""
    menu = operations.held_app(state, app_id).get_module(0)
    visit = next(form for form in menu.get_forms() if form.requires_case())
    register = next(form for form in menu.get_forms() if not form.requires_case())
    return menu.unique_id, visit.unique_id, register.unique_id


def test_the_package_key_names_every_document_its_tests_read():
    assert set(CORPUS_SAMPLE) <= set(DOCUMENTS)


@pytest.mark.under_determinism
def test_hqs_reads_after_each_page_saved_with_nothing_changed_are_retained(hq, core_runner, editor_driver):
    from proof.observe import publish

    export = _document().exports["minimum"]
    retained = Retained(DOCUMENT)
    shell = Retained("shell")
    saved = {}
    with hq_check(_with_web_apps(export)) as (state, _), _services(state):
        with _operation(state, "api-user"):
            member = operations.seed_api_user(state, MEMBER)
        with _operation(state, "first-publish"):
            app_id, refusal, _ = publish.create(state, export)
        assert refusal is None, refusal
        menu, visit, register = _menu_and_forms(state, app_id)
        saves = (
            ("app-settings", pages.APP_SETTINGS, None),
            ("ui-translations", pages.UI_TRANSLATIONS, None),
            ("case-management-visit", pages.CASE_MANAGEMENT, visit),
            ("case-management-register", pages.CASE_MANAGEMENT, register),
            ("add-ons", pages.ADD_ONS, None),
            ("menu-settings", pages.MODULE_SETTINGS, menu),
            ("case-list", pages.CASE_LIST, menu),
            ("case-detail", pages.CASE_DETAIL, menu),
            ("form-settings", pages.FORM_SETTINGS, visit),
        )
        for name, page, target in saves:
            with state.fork():
                with _operation(state, f"save-{name}"):
                    saved[name] = save_section(editor_driver, state, page, app_id, target).save
                with _operation(state, f"read-{name}"):
                    retained.keep(f"app-source-after-{name}-save", operations.source_read(state, app_id, member))
        with state.fork():
            with _operation(state, "save-form-builder"):
                run = vellum.open_and_save(editor_driver, state, app_id, visit)
            with _operation(state, "read-form-builder"):
                retained.keep("app-source-after-form-builder-save", operations.source_read(state, app_id, member))
        with _operation(state, "shell"):
            shell_id = operations.apply_upload(state, export.create.upload()).response["app_id"]
        with _operation(state, "save-shell-app-settings"):
            saved["shell"] = save_section(editor_driver, state, pages.APP_SETTINGS, shell_id).save
        with _operation(state, "read-shell-app-settings"):
            shell.keep("app-source-after-app-settings-save", operations.source_read(state, shell_id, member))

    for name, save in saved.items():
        assert save is not None and save.status == 200, (name, save)
    assert run.loaded and run.saved and run.save_button == "saved", (run.load_error, run.save_refusal)
    retained.hold(READS / DOCUMENT, others=lambda name: not name.endswith("-save"))
    shell.hold(READS / "shell", others=lambda name: not name.endswith("-save"))
