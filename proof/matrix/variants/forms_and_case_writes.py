"""The named changes of variants whose entry is in the manifest area ``forms-and-case-writes``.

A change to a form's source edits the source HQ holds as text: ``_change`` hands ``ops.set_form_source`` that source
with each ``(old, new, count)`` replacement made, each ``old`` held to occur exactly ``count`` times first, so a base
whose builder now writes another source fails the change by name rather than making another one. A question is added
at the end of its form, its data node, bind, text and control each after the form's last (``_appended``), in the
shape HQ's form builder writes. A value of the app's JSON is set with ``ops.set_json``, after any source change.
"""

from __future__ import annotations

import json

from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.lookups import changes_lookup_data

# The ends of a form HQ's form builder saves, which a question added last goes before.
_DATA_END = "\t\t\t\t</data>"
_ITEXT_START = "\t\t\t<itext>"
_TRANSLATION_END = "\t\t\t\t</translation>"
_BODY_END = "\t</h:body>"


def _replaced(text, pairs):
    """``text`` with each ``(old, new, count)`` of ``pairs`` made in order, every ``old`` held to occur ``count``
    times where it is replaced."""
    for old, new, count in pairs:
        found = text.count(old)
        if found != count:
            raise AssertionError(
                f"The form's source holds {old!r} {found} times, and the change expects it {count} times. Look at what"
                " the base's builder now writes for the form."
            )
        text = text.replace(old, new)
    return text


def _change(authoring, app_id, what, *pairs, menu, form):
    """The form at ``(menu, form)`` with ``pairs`` replaced in the source HQ holds, put in through the form page's
    upload (``ops.set_form_source``)."""
    ops.set_form_source(
        authoring, app_id, menu, form, lambda _root, held: _replaced(held.source, pairs), what=f"{what}:source"
    )


def _appended(node="", bind="", text="", control=""):
    """The replacements that add a data node, binds (or setvalues), texts and a control after the form's last."""
    pairs = []
    for end, added in ((_DATA_END, node), (_ITEXT_START, bind), (_TRANSLATION_END, text), (_BODY_END, control)):
        if added:
            pairs.append((end, added + end, 1))
    return tuple(pairs)


def _text(text_id, value):
    return f'\t\t\t\t\t<text id="{text_id}">\n\t\t\t\t\t\t<value>{value}</value>\n\t\t\t\t\t</text>\n'


def _question(question_id, label, control, data_type, items=(), attributes=""):
    """A question at the form's root, as the form builder writes one: its data node, bind, texts and control."""
    typed = f' type="{data_type}"' if data_type else ""
    text = _text(f"{question_id}-label", label)
    inner = f"\t\t\t<label ref=\"jr:itext('{question_id}-label')\" />\n"
    for value, item_label in items:
        text += _text(f"{question_id}-{value}-label", item_label)
        inner += (
            f"\t\t\t<item>\n\t\t\t\t<label ref=\"jr:itext('{question_id}-{value}-label')\" />\n"
            f"\t\t\t\t<value>{value}</value>\n\t\t\t</item>\n"
        )
    return _appended(
        node=f"\t\t\t\t\t<{question_id} />\n",
        bind=f'\t\t\t<bind vellum:nodeset="#form/{question_id}" nodeset="/data/{question_id}"{typed} />\n',
        text=text,
        control=(
            f'\t\t<{control}{attributes} vellum:ref="#form/{question_id}" ref="/data/{question_id}">\n'
            f"{inner}\t\t</{control}>\n"
        ),
    )


def _repeat(repeat_id, label, child, child_label):
    """A repeat group at the form's root holding one text question, as the form builder writes one."""
    return _appended(
        node=f'\t\t\t\t\t<{repeat_id} jr:template="">\n\t\t\t\t\t\t<{child} />\n\t\t\t\t\t</{repeat_id}>\n',
        bind=(
            f'\t\t\t<bind vellum:nodeset="#form/{repeat_id}" nodeset="/data/{repeat_id}" />\n'
            f'\t\t\t<bind vellum:nodeset="#form/{repeat_id}/{child}" nodeset="/data/{repeat_id}/{child}"'
            ' type="xsd:string" />\n'
        ),
        text=_text(f"{repeat_id}-label", label) + _text(f"{repeat_id}/{child}-label", child_label),
        control=(
            f"\t\t<group>\n\t\t\t<label ref=\"jr:itext('{repeat_id}-label')\" />\n"
            f'\t\t\t<repeat vellum:nodeset="#form/{repeat_id}" nodeset="/data/{repeat_id}">\n'
            f'\t\t\t\t<input vellum:ref="#form/{repeat_id}/{child}" ref="/data/{repeat_id}/{child}">\n'
            f"\t\t\t\t\t<label ref=\"jr:itext('{repeat_id}/{child}-label')\" />\n\t\t\t\t</input>\n"
            "\t\t\t</repeat>\n\t\t</group>\n"
        ),
    )


def _default_value(question_id, read_id):
    """The setvalue HQ's form builder writes for a Default Value of ``question_id`` reading ``read_id``."""
    return _appended(
        bind=(
            f'\t\t\t<setvalue event="xforms-ready" vellum:ref="#form/{question_id}" ref="/data/{question_id}"'
            f' vellum:value="#form/{read_id}" value="/data/{read_id}" />\n'
        )
    )


def _condition(kind, question=None, answer=None):
    return {"type": kind, "question": question, "answer": answer, "operator": "=", "doc_type": "FormActionCondition"}


def _update(question_path):
    return {"question_path": question_path, "update_mode": "always", "doc_type": "ConditionalCaseUpdate"}


def _index(tag, relationship="child", question=""):
    return {
        "tag": tag,
        "reference_id": "parent",
        "relationship": relationship,
        "relationship_question": question,
        "doc_type": "CaseIndex",
    }


def _open(tag, case_type, name_path, indices, repeat_context=""):
    """An advanced form's open action, as the advanced Case Management page saves one."""
    return {
        "case_type": case_type,
        "case_tag": tag,
        "name_update": _update(name_path),
        "case_properties": {},
        "repeat_context": repeat_context,
        "case_indices": indices,
        "open_condition": _condition("always"),
        "close_condition": _condition("never"),
        "doc_type": "AdvancedOpenCaseAction",
    }


