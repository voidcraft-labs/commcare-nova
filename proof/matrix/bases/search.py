"""``hq-search``: an app made in HQ whose menus each search for cases as HQ's Case List page sets a search.

1. A new app (``views/apps.py::default_new_app``), named "Client search" on
   the app page (``edit_app_attr``), and one global lookup table,
   ``districts``, made with HQ's own models
   (``proof/matrix/bases/lookups.py::make_tables``), which a search field
   offers as its choices.
2. A case list menu "Clients" of the case type ``client``
   (``views/modules.py::new_module``). Its registration form's source is
   written by HQ's own form writer (``xform_builder.py::XFormBuilder``) and
   uploaded on the form page: text ``client_name``, ``village``,
   ``client_code`` and ``standing``, a ``district``, and the dates ``dob``
   and ``last_visit``; its case management (``edit_form_actions``) names the
   case from ``client_name`` and saves the rest. No form saves
   ``registered_at``: a value its form types a date and time and saves
   straight to a case is saved there as its day alone (HQ's build binds the
   case block's leaf with no type, and Core's ``Recalculate.wrapData`` wraps
   a date there as a date), which Nova refuses
   (``forms-and-case-writes/a-datetime-question-saved-straight-to-a-case``).
   Its follow-up form holds
   a text question ``visit_note`` and a text question ``note_again`` whose
   Default Value reads it by its absolute path (``/data/visit_note``), which
   Nova's publish spells from ``current()`` (``default-reads-current``, which
   changes no behavior and states no first-publish change). Its case list,
   saved on the Case List tab (``edit_module_detail_screens``), shows the
   name and a calculated column comparing two dates and times bare,
   ``if(registered_at < now(), ...)``, which the reading types a date and
   time by its comparison with ``now()`` and Nova's publish compares as
   moments (``instant-comparison``), on the list the search's results show.
   No case the walks start from holds ``registered_at``, so the column shows
   its second branch on every state; ``hq-expressions`` shows the change on
   a value. Its Search, saved on the Case List page
   (``edit_module_detail_screens``, ``search_properties``): search first
   (``auto_launch``), with no title, and a field of each kind HQ's page
   offers that Nova holds: ``client_name``, which HQ does not match itself
   (``exclude``) and which a filter row compares with the case's name under
   a guard of its presence, written as a person writes it, with neither the
   quote checks Nova's own row holds nor its validation
   (``search-value-guards``); ``village`` with no input; ``client_code`` as
   a barcode; ``dob`` as a date, which HQ does not match itself
   (``exclude``) and which a row matches over the whole day, written as
   Nova's own row writes it (``case-search/input-date``,
   ``simpleArmDerivation.ts::deriveSimpleArmPredicate``); ``last_visit`` as a
   date range; and ``district`` choosing from the table ``districts``. Its
   list's filter, ``last_visit <= today()``, is restated by a further row
   whose CSQL calls HQ's own ``today()``, the project space's day, which
   Nova keeps on the server independently of the worker's day.
3. A case list menu "Active clients" of ``client``, its registration form
   deleted (``views/forms.py::delete_form``) and its follow-up holding a
   text question ``check_note``, whose list's filter is
   ``standing = 'active' and district = 'd1'`` and whose Search skips to its
   results (``auto_launch`` and ``default_search``) and restates that filter
   in one row that ANDs its two conditions, which Nova writes as two rows
   (``search-filter-rows-recut``).
4. A case list menu "Visits" of ``client``, its registration form deleted
   and its follow-up holding a text question ``visit_summary``, whose
   Search is inline (``inline_search``, so its forms read the search) with
   no field. Its list's filter, ``standing = 'open'``, is one the search does
   not restate. Nova keeps that filter on the device. The case database has a client
   both open and in north, one north and active, and one open elsewhere. HQ
   returns the two in north before the inline detail keeps the open client,
   on both the source and the first publish. The worker opens the retained
   client and fills the same form.
5. A referrals menu that searches case attributes, a date, an ancestor and
   the worker's owner ID. Independent rows use both the matched and excluded
   prompts. A separate device filter narrows the worker's list after the
   search returns.

Its configuration is the lane's floor with case search on,
``SYNC_SEARCH_CASE_CLAIM``, the flag HQ's Search options stand under,
``CASE_SEARCH_ADVANCED``, the flag the date fields, the field HQ does not
match and the inline search stand under (the gates of their manifest
entries), ``CASE_SEARCH_RELATED_LOOKUPS`` for the ancestor filter, and
``LOOKUP_TABLES`` for the table. Web Apps is off, as
``Application.cloudcare_enabled`` defaults; the inline search's forms read
results that Android cannot fetch, so its preselected declaration is Web Apps
only and its first publish turns Web Apps on.
"""

