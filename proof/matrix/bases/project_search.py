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
from proof.matrix.registry import Base, Declaration

ENDPOINT_ID = 17


def visit_form(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    form = XFormBuilder(name)
    form.new_question("area", "Area for the next visit", "select1", choices={"north": "North", "south": "South"})
    form.new_question("note", "Visit note", "string")
    return form


def visit_source(name):
    return visit_form(name).tostring(xml_declaration=True).decode("utf-8")


def visit_app(authoring, name, *, source=visit_source, updates=None):
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, name)
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.new_case_module(authoring, app_id, name="Area visits", case_type="visit")
    _pages.delete_form(authoring, app_id, 0, 0)
    ops.upload_form_source(authoring, app_id, 0, 0, source, "area")
    _pages.save_case_actions(authoring, app_id, 0, 0, updates=updates or {"district": "/data/area"})
    _pages.save_case_list(authoring, app_id, 0, columns=[_pages.column("name", "Visit")])
    return app_id


def bind_service(authoring, app_id, endpoint_id, defaults):
    from proof.hq import operations

    search = {
        "properties": [], "default_properties": defaults,
        "custom_sort_properties": [], "title_label": "", "description": "",
        "case_search_endpoint_id": endpoint_id, "auto_launch": True, "default_search": True,
    }
    module = operations.held_app(authoring.state, app_id).get_module(0)
    body, content_type = ops.form_body([("type", json.dumps("case")), ("search_properties", json.dumps(search))])
    ops.post(authoring, "edit_module_detail_screens", [app_id, module.unique_id],
             body, content_type, "choose the area's project search")


def build(authoring):
    from corehq.apps.data_dictionary.models import CaseProperty

    app_id = visit_app(authoring, "Assigned visits")
    with authoring.step("build:project-search"):
        install_project_searches(authoring.state, [{
            "id": ENDPOINT_ID, "name": "Visits by area", "case_type": "visit", "version": 1,
            "properties": [{"name": "district", "data_type": CaseProperty.DataType.PLAIN}],
            "parameters": [{"name": "area", "type": "text"}],
            "query": {"type": "all", "children": [{"type": "component", "field": "district", "operator": "equals",
                                                  "inputs": {"value": {"type": "parameter", "value": "area"}}}]},
        }])
        bind_service(authoring, app_id, ENDPOINT_ID, [{"property": "area", "defaultValue": "'north'"}])
    return app_id


BASE = Base(
    id="hq-project-search", build=build,
    configuration=Configuration(flags={"CASE_SEARCH_ENDPOINTS", "SYNC_SEARCH_CASE_CLAIM", "CASE_SEARCH_ADVANCED"},
                                privileges={"CLOUDCARE"}, case_search_enabled=True),
    exhibits=("case-search/case-search-endpoint-id", "questions/text-input-xsd-string"),
    declaration=Declaration(runs_only_on=None),
    cases=(("visit", (("district", "north"),)),),
)
