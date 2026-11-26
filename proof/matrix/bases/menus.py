"""``hq-menus``: an app made in HQ whose menus hold each navigation shape a person sets on HQ's pages.

1. A new app (``views/apps.py::default_new_app``), named "Household
   services" on the app page (``edit_app_attr``), with Web Apps turned on on
   the settings page.
2. Three case list menus of the case type ``household``
   (``views/modules.py::new_module``): "Household registration", which
   keeps its Registration Form (a text question ``head_name``, the case's
   name) and loses its Followup Form; "Households" and "Follow-ups", which
   each lose their Registration Form (``views/forms.py::delete_form``) and
   keep a follow-up: ``visit_note``, saved to the case, and
   ``follow_up_note``. Each form's source is written by HQ's own form writer
   (``xform_builder.py::XFormBuilder``) and uploaded on the form page.
3. Two survey menus, "Tools" at the top level beside the case list menus,
   and "Calculators" under it (``edit_module_attr``'s ``root_module_id``),
   each a display-only menu with one survey.
4. On "Households" (``edit_module_attr`` with ``all``): the case list menu
   item with a label, a display condition that compares today with a date
   (one a menu holds before any case is chosen), a deep link id on its case list,
   and Register offered always, its form the registration of the first menu,
   returning to the case list, with a picture uploaded through HQ's media
   picker (``hqmedia/views.py::ProcessImageFileUploadView``).
5. On "Follow-ups": Register with a label that holds no text, returning to
   the default, beside its form (``registration-label-fixed``); and the case
   list menu item shown with a label that holds no text, which the menu's
   page refuses (``edit_module_attr`` raises for a shown item with a blank
   label), so it is set with HQ's model (``list-settings-respelled``).
6. The registration form's deep link id (``edit_form_attr``'s
   ``session_endpoint_id``).
7. The "Households" follow-up form's settings (``edit_form_attr``): a
   display condition reading its own case's ``visit_note``, and an
   after-submit link that carries the chosen case by hand onto the
   follow-up form of "Follow-ups", a menu that chooses one case, under a
   condition that reads the case and holds no held-case guard
   (``link-held-case-guards-added``), with the menu as its otherwise.

Its configuration is the lane's floor with ``CLOUDCARE`` (Web Apps lists the
app), ``FORM_LINK_WORKFLOW`` (``_edit_form_attr`` saves an after-submit link
only under it) and ``SESSION_ENDPOINTS``, the flag HQ's deep link fields stand
under and that Nova's publish asks of a project space for an app with a deep
link. Web Apps is on and the content runs on both platforms, so its
preselected declaration is both, which includes Android, where its case list
expectations run.
"""

from __future__ import annotations

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Household services"
CASE_TYPE = "household"
REGISTER_PICTURE = "jr://file/commcare/image/register_household.png"
# A condition on the chosen case, read from the case database as HQ's form links read one, with no guard that the
# case is on the device.
LINK_CONDITION = (
    "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/visit_note = 'again'"
)
CARRIED_CASE = "instance('commcaresession')/session/data/case_id"


def _one_question_source(question, label):
    def write(name):
        from corehq.apps.app_manager.xform_builder import XFormBuilder

        xform = XFormBuilder(name)
        xform.new_question(question, label, "string")
        return xform.tostring(xml_declaration=True).decode("utf-8")

    return write


def _case_list_unlabelled(app):
    case_list = app.get_module(2).case_list
    case_list.show = True
    case_list.label = {app.langs[0]: ""}


