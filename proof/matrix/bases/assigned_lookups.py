"""An HQ-authored survey over public districts and private village rows."""

from proof.hq.configuration import Configuration
from proof.matrix.bases import _pages, lookups
from proof.matrix.registry import Base, Declaration
from proof.observe.casedata import USER_ID, USERNAME


def build(authoring):
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow, LookupTableRowOwner, OwnerType

    from proof.hq.operations import seed_mobile_worker

    app_id = lookups.build(authoring)
    _pages.rename_app(authoring, app_id, "Assigned farm visits")
    _pages.turn_web_apps_on(authoring, app_id)
    state = authoring.state
    with authoring.step("build:assign-villages-to-the-proof-worker", USER_ID.encode()):
        villages = LookupTable.objects.get(domain=state.domain, tag="villages")
        villages.is_global = False
        villages.save(update_fields=["is_global"])
        seed_mobile_worker(state, USERNAME, USER_ID)
        for row in LookupTableRow.objects.filter(domain=state.domain, table=villages).order_by("sort_key"):
            if row.fields["id"][0].value in {"v1", "v3"}:
                LookupTableRowOwner.objects.create(
                    domain=state.domain, row_id=row.id, owner_type=OwnerType.User, owner_id=USER_ID
                )
    return app_id


BASE = Base(
    id="hq-assigned-lookups",
    build=build,
    declaration=Declaration(runs_only_on="web-apps"),
    configuration=Configuration(privileges=frozenset({"CLOUDCARE", "LOOKUP_TABLES"})),
    exhibits=("questions/lookup-table-select-selectdynamic-mselectdynamic-itemset-nodeset",),
    vellum=((0, 0),),
)
