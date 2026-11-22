"""A project search runs the active version in this domain, even for an already installed app."""
import pytest
from lxml import etree

from proof.hq.state import open_unit
from proof.hq.configuration import Configuration
from proof.hq.database import fresh_database


def _select_at_both_entries(domain, endpoint_id, result, parent_id):
    """Apply each HQ-generated entry's actual datum to the same provider response.

    The inline form selects a parent before searching. The ordinary remote
    request has no parent datum. Preserve the fixture's attributes and
    children so a literal ProjectDB column called index cannot become an edge.
    """
    from copy import deepcopy

    from corehq.apps.app_manager.models import CaseSearch, DefaultCaseSearchProperty
    from corehq.apps.app_manager.tests.app_factory import AppFactory
    from corehq.apps.app_manager.tests.util import patch_get_xform_resource_overrides

    factory = AppFactory(domain=domain, build_version="2.57.0")
    parent, parent_form = factory.new_basic_module("areas", "clinic")
    factory.form_requires_case(parent_form, "clinic")
    ordinary, ordinary_form = factory.new_basic_module("directory", "outside")
    inline, inline_form = factory.new_basic_module("followup", "outside")
    for module, form, is_inline in [(ordinary, ordinary_form, False), (inline, inline_form, True)]:
        factory.form_requires_case(form, "outside")
        module.search_config = CaseSearch(
            default_properties=[DefaultCaseSearchProperty(property="region", defaultValue="'North'")],
            case_search_endpoint_id=endpoint_id, inline_search=is_inline, auto_launch=is_inline,
        )
    inline.parent_select.active = True
    inline.parent_select.module_id = parent.unique_id
    inline.parent_select.relationship = "parent"
    with patch_get_xform_resource_overrides():
        suite = etree.fromstring(factory.app.create_suite())
    result_document = etree.Element("root")
    result_document.append(deepcopy(result))
    chosen = {}
    for route, instance in [("ordinary", "results"), ("inline", inline.search_config.get_instance_name())]:
        marker = f"instance('{instance}')/results/case"
        datums = [element for element in suite.xpath("//*[@nodeset]") if element.get("nodeset").startswith(marker)]
        # The same case selector can be offered under more than one command.
        selectors = {(datum.get("nodeset"), datum.get("value")) for datum in datums}
        assert len(selectors) == 1, (route, selectors)
        expression, value = selectors.pop()
        session_document = etree.Element("root")
        data = etree.SubElement(etree.SubElement(session_document, "session"), "data")
        if route == "inline":
            parent_datums = datums[0].xpath("preceding-sibling::*[@nodeset]")
            parent_selectors = [datum for datum in parent_datums if "instance('casedb')" in datum.get("nodeset")]
            assert len(parent_selectors) == 1, [datum.get("id") for datum in parent_datums]
            etree.SubElement(data, parent_selectors[0].get("id")).text = parent_id
        instances = {instance: result_document, "commcaresession": session_document}
        selected = result_document.xpath(expression, extensions={(None, "instance"): lambda _ctx, name: instances[name]})
        chosen[route] = [str(row.xpath(value)[0]) for row in selected]
    return chosen


