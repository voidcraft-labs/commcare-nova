"""A project search runs the active version in this domain, even for an already installed app."""
import pytest
from lxml import etree

from proof.hq.state import open_unit
from proof.hq.configuration import Configuration
from proof.hq.database import fresh_database


def test_project_database_search_uses_named_parameters_current_version_and_flat_case_fields(hq):
    from unittest.mock import patch

    from django.db import connections
    from django.test import override_settings
    from sqlalchemy.engine import URL

    from corehq.apps.case_search.exceptions import CaseSearchUserError
    from corehq.apps.case_search.models import CaseSearchEndpoint, CaseSearchEndpointVersion
    from corehq.apps.case_search.utils import get_case_search_results_from_request
    from corehq.apps.project_db.table_ddl import (
        get_domain_query_engine, get_project_db_engine, setup_project_db,
    )
    from corehq.apps.project_db.tests.util import project_db_table
    from corehq.apps.project_db.user_sql import BadParameters
    from corehq.sql_db.connections import connection_manager

    # The setup SQL owns extensions and role provisioning functions. Its whole
    # database is a disposable clone; the domain role's name is unique across workers.
    with fresh_database() as database:
        domain = "nova-search-" + database.name.rsplit("_", 1)[-1]
        settings = Configuration(domain=domain, flags={"CASE_SEARCH_ENDPOINTS"}, case_search_enabled=True)
        configured = connections["default"].settings_dict
        url = URL.create("postgresql+psycopg2", username=configured["USER"],
                         password=configured["PASSWORD"], database=database.name,
                         host=configured["HOST"] or None, port=int(configured["PORT"] or 5432))
        original = connection_manager.get_connection_string
        def connection_string(engine):
            return url.render_as_string(hide_password=False) if engine == "project_db" else original(engine)
        with open_unit(settings, root_key=settings.digest(), transactional=False, strict=False), \
                override_settings(PROJECTDB_USERS_PASSWORD="synthetic-search-proof"), \
                patch.dict(connection_manager.engine_id_django_db_map, {"project_db": "default"}), \
                patch.object(connection_manager, "get_connection_string", connection_string):
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
            assert fixture.xpath("case[index/parent = 'clinic']/@case_id") == ["linked"]
