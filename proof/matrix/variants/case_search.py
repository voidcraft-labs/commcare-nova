"""The named changes of variants whose entry is in the manifest area ``case-search``.

Most rows of the area set one value of a menu's ``search_config`` with ``ops.set_json``; a function here is a change
that needs more than one value at once (a filter row beside the list clause it belongs with, a menu moved and its
search named), each value set in turn, HQ wrapping and saving the app after each (``_set_each``). A function that
moves forms or menus reads the app HQ holds and sets its whole ``/modules`` list, so every form keeps its own JSON and
its source. A menu is moved as a person moves one, through HQ's own rearrange view. A form's source is changed as text:
``_change`` hands ``ops.set_form_source`` the source HQ holds with each ``(old, new, count)`` replacement made, each
``old`` held to occur exactly ``count`` times first. The pointers address the app as HQ's source read serves it, and
every id is the base's own, as its retained source holds it.
"""

from __future__ import annotations

import copy
import json

from proof.matrix import ops

SESSION = "instance('commcaresession')/session"

# hq-search: Clients, Active clients and Visits, all of the case type client; Visits searches as its forms open.
# Each menu is named by its position in the app as it stands when the value is set (``ops.set_json``).
_ACTIVE_CLIENTS = {"$menu": 1}

# A text Search field as HQ's Case List page stores one, beside no other setting.
_TEXT_FIELD = {
    "hint": {},
    "hidden": False,
    "allow_blank_value": False,
    "exclude": False,
    "required": {"test": None, "text": {}, "doc_type": "Assertion"},
    "validations": [],
    "itemset": {"doc_type": "Itemset"},
    "is_group": False,
    "doc_type": "CaseSearchProperty",
}

# The menu Nova writes for a registration a list offers after its search found nothing, for the case type client in
# an app of one language: the basic shell with the one name column, hidden from every menu by ``false()``.
_HIDDEN_MENU = {
    "doc_type": "Module",
    "module_type": "basic",
    "case_type": "client",
    "put_in_root": False,
    "root_module_id": None,
    "case_details": {
        "doc_type": "DetailPair",
        "short": {
            "doc_type": "Detail",
            "display": "short",
            "columns": [
                {
                    "doc_type": "DetailColumn",
                    "header": {"en": "Name"},
                    "field": "name",
                    "useXpathExpression": False,
                    "model": "case",
                    "format": "plain",
                    "calc_xpath": ".",
                    "filter_xpath": "",
                    "advanced": "",
                    "late_flag": 30,
                    "time_ago_interval": 365.25,
                    "hasNodeset": False,
                    "hasAutocomplete": False,
                    "isTab": False,
                    "enum": [],
                    "graph_configuration": None,
                    "relevant": "",
                    "case_tile_field": None,
                    "grid_x": None,
                    "grid_y": None,
                    "width": None,
                    "height": None,
                    "horizontal_align": None,
                    "vertical_align": None,
                    "font_size": None,
                    "show_border": None,
                    "show_shading": None,
                    "nodeset": "",
                    "date_format": "%d/%m/%y",
                }
            ],
            "sort_elements": [],
            "tabs": [],
            "filter": None,
            "lookup_enabled": False,
            "lookup_autolaunch": False,
            "lookup_display_results": False,
            "lookup_name": None,
            "lookup_image": None,
            "lookup_action": None,
            "lookup_field_template": None,
            "lookup_field_header": {},
            "lookup_extras": [],
            "lookup_responses": [],
            "persist_case_context": None,
            "persistent_case_context_xml": "case_name",
            "persist_tile_on_forms": None,
            "persistent_case_tile_from_module": None,
            "pull_down_tile": None,
            "case_tile_template": None,
            "custom_xml": None,
            "no_items_text": {"en": "List is empty."},
        },
        "long": {
            "doc_type": "Detail",
            "display": "long",
            "columns": [],
            "sort_elements": [],
            "tabs": [],
            "filter": None,
            "lookup_enabled": False,
            "lookup_autolaunch": False,
            "lookup_display_results": False,
            "lookup_name": None,
            "lookup_image": None,
            "lookup_action": None,
            "lookup_field_template": None,
            "lookup_field_header": {},
            "lookup_extras": [],
            "lookup_responses": [],
            "persist_case_context": None,
            "persistent_case_context_xml": "case_name",
            "persist_tile_on_forms": None,
            "persistent_case_tile_from_module": None,
            "pull_down_tile": None,
            "case_tile_template": None,
            "custom_xml": None,
        },
    },
    "case_list": {
        "doc_type": "CaseList",
        "show": False,
        "label": {},
        "media_image": {},
        "media_audio": {},
        "custom_icons": [],
    },
    "case_list_form": {"doc_type": "CaseListForm", "form_id": None, "label": {}},
    "search_config": {
        "doc_type": "CaseSearch",
        "search_button_label": {"en": "Search All Cases"},
        "properties": [],
        "auto_launch": True,
        "default_search": False,
        "inline_search": False,
        "include_all_related_cases": False,
        "default_properties": [],
        "title_label": {"en": ""},
        "description": {"en": ""},
    },
    "display_style": "list",
    "media_image": {},
    "media_audio": {},
    "custom_icons": [],
    "is_training_module": False,
    "module_filter": "false()",
    "auto_select_case": False,
    "parent_select": {"active": False, "relationship": "parent", "module_id": None},
    "comment": "",
    "session_endpoint_id": "",
    "case_list_session_endpoint_id": "",
}
_HIDDEN_MENU_ID = "5adc0de0000000000000000000000003"
# "The search found nothing": the inline search's results hold no case.
_NO_MATCHES = "count(instance('results:inline')/results/case) = 0"