def _open_member_with_parent_index(authoring, app_id):
    """Open another member under the existing household connection."""
    ops.set_json(authoring, app_id, "/modules/1/forms/0/actions/open_cases", [
        _open("open_member_0", "member", "/data/notes", [_index("load_household0")]),
    ])


def open_member_with_hyphenated_parent_index(authoring, app_id):
    """Keep the original manual loads on parent while a writer adds another child link."""
    _open_member_with_parent_index(authoring, app_id)
    ops.set_json(
        authoring, app_id, "/modules/1/forms/0/actions/open_cases/0/case_indices/0/reference_id", "my-parent",
    )


def _open_visitor_with_index(authoring, app_id, reference):
    from proof.matrix.bases.hq_advanced import _source

    _pages.new_case_module(authoring, app_id, name="Visitors", case_type="visitor")
    ops.upload_form_source(
        authoring, app_id, 3, 0, _source(("visitor_name", "Visitor name", "string")), "visit-registration-source",
    )
    _pages.save_case_actions(authoring, app_id, 3, 0, name_path="/data/visitor_name")
    ops.set_json(authoring, app_id, "/modules/1/forms/0/actions/open_cases", [
        _open(
            "open_member_0", "visitor", "/data/notes",
            [{**_index("load_household0"), "reference_id": reference}],
        ),
    ])

def open_visitor_with_hyphenated_index(authoring, app_id):
    """Use the distinct connection for a type whose menu has no existing child chain."""
    _open_visitor_with_index(authoring, app_id, "my-parent")


def open_visitor_with_dotted_index(authoring, app_id):
    """Keep an exact dotted Advanced Case Management index."""
    _open_visitor_with_index(authoring, app_id, "my.parent")


def open_visitor_with_repeated_dot_index(authoring, app_id):
    """Keep adjacent periods as part of one Advanced connection name."""
    _open_visitor_with_index(authoring, app_id, "my..parent")


def open_visitor_with_accented_index(authoring, app_id):
    """Preserve the exact composed accent the worker's named index reads."""
    _open_visitor_with_index(authoring, app_id, "métrique")


def open_visitor_with_leading_accented_index(authoring, app_id):
    """Preserve a capital accented initial letter on the Advanced connection."""
    _open_visitor_with_index(authoring, app_id, "Équipe")


def open_visitor_with_greek_index(authoring, app_id):
    """A shared worker letter can start the exact index name."""
    _open_visitor_with_index(authoring, app_id, "Ωprobe")


def open_visitor_with_nko_digit_index(authoring, app_id):
    """A shared worker digit can continue the exact index name."""
    _open_visitor_with_index(authoring, app_id, "probe߀")


def open_visitor_with_web_only_index(authoring, app_id):
    """HQ saves a top-level child index which the Web Apps writer and Android lexer cannot carry."""
    _open_visitor_with_index(authoring, app_id, "აprobe")


def open_visitor_with_decomposed_index(authoring, app_id):
    """Keep the adjacent valid XML name outside the verified XPath grammar."""
    _open_visitor_with_index(authoring, app_id, "me\u0301trique")


def write_through_typed_user_index(authoring, app_id):
    """A declared user edge links an ordinary member to an ordinary household."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    from proof.matrix.bases.hq_advanced import new_advanced_module

    def registration(name):
        form = XFormBuilder(name)
        form.new_question("member_name", "Member name", "string")
        return form.tostring(xml_declaration=True).decode("utf-8")

    new_advanced_module(authoring, app_id, "Register linked members")
    ops.upload_form_source(authoring, app_id, 2, 0, registration, "typed-user-index-registration")
    ops.set_json(authoring, app_id, "/modules/2/case_type", "household")
    ops.set_json(authoring, app_id, "/modules/2/forms/0/actions/load_update_cases", [
        {
            "case_type": "household",
            "case_tag": "load_household0",
            "details_module": {"$menu": 0},
            "doc_type": "LoadUpdateAction",
        },
    ])
    ops.set_json(authoring, app_id, "/modules/2/forms/0/actions/open_cases", [
        _open("open_member_0", "member", "/data/member_name",
              [{**_index("load_household0"), "reference_id": "user"}]),
    ])
    ops.set_json(
        authoring, app_id, "/modules/1/forms/0/actions/update_case/update/user~1status_note",
        _update("/data/status_note"),
    )


def write_through_typed_parent_user_index(authoring, app_id):
    """A member's declared household owns a user index to an ordinary district."""
    from proof.matrix.bases.hq_advanced import new_advanced_module
    from proof.matrix.bases.hq_case_management import _source

    _pages.new_case_module(authoring, app_id, name="Districts", case_type="district")
    ops.upload_form_source(
        authoring, app_id, 2, 0, _source(("district_name", "District", "string")),
        "typed-parent-user-index-district",
    )
    _pages.save_case_actions(authoring, app_id, 2, 0, name_path="/data/district_name")
    new_advanced_module(authoring, app_id, "Register households linked to districts")
    ops.upload_form_source(
        authoring, app_id, 3, 0, _source(("household_name", "Household", "string")),
        "typed-parent-user-index-household",
    )
    ops.set_json(authoring, app_id, "/modules/3/case_type", "district")
    ops.set_json(authoring, app_id, "/modules/3/forms/0/actions/load_update_cases", [
        {
            "case_type": "district",
            "case_tag": "load_district0",
            "details_module": {"$menu": 2},
            "doc_type": "LoadUpdateAction",
        },
    ])
    ops.set_json(authoring, app_id, "/modules/3/forms/0/actions/open_cases", [
        _open("open_household_0", "household", "/data/household_name",
              [{**_index("load_district0"), "reference_id": "user"}]),
    ])
    _pages.save_case_actions(authoring, app_id, 1, 0, updates={"parent/user/status_note": "/data/status_note"})


# hq-advanced's Member visits form: its loads and open actions.
_VISIT_LOADS = "/modules/1/forms/0/actions/load_update_cases"
_VISIT_OPENS = "/modules/1/forms/0/actions/open_cases"


