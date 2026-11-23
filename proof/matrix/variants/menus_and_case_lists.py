"""The named changes of variants whose entry is in the manifest area ``menus-and-case-lists``.

Each sets several values of the stored app's JSON, one after another, through ``ops.set_json``: HQ wraps and saves
the whole document after each value, as its import and its update do. A class that needs two or more values at once
(a menu shown in the menu above beside a deep link, a list laid out as a tile with its cells) is made so, since no
single pointer holds every value it changes. The pointers address the app as HQ's source read serves it, and a
value names a menu or form of the base by its position (``{"$menu": m}``, ``{"$form": [m, f]}``), which
``ops.set_json`` resolves to the id the stored app holds there: HQ's source read gives every form a new id and moves
each reference it knows of to it (``models/applications.py::Application.export_json``,
``util.py::update_form_unique_ids``), so a form id the source read served names no form of the stored app, and an id
written here would name none once the base is authored again.
"""

from __future__ import annotations

from proof.matrix import ops


def _set_each(authoring, app_id, *values):
    """Each ``(pointer, value)`` of ``values`` set in turn, HQ wrapping and saving the app after each."""
    for pointer, value in values:
        ops.set_json(authoring, app_id, pointer, value)


def advanced_menu_with_a_narrowed_case_list_item(authoring, app_id):
    """Member visits offering its case list as a menu item, the list narrowed by a filter."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_list/show", True),
        ("/modules/1/case_details/short/filter", "age > 1"),
    )


def auto_select_on_a_multi_select_list(authoring, app_id):
    """Households' list choosing several households, every one chosen at once."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/multi_select", True),
        ("/modules/0/case_details/short/auto_select", True),
    )


def case_list_deep_link_on_display_only_menu(authoring, app_id):
    """Follow-ups given a case list deep link and its form shown in the menu above."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_list_session_endpoint_id", "follow_ups"),
        ("/modules/1/put_in_root", True),
    )


def child_menu_registering_its_root_s_case_type(authoring, app_id):
    """Tools made a list of households under Follow-ups, whose first form chooses a household, its own form registering
    one."""
    _set_each(
        authoring,
        app_id,
        ("/modules/4/root_module_id", None),
        ("/modules/3/root_module_id", {"$menu": 2}),
        ("/modules/3/case_type", "household"),
        (
            "/modules/3/forms/0/actions",
            {
                "open_case": {
                    "condition": {
                        "type": "always",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                    "name_update": {
                        "question_path": "/data/tool_name",
                        "update_mode": "always",
                        "doc_type": "ConditionalCaseUpdate",
                    },
                    "conflicts": [],
                    "external_id": None,
                    "doc_type": "OpenCaseAction",
                },
                "update_case": {
                    "condition": {
                        "type": "always",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                    "update": {},
                    "conflicts": {},
                    "doc_type": "UpdateCaseAction",
                },
                "close_case": {
                    "condition": {
                        "type": "never",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                    "doc_type": "FormAction",
                },
                "open_referral": {
                    "name_path": None,
                    "doc_type": "OpenReferralAction",
                    "followup_date": None,
                    "condition": {
                        "type": "never",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                },
                "update_referral": {
                    "followup_date": None,
                    "doc_type": "UpdateReferralAction",
                    "condition": {
                        "type": "never",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                },
                "close_referral": {
                    "condition": {
                        "type": "never",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                    "doc_type": "FormAction",
                },
                "case_preload": {
                    "preload": {},
                    "doc_type": "PreloadAction",
                    "condition": {
                        "type": "never",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                },
                "referral_preload": {
                    "preload": {},
                    "doc_type": "PreloadAction",
                    "condition": {
                        "type": "never",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                },
                "load_from_form": {
                    "preload": {},
                    "doc_type": "PreloadAction",
                    "condition": {
                        "type": "never",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                },
                "usercase_update": {
                    "update": {},
                    "conflicts": {},
                    "doc_type": "UpdateCaseAction",
                    "condition": {
                        "type": "never",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                },
                "usercase_preload": {
                    "preload": {},
                    "doc_type": "PreloadAction",
                    "condition": {
                        "type": "never",
                        "question": None,
                        "answer": None,
                        "operator": "=",
                        "doc_type": "FormActionCondition",
                    },
                },
                "subcases": [],
                "doc_type": "FormActions",
            },
        ),
    )


def child_of_another_type_under_a_formless_parent(authoring, app_id):
    """Tools made a list of households with no forms of its own, its child Calculators a list of members."""
    _set_each(
        authoring,
        app_id,
        ("/modules/3/forms", []),
        ("/modules/3/case_type", "household"),
        ("/modules/3/case_list/show", True),
        ("/modules/4/case_type", "member"),
    )


def display_only_menu_with_a_deep_link(authoring, app_id):
    """Tools given a deep link of its own and its form shown in the menu above."""
    _set_each(
        authoring,
        app_id,
        ("/modules/3/session_endpoint_id", "tools"),
        ("/modules/3/put_in_root", True),
    )


def form_condition_reading_the_case_on_the_first_menu(authoring, app_id):
    """Member visits shown on the first menu and Member reviews shown there under it, both menus' forms choosing a
    member, Member reviews' form shown only where the member holds a review note: HQ's build takes the condition (every
    form of the menu and of its root chooses a case of one type), and the first menu chooses no case before it."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/put_in_root", True),
        ("/modules/2/root_module_id", {"$menu": 1}),
        ("/modules/2/put_in_root", True),
        ("/modules/2/forms/0/form_filter", "#case/review_note != ''"),
    )


