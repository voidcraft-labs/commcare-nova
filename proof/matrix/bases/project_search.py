"""HQ's Case List editor binds a menu to a service its project space supplies.

A worker visits one assigned area and records the area for the next visit.
The search is configured in the project, outside the app. Rebuilding the
retained fixture creates that same service before a worker opens the app.
"""
import json

from proof.hq.configuration import Configuration
from proof.hq.project_search import install_project_searches
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.search import one_question_source
from proof.matrix.registry import Base, Declaration

ENDPOINT_ID = 17


def build(authoring):
    from corehq.apps.data_dictionary.models import CaseProperty
    from proof.hq import operations

    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Assigned visits")
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.new_case_module(authoring, app_id, name="Area visits", case_type="visit")
    _pages.delete_form(authoring, app_id, 0, 0)
    ops.upload_form_source(authoring, app_id, 0, 0, one_question_source("area", "Area for the next visit"), "area")
    _pages.save_case_actions(authoring, app_id, 0, 0, updates={"district": "/data/area"})
    _pages.save_case_list(authoring, app_id, 0, columns=[_pages.column("name", "Visit")])
    with authoring.step("build:project-search"):
        install_project_searches(authoring.state, [{
            "id": ENDPOINT_ID, "name": "Visits by area", "case_type": "visit", "version": 1,
            "properties": [{"name": "district", "data_type": CaseProperty.DataType.PLAIN}],
            "parameters": [{"name": "area", "type": "text"}],
            "query": {"type": "all", "children": [{"type": "component", "field": "district", "operator": "equals",
                                                  "inputs": {"value": {"type": "parameter", "value": "area"}}}]},
        }])
        search = {
            "properties": [], "default_properties": [{"property": "area", "defaultValue": "'north'"}],
            "custom_sort_properties": [], "title_label": "", "description": "",
            "case_search_endpoint_id": ENDPOINT_ID, "auto_launch": True, "default_search": True,
        }
        module = operations.held_app(authoring.state, app_id).get_module(0)
        body, content_type = ops.form_body([("type", json.dumps("case")), ("search_properties", json.dumps(search))])
        ops.post(authoring, "edit_module_detail_screens", [app_id, module.unique_id],
                 body, content_type, "choose the area's project search")
    return app_id


BASE = Base(
    id="hq-project-search", build=build,
    configuration=Configuration(flags={"CASE_SEARCH_ENDPOINTS", "SYNC_SEARCH_CASE_CLAIM", "CASE_SEARCH_ADVANCED"},
                                privileges={"CLOUDCARE"}, case_search_enabled=True),
    exhibits=("case-search/case-search-endpoint-id", "questions/text-input-xsd-string"),
    declaration=Declaration(runs_only_on=None),
    cases=(("visit", (("district", "north"),)),),
)
