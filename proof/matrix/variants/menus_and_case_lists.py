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
from proof.matrix.bases import _pages


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
    """The existing Household follow-up applies a new shared answer, without a scalar case preload."""
    def shared_start(root, _form):
        start, = root.xpath("//*[local-name()='setvalue'][@ref='/data/members']")
        start.getparent().remove(start)

    ops.set_form_source(authoring, app_id, 0, 1, shared_start, what="shared members answer")
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/multi_select", True),
        ("/modules/0/case_details/short/auto_select", True),
    )


def clickable_icon_for_a_visit(authoring, app_id):
    """A list icon opens its ordinary follow-up with the exact automatic-submission label."""
    def mark_label(root, _form):
        text, = root.xpath("//*[local-name()='itext']/*[local-name()='translation']/*[@id='visit_note-label']")
        label, = root.xpath("//*[local-name()='label'][@ref=$ref]", ref="jr:itext('visit_note-label')")
        text.set("id", "Pragma-Submit-Automatically")
        label.set("ref", "jr:itext('Pragma-Submit-Automatically')")

    ops.set_form_source(authoring, app_id, 1, 0, mark_label, what="automatic follow-up label")
    ops.set_json(authoring, app_id, "/modules/1/forms/0/session_endpoint_id", "record-visit")
    ops.set_json(authoring, app_id, "/modules/1/case_details/short/columns/1", {
        "doc_type": "DetailColumn",
        "model": "case",
        "field": "name",
        "format": "clickable-icon",
        "header": {"en": "Record visit"},
        "endpoint_action_id": "record-visit",
        "enum": [{
            "doc_type": "MappingItem",
            "key": "true()",
            "value": {"en": "jr://file/commcare/image/register_household.png"},
        }],
    })


def case_list_deep_link_on_display_only_menu(authoring, app_id):
    """Follow-ups given a case list deep link and its form shown in the menu above."""
    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_list_session_endpoint_id", "follow_ups"),
        ("/modules/1/put_in_root", True),
    )


def conditional_registration_returning_to_search(authoring, app_id):
    """Patients' empty-search action returns even when its form declines to open a case."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    def registration_source(name):
        form = XFormBuilder(name)
        form.new_question("case_name", "Name", "string")
        form.new_question("create_record", "Register this patient?", "select1", choices={"yes": "Yes", "no": "No"})
        return form.tostring(xml_declaration=True).decode("utf-8")

    ops.upload_form_source(authoring, app_id, 1, 0, registration_source, "conditional-registration")
    ops.set_json(authoring, app_id, "/modules/1/forms/0/actions/open_case/condition", {
        "doc_type": "FormActionCondition",
        "type": "if",
        "question": "/data/create_record",
        "answer": "yes",
        "operator": "=",
    })


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
    """Patients' list with a lookup extra that reads a relative XPath rather than fixed text."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/lookup_enabled", True),
        ("/modules/0/case_details/short/lookup_action", "org.example.SCAN"),
        ("/modules/0/case_details/short/lookup_name", "Scan a card"),
        ("/modules/0/case_details/short/lookup_extras", [{"key": "mode", "value": "scan"}]),
        ("/modules/0/case_details/short/lookup_responses", [{"key": "patient_id"}]),
    )