def as_created(authoring, app_id):
    """``hq-new-app``'s registration form as ``views/modules.py::new_module`` leaves it: its case's name from no
    question, saved on the Case Management tab (``edit_form_actions``, the mapping deleted in the
    ``case_mapping_diff``), and the blank source HQ writes for a new form (``views/utils.py::get_blank_form_xml``,
    ``models/modules.py::Module.new_form``), uploaded on the form page, which holds no question."""
    from corehq.apps.app_manager.form_action_diff import make_multi
    from corehq.apps.app_manager.views.utils import get_blank_form_xml

    from proof.hq import operations

    with authoring.step("variant:as-created:case-name"):
        form = operations.held_app(authoring.state, app_id).get_module(0).get_form(0)
        name_path = form.actions.open_case.name_update.question_path
        diff = {"open_case": {"delete": [{"question_path": name_path, "update_mode": "always"}]}} if name_path else {}
        body, content_type = ops.form_body(
            [("actions", json.dumps(make_multi(form.actions.to_json()))), ("case_mapping_diff", json.dumps(diff))]
        )
        ops.post(
            authoring,
            "edit_form_actions",
            [app_id, form.unique_id],
            body,
            content_type,
            "the registration form's case name, removed",
        )
    ops.set_form_source(
        authoring,
        app_id,
        0,
        0,
        lambda _root, held: get_blank_form_xml(held.default_name()),
        what="as-created:blank-source",
    )


# hq-case-management ---------------------------------------------------------------------------------------------


def child_close_answer_with_apostrophe(authoring, app_id):
    """The child case of ``hq-case-management``'s second follow-up form closed where ``member_left`` answers the
    choice ``don't``: the question's choice ``no`` given that value, and the close condition compared with it."""
    _change(
        authoring,
        app_id,
        "child-close-answer-with-apostrophe",
        (
            "<label ref=\"jr:itext('member_left-no-label')\" />\n\t\t\t\t<value>no</value>",
            "<label ref=\"jr:itext('member_left-no-label')\" />\n\t\t\t\t<value>don't</value>",
            1,
        ),
        menu=0,
        form=2,
    )
    ops.set_json(authoring, app_id, "/modules/0/forms/2/actions/subcases/0/close_condition/answer", "don't")


def child_close_is_true_on_a_choice(authoring, app_id):
    """The child case of ``hq-case-management``'s second follow-up form closed where ``member_left`` "is true", the
    Case Management operator ``boolean_true``, over that single-choice question, whose answer no yes or no holds: a
    device closes it wherever the question is answered at all."""
    ops.set_json(authoring, app_id, "/modules/0/forms/2/actions/subcases/0/close_condition/operator", "boolean_true")
    ops.set_json(authoring, app_id, "/modules/0/forms/2/actions/subcases/0/close_condition/answer", None)


def members_written_as_number_and_text(authoring, app_id):
    """``members`` of the household opened by ``hq-case-management``'s first follow-up form in its whole-number
    question ``members`` (a load from the case on the Case Management tab) and written by its second from the text
    question ``visit_note``: text a whole-number question cannot read."""
    ops.set_json(
        authoring,
        app_id,
        "/modules/0/forms/1/actions/case_preload/preload",
        {"/data/village_seen": "village", "/data/members": "members"},
    )
    ops.set_json(
        authoring, app_id, "/modules/0/forms/2/actions/update_case/update/members", _update("/data/visit_note")
    )


def update_from_a_photo(authoring, app_id):
    """``hq-case-management``'s member follow-up form given an image question ``photo``, whose answer the form saves
    to the member's ``photo``."""
    _change(
        authoring,
        app_id,
        "photo-question",
        *_question("photo", "Photo", "upload", "binary", attributes=' mediatype="image/*"'),
        menu=1,
        form=0,
    )
    ops.set_json(authoring, app_id, "/modules/1/forms/0/actions/update_case/update/photo", _update("/data/photo"))


def worker_preload_observed_before_its_source_only_write(authoring, app_id):
    """The basic worker editor preserves historical loads but cannot create them.
    A form default reading this destination before the late write distinguishes
    it from the otherwise equivalent ordinary worker-property starting value."""
    _change(authoring, app_id, "worker-preload-observed", *_default_value("visit_note", "village_seen"), menu=0, form=1)
    ops.set_json(authoring, app_id, "/modules/0/forms/1/actions/case_preload/preload", {})
    ops.set_json(authoring, app_id, "/modules/0/forms/1/actions/usercase_preload/preload", {"/data/village_seen": "last_visit_note"})


def preload_read_later(authoring, app_id):
    """``hq-case-management``'s first follow-up form's ``visit_note`` given a Default Value reading
    ``village_seen``, which the form's case preload fills."""
    _change(authoring, app_id, "preload-read-later", *_default_value("visit_note", "village_seen"), menu=0, form=1)


# hq-plain -------------------------------------------------------------------------------------------------------


def preload_in_a_multi_select_menu(authoring, app_id):
    """``hq-plain``'s households list choosing several cases, and its follow-up form's ``remark`` loaded from the
    case's ``remark``."""
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/multi_select", True)
    ops.set_json(
        authoring,
        app_id,
        "/modules/0/forms/1/actions/case_preload",
        {"preload": {"/data/remark": "remark"}, "doc_type": "PreloadAction", "condition": _condition("never")},
    )


def child_case_in_a_shared_multi_select_menu(authoring, app_id):
    """``hq-plain``'s households list choosing several cases, and its follow-up form opening a child case that writes
    no owner."""
    ops.set_json(authoring, app_id, "/case_sharing", True)
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/multi_select", True)
    ops.set_json(
        authoring,
        app_id,
        "/modules/0/forms/1/actions/subcases",
        [
            {
                "case_type": "household",
                "name_update": _update("/data/remark"),
                "reference_id": "parent",
                "repeat_context": "",
                "relationship": "child",
                "condition": _condition("always"),
                "close_condition": _condition("never"),
                "case_properties": {},
                "doc_type": "OpenSubCaseAction",
            }
        ],
    )