from __future__ import annotations

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.case_lists import _column, save_list
from proof.matrix.bases.lookups import make_tables
from proof.matrix.registry import Base

NAME = "Client search"
CASE_TYPE = "client"
DISTRICTS = {"tag": "districts", "fields": ["id", "name"], "rows": [["d1", "Upper valley"], ["d2", "Lower valley"]]}

FIELD = "instance('search-input:results')/input/field[@name = 'client_name']"
NAME_ROW = f"if(count({FIELD}), concat(\"case_name = '\", {FIELD}, \"'\"), 'match-all()')"
# HQ's own `today()` inside the CSQL, which HQ's search answers with the project space's day
# (``case_search/xpath_functions/value_functions.py::today``), restating the list's filter.
TODAY_FILTER = "last_visit <= today()"
TODAY_ROW = f'"{TODAY_FILTER}"'
DOB_FIELD = "instance('search-input:results')/input/field[@name = 'dob']"
# The whole day of the date the worker gives, as Nova's own row for a date field writes it.
DOB_ROW = (
    f"if(count({DOB_FIELD}), if({DOB_FIELD} = '', 'match-none()', concat('dob >= date(\"', {DOB_FIELD}, '\")', '', "
    f"' and dob < date-add(date(\"', {DOB_FIELD}, '\"), ', \"'\", 'days', \"'\", ', 1)', '')), 'match-all()')"
)
ACTIVE_FILTER = "standing = 'active' and district = 'd1'"
RECUT_ROW = f'"{ACTIVE_FILTER}"'
LIST_FILTER = "standing = 'open'"
JOINED_ROW = "\"village = 'north'\""
# A client both filters of the inline search's menu keep, which no generated case is (``Base.cases``).
OPEN_IN_NORTH = (CASE_TYPE, (("standing", "open"), ("village", "north")))
# Two dates and times compared bare, as a person writes the comparison in a calculated column.
REGISTERED_COLUMN = "if(registered_at < now(), 'Registered', 'Not yet')"


def registration_source(name):
    """The registration form, as HQ's ``XFormBuilder`` writes it."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("client_name", "Client's name", "string")
    xform.new_question("village", "Village", "string")
    xform.new_question("client_code", "Client code", "string")
    xform.new_question("standing", "Standing", "string")
    xform.new_question("district", "District", "string")
    xform.new_question("dob", "Date of birth", "date")
    xform.new_question("last_visit", "Last visit", "date")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def follow_up_source(name):
    """Menu 0's follow-up form, as HQ's ``XFormBuilder`` writes it: ``note_again``'s Default Value reads
    ``visit_note`` by its absolute path, a setvalue at ``xforms-ready`` (``XFormBuilder._append_to_model``'s
    ``value``)."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("visit_note", "How did the visit go?", "string")
    xform.new_question("note_again", "The note, as written", "string", value="/data/visit_note")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def one_question_source(question, label):
    def write(name):
        from corehq.apps.app_manager.xform_builder import XFormBuilder

        xform = XFormBuilder(name)
        xform.new_question(question, label, "string")
        return xform.tostring(xml_declaration=True).decode("utf-8")

    return write


def field(name, label, **settings):
    """A search field as the Case List page posts one (``views/modules.py::_update_search_properties`` reads
    ``name``, ``label``, ``hint``, ``appearance`` and the settings it names)."""
    return {"name": name, "label": label, "hint": "", "appearance": "", "receiver_expression": "", **settings}