def build(authoring) -> str:
    from proof.hq import operations

    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.turn_web_apps_on(authoring, app_id)

    _pages.new_case_module(authoring, app_id, name="Household registration", case_type=CASE_TYPE)
    ops.upload_form_source(authoring, app_id, 0, 0, _one_question_source("head_name", "Head of household"), "m0-reg")
    _pages.save_case_actions(authoring, app_id, 0, 0, name_path="/data/head_name")
    _pages.delete_form(authoring, app_id, 0, 1)

    _pages.new_case_module(authoring, app_id, name="Households", case_type=CASE_TYPE)
    _pages.delete_form(authoring, app_id, 1, 0)
    ops.upload_form_source(authoring, app_id, 1, 0, _one_question_source("visit_note", "Visit note"), "m1-follow")
    _pages.save_case_actions(authoring, app_id, 1, 0, updates={"visit_note": "/data/visit_note"})

    _pages.new_case_module(authoring, app_id, name="Follow-ups", case_type=CASE_TYPE)
    _pages.delete_form(authoring, app_id, 2, 0)
    ops.upload_form_source(
        authoring, app_id, 2, 0, _one_question_source("follow_up_note", "Follow-up note"), "m2-follow"
    )

    _pages.new_survey_module(authoring, app_id, name="Tools")
    ops.upload_form_source(authoring, app_id, 3, 0, _one_question_source("tool_name", "Tool name"), "m3-survey")
    _pages.new_survey_module(authoring, app_id, name="Calculators")
    ops.upload_form_source(authoring, app_id, 4, 0, _one_question_source("reading", "Reading"), "m4-survey")

    app = operations.held_app(authoring.state, app_id)
    registration = app.get_module(0).get_form(0).unique_id
    follow_ups = app.get_module(2)
    _pages.save_module_attributes(
        authoring, app_id, 4, [("root_module_id", app.get_module(3).unique_id)], "parent menu"
    )

    _pages.upload_picture(authoring, app_id, REGISTER_PICTURE)
    _pages.save_module_attributes(
        authoring,
        app_id,
        1,
        [
            ("case_list-show", "true"),
            ("case_list-label", "Browse households"),
            ("module_filter", "today() > date('2020-01-01')"),
            ("case_list_session_endpoint_id", "households"),
            ("case_list_form_id", registration),
            ("case_list_form_label", "Register a household"),
            ("case_list_post_form_workflow", "case_list"),
            ("case_list_form_media_image", REGISTER_PICTURE),
        ],
        "case list and register",
    )
    _pages.save_module_attributes(
        authoring,
        app_id,
        2,
        [
            ("case_list_form_id", registration),
            ("case_list_form_label", ""),
            ("case_list_post_form_workflow", "default"),
        ],
        "register",
    )
    _pages.change_app_model(authoring, app_id, "unlabelled-case-list", _case_list_unlabelled)

    _pages.save_form_attributes(authoring, app_id, 0, 0, [("session_endpoint_id", "register_household")], "deep link")
    _pages.save_form_attributes(
        authoring,
        app_id,
        1,
        0,
        [
            ("form_filter", "#case/visit_note != 'closed'"),
            ("post_form_workflow", "form"),
            ("form_links_xpath_expressions", LINK_CONDITION),
            ("form_links_form_ids", f"{follow_ups.unique_id}.{follow_ups.get_form(0).unique_id}"),
            ("datums_json", json.dumps([{"name": "case_id", "xpath": CARRIED_CASE}])),
            ("post_form_workflow_fallback", "module"),
        ],
        "display condition and after-submit link",
    )
    return app_id


BASE = Base(
    id="hq-menus",
    build=build,
    configuration=Configuration(
        flags=frozenset({"FOLLOWUP_FORMS_AS_CASE_LIST_FORM", "SESSION_ENDPOINTS"}), privileges=frozenset({"CLOUDCARE", "FORM_LINK_WORKFLOW"})
    ),
    exhibits=(
        "application-and-settings/40-hq-cloudcare-enabled",
        "questions/text-input-xsd-string",
        "forms-and-case-writes/open-case-name-update-question-path",
        "forms-and-case-writes/update-case-update-property-question",
        "menus-and-case-lists/child-menu-one-tier-root-module-id-a-parentless-module",
        "menus-and-case-lists/module-filter-value-lifts-into-predicate",
        "menus-and-case-lists/module-case-list-show-true-on-a-basic-module-with-forms",
        "menus-and-case-lists/module-case-list-label-lang",
        "menus-and-case-lists/case-list-session-endpoint-id",
        "menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module",
        "menus-and-case-lists/case-list-form-post-form-workflow-default-case-list",
        "menus-and-case-lists/case-list-form-media-image-media-audio",
        "forms-and-case-writes/session-endpoint-id",
        "forms-and-case-writes/form-filter-lifting-into-predicate-a-direct-own-case-property-in",
        "forms-and-case-writes/form-links-target-a-form-any-suite-form",
        "forms-and-case-writes/form-links-xpath",
        "forms-and-case-writes/form-links-datums-on-a-form-target-names-among-the-target-s",
        "forms-and-case-writes/post-form-workflow-form",
        "forms-and-case-writes/post-form-workflow-fallback-module-or-previous-screen-offered-in",
    ),
)