# hq-advanced ----------------------------------------------------------------------------------------------------


def load_writes_a_label(authoring, app_id):
    """``hq-advanced``'s member visit form given a label ``seen_label``, whose value the member's load saves to
    ``seen``."""
    _load_writes_a_label(authoring, app_id, ' appearance="minimal"')


def load_writes_an_interactive_label(authoring, app_id):
    """The selected member's load writes a message with an interactive confirmation."""
    _load_writes_a_label(authoring, app_id, "")


def load_writes_a_banner(authoring, app_id):
    """The selected member's load writes the value of a floating banner."""
    _load_writes_a_label(authoring, app_id, ' appearance="floating-good"')


def load_writes_a_preloaded_label(authoring, app_id):
    """The selected member's ordinary passive label also starts from that record."""
    load_writes_a_label(authoring, app_id)
    ops.set_json(authoring, app_id, f"{_VISIT_LOADS}/1/preload/~1data~1seen_label", "notes")


def load_writes_a_label_preloaded_from_an_earlier_case(authoring, app_id):
    """The member saves a label whose starting answer comes from the earlier household."""
    load_writes_a_label(authoring, app_id)
    ops.set_json(authoring, app_id, f"{_VISIT_LOADS}/0/preload/~1data~1seen_label", "village")


def load_writes_a_label_preloaded_from_two_cases(authoring, app_id):
    load_writes_a_label_preloaded_from_an_earlier_case(authoring, app_id)
    ops.set_json(authoring, app_id, f"{_VISIT_LOADS}/1/preload/~1data~1seen_label", "notes")


def load_writes_a_label_preloaded_from_two_cases_and_closes(authoring, app_id):
    load_writes_a_label_preloaded_from_two_cases(authoring, app_id)
    ops.set_json(authoring, app_id, f"{_VISIT_LOADS}/1/close_condition", _condition("always"))


def load_writes_a_label_and_closes(authoring, app_id):
    """The chosen member's load saves a label and closes the member on that same arm."""
    load_writes_a_label(authoring, app_id)
    ops.set_json(authoring, app_id, f"{_VISIT_LOADS}/1/close_condition", _condition("always"))


def _load_writes_a_label(authoring, app_id, appearance):
    _change(
        authoring,
        app_id,
        "seen-label",
        *_question("seen_label", "The member was seen", "trigger", None, attributes=appearance),
        menu=1,
        form=0,
    )
    ops.set_json(authoring, app_id, f"{_VISIT_LOADS}/1/case_properties/seen", _update("/data/seen_label"))


def load_preload_read_later(authoring, app_id):
    """``hq-advanced``'s member visit form's ``notes`` given a Default Value reading ``age_seen``, which the member's
    load fills."""
    _change(authoring, app_id, "load-preload-read-later", *_default_value("notes", "age_seen"), menu=1, form=0)


def _visits(authoring, app_id):
    """``hq-advanced``'s member visit form given a repeat ``visits`` holding the text question ``visitor``."""
    _change(authoring, app_id, "visits-repeat", *_repeat("visits", "Visits", "visitor", "Visitor"), menu=1, form=0)


def two_opens_sharing_a_repeat_block(authoring, app_id):
    """``hq-advanced``'s member visit form given a repeat ``visits``, and two members opened for each visit, one of
    them indexed to the household."""
    _visits(authoring, app_id)
    ops.set_json(
        authoring,
        app_id,
        _VISIT_OPENS,
        [
            _open("open_member_0", "member", "/data/visits/visitor", [_index("load_household0")], "/data/visits"),
            _open("open_member_1", "member", "/data/visits/visitor", [], "/data/visits"),
        ],
    )


def relationship_question_in_a_repeat(authoring, app_id):
    """``hq-advanced``'s member visit form given a repeat ``visits``, and a member opened under the household whose
    relationship the visit's ``visitor`` answers."""
    _visits(authoring, app_id)
    ops.set_json(
        authoring,
        app_id,
        _VISIT_OPENS,
        [
            _open(
                "open_member_0",
                "member",
                "/data/notes",
                [_index("load_household0", "question", "/data/visits/visitor")],
            )
        ],
    )


def open_indexed_to_a_repeated_open(authoring, app_id):
    """``hq-advanced``'s member visit form given a repeat ``visits``, a household opened for each visit, and a member
    opened once, outside the repeat, indexed to it."""
    _visits(authoring, app_id)
    ops.set_json(
        authoring,
        app_id,
        _VISIT_OPENS,
        [
            _open("open_household_0", "household", "/data/visits/visitor", [], "/data/visits"),
            _open("open_member_1", "member", "/data/notes", [_index("open_household_0")]),
        ],
    )


# hq-advanced's Member reviews form, whose second load chooses the member, and the menu Member visits it goes under.
_REVIEW_FORM = "/modules/2/forms/0"
_MEMBER_VISITS = {"$menu": 1}


def open_indexed_to_a_renamed_load(authoring, app_id):
    """``hq-advanced``'s Member reviews menu put under Member visits, its form's member load tagged
    ``load_member_seen``, and a member opened under that load. HQ's build renames the load's datum to the one Member
    visits chooses its member by, so the open action's index names a datum the session no longer holds. Each value is
    set at its own pointer: a whole form set at once would carry the form id HQ's source read mints anew on every
    read (``util.py::update_form_unique_ids``), which no later read serves."""
    ops.set_json(authoring, app_id, "/modules/2/root_module_id", _MEMBER_VISITS)
    ops.set_json(authoring, app_id, f"{_REVIEW_FORM}/actions/load_update_cases/1/case_tag", "load_member_seen")
    ops.set_json(
        authoring,
        app_id,
        f"{_REVIEW_FORM}/actions/open_cases",
        [_open("open_member_0", "member", "/data/review_note", [_index("load_member_seen")])],
    )


# The worker's record loaded by an auto-selected load in hq-advanced's Member visits form, as the advanced Case
# Management page saves one (``case_config_ui.js::addFormAction`` with ``auto_select``, ``actions.js``, whose mode
# ``usercase`` sets the case type ``commcare-user``), under the tag Nova derives for it, writing the visit's day.
_WORKER_TAG = "autoload_commcare_user0"


