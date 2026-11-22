"""Synthetic HQ project search services used by the native proof, outside the app Nova reads."""


def install_project_searches(unit, rows):
    from corehq.apps.case_search.models import CaseSearchEndpoint, CaseSearchEndpointVersion
    from corehq.apps.data_dictionary.models import CaseProperty, CaseType

    for row in rows:
        case_type, _ = CaseType.objects.get_or_create(domain=unit.domain, name=row["case_type"])
        for prop in row["properties"]:
            CaseProperty.objects.update_or_create(case_type=case_type, name=prop["name"],
                                                  defaults={"data_type": prop["data_type"]})
        service = CaseSearchEndpoint.objects.create(
            pk=row["id"], domain=unit.domain, name=row["name"], target_type=CaseSearchEndpoint.TargetType.ELASTICSEARCH,
        )
        service.current_version = CaseSearchEndpointVersion.objects.create(
            endpoint=service, version_number=row["version"], case_type=row["case_type"], parameters=row["parameters"],
            query=row["query"], action=CaseSearchEndpointVersion.Action.CREATE,
        )
        service.save(update_fields=["current_version"])


def project_searches_of(unit):
    from corehq.apps.case_search.models import CaseSearchEndpoint
    from corehq.apps.data_dictionary.models import CaseProperty

    rows = []
    for service in CaseSearchEndpoint.objects.filter(domain=unit.domain).select_related("current_version").order_by("id"):
        assert service.target_type == CaseSearchEndpoint.TargetType.ELASTICSEARCH and service.is_active
        current = service.current_version
        rows.append({
            "id": service.pk, "name": service.name, "case_type": current.case_type, "version": current.version_number,
            "parameters": current.parameters, "query": current.query,
            "properties": list(CaseProperty.objects.filter(case_type__domain=unit.domain, case_type__name=current.case_type)
                               .order_by("name").values("name", "data_type")),
        })
    return rows
