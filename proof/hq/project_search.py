"""Synthetic HQ project search services used by the native proof, outside the app Nova reads."""


def install_project_searches(unit, rows):
    from corehq.apps.case_search.models import CaseSearchEndpoint, CaseSearchEndpointVersion
    from corehq.apps.data_dictionary.models import CaseProperty, CaseType

    for row in rows:
        if "sql" in row:
            provider = CaseSearchEndpoint.TargetType.PROJECT_DB
            definition = {"dangerous_sql": row["sql"], "case_type": None, "query": None}
        else:
            provider = CaseSearchEndpoint.TargetType.ELASTICSEARCH
            case_type, _ = CaseType.objects.get_or_create(domain=unit.domain, name=row["case_type"])
            for prop in row["properties"]:
                CaseProperty.objects.update_or_create(case_type=case_type, name=prop["name"],
                                                      defaults={"data_type": prop["data_type"]})
            definition = {"case_type": row["case_type"], "query": row["query"]}
        service = CaseSearchEndpoint.objects.create(
            pk=row["id"], domain=unit.domain, name=row["name"], target_type=provider,
        )
        service.current_version = CaseSearchEndpointVersion.objects.create(
            endpoint=service, version_number=row["version"], parameters=row["parameters"],
            action=CaseSearchEndpointVersion.Action.CREATE, **definition,
        )
        service.save(update_fields=["current_version"])


def project_searches_of(unit):
    from corehq.apps.case_search.models import CaseSearchEndpoint
    from corehq.apps.data_dictionary.models import CaseProperty

    rows = []
    for service in CaseSearchEndpoint.objects.filter(domain=unit.domain).select_related("current_version").order_by("id"):
        assert service.is_active
        current = service.current_version
        if service.target_type == CaseSearchEndpoint.TargetType.PROJECT_DB:
            assert current.case_type is None and current.query is None
            rows.append({
                "id": service.pk, "name": service.name, "version": current.version_number,
                "parameters": current.parameters, "sql": current.dangerous_sql,
            })
        else:
            assert service.target_type == CaseSearchEndpoint.TargetType.ELASTICSEARCH
            rows.append({
                "id": service.pk, "name": service.name, "case_type": current.case_type, "version": current.version_number,
                "parameters": current.parameters, "query": current.query,
                "properties": list(CaseProperty.objects.filter(case_type__domain=unit.domain, case_type__name=current.case_type)
                                   .order_by("name").values("name", "data_type")),
            })
    return rows