def save_search(authoring, app_id, menu, *, fields=(), rows=(), filters=(), defaults=(), **workflow):
    """The menu's Search saved as the Case List page saves it (``edit_module_detail_screens``, whose
    ``_gather_and_update_search_properties`` builds the menu's ``CaseSearch`` from ``search_properties``): the
    fields, each row as a default filter of ``_xpath_query``, no title and no description, and ``workflow``'s
    ``auto_launch``, ``default_search`` and ``inline_search``."""
    from proof.hq import operations

    search = {
        "properties": list(fields),
        "default_properties": [
            *({"property": key, "defaultValue": value} for key, value in filters),
            *defaults,
            *({"property": "_xpath_query", "defaultValue": row} for row in rows),
        ],
        "custom_sort_properties": [],
        "title_label": "",
        "description": "",
        "auto_launch": workflow.get("auto_launch", False),
        "default_search": workflow.get("default_search", False),
        "inline_search": workflow.get("inline_search", False),
        "custom_related_case_property": workflow.get("custom_related_case_property", ""),
        "include_all_related_cases": workflow.get("include_all_related_cases", False),
        "search_button_display_condition": "",
        "blacklisted_owner_ids_expression": "",
    }
    with authoring.step(f"build:search:{menu}", json.dumps(search, sort_keys=True).encode()):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        body, content_type = ops.form_body([("type", json.dumps("case")), ("search_properties", json.dumps(search))])
        ops.post(
            authoring,
            "edit_module_detail_screens",
            [app_id, module.unique_id],
            body,
            content_type,
            f"the search of menu {menu}",
        )


def save_list_filter(authoring, app_id, menu, text):
    """The menu's case list filter saved on the Case List tab (``edit_module_detail_screens``'s ``filter``)."""
    from proof.hq import operations

    with authoring.step(f"build:list-filter:{menu}", text.encode()):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        body, content_type = ops.form_body([("type", json.dumps("case")), ("filter", json.dumps(text))])
        ops.post(
            authoring,
            "edit_module_detail_screens",
            [app_id, module.unique_id],
            body,
            content_type,
            f"the case list filter of menu {menu}",
        )


def follow_up_menu(authoring, app_id, menu, name, question, label):
    """A case list menu of ``client`` named ``name`` with its follow-up form alone, holding one text question."""
    _pages.new_case_module(authoring, app_id, name=name, case_type=CASE_TYPE)
    _pages.delete_form(authoring, app_id, menu, 0)
    ops.upload_form_source(authoring, app_id, menu, 0, one_question_source(question, label), f"m{menu}-follow-up")


def add_mixed_search(authoring, app_id):
    """A real menu-save and search-page save with a second selectable record type,
    a separate type returned to the form, and a record ID used for supporting details."""
    from proof.hq import operations

    menu = len(operations.held_app(authoring.state, app_id).modules)
    _pages.new_case_module(authoring, app_id, name="Household outreach", case_type="household")
    _pages.delete_form(authoring, app_id, menu, 0)
    ops.upload_form_source(authoring, app_id, menu, 0, one_question_source("visit_note", "Visit note"), "household-visit")
    _pages.save_module_attributes(authoring, app_id, menu, [("additional_case_types", "client")], "additional-record-types")
    save_search(
        authoring, app_id, menu, inline_search=True, auto_launch=True,
        custom_related_case_property="care_record",
        defaults=[
            {"property": "case_type", "defaultValue": "'referral'"},
            {"property": "x_commcare_include_all_related_cases", "defaultValue": "'false'"},
        ],
    )


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    make_tables(authoring, [DISTRICTS])

    _pages.new_case_module(authoring, app_id, name="Clients", case_type=CASE_TYPE)
    ops.upload_form_source(authoring, app_id, 0, 0, registration_source, "registration-source")
    _pages.save_case_actions(
        authoring,
        app_id,
        0,
        0,
        name_path="/data/client_name",
        updates={
            "village": "/data/village",
            "client_code": "/data/client_code",
            "standing": "/data/standing",
            "district": "/data/district",
            "dob": "/data/dob",
            "last_visit": "/data/last_visit",
        },
    )
    ops.upload_form_source(authoring, app_id, 0, 1, follow_up_source, "follow-up-source")
    save_list(
        authoring,
        app_id,
        0,
        columns=[_column("name", "Name"), _column(REGISTERED_COLUMN, "Registered", useXpathExpression=True)],
        sort_elements=[],
    )
    save_list_filter(authoring, app_id, 0, TODAY_FILTER)
    itemset = {
        "instance_id": "item-list:districts",
        "nodeset": "instance('item-list:districts')/districts_list/districts",
        "label": "name",
        "value": "id",
        "sort": "name",
    }
    save_search(
        authoring,
        app_id,
        0,
        fields=[
            field("client_name", "Name", exclude=True),
            field("village", "Village"),
            field("client_code", "Client code", appearance="barcode_scan"),
            field("dob", "Born on", appearance="date", exclude=True),
            field("last_visit", "Last visit between", appearance="daterange"),
            field("district", "District", appearance="fixture", fixture=json.dumps(itemset)),
        ],
        rows=[NAME_ROW, DOB_ROW, TODAY_ROW],
        auto_launch=True,
    )

    follow_up_menu(authoring, app_id, 1, "Active clients", "check_note", "What did you check?")
    save_list_filter(authoring, app_id, 1, ACTIVE_FILTER)
    save_search(authoring, app_id, 1, rows=[RECUT_ROW], auto_launch=True, default_search=True)

    follow_up_menu(authoring, app_id, 2, "Visits", "visit_summary", "Summarize the visit")
    save_list_filter(authoring, app_id, 2, LIST_FILTER)
    save_search(authoring, app_id, 2, rows=[JOINED_ROW], auto_launch=True, inline_search=True)
    follow_up_menu(authoring, app_id, 3, "Referrals", "referral_note", "What help did the client receive?")
    save_list_filter(authoring, app_id, 3, "standing = 'active'")

    def independent_answer(property_name, field_name):
        before = json.dumps(property_name + " != '")
        after = json.dumps("'")
        answer = f"instance('search-input:results')/input/field[@name = '{field_name}']"
        return f"concat({before}, {answer}, {after})"

    save_search(
        authoring, app_id, 3,
        fields=[
            field("status", "Status from the project space"),
            field("dob", "Date of birth", appearance="date"),
            field("village", "Village"),
            field("omit_code", "Leave out this client code", exclude=True),
        ],
        filters=[
            ("standing", "'active'"),
            ("parent/district", "'d1'"),
            ("owner_id", "instance('commcaresession')/session/context/userid"),
        ],
        rows=[
            json.dumps("date_opened > '2020-01-01'"),
            json.dumps("client_code > 0"),
            independent_answer("standing", "village"),
            independent_answer("client_code", "omit_code"),
        ],
        auto_launch=True,
    )
    add_mixed_search(authoring, app_id)
    return app_id


