"""``hq-empty-search``: an app made in HQ whose search offers to register a patient when it finds none.

The journey ``no-matches-basic`` holds (``lib/commcare/__tests__/noMatchesWireFixture.ts``), made on HQ's own
pages, so a runtime's answer to it can be compared with its answer to Nova's publish:

1. A new app (``views/apps.py::default_new_app``), named "Patient registry" on the app page
   (``edit_app_attr``), with Web Apps on.
2. A case list menu "Patients" of the case type ``patient`` (``views/modules.py::new_module``), its registration
   form deleted (``views/forms.py::delete_form``) and its follow-up "Visit" holding a text question ``note``,
   written by HQ's own form writer (``xform_builder.py::XFormBuilder``) and uploaded on the form page. Its case
   list shows the name (``edit_module_detail_screens``). Its Search, saved on the Case List page: search first
   and inline (``auto_launch``, ``inline_search``), one field ``patient_name`` HQ does not match itself
   (``exclude``) and a row matching the case's name to it.
3. A case list menu "Register patient" of ``patient``, its follow-up deleted, its registration form holding a
   text question ``case_name`` whose case management names the case from it (``edit_form_actions``), and the
   menu hidden by its display condition ``false()`` (``edit_module_attr``'s ``module_filter``).
4. Patients' settings page (``edit_module_attr``) offers that form on its case list, labelled "Register patient",
   only when the search found nothing (``case_list_form_expression``, under
   ``FOLLOWUP_FORMS_AS_CASE_LIST_FORM``), and returns to the case list after it
   (``case_list_post_form_workflow`` ``case_list``, "Go back to case list").

Nova's publish of ``no-matches-basic`` uploads the same arrangement (``lib/commcare/expander.ts``'s
``case_list_form`` and ``emissionPlan.ts``'s hidden menu): the return to the list after the form is HQ's build of
it in both (``suite_xml/post_process/workflow.py::CaseListFormWorkflow``), so a runtime that lands elsewhere after
registering lands there on both.

The registration's question starts blank: no form HQ's writer makes declares the search's input instance.
"""

from __future__ import annotations

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.case_lists import _column, save_list
from proof.matrix.bases.search import field, one_question_source, save_search
from proof.matrix.registry import Base

NAME = "Patient registry"
CASE_TYPE = "patient"
FIELD = "instance('search-input:results:inline')/input/field[@name = 'patient_name']"
NAME_ROW = f"if(count({FIELD}), concat(\"case_name = '\", {FIELD}, \"'\"), 'match-all()')"
NO_MATCHES = "count(instance('results:inline')/results/case) = 0"


def build(authoring) -> str:
    from proof.hq import operations

    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.turn_web_apps_on(authoring, app_id)

    _pages.new_case_module(authoring, app_id, name="Patients", case_type=CASE_TYPE)
    _pages.delete_form(authoring, app_id, 0, 0)
    _pages.save_form_attributes(authoring, app_id, 0, 0, [("name", "Visit")], "name")
    ops.upload_form_source(authoring, app_id, 0, 0, one_question_source("note", "Note"), "m0-visit")
    save_list(authoring, app_id, 0, columns=[_column("name", "Name")], sort_elements=[])
    save_search(
        authoring,
        app_id,
        0,
        fields=[field("patient_name", "Patient name", exclude=True)],
        rows=[NAME_ROW],
        auto_launch=True,
        inline_search=True,
    )

    _pages.new_case_module(authoring, app_id, name="Register patient", case_type=CASE_TYPE)
    _pages.delete_form(authoring, app_id, 1, 1)
    _pages.save_form_attributes(authoring, app_id, 1, 0, [("name", "Register patient")], "name")
    ops.upload_form_source(authoring, app_id, 1, 0, one_question_source("case_name", "Name"), "m1-register")
    _pages.save_case_actions(authoring, app_id, 1, 0, name_path="/data/case_name")
    _pages.save_module_attributes(authoring, app_id, 1, [("module_filter", "false()")], "display condition")

    registration = operations.held_app(authoring.state, app_id).get_module(1).get_form(0).unique_id
    _pages.save_module_attributes(
        authoring,
        app_id,
        0,
        [
            ("case_list_form_id", registration),
            ("case_list_form_label", "Register patient"),
            ("case_list_form_expression", NO_MATCHES),
            ("case_list_post_form_workflow", "case_list"),
        ],
        "register after an empty search",
    )
    return app_id


BASE = Base(
    id="hq-empty-search",
    build=build,
    configuration=Configuration(
        flags=frozenset({"FOLLOWUP_FORMS_AS_CASE_LIST_FORM", "SYNC_SEARCH_CASE_CLAIM", "CASE_SEARCH_ADVANCED"}),
        privileges=frozenset({"CLOUDCARE"}),
        case_search_enabled=True,
    ),
    # What its forms show: the case list form's own entries stand on the case list, which a base read as Web Apps
    # only (its forms read an inline search) cannot carry a case list expectation of, and are exhibited by
    # hq-menus; this base is the runtime's comparison.
    exhibits=(
        "questions/text-input-xsd-string",
        "forms-and-case-writes/open-case-name-update-question-path",
    ),
)