def _worker_load():
    return {
        "case_type": "commcare-user",
        "case_tag": _WORKER_TAG,
        "details_module": None,
        "case_index": _index(""),
        "preload": {},
        "case_properties": {"last_visit_seen": _update("/data/visited_on")},
        "close_condition": _condition("never"),
        "show_product_stock": False,
        "product_program": None,
        "auto_select": {"mode": "usercase", "value_source": "", "value_key": "", "doc_type": "AutoSelectCase"},
        "load_case_from_fixture": None,
        "doc_type": "LoadUpdateAction",
    }


def _visit_loads(authoring, app_id):
    """The Member visits form's loads as HQ holds them: the household, then the member indexed to it."""
    from proof.hq import operations

    form = operations.held_app(authoring.state, app_id).get_module(1).get_form(0)
    return [json.loads(json.dumps(load.to_json())) for load in form.actions.load_update_cases]


@changes_lookup_data
def household_chosen_by_a_stored_table(authoring, app_id):
    """The visit's last load takes its household id from one real global table row."""
    from proof.matrix.bases.lookups import make_tables

    make_tables(authoring, [{"tag": "villages", "fields": ["household_id"],
                             "rows": [["4b4d8b1b-052a-400b-9a47-9ce477ddcf08"]]}])
    loads = _visit_loads(authoring, app_id)
    automatic = dict(loads[0], case_tag="load_household2", details_module=None,
                     preload={}, case_properties={},
                     auto_select={"doc_type": "AutoSelectCase", "mode": "fixture",
                                  "value_source": "villages", "value_key": "household_id"})
    ops.set_json(authoring, app_id, _VISIT_LOADS, [*loads, automatic])


def worker_load_stored_first(authoring, app_id):
    """``hq-advanced``'s Member visits form with the worker's record's auto-selected load stored before the
    household and the member it chooses, which HQ's page keeps where a person drags it: HQ's entry computes the
    worker's datum in stored order, before the first chosen case."""
    ops.set_json(authoring, app_id, _VISIT_LOADS, [_worker_load(), *_visit_loads(authoring, app_id)])


def first_load_indexed_to_the_worker_load(authoring, app_id):
    """``hq-advanced``'s Member visits form with the worker's record's auto-selected load stored first, and the
    household's load after it indexed to it, which HQ's page offers on a load after the first that does not
    auto-select (``case_config_advanced.html``, ``actions.js`` ``subcase``): the chosen household narrowed to the
    worker's record's children."""
    household, *rest = _visit_loads(authoring, app_id)
    household["case_index"] = {**household["case_index"], "tag": _WORKER_TAG}
    ops.set_json(authoring, app_id, _VISIT_LOADS, [_worker_load(), household, *rest])


# Shapes a reading holds ----------------------------------------------------------------------------------------------


def _hidden(question_id, value, data_type):
    """A Hidden Value at the form's root whose calculate is ``value``, bound to ``data_type``, as Nova's publish writes
    one beside the form builder's own attributes: ``#form/`` in the form builder's spelling, ``/data/`` in the
    source's."""
    shown = value.replace("/data/", "#form/")
    return _appended(
        node=f"\t\t\t\t\t<{question_id} />\n",
        bind=(
            f'\t\t\t<bind vellum:nodeset="#form/{question_id}" nodeset="/data/{question_id}" type="{data_type}"'
            f' vellum:calculate="{shown}" calculate="{value}" />\n'
        ),
    )


def _sibling(name, owner, calculate):
    """The node Nova writes beside the question ``owner`` for its case write, as its publish writes it: a data node
    and a bind with no form builder attribute, relevant where the question is."""
    return _appended(
        node=f"\t\t\t\t\t<{name} />\n",
        bind=(
            f'\t\t\t<bind nodeset="/data/{name}" type="xsd:string" calculate="{calculate}"'
            f' relevant="count(/data/{owner}) &gt; 0" />\n'
        ),
    )


# The text Nova saves to a case for the date and time at ``{owner}``: the moment as CommCare HQ stores one, in UTC with
# six fraction digits (``lib/commcare/xpath/wire/instant.ts::storedInstantOfText`` over ``typedInstantText``), the day
# moved where the offset moves the clock past midnight, then the clock and the seconds.
_MOMENT = "format-date(coalesce(/data/{owner}, ''), '%Y-%m-%dT%H:%M:%S.%3%Z')"
_YEAR = "number(substr({F}, 0, 4))"
_MONTH = "number(substr({F}, 5, 7))"
_DAY = "number(substr({F}, 8, 10))"
_MINUTES = (
    "number(substr({F}, 11, 13)) * 60 + number(substr({F}, 14, 16)) - if(starts-with(substr({F}, 23), 'Z'), 0,"
    " if(starts-with(substr({F}, 23), '-'), -1, 1) * (number(substr(substr({F}, 23), 1, 3)) * 60 +"
    " if(string-length(substr({F}, 23)) &gt; 3, number(substr(substr({F}, 23), 4, 6)), 0)))"
)
_UTC_TEXT = (
    "if(/data/{owner} = '', '', concat(if({MIN} &lt; 0, if({D} &gt; 1, concat(substr({F}, 0, 8),"
    " substr(100 + ({D} - 1), 1)), if({MO} &gt; 1, concat(substr({F}, 0, 5), substr(100 + ({MO} - 1), 1), '-',"
    " substr(100 + if({MO} - 1 = 2, 28 + ({Y} mod 4 = 0 and {Y} mod 100 != 0 or {Y} mod 400 = 0), 30 + ({MO} - 1 +"
    " floor(({MO} - 1) div 8)) mod 2), 1)), concat(substr(10000 + ({Y} - 1), 1), '-12-31'))), if({MIN} &gt;= 1440,"
    " if({D} &lt; if({MO} = 2, 28 + ({Y} mod 4 = 0 and {Y} mod 100 != 0 or {Y} mod 400 = 0), 30 + ({MO} +"
    " floor({MO} div 8)) mod 2), concat(substr({F}, 0, 8), substr(100 + ({D} + 1), 1)), if({MO} &lt; 12,"
    " concat(substr({F}, 0, 5), substr(100 + ({MO} + 1), 1), '-01'), concat(substr(10000 + ({Y} + 1), 1),"
    " '-01-01'))), substr({F}, 0, 10))), 'T', substr(100 + floor(({MIN} + 1440) mod 1440 div 60), 1), ':',"
    " substr(100 + ({MIN} + 1440) mod 1440 mod 60, 1), ':', substr({F}, 17, 23), '000Z'))"
)