def _set_each(authoring, app_id, *values):
    """Each ``(pointer, value)`` of ``values`` set in turn, HQ wrapping and saving the app after each."""
    for pointer, value in values:
        ops.set_json(authoring, app_id, pointer, value)


def _modules(authoring, app_id):
    """The app's menus as HQ holds them, each a plain JSON copy."""
    from proof.hq import operations

    return json.loads(json.dumps(operations.held_app(authoring.state, app_id).to_json()))["modules"]


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


def _field(name, label):
    """A text Search field ``name`` labelled ``label``."""
    return {"name": name, "label": {"en": label}, **copy.deepcopy(_TEXT_FIELD)}


def _normalized(owners):
    """Nova's normalized spelling of an owner list ``owners`` (``nodesetFilter.ts``): its whitespace made single
    spaces, none at either end."""
    return f"replace(replace({owners}, '[ \\t\\r\\n]+', ' '), '^ | $', '')"


def _owner_clause(owners):
    """The case list filter's clause Nova writes for the owner list ``owners``: a case whose owner the list names is
    left off."""
    held = _normalized(owners)
    return f"{held} = '' or not(selected({held}, @owner_id))"


def _registration_after_an_empty_search(authoring, app_id, workflow, *, offered_again=False):
    """Clients' Registration Form moved into a menu of its own that no menu shows (Nova's hidden menu), which Visits'
    list offers once its search found nothing, the worker going on as ``workflow`` says; with ``offered_again``,
    Active clients' list offers the same form too, as its Register action."""
    clients, active, visits = _modules(authoring, app_id)
    form = clients["forms"].pop(0)
    hidden = {**copy.deepcopy(_HIDDEN_MENU), "unique_id": _HIDDEN_MENU_ID, "name": dict(form["name"]), "forms": [form]}
    block = {
        "form_id": form["unique_id"],
        "label": dict(form["name"]),
        "post_form_workflow": workflow,
        "relevancy_expression": _NO_MATCHES,
        "media_image": {},
        "media_audio": {},
        "custom_icons": [],
        "use_default_image_for_all": False,
        "use_default_audio_for_all": False,
        "doc_type": "CaseListForm",
    }
    visits["case_list_form"] = block
    if offered_again:
        active["case_list_form"] = {
            **{key: value for key, value in block.items() if key != "relevancy_expression"},
            "post_form_workflow": "case_list",
        }
    ops.set_json(authoring, app_id, "/modules", [clients, active, visits, hidden])


# Default filters --------------------------------------------------------------------------------------------------