def multi_select_above_a_hundred(authoring, app_id):
    """Patients' list choosing up to 500 patients."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/multi_select", True),
        ("/modules/0/case_details/short/max_select_value", 500),
    )


def multi_select_of_none(authoring, app_id):
    """Households' list choosing several households, at most none."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/multi_select", True),
        ("/modules/0/case_details/short/max_select_value", 0),
    )


def multi_select_unbounded(authoring, app_id):
    """Patients' list choosing several patients with no bound HQ's page writes, -1."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/multi_select", True),
        ("/modules/0/case_details/short/max_select_value", -1),
    )


def named_callout(authoring, app_id):
    """Patients' list given a callout as HQ's Case List page saves one: an action, a name, an extra and a response,
    which is one thing a person adds."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/lookup_enabled", True),
        ("/modules/0/case_details/short/lookup_action", "org.example.SCAN"),
        ("/modules/0/case_details/short/lookup_name", "Scan a card"),
        ("/modules/0/case_details/short/lookup_extras", [{"key": "mode", "value": "scan"}]),
        ("/modules/0/case_details/short/lookup_responses", [{"key": "patient_id"}]),
    )


def parent_selection_of_a_list_with_no_columns(authoring, app_id):
    """Tools made a list of members choosing a household first from Household registration, whose case list holds no
    column."""
    _set_each(
        authoring,
        app_id,
        ("/modules/3/case_type", "member"),
        (
            "/modules/3/parent_select",
            {
                "active": True,
                "relationship": "parent",
                "module_id": {"$menu": 0},
                "doc_type": "ParentSelect",
            },
        ),
        ("/modules/0/case_details/short/columns", []),
    )


