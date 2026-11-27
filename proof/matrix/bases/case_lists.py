"""``hq-case-lists``: an app made in HQ whose case lists hold the column formats and sort rules HQ's pages write.

1. A new app (``views/apps.py::default_new_app``), named "Patient lists" on
   the app page (``edit_app_attr``).
2. A case list menu "Patients" of the case type ``patient``
   (``views/modules.py::new_module``). Its registration form's source is
   written by HQ's own form writer (``xform_builder.py::XFormBuilder``) and
   uploaded on the form page: text ``patient_name``, date ``dob``, text
   ``phone``, single select ``village`` (``north``, ``south``), integer
   ``visits``, decimal ``weight`` (typed ``xsd:double``, as the form
   builder types a Decimal question) and text ``notes``; its case management
   (``edit_form_actions``) names the case from ``patient_name`` and saves
   the rest to the case. Its follow-up form holds a text question
   ``visit_note``.
3. The Case List tab (``edit_module_detail_screens``): the name, ``dob`` as
   a date, ``phone`` as a phone number, ``village`` as an ID mapping and a
   calculated column ``visits + 1``; sort rules on ``visits`` (``int``,
   descending, blanks last), on ``weight``, which no column shows (``double``,
   ascending, blanks first), on ``dob`` (``date``) and on the name
   (``plain``); and the filter ``dob > '2000-01-01'``, a date property
   compared with a quoted date. The Case Detail tab shows the name, ``dob``
   as a date, ``phone``, ``village`` and ``notes``, a column the list lacks.
4. A second case list menu "Follow-ups" of ``patient``, its registration
   form deleted (``views/forms.py::delete_form``) and its follow-up holding
   a text question ``follow_note``, whose list shows ``village`` invisible
   first, then the name, with no sort rule.
5. A third case list menu "Visits due" of ``patient``, its registration form
   deleted and its follow-up holding a text question ``due_note``, whose list
   shows the name and then ``visits`` as Search Only under a header the Case
   List tab leaves blank (stored as ``{"en": ""}``, the tab's serializer
   writing the header input's text for the page's language,
   ``details/bootstrap5/column.js``), and sorts on ``visits`` (``int``,
   descending, blanks last) with the display text "Visit count"
   (``views/modules.py::_update_sort_elements`` stores it under the page's
   language). HQ's build gives that column a header because the sort element
   has display text (``detail_screen.py::Invisible.header``), whose app
   string is blank in every language, so Android's Sort by lists an entry that
   shows blank, which the first publish drops
   (``sort-by-entry-with-a-blank-name-dropped``). It is a menu of its own so
   that no other list's columns or sort rules move.
6. The words of "Visits due"'s columns: HQ's build reads ``name``,
   ``date-opened`` and ``external-id`` as the case's own ``case_name``,
   ``date_opened`` and ``external_id`` (``detail_screen.py::CASE_PROPERTY_MAP``),
   so a column stores either word of each, and the Case List page stores the
   field as typed (``views/modules.py::edit_module_detail_screens`` wraps each
   posted column with ``DetailColumn.from_json``, which renames no field). Its
   list's name is typed ``case_name``; its Case Detail tab shows the name as
   ``name``, the opening date typed ``date_opened`` and the external id typed
   ``external-id``. The app string id HQ's build gives a column's header names
   the stored word (``id_strings.py::detail_column_header_locale``,
   ``m2.case_short.case_case_name_1.header``), so a first publish that wrote
   the other word would move each id. The UI translations page
   (``views/apps.py::edit_app_ui_translations``) holds an English override of
   the external id's header under its id (``EXTERNAL_ID_HEADER_KEY``), which
   ``app_strings.py``'s strategies lay over the header HQ's build writes
   there, and which reads as that header's English wording only where the
   reading names the column's id by its stored word.

It saves no setting. Web Apps is off, as ``Application.cloudcare_enabled``
defaults, and its content runs on Android, so its preselected declaration is
Android only, which a case list's value expectations need: they run on
Nova's local archive. A multi-select list is not here: it is unavailable on
Android (``menus-and-case-lists/detail-multi-select``), so a base read as
Android cannot hold one, and its ``max_select_value`` of ``-1`` is a variant
over a base whose reading declares Web Apps. Its configuration is the lane's
floor: nothing it holds is gated.
"""