def owner_exclusion_twice(authoring, app_id):
    """Active clients' search excluding the owner ``abc`` both by its owner list, which its case list's filter holds
    Nova's clause for, and by a default filter keyed ``commcare_blacklisted_owner_ids``."""
    owners = "'abc'"
    _set_each(
        authoring,
        app_id,
        (
            "/modules/1/case_details/short/filter",
            f"standing = 'active' and district = 'd1' and ({_owner_clause(owners)})",
        ),
        ("/modules/1/search_config/blacklisted_owner_ids_expression", _normalized(owners)),
        (
            "/modules/1/search_config/default_properties/-",
            {
                "property": "commcare_blacklisted_owner_ids",
                "defaultValue": "'abc'",
                "doc_type": "DefaultCaseSearchProperty",
            },
        ),
    )


# Settings -----------------------------------------------------------------------------------------------------------


def list_first_in_web_apps(authoring, app_id):
    """Clients' case list shown before its search, in an app Web Apps runs."""
    _set_each(authoring, app_id, ("/cloudcare_enabled", True), ("/modules/0/search_config/auto_launch", False))


def owner_exclusion_on_an_ordered_text(authoring, app_id):
    """Active clients' owner list chosen by ordering the worker's name against text, its case list's filter holding
    Nova's clause for the list."""
    owners = f"if({SESSION}/context/username > 'm', 'a', 'b')"
    _set_each(
        authoring,
        app_id,
        (
            "/modules/1/case_details/short/filter",
            f"standing = 'active' and district = 'd1' and ({_owner_clause(owners)})",
        ),
        ("/modules/1/search_config/blacklisted_owner_ids_expression", _normalized(owners)),
    )


def title_blank_in_english(authoring, app_id):
    """The app given French, and Clients' search screen titled in French alone, its English title blank."""
    _set_each(
        authoring,
        app_id,
        ("/langs", ["en", "fra"]),
        ("/modules/0/search_config/title_label", {"en": "", "fra": "Chercher"}),
    )


def results_instance_shared_with_the_root_menu(authoring, app_id):
    """Active clients searching as its forms open, and Visits, which searches so too, made its child menu: both name
    their results ``results:inline``."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/search_config/inline_search", True),
        ("/modules/2/root_module_id", _ACTIVE_CLIENTS),
    )


def search_without_the_related_cases_it_reads(authoring, app_id):
    """``hq-case-management``: Members given a Search field and a calculated column of its household's name, its
    search not including related cases."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/search_config/properties", [_field("status_note", "Status")]),
        (
            "/modules/1/case_details/short/columns/-",
            {
                "format": "plain",
                "header": {"en": "Household"},
                "field": "current()/../case[@case_id=current()/index/parent and @case_type='household']/case_name",
                "model": "case",
                "hasAutocomplete": True,
                "useXpathExpression": True,
                "grid_x": None,
                "grid_y": None,
                "enum": [],
                "graph_configuration": {
                    "config": {},
                    "locale_specific_config": {},
                    "annotations": [],
                    "series": [],
                    "doc_type": "GraphConfiguration",
                },
                "late_flag": 30,
                "time_ago_interval": 365.25,
                "date_format": "%d/%m/%y",
                "doc_type": "DetailColumn",
            },
        ),
    )


def search_on_display_only_menu(authoring, app_id):
    """``hq-menus``: Household registration showing its form in the menu above, and searching for households by
    village."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/put_in_root", True),
        ("/modules/0/search_config/properties", [_field("village", "Village")]),
    )


# Search fields ------------------------------------------------------------------------------------------------------


def fields_grouped(authoring, app_id):
    """Clients' six Search fields put in one group of its search screen, the group's own entry last."""
    _set_each(
        authoring,
        app_id,
        (
            "/modules/0/search_config/properties/-",
            {**_field("g", "Group"), "is_group": True, "group_key": "g"},
        ),
        *((f"/modules/0/search_config/properties/{index}/group_key", "g") for index in range(6)),
    )


# Registration after an empty search ---------------------------------------------------------------------------------


def registration_after_an_empty_search_to_home(authoring, app_id):
    """Visits offering Clients' Registration Form, from a hidden menu, once its search found nothing, the worker going
    home after it rather than back to the list."""
    _registration_after_an_empty_search(authoring, app_id, "default")


def registration_after_an_empty_search_offered_again(authoring, app_id):
    """Visits offering Clients' Registration Form, from a hidden menu, once its search found nothing, and Active
    clients' list offering the same form as its Register action."""
    _registration_after_an_empty_search(authoring, app_id, "case_list", offered_again=True)


