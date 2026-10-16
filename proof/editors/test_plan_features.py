"""The plan privileges Nova's publish asks a person to confirm, as HQ's own pages and Vellum show their absence.

Contract: Nova's publish asks the person to confirm each plan privilege an
app needs (``lib/commcare/planPrivileges.ts::requiredPlanPrivileges``),
because no API key reads a plan, and each one's consequence says what a
person meets in HQ without it. HQ's build is unchanged without these four;
its editors are not:

- ``child_cases`` on ``case-capture-query``: the form's Case Management page
  shows its child cases under HQ's notice that they stay un-editable, with
  no control to add or remove one (``add_ons.py::_ADD_ONS["subcases"]``,
  ``partials/forms/case_config.html``), and its save keeps them;
- ``form_link_workflow`` on ``form-link-unconditional``: the form settings
  save posts no link, and the same request carrying a changed link leaves
  the link as Nova wrote it (``views/forms.py::_edit_form_attr``);
- ``save_to_case`` on ``case-operation-query``: Vellum loads without its
  ``saveToCase`` plugin (``views/formdesigner.py::_get_vellum_plugins``) and
  its save drops the ``@case_id``, ``@date_modified`` and ``@user_id`` binds of
  every Save to Case block;
- ``lookup_tables`` on ``case-choice-attendance``: Vellum reports its Lookup
  Tables error on each question whose choices are cases
  (``src/itemset.js``, ``Itemset.itemsetData.validationFunc``, given
  ``features.lookup_tables`` by ``views/formdesigner.py``), and its save keeps
  the itemsets, though HQ's build passes such a form.

Each runs on a plan without the privilege and, the accepted case, on the
same plan with it. The plausible failures: a privilege whose absence HQ's
editors do not show (then Nova asks about nothing a person meets), and a
reading of a page or of Vellum that never loaded what the privilege decides.
"""

from __future__ import annotations

import dataclasses
import json
from contextlib import contextmanager
from urllib.parse import parse_qsl

from lxml import etree

from proof.editors import pages, vellum
from proof.editors.conftest import corpus_document, record_timing
from proof.hq import operations
from proof.hq.check import hq_check

XFORMS = "http://www.w3.org/2002/xforms"
# What every form page offers whatever the plan: the Case Management section's Save bar.
ALWAYS = pages.CASE_MANAGEMENT.bar
CHILD_CASE_CONTROLS = {
    "add": 'a[data-bind="click: addSubCase"]',
    "remove": "a.case-action-remove",
    "always": ALWAYS,
}
# The case binds of a Save to Case block, by the attribute each binds.
CASE_BIND_ATTRIBUTES = ("@case_id", "@date_modified", "@user_id")
LOOKUP_TABLES_ERROR = "You no longer have access to Lookup Tables in your application."


@dataclasses.dataclass(frozen=True)
class _Opened:
    state: object
    app_id: str


@contextmanager
def _published(document, privilege, granted):
    """``document`` as Nova's first publish leaves it, on its plan with ``privilege`` or without it."""
    from proof.observe import publish

    configuration = document.exports["minimum"].configuration.hq()
    assert privilege in configuration.privileges, (document.id, sorted(configuration.privileges))
    if not granted:
        configuration = dataclasses.replace(configuration, privileges=frozenset(configuration.privileges - {privilege}))
    with hq_check(configuration) as (state, _):
        app_id, refusal, _ = publish.create(state, document.exports["minimum"])
        assert refusal is None, refusal
        yield _Opened(state, app_id)


def _offered(driver, state, app_id, form_id, selectors):
    """How many of each selector the form's page holds, loaded in Chromium by HQ's own page view."""
    from django.urls import reverse

    from proof.editors.hq import HQAnswers, editor_build

    editor_build()
    answers = HQAnswers(state)
    run = driver.run(
        [
            {"goto": reverse("view_form", args=[state.domain, app_id, form_id])},
            {"until": "pages/ready", "arg": {"bar": ALWAYS}},
            {"settle": True},
            {"call": "pages/offered", "arg": dict(selectors)},
        ],
        answer=answers,
    )
    answers.check()
    return {name: counted["held"] for name, counted in run["outcomes"][-1]["value"].items()}


def _form(state, app_id, holds):
    found = [form for form in operations.held_app(state, app_id).get_forms() if holds(form)]
    assert found, "the app holds no form with the content under test"
    return found[0]


def _subcases(form):
    """What a form's child cases are: each one's case type, the properties it writes, and its index. An index named
    by no reference id is the default parent one, whether the save spells the id empty or absent."""
    return [
        (subcase.case_type, sorted(subcase.case_properties), subcase.reference_id or None, subcase.relationship)
        for subcase in form.actions.subcases
    ]


def test_without_child_cases_hqs_page_keeps_a_forms_child_cases_and_offers_no_change(hq, core_runner, editor_driver):
    document = corpus_document("case-capture-query")
    found = {}
    for granted in (True, False):
        with _published(document, "CHILD_CASES", granted) as opened:
            form = _form(opened.state, opened.app_id, lambda form: bool(form.actions.subcases))
            before = _subcases(form)
            offered = _offered(editor_driver, opened.state, opened.app_id, form.unique_id, CHILD_CASE_CONTROLS)
            saved = pages.fresh_section_save(
                editor_driver, opened.state, pages.CASE_MANAGEMENT, opened.app_id, form.unique_id
            )
            record_timing("page_save:case management", saved.seconds)
            after = _form(
                opened.state, opened.app_id, lambda held, unique_id=form.unique_id: held.unique_id == unique_id
            )
            found[granted] = {
                "offered": {name: count > 0 for name, count in offered.items()},
                "saved": saved.save is not None and saved.save.status == 200 and not saved.refused,
                "kept": _subcases(after) == before,
            }
    assert found == {
        True: {"offered": {"add": True, "remove": True, "always": True}, "saved": True, "kept": True},
        False: {"offered": {"add": False, "remove": False, "always": True}, "saved": True, "kept": True},
    }, found


