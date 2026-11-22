"""HQ's endpoint editor saves a read-only project database query; its Case List
editor chooses that endpoint and supplies text and numeric parameters.
"""
import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases.project_search import bind_service, visit_app, visit_form
from proof.matrix.registry import Base, Declaration

NAME = "Visits in the chosen area"


def visit_source(name):
    form = visit_form(name)
    form.new_question("priority", "Priority for the next visit", "int")
    return form.tostring(xml_declaration=True).decode("utf-8")


def build(authoring):
    from django.urls import resolve, reverse
    from corehq.apps.case_search.endpoint_views import CaseSearchEndpointNewView
    from corehq.apps.case_search.models import CaseSearchEndpoint
    from proof.hq import requests

    app_id = visit_app(authoring, "Visit database", source=visit_source,
                       updates={"district": "/data/area", "priority": "/data/priority"})
    with authoring.step("build:project-database-search"):
        state = authoring.state
        parameters = [{"name": "area", "type": "text"}, {"name": "minimum_priority", "type": "number"}]
        statement = (
            "SELECT case_id, case_name, prop__district AS area FROM visit "
            "WHERE prop__district = :area AND number_prop__priority >= :minimum_priority "
            "ORDER BY case_id"
        )
        body, content_type = ops.form_body([("name", NAME), ("parameters", json.dumps(parameters)), ("sql", statement)])
        path = reverse(CaseSearchEndpointNewView.urlname, args=[state.domain])
        query = "?target_type=" + CaseSearchEndpoint.TargetType.PROJECT_DB
        request = requests.raw_post(state, path + query, body, content_type)
        match = resolve(path)
        response = match.func(request, *match.args, **match.kwargs)
        assert response.status_code == 302, (response.status_code, getattr(response, "context_data", {}).get("form"))
        endpoint = CaseSearchEndpoint.objects.get(domain=state.domain, name=NAME, is_active=True)
        assert endpoint.current_version.dangerous_sql == statement and endpoint.current_version.parameters == parameters
        bind_service(authoring, app_id, endpoint.pk, [
            {"property": "area", "defaultValue": "'north'"},
            {"property": "minimum_priority", "defaultValue": "3"},
        ])
    return app_id


BASE = Base(
    id="hq-project-database-search",
    build=build,
    configuration=Configuration(flags={"PROJECT_DB", "CASE_SEARCH_ENDPOINTS", "SYNC_SEARCH_CASE_CLAIM", "CASE_SEARCH_ADVANCED"},
                                privileges={"CLOUDCARE"}, case_search_enabled=True, sync_cases_on_form_entry=True),
    exhibits=("case-search/case-search-endpoint-id", "questions/text-input-xsd-string"),
    declaration=Declaration(runs_only_on=None),
    cases=(("visit", (("district", "north"),)),),
)