# A child menu of a menu whose forms read the search -------------------------------------------------------------------


def child_menu_reads_the_search(authoring, app_id):
    """Visits moved second and given a Search field, village; Active clients, its search taken away, made Visits'
    child menu, choosing its own case from its own list; and Active clients' Followup Form showing ``check_note``
    where Visits' village answer is ``north``. HQ's build keeps the child's own selection where it matches the root
    menu's (``entries.py::EntriesHelper.add_parent_datums``), so the child's entry carries no query of Visits' and
    the form reads an instance no step loads. The results instance of its own HQ's build needs of the child is the
    row's second change."""
    with authoring.step("variant:child-menu-reads-the-search:visits-second"):
        body, content_type = ops.form_body([("from", "2"), ("to", "1"), ("ajax", "false")])
        ops.post(authoring, "rearrange", [app_id, "modules"], body, content_type, "Visits moved second", redirects=True)
    _set_each(
        authoring,
        app_id,
        ("/modules/1/search_config/properties", [_field("village", "Village")]),
        # Visits, second once moved.
        ("/modules/2/root_module_id", {"$menu": 1}),
        ("/modules/2/search_config/default_properties", []),
    )
    inputs = "search-input:results:inline"
    _change(
        authoring,
        app_id,
        "child-menu-reads-the-search",
        (
            '<bind nodeset="/data/check_note" type="xsd:string"/>',
            '<bind nodeset="/data/check_note" type="xsd:string"'
            f" relevant=\"instance('{inputs}')/input/field[@name = 'village'] = 'north'\"/>",
            1,
        ),
        (
            "</instance><itext>",
            f'</instance><instance id="{inputs}" src="jr://instance/search-input/results:inline"/><itext>',
            1,
        ),
        menu=2,
        form=0,
    )


# hq-case-management: Households, of the case type household, and Members, of member, a household's child case.
_HOUSEHOLDS = {"$menu": 0}


def child_menu_selecting_from_the_search_reads_it(authoring, app_id):
    """``hq-case-management``: Households given a Search field, village, and searching as its forms open; Members made
    its child menu, choosing a household from Households' list before its own member; and Members' Followup Form
    showing ``status_note`` where Households' village answer is ``north``. HQ's build writes Households' query into
    the entry ahead of that choice (``entries.py::EntriesHelper.add_remote_query_datums``), so the form reads the
    answers its own entry loaded. The results instance of its own HQ's build needs of Members is the row's second
    change."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/search_config/properties", [_field("village", "Village")]),
        ("/modules/0/search_config/inline_search", True),
        ("/modules/0/search_config/auto_launch", True),
        ("/modules/1/root_module_id", _HOUSEHOLDS),
        (
            "/modules/1/parent_select",
            {"active": True, "relationship": "parent", "module_id": _HOUSEHOLDS, "doc_type": "ParentSelect"},
        ),
    )
    inputs = "search-input:results:inline"
    bind = '<bind vellum:nodeset="#form/status_note" nodeset="/data/status_note" type="xsd:string" />'
    _change(
        authoring,
        app_id,
        "child-menu-selecting-from-the-search-reads-it",
        (
            bind,
            f'<instance id="{inputs}" src="jr://instance/search-input/results:inline" />'
            + bind.replace(" />", f" relevant=\"instance('{inputs}')/input/field[@name = 'village'] = 'north'\" />"),
            1,
        ),
        menu=1,
        form=0,
    )


# Holding rows -----------------------------------------------------------------------------------------------------

# hq-search: Clients, the menu whose search shows its fields first.
_CLIENTS = {"$menu": 0}
# The Search field answers of a search HQ's build names ``results``.
_SEARCH_INPUT = "instance('search-input:results')/input/field"


def _answer(name):
    """The answer to the Search field ``name`` of a search whose results instance is ``results``."""
    return f"{_SEARCH_INPUT}[@name = '{name}']"


def _filter_row(value):
    """A default filter of the search's own CSQL, its value the XPath ``value``."""
    return {"property": "_xpath_query", "defaultValue": value, "doc_type": "DefaultCaseSearchProperty"}