def parent_selection_of_an_inline_search(authoring, app_id):
    """Households searching inline for a household by village, and Members choosing a household there first."""
    _set_each(
        authoring,
        app_id,
        (
            "/modules/0/search_config/properties",
            [
                {
                    "name": "village",
                    "label": {"en": "Village"},
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
            ],
        ),
        ("/modules/0/search_config/inline_search", True),
        ("/modules/0/search_config/auto_launch", True),
        (
            "/modules/1/parent_select",
            {
                "active": True,
                "relationship": "parent",
                "module_id": {"$menu": 0},
                "doc_type": "ParentSelect",
            },
        ),
    )


def parent_selection_outside_the_parent_type(authoring, app_id):
    """A list of villages added, and Members choosing a village before a member, though a member's parent is a
    household."""
    _set_each(
        authoring,
        app_id,
        (
            "/modules/2",
            {
                "name": {"en": "Villages"},
                "forms": [],
                "case_type": "village",
                "case_details": {
                    "short": {
                        "columns": [
                            {
                                "format": "plain",
                                "header": {"en": "Name"},
                                "field": "name",
                                "model": "case",
                                "hasAutocomplete": True,
                                "useXpathExpression": False,
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
                            }
                        ],
                        "display": "short",
                        "tabs": [],
                        "sort_elements": [],
                        "instance_name": "casedb",
                        "persist_case_context": None,
                        "persistent_case_context_xml": "case_name",
                        "multi_select": False,
                        "auto_select": False,
                        "max_select_value": 100,
                        "persist_tile_on_forms": None,
                        "pull_down_tile": None,
                        "case_tile_group": {
                            "index_identifier": None,
                            "header_rows": 2,
                            "doc_type": "CaseTileGroupConfig",
                        },
                        "no_items_text": {"en": "List is empty."},
                        "select_text": {"en": "Continue"},
                        "doc_type": "Detail",
                        "lookup_enabled": False,
                        "lookup_autolaunch": False,
                        "lookup_image": None,
                        "lookup_extras": [],
                        "lookup_responses": [],
                        "lookup_display_results": False,
                        "lookup_field_header": {},
                    },
                    "long": {
                        "columns": [
                            {
                                "format": "plain",
                                "header": {"en": "Name"},
                                "field": "name",
                                "model": "case",
                                "hasAutocomplete": True,
                                "useXpathExpression": False,
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
                            }
                        ],
                        "display": "long",
                        "tabs": [],
                        "sort_elements": [],
                        "instance_name": "casedb",
                        "persist_case_context": None,
                        "persistent_case_context_xml": "case_name",
                        "multi_select": False,
                        "auto_select": False,
                        "max_select_value": 100,
                        "persist_tile_on_forms": None,
                        "pull_down_tile": None,
                        "case_tile_group": {
                            "index_identifier": None,
                            "header_rows": 2,
                            "doc_type": "CaseTileGroupConfig",
                        },
                        "no_items_text": {"en": "List is empty."},
                        "select_text": {"en": "Continue"},
                        "doc_type": "Detail",
                        "lookup_enabled": False,
                        "lookup_autolaunch": False,
                        "lookup_image": None,
                        "lookup_extras": [],
                        "lookup_responses": [],
                        "lookup_display_results": False,
                        "lookup_field_header": {},
                    },
                    "doc_type": "DetailPair",
                },
                "module_type": "basic",
                "ref_details": {
                    "short": {
                        "display": "short",
                        "columns": [],
                        "tabs": [],
                        "sort_elements": [],
                        "instance_name": "casedb",
                        "persist_case_context": None,
                        "persistent_case_context_xml": "case_name",
                        "multi_select": False,
                        "auto_select": False,
                        "max_select_value": 100,
                        "persist_tile_on_forms": None,
                        "pull_down_tile": None,
                        "case_tile_group": {
                            "index_identifier": None,
                            "header_rows": 2,
                            "doc_type": "CaseTileGroupConfig",
                        },
                        "no_items_text": {"en": "List is empty."},
                        "select_text": {"en": "Continue"},
                        "doc_type": "Detail",
                        "lookup_enabled": False,
                        "lookup_autolaunch": False,
                        "lookup_image": None,
                        "lookup_extras": [],
                        "lookup_responses": [],
                        "lookup_display_results": False,
                        "lookup_field_header": {},
                    },
                    "long": {
                        "display": "long",
                        "columns": [],
                        "tabs": [],
                        "sort_elements": [],
                        "instance_name": "casedb",
                        "persist_case_context": None,
                        "persistent_case_context_xml": "case_name",
                        "multi_select": False,
                        "auto_select": False,
                        "max_select_value": 100,
                        "persist_tile_on_forms": None,
                        "pull_down_tile": None,
                        "case_tile_group": {
                            "index_identifier": None,
                            "header_rows": 2,
                            "doc_type": "CaseTileGroupConfig",
                        },
                        "no_items_text": {"en": "List is empty."},
                        "select_text": {"en": "Continue"},
                        "doc_type": "Detail",
                        "lookup_enabled": False,
                        "lookup_autolaunch": False,
                        "lookup_image": None,
                        "lookup_extras": [],
                        "lookup_responses": [],
                        "lookup_display_results": False,
                        "lookup_field_header": {},
                    },
                    "doc_type": "DetailPair",
                },
                "case_list": {
                    "label": {},
                    "show": True,
                    "doc_type": "CaseList",
                    "media_image": {},
                    "media_audio": {},
                    "custom_icons": [],
                    "use_default_image_for_all": False,
                    "use_default_audio_for_all": False,
                },
                "referral_list": {
                    "label": {},
                    "show": False,
                    "doc_type": "CaseList",
                    "media_image": {},
                    "media_audio": {},
                    "custom_icons": [],
                    "use_default_image_for_all": False,
                    "use_default_audio_for_all": False,
                },
                "task_list": {
                    "label": {},
                    "show": False,
                    "doc_type": "CaseList",
                    "media_image": {},
                    "media_audio": {},
                    "custom_icons": [],
                    "use_default_image_for_all": False,
                    "use_default_audio_for_all": False,
                },
                "parent_select": {
                    "active": False,
                    "relationship": "parent",
                    "module_id": None,
                    "doc_type": "ParentSelect",
                },
                "search_config": {
                    "search_button_label": {"en": "Search All Cases"},
                    "properties": [],
                    "auto_launch": False,
                    "default_search": False,
                    "default_properties": [],
                    "custom_sort_properties": [],
                    "additional_case_types": [],
                    "additional_registry_cases": [],
                    "title_label": {},
                    "description": {},
                    "include_all_related_cases": False,
                    "search_on_clear": False,
                    "inline_search": False,
                    "doc_type": "CaseSearch",
                },
                "display_style": "list",
                "lazy_load_case_list_fields": False,
                "show_case_list_optimization_options": False,
                "doc_type": "Module",
                "unique_id": "5adc0de0000000000000000000000005",
                "case_list_form": {
                    "form_id": None,
                    "label": {},
                    "post_form_workflow": "default",
                    "doc_type": "CaseListForm",
                    "media_image": {},
                    "media_audio": {},
                    "custom_icons": [],
                    "use_default_image_for_all": False,
                    "use_default_audio_for_all": False,
                },
                "put_in_root": False,
                "fixture_select": {"active": False, "localize": False, "doc_type": "FixtureSelect"},
                "report_context_tile": False,
                "auto_select_case": False,
                "is_training_module": False,
                "custom_assertions": [],
                "media_image": {},
                "media_audio": {},
                "custom_icons": [],
                "use_default_image_for_all": False,
                "use_default_audio_for_all": False,
                "comment": "",
            },
        ),
        (
            "/modules/1/parent_select",
            {
                "active": True,
                "relationship": "parent",
                "module_id": "5adc0de0000000000000000000000005",
                "doc_type": "ParentSelect",
            },
        ),
    )


def registration_by_a_parent_follow_up(authoring, app_id):
    """Members choosing a household first, its Register action a follow-up form of that household."""
    _set_each(
        authoring,
        app_id,
        (
            "/modules/1/parent_select",
            {
                "active": True,
                "relationship": "parent",
                "module_id": {"$menu": 0},
                "doc_type": "ParentSelect",
            },
        ),
        ("/modules/1/case_list_form/form_id", {"$form": [0, 1]}),
    )


def registration_on_a_display_only_child_of_a_registering_parent(authoring, app_id):
    """Follow-ups made a child of Households, both registering the same form, its forms shown in the menu above."""
    _set_each(
        authoring,
        app_id,
        ("/modules/2/root_module_id", {"$menu": 1}),
        ("/modules/2/put_in_root", True),
    )


def registration_on_a_display_only_tile_list(authoring, app_id):
    """Follow-ups' form shown in the menu above, its list laid out as a tile beside its Register action."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_list_form/form_id", {"$form": [0, 0]}),
        ("/modules/1/put_in_root", True),
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        (
            "/modules/1/case_details/short/columns",
            [
                {
                    "model": "case",
                    "field": "name",
                    "header": {"en": "Name"},
                    "format": "plain",
                    "useXpathExpression": False,
                    "grid_x": 0,
                    "grid_y": 0,
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
                    "width": 12,
                    "height": 1,
                    "horizontal_align": "left",
                    "vertical_align": "start",
                    "font_size": "medium",
                    "show_border": False,
                    "show_shading": False,
                }
            ],
        ),
    )


def registration_returning_with_a_new_case_to_a_multi_select_list(authoring, app_id):
    """Follow-ups' list choosing several patients, beside a Register action that goes on with the new case."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_list_form/form_id", {"$form": [0, 0]}),
        ("/modules/1/case_details/short/multi_select", True),
    )


