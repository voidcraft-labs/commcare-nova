"""``hq-advanced``: an app made in HQ whose advanced menus load a two-menu chain, with HQ's own models.

1. A new app (``views/apps.py::default_new_app``), named "Member visits" on
   the app page (``edit_app_attr``).
2. A case list menu "Households" of the case type ``household``
   (``views/modules.py::new_module``). Its registration form names the case;
   its follow-up form saves ``village`` and opens a ``member`` child case
   (``views/forms.py::edit_form_actions``), and then the write of ``village``
   is stored with ``update_mode`` ``edit`` through HQ's model.
3. Two advanced menus of the case type ``member``, each added as the add
   menu's Advanced posts it (``views/modules.py::new_module`` with
   ``module_type`` ``advanced``, ``_new_advanced_module``, which adds one
   form) and given its case type with HQ's model. Each form's loads, made
   with HQ's models (``models/form_actions.py::LoadUpdateAction``,
   ``CaseIndex``), are the menu's chain: the household chosen in
   "Households" (``load_household0``, the tag HQ's page gives a load,
   ``forms/advanced/case_config_ui.js::addFormAction``), then the member
   chosen under it in the form's own menu (``load_member1``, indexed to the
   household's load as ``parent``):

   - "Member visits": the form writes the household's
     ``last_member_visit`` on its load, stored with ``update_mode`` ``edit``,
     loads the member's ``age`` into a question no later default reads, and
     writes the member's ``notes``;
   - "Member reviews": the household's load is read only, and the form writes
     the member's ``review_note``.

Each form's source is written by HQ's own form writer
(``xform_builder.py::XFormBuilder``), uploaded on the form page and saved in
the form builder. The project space does not hold
``SAVE_ONLY_EDITED_FORM_FIELDS``, so the flag read answers ``not-applied``:
the basic write stored ``edit`` reads as saved every time, and the advanced
one is read past. Its configuration is the lane's floor with ``CHILD_CASES``,
under which the Case Management tab offers child cases
(``proof/checks/configurations.py::_needs_child_cases``). Web Apps stays off,
as ``Application.cloudcare_enabled`` defaults, and its content runs on
Android, so its preselected declaration is Android only.
"""

from __future__ import annotations

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Member visits"
HOUSEHOLD_LOAD = "load_household0"
MEMBER_LOAD = "load_member1"


def _source(*questions):
    """A source of ``questions`` (``(name, label, data type)`` each), as ``XFormBuilder`` writes it."""

    def write(name):
        from corehq.apps.app_manager.xform_builder import XFormBuilder

        xform = XFormBuilder(name)
        for question_name, label, data_type in questions:
            xform.new_question(question_name, label, data_type)
        return xform.tostring(xml_declaration=True).decode("utf-8")

    return write


REGISTRATION = _source(("head_name", "Head of household", "string"))
HOUSEHOLD_VISIT = _source(("village", "Village", "string"), ("new_member", "New member", "string"))
MEMBER_VISIT = _source(
    ("visited_on", "Visited on", "date"),
    ("age_seen", "Age on record", "int"),
    ("notes", "Notes", "string"),
)
MEMBER_REVIEW = _source(("review_note", "Review note", "string"))


def new_advanced_module(authoring, app_id, name):
    """An advanced menu named ``name``, as the add menu's Advanced posts it (``views/modules.py::new_module`` with
    ``module_type`` ``advanced``, which adds one form, "Untitled Form")."""
    pairs = [("module_type", "advanced"), ("name", name)]
    with authoring.step(f"build:new-advanced-module:{name}", json.dumps(pairs).encode()):
        body, content_type = ops.form_body(pairs)
        ops.post(authoring, "new_module", [app_id], body, content_type, "a new advanced menu", redirects=True)


def _member_type(menu):
    def change(app):
        app.get_module(menu).case_type = "member"

    return change


def _village_saved_only_if_changed(app):
    """The household follow-up form's write of ``village`` stored with ``update_mode`` ``edit``."""
    from corehq.apps.app_manager.models import ConditionalCaseUpdate

    update = app.get_module(0).get_form(1).actions.update_case.update
    update["village"] = ConditionalCaseUpdate(question_path=update["village"].question_path, update_mode="edit")