def test_project_database_search_uses_named_parameters_current_version_and_flat_case_fields(hq):
    from contextlib import ExitStack
    from unittest.mock import patch

    from django.test import override_settings
    from urllib.parse import urlsplit, urlunsplit

    from corehq.apps.case_search.exceptions import CaseSearchUserError
    from corehq.apps.case_search.models import CaseSearchEndpoint, CaseSearchEndpointVersion
    from corehq.apps.case_search.utils import get_case_search_results_from_request
    from corehq.apps.project_db.table_ddl import (
        get_domain_query_engine, get_project_db_engine, setup_project_db,
    )
    from corehq.apps.project_db.tests.util import project_db_table
    from corehq.apps.project_db.user_sql import BadParameters
    from corehq.sql_db.connections import connection_manager
    from corehq.util.test_utils import mock_out_couch

    from proof.hq.boot import clear_caches
    from proof.hq.couch import ComputedViewCouch
    from proof.hq.seams import SeamRecord, flags
    from proof.hq.state import build_config_document, domain_document

    # The setup SQL owns extensions and role provisioning functions. Its whole
    # database is a disposable clone; the domain role's name is unique across workers.
    with fresh_database() as database:
        domain = "nova-search-" + database.name.rsplit("_", 1)[-1]
        settings = Configuration(domain=domain, flags={"CASE_SEARCH_ENDPOINTS"}, case_search_enabled=True)
        original = connection_manager.get_connection_string
        base = urlsplit(original("default"))
        cloned_url = urlunsplit(base._replace(path=f"/{database.name}"))

        def connection_string(engine):
            return cloned_url if engine == "project_db" else original(engine)

        # The provider and its read-only role each open their own connection.
        # A dedicated clone owns them, while the same domain and flag fixtures
        # used by an HQ unit supply its clock zone and endpoint entitlement.
        with ExitStack() as stack:
            clear_caches()
            stack.callback(clear_caches)
            couch = ComputedViewCouch()
            mock_couch = mock_out_couch()
            mock_couch.db = couch
            stack.enter_context(mock_couch)
            couch.seed(domain_document(settings))
            couch.seed(build_config_document(settings))
            stack.enter_context(flags(settings, SeamRecord()))
            stack.enter_context(override_settings(PROJECTDB_USERS_PASSWORD="synthetic-search-proof"))
            stack.enter_context(patch.dict(connection_manager.engine_id_django_db_map, {"project_db": "default"}))
            stack.enter_context(patch.object(connection_manager, "get_connection_string", connection_string))
            admin = get_project_db_engine()
            assert admin.url.database == database.name
            try:
                setup_project_db()
                data = (
                    ["case_id", "owner_id", "case_name", "parent_id"],
                    [("v1", "worker", "North", "clinic-a"), ("v2", "worker", "South", None)],
                )
                with project_db_table(domain, "visit", {}, data=data):
                    reader = get_domain_query_engine(domain)
                    try:
                        service = CaseSearchEndpoint.objects.create(
                            domain=domain, name="Assigned visits", target_type=CaseSearchEndpoint.TargetType.PROJECT_DB,
                        )
                        def publish(version, columns):
                            current = CaseSearchEndpointVersion.objects.create(
                                endpoint=service, version_number=version, case_type="visit",
                                dangerous_sql=(
                                    f"SELECT case_id, {columns}, parent_id AS index FROM visit "
                                    "WHERE (:region IS NULL OR case_name = :region) ORDER BY case_id"
                                ),
                                action=(CaseSearchEndpointVersion.Action.CREATE if version == 1
                                        else CaseSearchEndpointVersion.Action.UPDATE),
                            )
                            service.current_version = current
                            service.save(update_fields=["current_version"])

                        def request(target=domain, **criteria):
                            payload = {
                                "x_commcare_endpoint_id": [str(service.pk)],
                                "case_type": ["person"],
                                **{key: [value] for key, value in criteria.items()},
                            }
                            raw, _profiler = get_case_search_results_from_request(target, None, None, payload)
                            root = etree.fromstring(raw)
                            assert root.tag == "results" and root.get("id") == "case"
                            return list(root)

                        publish(1, "case_name AS region")
                        assert [row.get("case_id") for row in request()] == ["v1", "v2"]
                        assert request(region="") == []
                        [row] = request(region="North")
                        assert (row.get("case_id"), row.findtext("region"), row.findtext("index")) == (
                            "v1", "North", "clinic-a",
                        )
                        assert len(row.find("index")) == 0
                        assert _select_at_both_entries(domain, service.pk, row.getparent(), "clinic-a") == {
                            "ordinary": ["v1"], "inline": [],
                        }
                        for key in ("extra", "_xpath_query", "commcare_blacklisted_owner_ids"):
                            with pytest.raises(BadParameters, match="Unexpected params"):
                                request(**{key: "field"})
                        with pytest.raises(CaseSearchUserError):
                            request(target=domain + "-other")
                        publish(2, "case_name AS district")
                        [changed] = request(region="North")
                        assert changed.find("region") is None and changed.findtext("district") == "North"
                        service.is_active = False
                        service.save(update_fields=["is_active"])
                        with pytest.raises(CaseSearchUserError, match="not found"):
                            request(region="North")
                    finally:
                        reader.dispose()
                        get_domain_query_engine.cache_clear()
            finally:
                connection_manager.dispose_engine("project_db")