def test_without_the_form_link_workflow_a_changed_link_is_not_stored(hq, core_runner, editor_driver):
    document = corpus_document("form-link-unconditional")
    found = {}
    for granted in (True, False):
        with _published(document, "FORM_LINK_WORKFLOW", granted) as opened:
            state, app_id = opened.state, opened.app_id
            form = _form(state, app_id, lambda form: bool(form.form_links))
            (link,) = form.form_links
            target = link.form_id or link.module_unique_id
            saved = pages.fresh_section_save(editor_driver, state, pages.FORM_SETTINGS, app_id, form.unique_id)
            record_timing("page_save:form settings", saved.seconds)
            posted = [name for name, _ in parse_qsl((saved.save.body or b"").decode("utf-8"), keep_blank_values=True)]
            held = _form(state, app_id, lambda held, unique_id=form.unique_id: held.unique_id == unique_id)
            kept = (held.post_form_workflow, [(each.xpath, each.form_id) for each in held.form_links])
            # The same request carrying a changed link, as the page posts one under the privilege.
            pairs = [
                (name, value)
                for name, value in parse_qsl((saved.save.body or b"").decode("utf-8"), keep_blank_values=True)
                if not name.startswith("form_links_") and name != "datums_json"
            ]
            pairs += [
                ("form_links_xpath_expressions", "1 = 1"),
                ("form_links_form_ids", target),
                ("datums_json", "[]"),
            ]
            with state.committing():
                answered = operations.session_post(state, "edit_form_attr", app_id, form.unique_id, "all", pairs=pairs)
            changed = _form(state, app_id, lambda held, unique_id=form.unique_id: held.unique_id == unique_id)
            found[granted] = {
                "postsLinks": any(name.startswith("form_links_") for name in posted),
                "keptAfterSave": kept == ("form", [(link.xpath, link.form_id)]),
                "changedStatus": answered.status_code,
                "changed": [each.xpath for each in changed.form_links],
            }
    assert found[True]["postsLinks"] and found[True]["keptAfterSave"], found
    assert found[True]["changed"] == ["1 = 1"], found
    assert found[False]["postsLinks"] is False and found[False]["keptAfterSave"], found
    assert found[False]["changedStatus"] == 200 and "1 = 1" not in found[False]["changed"], found


def _case_binds(source):
    """The nodesets of a form's binds onto a Save to Case block's case attributes."""
    root = etree.fromstring(source.encode("utf-8"))
    return sorted(
        bind.get("nodeset")
        for bind in root.iter(f"{{{XFORMS}}}bind")
        if (bind.get("nodeset") or "").rsplit("/", 1)[-1] in CASE_BIND_ATTRIBUTES
    )


def test_without_save_to_case_vellums_save_drops_each_blocks_case_binds(hq, core_runner, editor_driver):
    document = corpus_document("case-operation-query")
    found = {}
    for granted in (True, False):
        with _published(document, "VELLUM_SAVE_TO_CASE", granted) as opened:
            form = _form(opened.state, opened.app_id, lambda form: 'vellum:role="SaveToCase"' in (form.source or ""))
            before = _case_binds(form.source)
            assert before, "the form holds no Save to Case block's case binds"
            run = vellum.fresh_open_and_save(editor_driver, opened.state, opened.app_id, form.unique_id)
            record_timing("vellum:save to case", run.seconds.get("run", 0))
            assert run.loaded and run.saved, (run.load_error, run.save_refusal)
            found[granted] = (before, _case_binds(run.stored_source))
    assert found[True][1] == found[True][0], found
    assert found[False][1] == [], found


def _itemsets(source):
    return len(list(etree.fromstring(source.encode("utf-8")).iter(f"{{{XFORMS}}}itemset")))


def test_without_lookup_tables_vellum_reports_each_question_whose_choices_are_cases(hq, core_runner, editor_driver):
    document = corpus_document("case-choice-attendance")
    found = {}
    for granted in (True, False):
        with _published(document, "LOOKUP_TABLES", granted) as opened:
            forms = [
                form
                for form in operations.held_app(opened.state, opened.app_id).get_forms()
                if form.source and _itemsets(form.source)
            ]
            counted = {"itemsets": 0, "reported": 0, "kept": 0}
            for form in forms:
                counted["itemsets"] += _itemsets(form.source)
                run = vellum.fresh_open_and_save(editor_driver, opened.state, opened.app_id, form.unique_id)
                assert run.loaded and run.saved, (run.load_error, run.save_refusal)
                # Vellum reports the error on each question's itemset, a mug of its own with no path.
                counted["reported"] += sum(
                    1
                    for question in run.questions
                    if any(
                        message["level"] == "error" and LOOKUP_TABLES_ERROR in message["message"]
                        for message in question["messages"]
                    )
                )
                counted["kept"] += _itemsets(run.stored_source)
            found[granted] = counted
    assert found == {
        True: {"itemsets": 3, "reported": 0, "kept": 3},
        False: {"itemsets": 3, "reported": 3, "kept": 3},
    }, json.dumps(found)