def registration_under_a_display_only_menu_sharing_its_case(authoring, app_id):
    """Households' one follow-up form shown in the menu above, with no condition, link or deep link, and Follow-ups
    under it keeping its Register action."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/put_in_root", True),
        ("/modules/1/case_list_session_endpoint_id", None),
        ("/modules/1/forms/0/form_filter", None),
        ("/modules/1/forms/0/post_form_workflow", "default"),
        ("/modules/1/forms/0/form_links", []),
        ("/modules/1/forms/0/post_form_workflow_fallback", None),
        ("/modules/2/root_module_id", {"$menu": 1}),
    )


def _second_case_type_on_another_command(authoring, app_id):
    from proof.matrix.bases import _pages

    _pages.new_case_module(authoring, app_id, name="Clinics", case_type="clinic")
    _pages.delete_form(authoring, app_id, 5, 0)


def registration_under_a_first_menu_with_different_case_types(authoring, app_id):
    registration_under_a_display_only_menu_sharing_its_case(authoring, app_id)
    _second_case_type_on_another_command(authoring, app_id)



def search_only_column_in_a_tile(authoring, app_id):
    """Follow-ups' list laid out as a tile, its search-only village column given a cell."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        (
            "/modules/1/case_details/short/columns",
            [
                {
                    "model": "case",
                    "field": "village",
                    "header": {"en": "Village"},
                    "format": "invisible",
                    "useXpathExpression": False,
                    "grid_x": 0,
                    "grid_y": 1,
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
                    "width": 12,
                    "height": 1,
                    "horizontal_align": "left",
                    "vertical_align": "start",
                    "font_size": "medium",
                    "show_border": False,
                    "show_shading": False,
                },
                {
                    "model": "case",
                    "field": "name",
                    "header": {"en": "Name"},
                    "format": "plain",
                    "useXpathExpression": False,
                    "grid_x": 0,
                    "grid_y": 0,
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
                    "width": 12,
                    "height": 1,
                    "horizontal_align": "left",
                    "vertical_align": "start",
                    "font_size": "medium",
                    "show_border": False,
                    "show_shading": False,
                },
            ],
        ),
    )