def _utc_text(owner):
    """The calculate of the ``nova_datetime_`` node Nova writes beside the date and time at ``owner``."""
    moment = _MOMENT.format(owner=owner)
    pieces = {"Y": _YEAR, "MO": _MONTH, "D": _DAY, "MIN": _MINUTES}
    return _UTC_TEXT.format(owner=owner, F=moment, **{key: one.format(F=moment) for key, one in pieces.items()})


def seen_moment_through_the_join(authoring, app_id):
    """``hq-case-management``'s member follow-up form given a date ``seen_on``, a time ``seen_time`` and a Hidden Value
    ``seen_moment`` joining them into one date and time, which the form saves to the member's ``seen_moment`` through
    the node Nova writes beside it, as a date and time question split in two is saved. ``seen_moment`` is a Hidden
    Value bound ``xsd:dateTime`` whose calculate keeps a date's clock, so the change also shows that entry
    (``questions/hidden-value-bound-xsd-datetime``)."""
    join = (
        "date(format-date(if(/data/seen_on = '' or /data/seen_time = '', '', concat(/data/seen_on, 'T',"
        " /data/seen_time)), '%Y-%m-%dT%H:%M:%S.%3%Z'))"
    )
    _change(
        authoring,
        app_id,
        "seen-moment",
        *_question("seen_on", "Seen on", "input", "xsd:date"),
        *_question("seen_time", "Seen at", "input", "xsd:time"),
        *_hidden("seen_moment", join, "xsd:dateTime"),
        *_sibling("nova_datetime_seen_moment", "seen_moment", _utc_text("seen_moment")),
        menu=1,
        form=0,
    )
    ops.set_json(
        authoring,
        app_id,
        "/modules/1/forms/0/actions/update_case/update/seen_moment",
        _update("/data/nova_datetime_seen_moment"),
    )


def hidden_clock_saved_as_a_day(authoring, app_id):
    """The Member Followup keeps a timestamp and writes its day directly to the member."""
    _change(
        authoring, app_id, "hidden-day", *_hidden("recorded_at", "now()", "xsd:dateTime"),
        menu=1, form=0,
    )
    ops.set_json(
        authoring, app_id, "/modules/1/forms/0/actions/update_case/update/visit_day",
        _update("/data/recorded_at"),
    )


def datetime_answer_saved_through_parent_as_a_day(authoring, app_id):
    """The member follow-up writes the day of an answered timestamp to the household."""
    _change(
        authoring, app_id, "parent-day",
        ('type="xsd:string"', 'type="xsd:dateTime"', 1),
        menu=1, form=0,
    )
    ops.set_json(
        authoring, app_id, "/modules/1/forms/0/actions/update_case/update/parent~1visit_day",
        _update("/data/status_note"),
    )


def photo_link_saved_to_the_case(authoring, app_id):
    """``hq-case-management``'s member follow-up form given an image question ``photo`` and the node Nova writes beside
    it for the photo's address on CommCare HQ (the form's attachment, by its instance id and the file's name), which
    the form saves to the member's ``photo_link``."""
    link = (
        "if(/data/photo = '', '', concat('https://www.commcarehq.org/a/nova-proof/api/form_attachment/v1/',"
        " /data/meta/instanceID, '/', /data/photo))"
    )
    _change(
        authoring,
        app_id,
        "photo-link",
        *_question("photo", "Photo", "upload", "binary", attributes=' mediatype="image/*"'),
        *_sibling("nova_url_photo", "photo", link),
        menu=1,
        form=0,
    )
    ops.set_json(
        authoring, app_id, "/modules/1/forms/0/actions/update_case/update/photo_link", _update("/data/nova_url_photo")
    )


def _preload(paths):
    """A case preload of ``paths`` (question path to property), as the Case Management page saves one."""
    return {"preload": paths, "doc_type": "PreloadAction", "condition": _condition("never")}


def preload_into_a_repeated_question(authoring, app_id):
    """``hq-case-management``'s member follow-up form given a repeat ``visits`` holding ``visitor``, which the form's
    case preload fills from the member's ``status_note``."""
    _change(authoring, app_id, "visits-repeat", *_repeat("visits", "Visits", "visitor", "Visitor"), menu=1, form=0)
    ops.set_json(
        authoring, app_id, "/modules/1/forms/0/actions/case_preload", _preload({"/data/visits/visitor": "status_note"})
    )


# hq-case-management's Households menu, which the Members menu chooses its member's household from.
_HOUSEHOLDS = {"$menu": 0}


def preload_in_a_multi_select_child_menu(authoring, app_id):
    """``hq-case-management``'s Members list choosing several members after its household is chosen in Households,
    and its follow-up form's ``status_note`` loaded from each member's ``status_note``."""
    ops.set_json(authoring, app_id, "/modules/1/case_details/short/multi_select", True)
    ops.set_json(
        authoring,
        app_id,
        "/modules/1/parent_select",
        {"active": True, "relationship": "parent", "module_id": _HOUSEHOLDS, "doc_type": "ParentSelect"},
    )
    ops.set_json(
        authoring, app_id, "/modules/1/forms/0/actions/case_preload", _preload({"/data/status_note": "status_note"})
    )


def _update_never():
    """A form's update of its own case that never runs and writes nothing."""
    return {"condition": _condition("never"), "update": {}, "conflicts": {}, "doc_type": "UpdateCaseAction"}


def update_never_in_a_multi_select_menu(authoring, app_id):
    """``hq-case-management``'s Members list choosing several members, and its follow-up form's update of the chosen
    members never run and writing nothing."""
    ops.set_json(authoring, app_id, "/modules/1/case_details/short/multi_select", True)
    ops.set_json(authoring, app_id, "/modules/1/forms/0/actions/update_case", _update_never())


