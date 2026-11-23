"""Generate genuine per-worker fixture bytes, then change membership and restore again."""

from types import SimpleNamespace
from xml.etree import ElementTree as ET

from proof.hq import operations
from proof.native.hq_support import native_check


def restored_audiences(exports):
    from casexml.apps.phone.models import OTARestoreCommCareUser, OTARestoreWebUser
    from corehq.apps.fixtures.fixturegenerators import ItemListsProvider
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow, LookupTableRowOwner
    from corehq.apps.groups.models import Group
    from corehq.apps.locations.models import LocationType, SQLLocation
    from corehq.apps.users.fixturegenerators import UserGroupsFixtureProvider
    from corehq.apps.users.models import CommCareUser

    from proof.hq import redis as hq_redis

    # Placing a worker saves the worker's user case through HQ's receiver, which takes its lock in Redis
    # (``form_processor/interfaces/processor.py::acquire_lock_for_xform``): HQ's own Redis for the step.
    with (
        native_check("worker-audiences", privileges={"LOOKUP_TABLES", "LOCATIONS", "CASE_SHARING_GROUPS"}) as (state, _),
        hq_redis.shared(None),
    ):
        workers = {
            name: CommCareUser.wrap(operations.seed_mobile_worker(state, name, "mobile-" + name))
            for name in ("ada", "bea", "cal")
        }
        root_type = LocationType.objects.create(domain=state.domain, name="District", code="district", shares_cases=False)
        clinic_type = LocationType.objects.create(domain=state.domain, name="Clinic", code="clinic", parent_type=root_type, shares_cases=False)
        district = SQLLocation.objects.create(domain=state.domain, name="District", site_code="district", location_type=root_type)
        clinic = SQLLocation.objects.create(domain=state.domain, name="Clinic", site_code="clinic", parent=district, location_type=clinic_type)
        extra = SQLLocation.objects.create(domain=state.domain, name="Outpost", site_code="outpost", location_type=root_type)
        workers["ada"].set_location(clinic)
        workers["ada"].reset_locations([clinic.location_id, extra.location_id])
        for group_id, name, members, shares, metadata in (
            ("roster", "Roster", ["ada"], False, {}),
            ("east", "East", ["bea", "cal"], True, {"meeting": " Friday "}),
            ("west", "West", ["cal"], True, {}),
        ):
            group = Group(domain=state.domain, name=name, users=[workers[n].user_id for n in members],
                          case_sharing=shares, metadata=metadata).to_json()
            state.couch.seed({**group, "_id": group_id})
        report = operations.upload_lookup_workbook(state, (exports / "assigned-outreach.xlsx").read_bytes(), replace=True)
        assert report.success and not report.errors, (report.errors, report.messages)
        table = LookupTable.objects.get(domain=state.domain, tag="outreach")
        assert not table.is_global
        rows = list(LookupTableRow.objects.iter_rows(state.domain, table_id=table.id))
        assert len(rows) == len({r.id for r in rows}) == 6
        # Equal-looking rows keep two distinct source identities, and the dual grant
        # on row 3 is deduplicated by HQ's Subquery over row IDs.
        assert [set(LookupTableRowOwner.objects.filter(row_id=r.id).values_list("owner_id", flat=True)) for r in rows] == [
            {"mobile-ada"}, {"mobile-bea"}, {"mobile-ada", "roster"}, {district.location_id}, {extra.location_id}, set()
        ]
        provider = ItemListsProvider()
        principals = {name: OTARestoreCommCareUser(state.domain, user) for name, user in workers.items()}
        principals["author"] = OTARestoreWebUser(state.domain, state.web_user)
        deliveries = {"ada": ["Twin", "Direct and roster", "District"], "bea": ["Twin"], "cal": [], "author": []}
        group_ids = {"ada": [], "bea": ["east"], "cal": ["east", "west"], "author": []}
        for name, principal in principals.items():
            fixtures, _count = provider.get_user_items_and_count({table.id: table}, principal)
            (data,) = list(fixtures)
            assert [item.findtext("label") for item in data.findall("./outreach_list/outreach")] == deliveries[name]
            (groups,) = UserGroupsFixtureProvider()(SimpleNamespace(restore_user=principal, last_sync_log=None))
            assert sorted(node.get("id") for node in groups.findall("./groups/group")) == group_ids[name]
            if name == "bea":
                assert groups.findtext("./groups/group/group_data/data[@key='meeting']") == " Friday "
            envelope = ET.Element("OpenRosaResponse", xmlns="http://openrosa.org/http/response")
            envelope.extend([data, groups])
            (exports / f"worker-groups-{name}.restore.xml").write_bytes(ET.tostring(envelope))
        # A new full restore after explicit revocation must omit the worker's
        # own copy of Twin, though another worker still owns an equal-looking row.
        LookupTableRowOwner.objects.filter(row_id=rows[0].id, owner_id="mobile-ada").delete()
        (data,), _ = provider.get_user_items_and_count({table.id: table}, principals["ada"])
        assert [n.findtext("label") for n in data.findall("./outreach_list/outreach")] == ["Direct and roster", "District"]
        # An incremental restore with no changed table omits the fixture.
        from django.utils import timezone
        delta = SimpleNamespace(restore_user=principals["ada"], last_sync_log=SimpleNamespace(date=timezone.now()),
                                overwrite_cache=False)
        assert not any(node.get("id") == "item-list:outreach" for node in provider(delta))