from __future__ import annotations

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Patient lists"
CASE_TYPE = "patient"
FILTER = "dob > '2000-01-01'"
# The app string id HQ's build gives the header of "Visits due"'s third Case Detail column, stored as ``external-id``
# (``id_strings.py::detail_column_header_locale``: the menu, the detail, the model, the field and the column's place
# from one).
EXTERNAL_ID_HEADER_KEY = "m2.case_long.case_external-id_3.header"


def registration_source(name):
    """The registration form, as HQ's ``XFormBuilder`` writes it, with ``weight`` typed as the form builder types a
    Decimal question."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("patient_name", "Patient's name", "string")
    xform.new_question("dob", "Date of birth", "date")
    xform.new_question("phone", "Phone number", "string")
    xform.new_question("village", "Village", "select1", choices={"north": "North", "south": "South"})
    xform.new_question("visits", "Visits so far", "int")
    xform.new_question("weight", "Weight in kilograms", "decimal")
    xform.new_question("notes", "Notes", "string")
    # The form writer types a decimal ``xsd:decimal``, which HQ's form builder never writes: its Decimal question is
    # ``xsd:double`` (``mugs/types/numeric.js``). The form writer makes its binds with no namespace while the form
    # is in memory (``lxml.builder.E``), so the bind is found by local name.
    binds = xform._etree.xpath("//*[local-name()='bind'][@nodeset='/data/weight']")
    if len(binds) != 1:
        raise ValueError(f"The form writer wrote {len(binds)} binds for weight.")
    binds[0].set("type", "xsd:double")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def one_question_source(question, label):
    def write(name):
        from corehq.apps.app_manager.xform_builder import XFormBuilder

        xform = XFormBuilder(name)
        xform.new_question(question, label, "string")
        return xform.tostring(xml_declaration=True).decode("utf-8")

    return write


def _column(field, header, *, format="plain", **extra):
    """A case list or case detail column as HQ's model writes it (``models/case_list.py::DetailColumn``), which
    the tabs post back as they hold it."""
    from corehq.apps.app_manager.models import DetailColumn

    return DetailColumn(model="case", field=field, header={"en": header}, format=format, **extra).to_json()


def _village_mapping():
    from corehq.apps.app_manager.models import MappingItem

    return [
        MappingItem(key="north", value={"en": "North"}),
        MappingItem(key="south", value={"en": "South"}),
        MappingItem(key="", value={"en": "Unspecified"}),
        MappingItem(key="east bank", value={"en": "East Bank"}),
    ]


def _sort(field, type, direction, blanks, display=""):
    """A sort rule as the Case List tab posts one (``sort_rows.js``): ``display`` is the text of the page's
    language."""
    return {
        "field": field,
        "type": type,
        "direction": direction,
        "blanks": blanks,
        "display": display,
        "sort_calculation": "",
    }


def save_list(authoring, app_id, menu, *, columns, sort_elements, filter=None):
    """The menu's case list saved as the Case List tab saves it (``edit_module_detail_screens``: ``type``
    ``case``, the columns, the sort rules and the list's own settings, each JSON), with ``filter`` where given."""
    from proof.hq import operations

    pairs = [
        ("type", json.dumps("case")),
        ("short", json.dumps(list(columns))),
        ("sort_elements", json.dumps(list(sort_elements))),
        ("multi_select", json.dumps(False)),
        ("auto_select", json.dumps(False)),
    ]
    if filter is not None:
        pairs.append(("filter", json.dumps(filter)))
    with authoring.step(f"build:case-list:{menu}", json.dumps(pairs).encode()):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        body, content_type = ops.form_body(pairs)
        ops.post(
            authoring,
            "edit_module_detail_screens",
            [app_id, module.unique_id],
            body,
            content_type,
            f"the case list of menu {menu}",
        )


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.new_case_module(authoring, app_id, name="Patients", case_type=CASE_TYPE)
    ops.upload_form_source(authoring, app_id, 0, 0, registration_source, "registration-source")
    _pages.save_case_actions(
        authoring,
        app_id,
        0,
        0,
        name_path="/data/patient_name",
        updates={
            "dob": "/data/dob",
            "phone": "/data/phone",
            "village": "/data/village",
            "visits": "/data/visits",
            "weight": "/data/weight",
            "notes": "/data/notes",
        },
    )
    ops.upload_form_source(
        authoring, app_id, 0, 1, one_question_source("visit_note", "How did the visit go?"), "follow-up-source"
    )
    save_list(
        authoring,
        app_id,
        0,
        columns=[
            _column("name", "Name"),
            _column("dob", "Born", format="date"),
            _column("phone", "Phone", format="phone"),
            _column("village", "Village", format="enum", enum=_village_mapping()),
            _column("visits + 1", "Next visit", useXpathExpression=True),
        ],
        sort_elements=[
            _sort("visits", "int", "descending", "last"),
            _sort("weight", "double", "ascending", "first"),
            _sort("dob", "date", "ascending", "last"),
            _sort("name", "plain", "ascending", "first"),
        ],
        filter=FILTER,
    )
    _pages.save_case_detail(
        authoring,
        app_id,
        0,
        columns=[
            _column("name", "Name"),
            _column("dob", "Born", format="date"),
            _column("phone", "Phone", format="phone"),
            _column("village", "Village", format="enum", enum=_village_mapping()),
            _column("notes", "Notes"),
            _column("notes", "Visit instructions", format="markdown"),
            _column("dob", "Weeks since birth", format="time-ago", time_ago_interval=7),
            _column("dob", "Due", format="late-flag", late_flag=1),
            _column("dob", "Upcoming", format="late-flag", late_flag=-2),
        ],
    )

    _pages.new_case_module(authoring, app_id, name="Follow-ups", case_type=CASE_TYPE)
    _pages.delete_form(authoring, app_id, 1, 0)
    ops.upload_form_source(
        authoring, app_id, 1, 0, one_question_source("follow_note", "What needs to happen next?"), "follow-up-2"
    )
    save_list(
        authoring,
        app_id,
        1,
        columns=[_column("village", "Village", format="invisible"), _column("name", "Name")],
        sort_elements=[],
    )

    _pages.new_case_module(authoring, app_id, name="Visits due", case_type=CASE_TYPE)
    _pages.delete_form(authoring, app_id, 2, 0)
    ops.upload_form_source(
        authoring, app_id, 2, 0, one_question_source("due_note", "What is due at this visit?"), "follow-up-3"
    )
    save_list(
        authoring,
        app_id,
        2,
        columns=[_column("case_name", "Name"), _column("visits", "", format="invisible")],
        sort_elements=[_sort("visits", "int", "descending", "last", display="Visit count")],
    )
    _pages.save_case_detail(
        authoring,
        app_id,
        2,
        columns=[_column("name", "Name"), _column("date_opened", "Opened"), _column("external-id", "Reference")],
    )
    _pages.save_ui_translations(authoring, app_id, {"en": {EXTERNAL_ID_HEADER_KEY: "Patient reference"}})
    return app_id