def child_case_in_a_multi_select_menu(authoring, app_id):
    """``hq-case-management``'s Members list choosing several members, and its follow-up form opening a member under
    each, named by ``status_note``, in an app that shares no cases."""
    ops.set_json(authoring, app_id, "/modules/1/case_details/short/multi_select", True)
    ops.set_json(
        authoring,
        app_id,
        "/modules/1/forms/0/actions/subcases",
        [
            {
                "case_type": "member",
                "name_update": _update("/data/status_note"),
                "reference_id": "parent",
                "repeat_context": "",
                "relationship": "child",
                "condition": _condition("always"),
                "close_condition": _condition("never"),
                "case_properties": {},
                "doc_type": "OpenSubCaseAction",
            }
        ],
    )


def open_in_a_repeat(authoring, app_id):
    """``hq-advanced``'s member visit form given a repeat ``visits``, and a member opened for each visit under the
    household, named by the visit's ``visitor``."""
    _visits(authoring, app_id)
    ops.set_json(
        authoring,
        app_id,
        _VISIT_OPENS,
        [_open("open_member_0", "member", "/data/visits/visitor", [_index("load_household0")], "/data/visits")],
    )


def conditional_open_with_web_only_index(authoring, app_id):
    """Keep conditional creates separate from the always-run index writers."""
    open_visitor_with_web_only_index(authoring, app_id)
    _visit_outcome(authoring, app_id)
    ops.set_json(
        authoring, app_id, f"{_VISIT_OPENS}/0/open_condition",
        _condition("if", "/data/visit_outcome", "new"),
    )


def open_in_repeat_with_web_only_index(authoring, app_id):
    """Put the one-worker index inside the authored Visits repeat, outside the initial instance writer proof."""
    open_in_a_repeat(authoring, app_id)
    ops.set_json(authoring, app_id, f"{_VISIT_OPENS}/0/case_indices/0/reference_id", "აprobe")


def member_registered_in_an_advanced_form(authoring, app_id):
    """``hq-advanced``'s Member reviews form loading no case and opening one member, named by the form's
    ``review_note``: the form registers a member, as HQ counts a registration of an advanced form
    (``AdvancedForm.is_registration_form``)."""
    ops.set_json(authoring, app_id, f"{_REVIEW_FORM}/actions/load_update_cases", [])
    ops.set_json(
        authoring,
        app_id,
        f"{_REVIEW_FORM}/actions/open_cases",
        [_open("open_member_0", "member", "/data/review_note", [])],
    )


def _visit_outcome(authoring, app_id):
    """``hq-advanced``'s member visit form given a single-choice question ``visit_outcome``, answered ``new`` or
    ``left``."""
    _change(
        authoring,
        app_id,
        "visit-outcome",
        *_question("visit_outcome", "Outcome", "select1", None, items=(("new", "New member"), ("left", "Left"))),
        menu=1,
        form=0,
    )


def open_member_under_a_condition(authoring, app_id):
    """``hq-advanced``'s member visit form opening a member under the household where ``visit_outcome`` answers
    ``new``."""
    _visit_outcome(authoring, app_id)
    opened = _open("open_member_0", "member", "/data/notes", [_index("load_household0")])
    opened["open_condition"] = _condition("if", "/data/visit_outcome", "new")
    ops.set_json(authoring, app_id, _VISIT_OPENS, [opened])


def open_member_closed_under_a_condition(authoring, app_id):
    """``hq-advanced``'s member visit form opening a member under the household, closed where ``visit_outcome``
    answers ``left``."""
    _visit_outcome(authoring, app_id)
    opened = _open("open_member_0", "member", "/data/notes", [_index("load_household0")])
    opened["close_condition"] = _condition("if", "/data/visit_outcome", "left")
    ops.set_json(authoring, app_id, _VISIT_OPENS, [opened])


def member_opened_under_a_member_in_one_repeat(authoring, app_id):
    """``hq-advanced``'s member visit form given a repeat ``visits``, and for each visit a member opened under the
    household and a second member opened under that one, both in the repeat: the second's index, ``member_parent``,
    names the open action of its own row, which HQ's build links in the row (a repeat's two indexed open actions nest
    their blocks, ``xform.py::_create_casexml_advanced``)."""
    _visits(authoring, app_id)
    ops.set_json(
        authoring,
        app_id,
        _VISIT_OPENS,
        [
            _open("open_member_0", "member", "/data/visits/visitor", [_index("load_household0")], "/data/visits"),
            _open(
                "open_member_1",
                "member",
                "/data/visits/visitor",
                [{**_index("open_member_0"), "reference_id": "member_parent"}],
                "/data/visits",
            ),
        ],
    )


# hq-plain's Followup Form: the start of its head's hashtag prefixes as HQ's form builder saved them.
_PLAIN_PREFIXES = "{&quot;prefixes&quot;:{&quot;#case/&quot;:"
# The worker's case, the path HQ's session schema gives the form builder for ``#user``
# (``app_schemas/session_schema.py``, its ``userid`` reference; ``xpath.py::UsercaseXPath``).
_WORKER_CASE = (
    "instance('casedb')/casedb/case[@case_type = 'commcare-user']"
    "[hq_user_id = instance('commcaresession')/session/context/userid]/"
)


def head_prefixes_naming_the_worker(authoring, app_id):
    """``hq-plain``'s Followup Form, its head's hashtag prefixes (``vellum:hashtagTransforms``) naming ``#user/``,
    the worker's case, beside ``#case/``, as the form builder writes them for a form whose expressions read a worker
    property (Vellum's ``datasources.js``, a prefix a node's hashtag gives)."""
    _change(
        authoring,
        app_id,
        "head-prefixes-naming-the-worker",
        (
            _PLAIN_PREFIXES,
            "{&quot;prefixes&quot;:{&quot;#user/&quot;:&quot;" + _WORKER_CASE + "&quot;,&quot;#case/&quot;:",
            1,
        ),
        menu=0,
        form=1,
    )