def test_elasticsearch_search_keeps_real_parent_edges_and_uses_the_service_case_type(hq):
    from hashlib import sha256

    from casexml.apps.case.mock import CaseBlock, IndexAttrs
    from corehq.apps.case_search.models import CaseSearchEndpoint, CaseSearchEndpointVersion
    from corehq.apps.case_search.utils import get_case_search_results_from_request
    from corehq.apps.data_dictionary.models import CaseProperty, CaseType
    from corehq.apps.hqcase.utils import submit_case_blocks

    from proof.hq import redis as hq_redis

    settings = Configuration(domain="search-visits", flags=frozenset({"CASE_SEARCH_ENDPOINTS"}), case_search_enabled=True)
    with open_unit(settings, root_key=settings.digest(), strict=False) as unit:
        with hq_redis.shared(None), unit.committing(), unit.operation("receive cases", sha256(b"search-edges").digest()):
            cases = [
                CaseBlock(create=True, case_id="clinic", case_type="clinic", case_name="North", owner_id="worker"),
                CaseBlock(create=True, case_id="linked", case_type="visit", case_name="Linked", owner_id="worker",
                          update={"district": "north"}, index={"parent": IndexAttrs("clinic", "clinic", "child")}),
                CaseBlock(create=True, case_id="other", case_type="visit", case_name="Other", owner_id="worker",
                          update={"district": "north"}),
                CaseBlock(create=True, case_id="south", case_type="visit", case_name="South", owner_id="worker",
                          update={"district": "south"}),
            ]
            submit_case_blocks([case.as_text() for case in cases], unit.domain, user_id="worker", device_id="proof")
        with unit.operation("search visits", sha256(b"active-visit-service").digest()):
            visit = CaseType.objects.create(domain=unit.domain, name="visit")
            CaseProperty.objects.create(case_type=visit, name="district", data_type=CaseProperty.DataType.PLAIN)
            endpoint = CaseSearchEndpoint.objects.create(domain=unit.domain, name="Visit directory",
                                                         target_type=CaseSearchEndpoint.TargetType.ELASTICSEARCH)
            endpoint.current_version = CaseSearchEndpointVersion.objects.create(
                endpoint=endpoint, version_number=1, case_type="visit", action=CaseSearchEndpointVersion.Action.CREATE,
                parameters=[{"name":"region", "type":"text"}],
                query={"type":"all","children":[{"type":"component","field":"district","operator":"equals",
                                                  "inputs":{"value":{"type":"parameter","value":"region"}}}]},
            )
            endpoint.save(update_fields=["current_version"])
            raw, _ = get_case_search_results_from_request(unit.domain, None, None, {
                "x_commcare_endpoint_id":[str(endpoint.pk)], "case_type":["different"], "region":["north"],
            })
            fixture = etree.fromstring(raw)
            assert set(fixture.xpath("case/@case_id")) == {"linked", "other"}
            selected = _select_at_both_entries(unit.domain, endpoint.pk, fixture, "clinic")
            assert set(selected["ordinary"]) == {"linked", "other"}
            assert selected["inline"] == ["linked"]