BASE = Base(
    id="hq-case-lists",
    build=build,
    configuration=Configuration(),
    exhibits=(
        "questions/text-input-xsd-string",
        "questions/date-xsd-date",
        "questions/integer-xsd-int-xsd-integer-read-as-the-same",
        "questions/decimal-xsd-double",
        "questions/multiple-choice-select1-item",
        "forms-and-case-writes/open-case-name-update-question-path",
        "forms-and-case-writes/update-case-update-property-question",
        "menus-and-case-lists/module-with-case-type-case-list-module",
        "menus-and-case-lists/detail-filter-value-lifts-into-predicate",
        "menus-and-case-lists/2-date-date-format-d-m-y-d-m-y-m-d-y-m-d-y-b-d-y",
        "menus-and-case-lists/4-phone",
        "menus-and-case-lists/6-late-flag-late-flag-1",
        "menus-and-case-lists/6p-late-flag-late-flag-0",
        "menus-and-case-lists/10-markdown-outside-the-link-shape",
        "menus-and-case-lists/3-time-ago-time-ago-interval-the-7-menu-values-years-months",
        "menus-and-case-lists/5-enum-id-mapping",
        "menus-and-case-lists/5pp-enum-key-that-is-empty-or-holds-whitespace",
        "menus-and-case-lists/usexpathexpression-field-xpath-lifting-into-valueexpression",
        "menus-and-case-lists/direction",
        "menus-and-case-lists/blanks-first-last",
        "menus-and-case-lists/type-plain-date-int-double-equal-to-the-type-nova-derives",
        "menus-and-case-lists/field-naming-a-property-not-displayed-hq-appends-a-hidden-column",
        "menus-and-case-lists/7-invisible-search-only-on-the-case-list-outside-a-custom-tile",
        "menus-and-case-lists/no-sort-elements",
        "menus-and-case-lists/display-lang-on-a-sort-joined-to-an-invisible-column",
        "menus-and-case-lists/name-date-opened-external-id-status-owner-id-hq-renames-to-case",
        "application-and-settings/translations-generated-wording",
    ),
)