def tile_cell_not_aligned(authoring, app_id):
    """Follow-ups' list laid out as a tile whose one cell holds no horizontal alignment."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        (
            "/modules/1/case_details/short/columns",
            [
                {
                    "model": "case",
                    "field": "name",
                    "header": {"en": "Name"},
                    "format": "plain",
                    "useXpathExpression": False,
                    "grid_x": 0,
                    "grid_y": 0,
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
                    "width": 12,
                    "height": 1,
                    "horizontal_align": None,
                    "vertical_align": "start",
                    "font_size": "medium",
                    "show_border": False,
                    "show_shading": False,
                }
            ],
        ),
    )


def tile_cell_not_placed(authoring, app_id):
    """Follow-ups' list laid out as a tile whose one cell has no place on the grid."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        (
            "/modules/1/case_details/short/columns",
            [
                {
                    "model": "case",
                    "field": "name",
                    "header": {"en": "Name"},
                    "format": "plain",
                    "useXpathExpression": False,
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
                    "width": 12,
                    "height": 1,
                    "horizontal_align": "left",
                    "vertical_align": "start",
                    "font_size": "medium",
                    "show_border": False,
                    "show_shading": False,
                }
            ],
        ),
    )


def tile_cell_without_a_size(authoring, app_id):
    """Follow-ups' list laid out as a tile whose one cell holds no font size."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        (
            "/modules/1/case_details/short/columns",
            [
                {
                    "model": "case",
                    "field": "name",
                    "header": {"en": "Name"},
                    "format": "plain",
                    "useXpathExpression": False,
                    "grid_x": 0,
                    "grid_y": 0,
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
                    "width": 12,
                    "height": 1,
                    "horizontal_align": "left",
                    "vertical_align": "start",
                    "font_size": None,
                    "show_border": False,
                    "show_shading": False,
                }
            ],
        ),
    )


def tile_grouped_by_a_hyphenated_index(authoring, app_id):
    """Follow-ups' list laid out as a tile, grouped by an index name holding a hyphen."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        (
            "/modules/1/case_details/short/columns",
            [
                {
                    "model": "case",
                    "field": "name",
                    "header": {"en": "Name"},
                    "format": "plain",
                    "useXpathExpression": False,
                    "grid_x": 0,
                    "grid_y": 0,
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
                    "width": 12,
                    "height": 1,
                    "horizontal_align": "left",
                    "vertical_align": "start",
                    "font_size": "medium",
                    "show_border": False,
                    "show_shading": False,
                }
            ],
        ),
        (
            "/modules/1/case_details/short/case_tile_group",
            {"doc_type": "CaseTileGroupConfig", "header_rows": 2, "index_identifier": "my-parent"},
        ),
    )