BASE = Base(
    id="hq-search",
    build=build,
    configuration=Configuration(
        flags=frozenset({"FOLLOWUP_FORMS_AS_CASE_LIST_FORM", "SYNC_SEARCH_CASE_CLAIM", "CASE_SEARCH_ADVANCED", "CASE_SEARCH_RELATED_LOOKUPS"}),
        privileges=frozenset({"LOOKUP_TABLES"}),
        case_search_enabled=True,
    ),
    cases=(OPEN_IN_NORTH,),
    exhibits=(
        "questions/text-input-xsd-string",
        "questions/date-xsd-date",
        "forms-and-case-writes/open-case-name-update-question-path",
        "forms-and-case-writes/update-case-update-property-question",
        "case-search/workflow-search-first-auto-launch-true-default-search-false",
        "case-search/workflow-skip-to-default-results-auto-launch-true-default-search",
        "case-search/inline-search-true-auto-launch-true-on-a-module-without-visible",
        "case-search/title-label-or-blank-hq-s-default",
        "case-search/name-prompt-key-case-property",
        "case-search/label-lang",
        "case-search/text-prompt-no-input",
        "case-search/appearance-barcode-scan",
        "case-search/input-date",
        "case-search/input-daterange",
        "case-search/input-select1-lookup-itemset",
        "case-search/itemset-instance-id-item-list-tag-nodeset-label-value-over",
        "case-search/itemset-sort-over-a-lookup-field",
        "case-search/exclude",
        "case-search/default-properties-entry-keyed-by-a-plain-property-property-p",
        "case-search/default-properties-entry-keyed-by-an-ancestor-path-parent-p",
        "case-search/default-properties-entry-keyed-owner-id-case-id-commcare-project",
        "case-search/prompt-named-for-a-case-attribute-hq-matches-itself",
        "case-search/date-prompt-matched-by-hq-s-own-rule",
        "case-search/date-only-comparison-on-date-opened-closed-on-last-modified",
        "case-search/xpath-query-row-reading-a-field-hq-also-matches",
        "case-search/xpath-query-row-reading-an-excluded-field-outside-its-presence-guard",
        "case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s",
        "case-search/case-list-filter-clause-the-search-does-not-restate",
        "case-search/xpath-query-condition-outside-what-nova-types",
        "case-search/several-xpath-query-rows",
        "case-search/additional-case-types",
        "case-search/default-properties-entry-keyed-case-type",
        "case-search/custom-related-case-property",
        "case-search/default-related-record-inclusion",
    ),
)