def fixed_text_callout(authoring, app_id):
    """Patients' list with a named companion, literal text arguments and ordered fallback response names."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/case_details/short/lookup_enabled", True),
        ("/modules/0/case_details/short/lookup_action", "org.example.SCAN"),
        ("/modules/0/case_details/short/lookup_name", "Scan a card"),
        ("/modules/0/case_details/short/lookup_extras", [
            {"key": "mode", "value": "'scan'"},
            {"key": "source", "value": "concat('home', ' visit')"},
        ]),
        ("/modules/0/case_details/short/lookup_responses", [{"key": "patient_id"}, {"key": "fallback"}]),
    )


def fixed_text_callout_with_worker_name(authoring, app_id):
    """Patients' lookup passes the signed-in worker's username beside a fixed argument."""
    fixed_text_callout(authoring, app_id)
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/lookup_extras", [
        {"key": "mode", "value": "'scan'"},
        {"key": "worker", "value": "instance('commcaresession')/session/context/username"},
    ])


def fixed_text_callout_with_count(authoring, app_id):
    """A follow-up reads the guarded count from its one case list in an Android-only app."""
    from lxml import etree

    from proof.matrix.variants.expressions_and_data import _declare

    fixed_text_callout(authoring, app_id)
    ops.set_json(authoring, app_id, "/cloudcare_enabled", False)

    def edit(root, _held):
        _declare(root, "commcaresession", "jr://instance/session")
        model, = root.xpath("//*[local-name()='model']")
        data, = model.xpath("./*[local-name()='instance'][not(@id)]/*")
        data.append(etree.Element(f"{{{etree.QName(data).namespace}}}lookup_count"))
        bind = etree.Element(f"{{{etree.QName(model).namespace}}}bind")
        bind.set("nodeset", "/data/lookup_count")
        result = "instance('commcaresession')/session/data/fingerprintquery"
        bind.set("calculate", f"if(count({result}) = 1, number({result}[1]), '')")
        model.append(bind)

    ops.set_form_source(authoring, app_id, 0, 1, edit, what="guarded companion lookup count")


def fixed_text_callout_with_confidence(authoring, app_id):
    """Patients' lookup matches the returned IDs to the cases and has a visible confidence heading."""
    fixed_text_callout(authoring, app_id)
    _set_each(
        authoring, app_id,
        ("/modules/0/case_details/short/lookup_display_results", True),
        ("/modules/0/case_details/short/lookup_field_template", "@case_id"),
        ("/modules/0/case_details/short/lookup_field_header", {"en": "Confidence"}),
    )


def fixed_text_callout_with_icon(authoring, app_id):
    """Patients' lookup button uses a picture the HQ picker uploaded."""
    fixed_text_callout(authoring, app_id)
    path = "jr://file/commcare/image/case-lookup.png"
    _pages.upload_picture(authoring, app_id, path)
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/lookup_image", path)


def automatic_fixed_text_callout(authoring, app_id):
    """The same companion configuration with automatic lookup enabled."""
    fixed_text_callout(authoring, app_id)
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/lookup_autolaunch", True)


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


def _tile_cell(field, x, width, y=0):
    """A placed cell of a custom tile as HQ's Case List page stores it."""
    return {
        "model": "case",
        "field": field,
        "header": {"en": field},
        "format": "plain",
        "useXpathExpression": False,
        "grid_x": x,
        "grid_y": y,
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
        "width": width,
        "height": 1,
        "horizontal_align": "left",
        "vertical_align": "start",
        "font_size": "medium",
        "show_border": False,
        "show_shading": False,
    }


def tile_cells_overlapping(authoring, app_id):
    """Follow-ups' list laid out as a tile whose ``village`` cell covers part of the name's row: both cells as the
    Case List page stores them, which no check of HQ's compares."""

    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        ("/modules/1/case_details/short/columns", [_tile_cell("name", 0, 12), _tile_cell("village", 3, 6)]),
    )


def tile_cell_outside_the_grid(authoring, app_id):
    """Follow-ups' list laid out as a tile whose ``village`` cell runs past the twelfth column: a place HQ's Case
    List page does not offer (its pickers stop at the twelfth column), as an imported app holds it."""

    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        ("/modules/1/case_details/short/columns", [_tile_cell("name", 0, 6), _tile_cell("village", 8, 6)]),
    )


def tile_cell_below_the_rows_offered(authoring, app_id):
    """Follow-ups' list laid out as a tile of two fields whose ``village`` cell sits on the thirteenth row, inside
    the twelve columns: below the six rows HQ's Case List page offers two columns (``screen.js``,
    ``caseTileRowMax``), so the page's next save moves it, as an imported app holds it."""

    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        ("/modules/1/case_details/short/columns", [_tile_cell("name", 0, 12), _tile_cell("village", 0, 12, y=12)]),
    )