def field_matching_the_owner(authoring, app_id):
    """Clients given an excluded Search field named ``owner_id``, and the filter row that searches for the cases that
    owner holds once the field is answered."""
    answer = _answer("owner_id")
    _set_each(
        authoring,
        app_id,
        ("/modules/0/search_config/properties/-", {**_field("owner_id", "Owner"), "exclude": True}),
        (
            "/modules/0/search_config/default_properties/-",
            _filter_row(f"if(count({answer}), concat(\"@owner_id = '\", {answer}, \"'\"), 'match-all()')"),
        ),
    )


def results_instance_named_as_the_root_menu_s(authoring, app_id):
    """Active clients made Clients' child menu, its search naming its results ``inline``, the results instance Clients'
    search has by default: Clients does not search inline, so no build or runtime compares the two."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/root_module_id", _CLIENTS),
        ("/modules/1/search_config/instance_name", "inline"),
    )


def owner_exclusion_the_list_applies(authoring, app_id):
    """Active clients' search leaving off the cases the owner ``abc`` holds, its case list's filter holding Nova's
    clause for the same owner list."""
    owners = "'abc'"
    _set_each(
        authoring,
        app_id,
        (
            "/modules/1/case_details/short/filter",
            f"standing = 'active' and district = 'd1' and ({_owner_clause(owners)})",
        ),
        ("/modules/1/search_config/blacklisted_owner_ids_expression", _normalized(owners)),
    )


def inline_search_skipping_its_shown_field(authoring, app_id):
    """Visits, which searches as its forms open, given a shown Search field, the client code read by barcode, and
    going straight to its results."""
    client_code = {**_field("client_code", "Client code"), "appearance": "barcode_scan"}
    _set_each(
        authoring,
        app_id,
        ("/modules/2/search_config/properties", [client_code]),
        ("/modules/2/search_config/default_search", True),
    )


def field_choosing_a_service(authoring, app_id):
    """Clients given an excluded Search field choosing one district from the lookup table, and the filter row that
    searches for the cases whose ``services`` hold the chosen value once the field is answered."""
    answer = _answer("service_pick")
    service = {
        **_field("service_pick", "Service"),
        "exclude": True,
        "input_": "select1",
        "itemset": {
            "instance_id": "item-list:districts",
            "nodeset": "instance('item-list:districts')/districts_list/districts",
            "value": "id",
            "sort": "name",
            "label": "name",
            "doc_type": "Itemset",
        },
    }
    _set_each(
        authoring,
        app_id,
        ("/modules/0/search_config/properties/-", service),
        (
            "/modules/0/search_config/default_properties/-",
            _filter_row(f"if(count({answer}), concat(\"selected-any(services, '\", {answer}, \"')\"), 'match-all()')"),
        ),
    )


def field_naming_a_distance_unit(authoring, app_id):
    """Clients given an excluded Search field naming a distance unit, and the filter row that searches for the cases
    within ten of that unit of a fixed point once the field is answered."""
    answer = _answer("unit")
    _set_each(
        authoring,
        app_id,
        ("/modules/0/search_config/properties/-", {**_field("unit", "Unit"), "exclude": True}),
        (
            "/modules/0/search_config/default_properties/-",
            _filter_row(
                f"if(count({answer}), concat(\"within-distance(location, '42.4402 -71.1453', 10, \", '\"', {answer},"
                " '\"', \")\"), 'match-all()')"
            ),
        ),
    )


from proof.matrix.bases.lookups import changes_lookup_data, qualify_districts


@changes_lookup_data
def district_choice_details(authoring, app_id):
    """Rich Search choices save each district code and sort by its French name."""
    qualify_districts(authoring)
    base = "/modules/0/search_config/properties/5/itemset"
    _set_each(
        authoring, app_id,
        (base + "/value", "@row_code"),
        (base + "/label", "name[@lang='fr'][1]"),
        (base + "/sort", "name[@lang='en'][1]"),
    )
