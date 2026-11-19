"""``hq-case-management``: an app made in HQ holding each case setting HQ's Case Management page writes and Nova holds.

1. A new app (``views/apps.py::default_new_app``), named "Household cases"
   on the app page (``edit_app_attr``).
2. A case list menu "Households" of the case type ``household`` and one
   "Members" of the type ``member`` (``views/modules.py::new_module``), the
   second keeping only its Followup Form (``views/forms.py::delete_form``),
   and two more follow-up forms in "Households" (``views/forms.py::new_form``).
   Each form's source is written by HQ's own form writer
   (``xform_builder.py::XFormBuilder``), uploaded on the form page and saved
   in the form builder.
3. Each form's case management saved on its Case Management tab
   (``views/forms.py::edit_form_actions``), the tab's sections posted whole
   and each property mapping with its ``update_mode``:

   - the registration form: the case's name, an external id
     (``open_case.external_id``), and one child ``member`` outside any repeat
     whose index names ``parent`` (``reference_id``);
   - the first follow-up form: ``members`` saved only if changed
     (``update_mode`` ``edit``, which the project space applies under
     ``SAVE_ONLY_EDITED_FORM_FIELDS``), a write and a load of the worker's own
     record (``usercase_update``, ``usercase_preload``), and a load of the
     case's ``village`` into a question no later default reads
     (``case_preload``), made with HQ's model, since the basic tab offers no
     load (``partials/forms/case_config_ko_templates.html``), which the tab's
     own save keeps (``forms/case_config_ui.js::HQFormActions.from_case_transaction``);
   - the second follow-up form: its case's ``note`` written under an ``if``
     condition, and a child ``member`` closed where the answer says the
     member left (``close_condition``);
   - the third follow-up form: a date-and-time question saved to the case
     through the Hidden Value ``nova_datetime_seen_at``, whose calculate is
     the spelling Nova wrote before it wrote CommCare HQ's stored text
     (``lib/commcare/xpath/wire/instant.ts::typedInstantValue`` of the
     question: ``format-date`` of it in ``%Y-%m-%dT%H:%M:%S.%3%Z`` under a
     blank guard), and the bind Nova writes for it, typed ``xsd:string`` and
     relevant while the question holds an answer
     (``lib/commcare/xform/builder.ts``'s date-and-time sibling, which
     ``reader/xform/generated.ts::recognizeGenerated`` holds a sibling to).
     No page of HQ's writes that node, so after the form's own
     save in the form builder it is put in through the form page's upload
     (``ops.set_form_source``) and its path named in the form's case update;
   - the "Members" follow-up form: one property of its case.

Its configuration is the lane's floor with ``SAVE_ONLY_EDITED_FORM_FIELDS``
(so the flag read answers ``applied``), ``USERCASE`` for the worker's own
record (``_needs_usercase``) and ``CHILD_CASES``, under which the tab offers
child cases (``_needs_child_cases``). Web Apps stays off, as
``Application.cloudcare_enabled`` defaults, and a date-and-time question runs
on Android alone, so its preselected declaration is Android only.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Household cases"
HOUSEHOLDS = "Households"
MEMBERS = "Members"
# ``lib/commcare/xpath/wire/instant.ts::typedInstantValue`` of the question, as Nova wrote the sibling before it
# wrote CommCare HQ's stored text (``lib/domain/expression/datePattern.ts::INSTANT_TEXT_PATTERN``).
EARLIER_DATETIME_SPELLING = (
    "if(/data/seen_at = '', '', format-date(coalesce(/data/seen_at, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))"
)
SIBLING = "nova_datetime_seen_at"
YES_NO = {"yes": "Yes", "no": "No"}


def _source(*questions):
    """A source of ``questions`` (``(name, label, data type[, choices])`` each), as ``XFormBuilder`` writes it."""

    def write(name):
        from corehq.apps.app_manager.xform_builder import XFormBuilder

        xform = XFormBuilder(name)
        for question in questions:
            question_name, label, data_type, *choices = question
            xform.new_question(question_name, label, data_type, choices=choices[0] if choices else None)
        return xform.tostring(xml_declaration=True).decode("utf-8")

    return write


REGISTRATION = _source(
    ("head_name", "Head of household", "string"),
    ("household_ref", "Household reference", "string"),
    ("first_member", "First member", "string"),
)
VISIT = _source(
    ("members", "Members", "int"),
    ("village_seen", "Village on record", "string"),
    ("visit_note", "Visit note", "string"),
    ("district", "Your district", "string"),
)
CONDITIONAL = _source(
    ("visited", "Was the household visited", "select1", YES_NO),
    ("visit_note", "Visit note", "string"),
    ("new_member", "New member", "string"),
    ("member_left", "Has the new member left", "select1", YES_NO),
)
SEEN = _source(("seen_at", "Seen at", "dateTime"))
MEMBER_VISIT = _source(("status_note", "Status note", "string"))


def _condition(question=None, answer=None, *, type="if"):
    from corehq.apps.app_manager.models import FormActionCondition

    if type != "if":
        return FormActionCondition(type=type)
    return FormActionCondition(type="if", question=question, answer=answer, operator="=")


def _child(name_path, *, reference_id=None, close=None):
    """A child ``member`` case as the tab's child case section holds it (``models/form_actions.py::OpenSubCaseAction``),
    outside any repeat, opened always."""
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, OpenSubCaseAction

    return OpenSubCaseAction(
        case_type="member",
        name_update=ConditionalCaseUpdate(question_path=name_path),
        reference_id=reference_id,
        repeat_context="",
        relationship="child",
        condition=_condition(type="always"),
        close_condition=close if close is not None else _condition(type="never"),
    ).to_json()


def _registration(actions):
    actions["open_case"]["external_id"] = "/data/household_ref"
    actions["subcases"] = [_child("/data/first_member", reference_id="parent")]


def _visit(actions):
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, PreloadAction, UpdateCaseAction

    actions["usercase_update"] = UpdateCaseAction(
        update={"last_visit_note": ConditionalCaseUpdate(question_path="/data/visit_note")},
        condition=_condition(type="always"),
    ).to_json()
    actions["usercase_preload"] = PreloadAction(preload={"/data/district": "district"}).to_json()


def _conditional(actions):
    actions["update_case"]["condition"] = _condition("/data/visited", "yes").to_json()
    actions["subcases"] = [_child("/data/new_member", close=_condition("/data/member_left", "yes"))]


def _village_loaded(app):
    """The first follow-up form's load of the case's ``village``, with HQ's model."""
    from corehq.apps.app_manager.models import PreloadAction

    app.get_module(0).get_form(1).actions.case_preload = PreloadAction(preload={"/data/village_seen": "village"})