def translatable_text_over_a_parent_property_beside_search(authoring, app_id):
    """Follow-ups searchable by village, its list showing the parent's village as translatable text."""
    _set_each(
        authoring,
        app_id,
        (
            "/modules/1/search_config/properties",
            [
                {
                    "name": "village",
                    "label": {"en": "Village"},
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
            ],
        ),
        (
            "/modules/1/case_details/short/columns/2",
            {
                "date_format": "%d/%m/%y",
                "doc_type": "DetailColumn",
                "enum": [{"alt_text": {}, "doc_type": "MappingItem", "key": "north", "value": {"en": "North"}}],
                "field": "parent/village",
                "format": "translatable-enum",
                "graph_configuration": {
                    "annotations": [],
                    "config": {},
                    "doc_type": "GraphConfiguration",
                    "locale_specific_config": {},
                    "series": [],
                },
                "grid_x": None,
                "grid_y": None,
                "header": {"en": "Village"},
                "late_flag": 30,
                "model": "case",
                "time_ago_interval": 365.25,
                "useXpathExpression": False,
            },
        ),
    )


def worker_case_type_on_an_advanced_menu(authoring, app_id):
    """Member reviews listing the worker's own record, its form loading that type from it."""
    _set_each(
        authoring,
        app_id,
        ("/modules/2/case_type", "commcare-user"),
        ("/modules/2/forms/0/actions/load_update_cases/1/case_type", "commcare-user"),
    )


# Holding variants: a class Nova reads, made where no base holds it ------------------------------------------------

# A case list menu item labelled as a person labels it on the menu's settings page.
_CASE_LIST_ITEM = {
    "show": True,
    "doc_type": "CaseList",
    "media_image": {},
    "media_audio": {},
    "custom_icons": [],
    "use_default_image_for_all": False,
    "use_default_audio_for_all": False,
}
# The index a load names when it follows none: the default of HQ's ``CaseIndex``.
_NO_INDEX = {
    "tag": None,
    "reference_id": "parent",
    "relationship": "child",
    "relationship_question": "",
    "doc_type": "CaseIndex",
}
# A menu of its own for a list that shows every patient, an id no other menu of hq-case-lists holds.
_ALL_PATIENTS_ID = "5adc0de0000000000000000000000041"


def _held(authoring, app_id):
    """The app as HQ stores it, a plain JSON copy: every form id the stored app's own."""
    import json

    from proof.hq import operations

    return json.loads(json.dumps(operations.held_app(authoring.state, app_id).to_json()))


def _tile_cells(menu, column, y):
    """The cell keys of a list column placed on row ``y`` of a tile, across its whole width, as the Case List page
    saves a placed cell."""
    cells = {
        "grid_x": 0,
        "grid_y": y,
        "width": 12,
        "height": 1,
        "horizontal_align": "left",
        "vertical_align": "start",
        "font_size": "medium",
    }
    return [(f"/modules/{menu}/case_details/short/columns/{column}/{key}", value) for key, value in cells.items()]


def follow_ups_shown_above_offering_registration(authoring, app_id):
    """Follow-ups' forms shown in the menu above, its list offering Patients' Registration Form, for which HQ's build
    writes no registration action on a menu shown above."""
    registration = _held(authoring, app_id)["modules"][0]["forms"][0]["unique_id"]
    _set_each(
        authoring,
        app_id,
        ("/modules/1/put_in_root", True),
        (
            "/modules/1/case_list_form",
            {
                "form_id": registration,
                "label": {"en": "Register a patient"},
                "post_form_workflow": "default",
                "doc_type": "CaseListForm",
                "media_image": {},
                "media_audio": {},
                "custom_icons": [],
                "use_default_image_for_all": False,
                "use_default_audio_for_all": False,
            },
        ),
    )


def formless_menu_showing_its_list(authoring, app_id):
    """A menu of patients holding no form, offering its case list as a menu item: Follow-ups' list and settings,
    without its form."""
    menu = _held(authoring, app_id)["modules"][1]
    menu.update(
        {
            "name": {"en": "All patients"},
            "forms": [],
            "unique_id": _ALL_PATIENTS_ID,
            "case_list": {**_CASE_LIST_ITEM, "label": {"en": "Browse patients"}},
        }
    )
    ops.set_json(authoring, app_id, "/modules/-", menu)


def member_reviews_listing_every_member(authoring, app_id):
    """Member reviews' form loading the member alone, through no household, and the menu offering its case list as a
    menu item, which lists every member."""
    loads = _held(authoring, app_id)["modules"][2]["forms"][0]["actions"]["load_update_cases"]
    member = next(load for load in loads if load["case_tag"] == "load_member1")
    _set_each(
        authoring,
        app_id,
        ("/modules/2/forms/0/actions/load_update_cases", [{**member, "case_index": _NO_INDEX}]),
        ("/modules/2/case_list", {**_CASE_LIST_ITEM, "label": {"en": "All members"}}),
    )


def registration_after_an_empty_search_back_to_the_list(authoring, app_id):
    """Visits offering Clients' Registration Form, from a menu no menu shows (``false()``), once its search found
    nothing, the worker going back to the list after it."""
    from proof.matrix.variants.case_search import _registration_after_an_empty_search

    _registration_after_an_empty_search(authoring, app_id, "case_list")


def tile_cell_bordered_and_shaded(authoring, app_id):
    """The Case List laid out as a tile, its one cell drawn with a border and shaded."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/case_tile_template", "custom"),
        ("/modules/0/case_details/short/columns/0/show_border", True),
        ("/modules/0/case_details/short/columns/0/show_shading", True),
    )


def tile_grouped_by_parent(authoring, app_id):
    """Households' list laid out as a tile of two rows, a household's name above its village, the cases grouped by
    their parent with the first row as each group's header."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/case_tile_template", "custom"),
        *_tile_cells(0, 0, 0),
        *_tile_cells(0, 1, 1),
        (
            "/modules/0/case_details/short/case_tile_group",
            {"index_identifier": "parent", "header_rows": 1, "doc_type": "CaseTileGroupConfig"},
        ),
    )