def _loads(menu, *, household_writes, member_writes, preload=None):
    """The menu's form's loads: the household chosen in "Households", then the member chosen in the menu, indexed
    to it."""

    def change(app):
        from corehq.apps.app_manager.models import CaseIndex, ConditionalCaseUpdate, LoadUpdateAction

        def writes(mapping):
            return {
                prop: ConditionalCaseUpdate(question_path=path, update_mode=mode)
                for prop, (path, mode) in mapping.items()
            }

        households = app.get_module(0)
        module = app.get_module(menu)
        module.get_form(0).actions.load_update_cases = [
            LoadUpdateAction(
                case_type="household",
                case_tag=HOUSEHOLD_LOAD,
                details_module=households.unique_id,
                case_properties=writes(household_writes),
            ),
            LoadUpdateAction(
                case_type="member",
                case_tag=MEMBER_LOAD,
                details_module=module.unique_id,
                case_index=CaseIndex(tag=HOUSEHOLD_LOAD, reference_id="parent", relationship="child"),
                preload=dict(preload or {}),
                case_properties=writes(member_writes),
            ),
        ]

    return change


def _member_child(actions):
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, FormActionCondition, OpenSubCaseAction

    actions["subcases"] = [
        OpenSubCaseAction(
            case_type="member",
            name_update=ConditionalCaseUpdate(question_path="/data/new_member"),
            repeat_context="",
            relationship="child",
            condition=FormActionCondition(type="always"),
        ).to_json()
    ]


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.new_case_module(authoring, app_id, name="Households", case_type="household")
    new_advanced_module(authoring, app_id, "Member visits")
    new_advanced_module(authoring, app_id, "Member reviews")
    for menu in (1, 2):
        _pages.change_app_model(authoring, app_id, f"member-type:{menu}", _member_type(menu))
    for (menu, form), write, what in (
        ((0, 0), REGISTRATION, "registration-source"),
        ((0, 1), HOUSEHOLD_VISIT, "household-visit-source"),
        ((1, 0), MEMBER_VISIT, "member-visit-source"),
        ((2, 0), MEMBER_REVIEW, "member-review-source"),
    ):
        ops.upload_form_source(authoring, app_id, menu, form, write, what)
    _pages.save_case_actions(authoring, app_id, 0, 0, name_path="/data/head_name")
    _pages.save_case_management(
        authoring,
        app_id,
        0,
        1,
        change=_member_child,
        diff={"update_case": {"add": {"village": [{"question_path": "/data/village", "update_mode": "always"}]}}},
        what="household visit's case management",
    )
    _pages.change_app_model(authoring, app_id, "village-edit-mode", _village_saved_only_if_changed)
    _pages.change_app_model(
        authoring,
        app_id,
        "member-visit-loads",
        _loads(
            1,
            household_writes={"last_member_visit": ("/data/visited_on", "edit")},
            member_writes={"notes": ("/data/notes", "always")},
            preload={"/data/age_seen": "age"},
        ),
    )
    _pages.change_app_model(
        authoring,
        app_id,
        "member-review-loads",
        _loads(2, household_writes={}, member_writes={"review_note": ("/data/review_note", "always")}),
    )
    return app_id


BASE = Base(
    id="hq-advanced",
    build=build,
    configuration=Configuration(privileges=frozenset({"CHILD_CASES"})),
    exhibits=(
        "forms-and-case-writes/open-case-name-update-question-path",
        "forms-and-case-writes/update-case-update-property-question",
        "forms-and-case-writes/subcases-child-case-relationship-child-type-a-module-case-type",
        "forms-and-case-writes/advancedform",
        "forms-and-case-writes/load-update-cases-loadupdateaction",
        "forms-and-case-writes/loadupdateaction-case-tag-without",
        "forms-and-case-writes/loadupdateaction-case-type",
        "forms-and-case-writes/loadupdateaction-details-module",
        "forms-and-case-writes/loadupdateaction-preload-question-property",
        "forms-and-case-writes/loadupdateaction-case-properties",
        "forms-and-case-writes/loadupdateaction-case-index-tag-reference-id-relationship",
        "forms-and-case-writes/update-mode-edit-in-a-project-space-that-saves-every-time",
    ),
    vellum=((0, 0), (0, 1), (1, 0), (2, 0)),
)