def _sibling_added(root, _form):
    """The Hidden Value ``nova_datetime_seen_at`` after ``seen_at``: its data node and its bind as Nova writes it,
    typed ``xsd:string`` and relevant while ``seen_at`` holds an answer, whose calculate is the spelling Nova wrote
    before it wrote CommCare HQ's stored text."""
    from lxml import etree

    xforms = "http://www.w3.org/2002/xforms"
    model = root.find(f"{{http://www.w3.org/1999/xhtml}}head/{{{xforms}}}model")
    data = next(child for child in model.find(f"{{{xforms}}}instance") if isinstance(child.tag, str))
    namespace = etree.QName(data).namespace
    question = data.find(f"{{{namespace}}}seen_at")
    bind = next(
        (child for child in model.iter(f"{{{xforms}}}bind") if child.get("nodeset") == "/data/seen_at"),
        None,
    )
    if question is None or bind is None:
        raise ops.MatrixChangeRefused(
            "HQ's form builder saved the third follow-up form of hq-case-management with no question seen_at; the"
            " builder uploads one, so look at what the builder now writes."
        )
    question.addnext(etree.Element(f"{{{namespace}}}{SIBLING}"))
    bind.addnext(
        etree.Element(
            f"{{{xforms}}}bind",
            nodeset=f"/data/{SIBLING}",
            type="xsd:string",
            calculate=EARLIER_DATETIME_SPELLING,
            relevant="count(/data/seen_at) > 0",
        )
    )
    return None


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.new_case_module(authoring, app_id, name=HOUSEHOLDS, case_type="household")
    _pages.new_form(authoring, app_id, 0, case_action="update")
    _pages.new_form(authoring, app_id, 0, case_action="update")
    _pages.new_case_module(authoring, app_id, name=MEMBERS, case_type="member")
    _pages.delete_form(authoring, app_id, 1, 0)
    for (menu, form), write, what in (
        ((0, 0), REGISTRATION, "registration-source"),
        ((0, 1), VISIT, "visit-source"),
        ((0, 2), CONDITIONAL, "conditional-source"),
        ((0, 3), SEEN, "seen-source"),
        ((1, 0), MEMBER_VISIT, "member-visit-source"),
    ):
        ops.upload_form_source(authoring, app_id, menu, form, write, what)
    # The date-and-time form is saved in the form builder before its sibling is put in and not after (it is no
    # position of BASE.vellum), so the sibling stands as the form page's upload put it.
    ops.builder_save(authoring, app_id, 0, 3)
    ops.set_form_source(authoring, app_id, 0, 3, _sibling_added, what="datetime-sibling", label="build")
    _pages.save_case_management(
        authoring,
        app_id,
        0,
        0,
        change=_registration,
        diff={"open_case": {"add": [{"question_path": "/data/head_name", "update_mode": "always"}]}},
        what="registration's case management",
    )
    _pages.save_case_management(
        authoring,
        app_id,
        0,
        1,
        change=_visit,
        diff={"update_case": {"add": {"members": [{"question_path": "/data/members", "update_mode": "edit"}]}}},
        what="visit's case management",
    )
    _pages.change_app_model(authoring, app_id, "village-preload", _village_loaded)
    _pages.save_case_management(
        authoring,
        app_id,
        0,
        2,
        change=_conditional,
        diff={"update_case": {"add": {"note": [{"question_path": "/data/visit_note", "update_mode": "always"}]}}},
        what="conditional update's case management",
    )
    _pages.save_case_management(
        authoring,
        app_id,
        0,
        3,
        diff={"update_case": {"add": {"seen_at": [{"question_path": f"/data/{SIBLING}", "update_mode": "always"}]}}},
        what="date-and-time form's case management",
    )
    _pages.save_case_management(
        authoring,
        app_id,
        1,
        0,
        diff={
            "update_case": {"add": {"status_note": [{"question_path": "/data/status_note", "update_mode": "always"}]}}
        },
        what="member visit's case management",
    )
    return app_id