def tile_kept_on_forms(authoring, app_id):
    """The Case List laid out as a tile, the chosen case's tile kept at the top of its forms."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/case_tile_template", "custom"),
        ("/modules/0/case_details/short/persist_tile_on_forms", True),
    )


def tile_kept_on_forms_beside_case_context(authoring, app_id):
    """The Case List laid out as a tile kept at the top of its forms, beside the switch that would keep the case's
    name there instead."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/case_tile_template", "custom"),
        ("/modules/0/case_details/short/persist_tile_on_forms", True),
        ("/modules/0/case_details/short/persist_case_context", True),
    )


def village_label_column_sorted(authoring, app_id):
    """Patients' list showing ``village`` by its choices' labels, as Nova writes a column over a select property
    (a ``translatable-enum`` column over an expression that names each choice's label, ``enum`` holding the
    labels), and sorted last by that column (``_cc_calculated_3``), which HQ's build sorts by the label it shows
    (``detail_screen.py::FormattedDetailColumn.sort_node``)."""
    column = {
        "model": "case",
        "field": "if(village = 'north', $nova_text_0000000000, if(village = 'south', $nova_text_0000000001, village))",
        "header": {"en": "Village"},
        "format": "translatable-enum",
        "enum": [
            {"key": "nova_text_0000000000", "value": {"en": "North"}, "alt_text": {}, "doc_type": "MappingItem"},
            {"key": "nova_text_0000000001", "value": {"en": "South"}, "alt_text": {}, "doc_type": "MappingItem"},
        ],
        "useXpathExpression": True,
        "doc_type": "DetailColumn",
    }
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/columns/3", column),
        (
            "/modules/0/case_details/short/sort_elements/-",
            {
                "field": "_cc_calculated_3",
                "type": "plain",
                "direction": "ascending",
                "blanks": "first",
                "display": {"en": ""},
                "sort_calculation": "",
                "doc_type": "SortElement",
            },
        ),
    )