def tile_taller_than_twelve_rows(authoring, app_id):
    """Follow-ups' list laid out as a tile of thirteen fields, one full line each, the last on the thirteenth row:
    HQ's Case List page offers a list of thirteen columns thirteen rows and keeps that cell, and both runtimes size
    the tile to it."""

    _set_each(
        authoring,
        app_id,
        ("/modules/1/case_details/short/case_tile_template", "custom"),
        (
            "/modules/1/case_details/short/columns",
            [_tile_cell("name" if row % 2 == 0 else "village", 0, 12, y=row) for row in range(13)],
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


def distance_on_translated_calculation(authoring, app_id):
    """The saved village-label column sorted by distance, which requires a position at the worker."""
    village_label_column_sorted(authoring, app_id)
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/sort_elements/4/type", "distance")


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


def form_links_on_a_menu_listing_survey_forms(authoring, app_id):
    """The Tools / Calculators pair of listing menus, the Tools mirror holding a deep link to Tools' survey. HQ's
    menu settings page cannot save it: it sends the link with every save, but renders the deep link field its save
    reads only in the Advanced panel, which it hides on a menu that tracks no cases
    (``views/modules.py::get_module_view_context``, ``edit_module_attr``)."""
    child_menus_listing_the_same_forms(authoring, app_id)
    ops.set_json(
        authoring,
        app_id,
        "/modules/5/form_session_endpoints",
        [{"doc_type": "ShadowFormEndpoint", "form_id": {"$form": [3, 0]}, "session_endpoint_id": "tools-survey"}],
    )


def _add_listed_menu(authoring, app_id, *, excluded=(), linked=(), show=False, stored_case_type=None):
    """A second route to the hq-plain forms. HQ resolves the actual source form ids before saving."""
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
            "case_type": owner["case_type"] if stored_case_type == "source" else None,
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


def listed_menu_storing_its_source_case_type(authoring, app_id):
    """A listing menu whose stored ``case_type`` key holds its source's type, as an app saved before
    ``ShadowModule.case_type`` became the property derived from the source can. HQ reads the property,
    so the stored key changes nothing."""
    _add_listed_menu(authoring, app_id, stored_case_type="source")


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


def choose_one_grid_menu(authoring, app_id):
    """Save the app's individual setting, then the menu's Grid option, through HQ's settings pages."""
    from proof.matrix.bases import _pages

    _pages.save_settings(authoring, app_id, attributes={"grid_form_menus": "some"})
    _pages.save_module_attributes(authoring, app_id, 2, [("display_style", "grid")], "grid layout")


def _case_display_columns(authoring, app_id, *columns):
    """Append map or image fields to the five-column HQ-authored case list."""
    for index, (field, form, label, *mapping) in enumerate(columns, start=5):
        column = {"doc_type": "DetailColumn", "model": "case", "format": form,
                  "field": field, "header": {"en": label}, "useXpathExpression": False}
        if mapping:
            column["enum"] = mapping[0]
        ops.set_json(authoring, app_id, f"/modules/0/case_details/short/columns/{index}", column)


def case_list_geo_boundary_colors(authoring, app_id):
    _case_display_columns(authoring, app_id,
        ('area_colour', 'geo-boundary-color', 'Area colour'),
        ('address', 'address', 'Address'),
        ('area', 'geo-boundary', 'Area'),
    )


def case_list_geo_boundary_column(authoring, app_id):
    _case_display_columns(authoring, app_id,
        ('area', 'geo-boundary', 'Area'),
        ('address', 'address', 'Address'),
    )


def case_list_geo_points_colors(authoring, app_id):
    _case_display_columns(authoring, app_id,
        ('point_colours', 'geo-points-colors', 'Point colours'),
        ('address', 'address', 'Address'),
        ('points', 'geo-points', 'Points'),
    )


def case_list_geo_points_column(authoring, app_id):
    _case_display_columns(authoring, app_id,
        ('area', 'geo-points', 'Area'),
        ('address', 'address', 'Address'),
    )


def case_list_icon_alt_text(authoring, app_id):
    _case_display_columns(authoring, app_id,
        ('village', 'enum-image', 'Map', [{'alt_text': {'en': 'North'}, 'doc_type': 'MappingItem', 'key': "selected(., 'north')", 'value': {'en': 'jr://file/commcare/image/north.png'}}]),
    )
    _pages.attach_media(authoring, app_id, 'jr://file/commcare/image/north.png')


def case_list_icon_column_over_conditions(authoring, app_id):
    _case_display_columns(authoring, app_id,
        ('visits', 'enum-image', 'Visits', [{'alt_text': {}, 'doc_type': 'MappingItem', 'key': '. > 3', 'value': {'en': 'jr://file/commcare/image/many.png'}}]),
    )
    _pages.attach_media(authoring, app_id, 'jr://file/commcare/image/many.png')


def case_list_icon_column_over_values(authoring, app_id):
    _case_display_columns(authoring, app_id,
        ('status_code', 'enum-image', 'Status', [
            {'alt_text': {'en': 'No image for new cases'}, 'doc_type': 'MappingItem',
             'key': 'new', 'value': {'en': ''}},
            {'alt_text': {}, 'doc_type': 'MappingItem', 'key': 'a',
             'value': {'en': 'jr://file/commcare/image/active.png'}},
        ]),
    )
    _pages.attach_media(authoring, app_id, 'jr://file/commcare/image/active.png')


def _detail_tile(authoring, app_id, menu, tabs):
    """Use two physical columns with independent rectangles on the same row."""
    root = f"/modules/{menu}/case_details/long"
    columns = [
        {"doc_type": "DetailColumn", "model": "case", "field": prop,
         "header": {"en": title}, "format": fmt, "useXpathExpression": False,
         "grid_x": x, "grid_y": 0, "width": 6, "height": 1,
         "horizontal_align": "left", "vertical_align": "start", "font_size": "medium",
         "show_border": False, "show_shading": False}
        for prop, title, fmt, x in (("name", "Name", "plain", 0), ("date_opened", "Opened", "date", 6))
    ]
    _set_each(authoring, app_id, (root + "/columns", columns), (root + "/case_tile_template", "custom"))
    if tabs:
        ops.set_json(authoring, app_id, root + "/tabs", [
            {"doc_type": "DetailTab", "isTab": True, "header": {"en": title},
             "starting_index": i, "has_nodeset": False} for i, title in enumerate(tabs)
        ])


def placed_case_detail_tile(authoring, app_id):
    _detail_tile(authoring, app_id, 0, ())


def basic_detail_tabs_sharing_a_tile_row(authoring, app_id):
    _detail_tile(authoring, app_id, 0, ("Patient", "More"))


def advanced_detail_tabs_sharing_a_tile_row(authoring, app_id):
    _detail_tile(authoring, app_id, 1, ("Member", "More"))


def all_named_tile_positions(authoring, app_id):
    """Every built-in tile position names a real column. Repeated properties
    keep distinct physical columns; each has its own heading."""
    slots = [f"{position}_{content}" for position in ("top_left", "top_right", "middle_left", "middle_right", "bottom_left") for content in ("image", "text")]
    columns = [
        {"doc_type": "DetailColumn", "field": "name", "model": "case",
         "header": {"en": slot.replace("_", " ").title()}, "format": "plain",
         "case_tile_field": slot, "useXpathExpression": False}
        for slot in slots
    ]
    _set_each(authoring, app_id, ("/modules/0/case_details/short/columns", columns),
              ("/modules/0/case_details/short/case_tile_template", "icon_text_grid"))


def expand_own_case_tile(authoring, app_id):
    search_only_column_in_a_tile(authoring, app_id)
    _set_each(
        authoring, app_id,
        ("/modules/1/case_details/short/persist_tile_on_forms", True),
        ("/modules/1/case_details/short/pull_down_tile", True),
    )


def use_other_case_tile(authoring, app_id):
    search_only_column_in_a_tile(authoring, app_id)
    _set_each(authoring, app_id,
              ("/modules/0/case_details/short/persistent_case_tile_from_module", {"$menu": 1}))


def _visit_rows_detail(authoring, app_id, tab, hidden=False):
    """One ordinary selected-case group and a separate Visits group over its own rows."""
    root = "/modules/0/case_details/long"
    fields = [
        {"doc_type": "DetailColumn", "model": "case", "field": field, "format": fmt, "header": {"en": title}}
        for field, title, fmt in (("name", "Patient", "plain"), ("name", "Visit", "plain"))
    ]
    if hidden:
        fields.append({"doc_type": "DetailColumn", "model": "case", "field": "status",
                       "format": "invisible", "header": {"en": "Visit priority"}})
    _set_each(authoring, app_id, (root + "/columns", fields), (root + "/tabs", [
        {"doc_type": "DetailTab", "starting_index": 0, "header": {"en": "Patient"}},
        {"doc_type": "DetailTab", "starting_index": 1, "header": {"en": "Visits"}, "has_nodeset": True, **tab},
    ]))


def explicit_visit_rows(authoring, app_id):
    _visit_rows_detail(authoring, app_id, {"nodeset": "instance('casedb')/casedb/case[@case_type = 'visit']"})


def _member_rows_detail(authoring, app_id, tab, hidden=False):
    """Households' case detail as one ordinary selected-case group and a separate Members group over its own rows:
    the household registration adds members as child cases, so HQ's Case Detail page offers ``member`` as the
    tab's child type (``Application.get_subcase_types``) and keeps it at its next save."""
    root = "/modules/0/case_details/long"
    fields = [
        {"doc_type": "DetailColumn", "model": "case", "field": field, "format": fmt, "header": {"en": title}}
        for field, title, fmt in (("name", "Household", "plain"), ("name", "Member", "plain"))
    ]
    if hidden:
        fields.append({"doc_type": "DetailColumn", "model": "case", "field": "status_note",
                       "format": "invisible", "header": {"en": "Member priority"}})
    _set_each(authoring, app_id, (root + "/columns", fields), (root + "/tabs", [
        {"doc_type": "DetailTab", "starting_index": 0, "header": {"en": "Household"}},
        {"doc_type": "DetailTab", "starting_index": 1, "header": {"en": "Members"}, "has_nodeset": True, **tab},
    ]))


def child_member_rows(authoring, app_id):
    _member_rows_detail(authoring, app_id, {"nodeset_case_type": "member", "nodeset_filter": ""})


def hidden_child_member_order(authoring, app_id):
    _member_rows_detail(authoring, app_id, {"nodeset_case_type": "member"}, hidden=True)


def different_persistent_lines(authoring, app_id):
    root = "/modules/0/case_details/"
    _set_each(authoring, app_id, (root + "short/persist_case_context", True),
              (root + "short/persistent_case_context_xml", "case_name"), (root + "long/persist_case_context", True),
              (root + "long/persistent_case_context_xml", "village"))


def named_tile_using_raw_value(authoring, app_id):
    all_named_tile_positions(authoring, app_id)
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/columns/1/format", "invisible")


def named_tile_with_an_unselected_slot(authoring, app_id):
    all_named_tile_positions(authoring, app_id)
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/columns/-", {
        "doc_type": "DetailColumn", "field": "village", "model": "case", "format": "plain",
        "header": {"en": "Extra"}, "case_tile_field": "unused_position",
    })


def unreadable_form_context_line(authoring, app_id):
    root = "/modules/0/case_details/short"
    _set_each(authoring, app_id, (root + "/persist_case_context", True),
              (root + "/persistent_case_context_xml", "instance('unknown-roster')/rows/row"))


def explicit_member_rows_with_related_cases(authoring, app_id):
    _member_rows_detail(authoring, app_id, {"nodeset": "instance('casedb')/casedb/case[@case_type = 'member']",
                                           "nodeset_case_type": "member"})


def calculation_loading_faster(authoring, app_id):
    """Patients' list with faster loading on and its ``visits + 1`` calculation kept and worked out later: the
    menu's setting first, as the Case List page saves it, then the column's choice."""
    _set_each(
        authoring,
        app_id,
        ("/modules/0/show_case_list_optimization_options", True),
        ("/modules/0/case_details/short/columns/4/optimization", "cache_and_lazy_load"),
    )