BASE = Base(
    id="hq-case-management",
    build=build,
    configuration=Configuration(
        flags=frozenset({"SAVE_ONLY_EDITED_FORM_FIELDS"}), privileges=frozenset({"USERCASE", "CHILD_CASES"})
    ),
    exhibits=(
        "forms-and-case-writes/open-case-name-update-question-path",
        "forms-and-case-writes/open-case-external-id-on-a-form-whose-open-case-is-active",
        "forms-and-case-writes/subcases-child-case-relationship-child-type-a-module-case-type",
        "forms-and-case-writes/subcases-reference-id-null-parent",
        "forms-and-case-writes/subcases-case-properties-name-update",
        "forms-and-case-writes/subcases-close-condition-active",
        "forms-and-case-writes/update-case-condition-always",
        "forms-and-case-writes/update-case-condition-if-whose-question-exists",
        "forms-and-case-writes/update-case-update-property-question",
        "forms-and-case-writes/conditionalcaseupdate-update-mode-edit",
        "forms-and-case-writes/case-preload-question-property-into-a-question-outside-any",
        "forms-and-case-writes/usercase-update-with-condition-always-or-if-read-as-always-xform",
        "forms-and-case-writes/usercase-preload-into-a-question-outside-any-repeat-on-a-form",
        "forms-and-case-writes/update-from-a-date-and-time-question-through-a-hidden-sibling",
    ),
    vellum=((0, 0), (0, 1), (0, 2), (1, 0)),
)