def link_through_a_first_menu_with_different_case_types(authoring, app_id):
    from proof.matrix.variants.menus_and_case_lists import _second_case_type_on_another_command

    ops.set_json(authoring, app_id, "/modules/2/put_in_root", True)
    _second_case_type_on_another_command(authoring, app_id)


def previous_on_a_first_menu_with_no_shared_case(authoring, app_id):
    """Both menus show their forms on the first menu, and the Members follow-up returns with Previous. The first
    menu's forms share no case (the household registration's entry selects none), so Previous carries no case of
    one type into a form that reads another (``workflow.py::WorkflowHelper._root_module_datums``)."""
    ops.set_json(authoring, app_id, "/modules/0/put_in_root", True)
    ops.set_json(authoring, app_id, "/modules/1/put_in_root", True)
    ops.set_json(authoring, app_id, "/modules/1/forms/0/post_form_workflow", "previous_screen")

def connection_from_a_parent_aligned_load(authoring, app_id):
    """The child follows a member's parent after HQ aligns that member to the root menu's datum."""
    path = "/modules/2/forms/0/actions/load_update_cases"
    ops.set_json(authoring, app_id, "/modules/2/root_module_id", {"$menu": 1})
    ops.set_json(authoring, app_id, path + "/1/case_tag", "child_member")
    ops.set_json(
        authoring, app_id, path + "/-",
        {
            "doc_type": "LoadUpdateAction", "case_type": "household", "case_tag": "connected_household",
            "details_module": None, "case_index": _index(""), "case_properties": {}, "preload": {},
            "close_condition": _condition("never"),
            "auto_select": {"doc_type": "AutoSelectCase", "mode": "case",
                            "value_source": "child_member", "value_key": "parent"},
        },
    )


def two_entries_opening_the_visit(authoring, app_id):
    """Two entries created from HQ’s menu, each pointed at the ordinary parent
    by its form settings and configured through its Advanced Case Management save."""
    from corehq.apps.app_manager.models import AdvancedFormActions, CaseIndex, LoadUpdateAction
    from proof.hq import operations
    from proof.matrix.bases import _pages

    app = operations.held_app(authoring.state, app_id)
    households, visits, reviews = [app.get_module(index) for index in range(3)]
    parent_id = visits.get_form(0).unique_id

    def pick(tag, case_type, menu):
        return LoadUpdateAction(case_type=case_type, case_tag=tag, details_module=menu.unique_id)

    member = pick("load_member1", "member", visits)
    member.case_index = CaseIndex(tag="load_household0", reference_id="parent", relationship="child")
    for menu, name, workflow, choices in (
        (1, "Visit from a referral", "root", [
            pick("referring_household", "household", households),
            pick("load_member1", "member", reviews),
            pick("load_household0", "household", households),
        ]),
        (2, "Visit from a callback", "default", [pick("load_household0", "household", households), member]),
    ):
        _pages.new_form(authoring, app_id, menu, form_type="shadow")
        _pages.save_form_attributes(authoring, app_id, menu, 1, [
            ("name", name), ("shadow_parent", parent_id), ("post_form_workflow", workflow),
        ], "shared entry")
        actions = AdvancedFormActions(load_update_cases=choices)
        pairs = [("actions", json.dumps(actions.to_json())), ("arbitrary_datums", "[]")]
        with authoring.step(f"build:shared-entry-choices:{menu}", json.dumps(pairs).encode()):
            entry = operations.held_app(authoring.state, app_id).get_module(menu).get_form(1)
            body, content_type = ops.form_body(pairs)
            ops.post(authoring, "edit_advanced_form_actions", [app_id, entry.unique_id], body, content_type, name)


def first_load_writes_through_declared_parent(authoring, app_id):
    """A district follow-up establishes the household parent used by the existing first load."""
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, FormActionCondition, OpenSubCaseAction

    from proof.matrix.bases.hq_advanced import HOUSEHOLD_VISIT, REGISTRATION

    _pages.new_case_module(authoring, app_id, name="Districts", case_type="district")
    ops.upload_form_source(authoring, app_id, 3, 0, REGISTRATION, "district registration source")
    ops.upload_form_source(authoring, app_id, 3, 1, HOUSEHOLD_VISIT, "district follow-up source")
    _pages.save_case_actions(authoring, app_id, 3, 0, name_path="/data/head_name")

    def open_household(actions):
        actions["subcases"] = [
            OpenSubCaseAction(
                case_type="household",
                name_update=ConditionalCaseUpdate(question_path="/data/new_member"),
                repeat_context="",
                relationship="child",
                condition=FormActionCondition(type="always"),
            ).to_json()
        ]

    _pages.save_case_management(authoring, app_id, 3, 1, change=open_household, what="household district parent")

    def update_district(app):
        load = app.get_module(1).get_form(0).actions.load_update_cases[0]
        load.case_properties = {
            "parent/last_member_visit": ConditionalCaseUpdate(
                question_path="/data/visited_on", update_mode="always"
            )
        }

    _pages.change_app_model(authoring, app_id, "save-visit-to-household-district", update_district)


def open_relationship_from_constrained_text(authoring, app_id):
    """Exercise an editable Text answer that can carry only the two permitted relationships."""
    from proof.matrix.registry import load_variants

    change = next(row.change for row in load_variants() if row.id == "hq-advanced/open-relationship-by-question")
    ops.set_json(authoring, app_id, change["pointer"], change["value"])

    def constrain_notes(root, _form):
        bind, = root.xpath("//*[local-name()='bind'][@nodeset='/data/notes']")
        bind.set("constraint", ". = 'child' or . = 'extension'")
        bind.set("required", "true()")

    ops.set_form_source(authoring, app_id, 1, 0, constrain_notes, what="require a valid case relationship")


def open_relationship_from_optional_constrained_text(authoring, app_id):
    open_relationship_from_constrained_text(authoring, app_id)

    def optional_notes(root, _form):
        bind, = root.xpath("//*[local-name()='bind'][@nodeset='/data/notes']")
        bind.attrib.pop("required")

    ops.set_form_source(authoring, app_id, 1, 0, optional_notes, what="allow a blank case relationship answer")