# A text Search field as HQ's Case List page stores one.
_STATUS_FIELD = {
    "name": "status_note",
    "label": {"en": "Status"},
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


def inline_search_under_a_parent_selection(authoring, app_id):
    """``hq-case-management``'s Members given the Search field ``status_note`` and searching as its forms open (the
    search launched first, inline), its household chosen first from Households' list (an active parent selection by
    the parent relationship), for which HQ's build adds the search's own ``ancestor-exists`` query of the household's
    type (``util.py::module_uses_inline_search_with_parent_relationship_parent_select``)."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/search_config/properties", [_STATUS_FIELD]),
        ("/modules/1/search_config/auto_launch", True),
        ("/modules/1/search_config/inline_search", True),
        (
            "/modules/1/parent_select",
            {"active": True, "relationship": "parent", "module_id": {"$menu": 0}, "doc_type": "ParentSelect"},
        ),
    )


def child_menus_listing_the_same_forms(authoring, app_id):
    """Two physical source menus and the pair of linked parent and child menus that list their forms."""
    parent = "5adc0de0000000000000000000000003"
    for position, name, menu_id, source, root in (
        (5, "Tools mirror", parent, 3, None),
        (6, "Calculators mirror", "5adc0de0000000000000000000000004", 4, parent),
    ):
        ops.set_json(
            authoring,
            app_id,
            f"/modules/{position}",
            {
                "doc_type": "ShadowModule",
                "name": {"en": name},
                "forms": [],
                "case_type": None,
                "shadow_module_version": 2,
                "unique_id": menu_id,
                "source_module_id": {"$menu": source},
                **({"root_module_id": root} if root else {}),
            },
        )


def _add_listed_menu(authoring, app_id, *, excluded=(), linked=(), show=False, stored_type=False):
    """A second route to the hq-plain forms. HQ resolves the actual source form ids before saving. With
    ``stored_type``, the menu's stored ``case_type`` holds its source's type, as a document saved where HQ stored
    the key keeps it, where HQ's ``ShadowModule.case_type`` reads the source's (``models/modules.py``)."""
    owner = _held(authoring, app_id)["modules"][0]
    ops.set_json(
        authoring,
        app_id,
        "/modules/-",
        {
            "doc_type": "ShadowModule",
            "shadow_module_version": 2,
            "module_type": "shadow",
            "unique_id": "00000000000000000000000000000017",
            "source_module_id": {"$menu": 0},
            "name": {"en": "At home"},
            "forms": [],
            "case_type": owner["case_type"] if stored_type else None,
            "case_details": owner["case_details"],
            "case_list": {"show": show},
            "excluded_form_ids": list(excluded),
            "session_endpoint_id": "at-home",
            "form_session_endpoints": [
                {"doc_type": "ShadowFormEndpoint", "form_id": form_id, "session_endpoint_id": link}
                for form_id, link in linked
            ],
        },
    )


def all_forms_listed_in_another_menu(authoring, app_id):
    _add_listed_menu(authoring, app_id)


def listed_menu_storing_its_type(authoring, app_id):
    _add_listed_menu(authoring, app_id, stored_type=True)


def some_forms_listed_in_another_menu(authoring, app_id):
    _add_listed_menu(authoring, app_id, excluded=[{"$form": [0, 0]}], linked=[({"$form": [0, 1]}, "home-followup")])


def list_item_on_a_menu_listing_source_forms(authoring, app_id):
    _add_listed_menu(authoring, app_id, show=True)


def spaced_link_on_a_menu_listing_source_forms(authoring, app_id):
    _add_listed_menu(authoring, app_id, linked=[({"$form": [0, 1]}, " home-followup ")])


def unavailable_form_on_a_menu_listing_source_forms(authoring, app_id):
    _add_listed_menu(authoring, app_id, excluded=["00000000000000000000000000000000"])


def listed_menu_missing_its_required_child(authoring, app_id):
    """The first half of the working Tools / Calculators pair. No Calculators submenu is present."""
    ops.set_json(
        authoring,
        app_id,
        "/modules/5",
        {
            "doc_type": "ShadowModule",
            "name": {"en": "Tools mirror"},
            "forms": [],
            "case_type": None,
            "shadow_module_version": 2,
            "unique_id": "5adc0de0000000000000000000000003",
            "source_module_id": {"$menu": 3},
        },
    )
