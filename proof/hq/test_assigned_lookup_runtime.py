"""HQ's assigned row receipts and the installed worker's choice-source boundary."""

import base64

import pytest
from lxml import etree

from proof.core.client import CoreRunnerError
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.test_indexed_lookup import _compiled_app
from proof.hq.test_lookup_upload import workbook
from proof.observe import casedata, publish
from proof.observe.sessions import admitted


def _villages(group):
    return workbook(
        [
            (
                "types",
                ("Delete(Y/N)", "table_id", "is_global?", "field 1", "field 2", "field 3"),
                [("N", "villages", "no", "id", "name", "district")],
            ),
            (
                "villages",
                (
                    "UID",
                    "Delete(Y/N)",
                    "field: id",
                    "field: name",
                    "field: district",
                    "user 1",
                    "group 1",
                    "location 1",
                ),
                [
                    (None, "N", "direct", "Direct clinic", "d1", "first", "", ""),
                    (None, "N", "group", "Group clinic", "d1", "", group, ""),
                    (None, "N", "place", "Regional clinic", "d1", "", "", "region"),
                    (None, "N", "union", "Shared clinic", "d1", "first", "first team", "region"),
                    (None, "N", "other", "Other clinic", "d2", "second", "", ""),
                    (None, "N", "nobody", "Unassigned clinic", "d2", "", "", ""),
                ],
            ),
        ]
    )


def test_native_worker_distinguishes_unavailable_empty_and_filtered_assigned_choices(
    hq, core_runner, documents, tmp_path
):
    from casexml.apps.phone.models import OTARestoreCommCareUser
    from casexml.apps.phone.utils import GLOBAL_USER_ID, write_fixture_items_to_io
    from corehq.apps.fixtures.fixturegenerators import ItemListsProvider
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow
    from corehq.apps.groups.models import Group
    from corehq.apps.users.models import CommCareUser

    document = documents["hq-lookups"]
    with hq_check(document.exports["minimum"].configuration.hq()) as (state, record):
        app_id, refusal, _ = publish.create_authored(state, document)
        assert refusal is None
        people = {
            name: CommCareUser.wrap(operations.seed_mobile_worker(state, name, f"worker-{name}"))
            for name in ("first", "second", "empty")
        }
        for name in ("first", "second"):
            state.couch.seed(
                {
                    **Group(domain=state.domain, name=f"{name} team", users=[people[name].user_id]).to_json(),
                    "_id": f"group-{name}",
                }
            )
        region = operations.seed_location(state, "Region", "region")
        clinic = operations.seed_location(state, "Clinic", "clinic")
        clinic.parent = region
        clinic.save()
        people["first"].location_id = clinic.location_id

        def restores():
            assigned = LookupTable.objects.get(domain=state.domain, tag="villages")
            global_items = []
            provider = ItemListsProvider()
            for table in LookupTable.objects.filter(domain=state.domain, is_global=True).order_by("tag"):
                with write_fixture_items_to_io(provider._get_global_items(table, state.domain)) as fixture:
                    global_items.append(fixture.getvalue())
            result = {}
            for name, user in people.items():
                principal = OTARestoreCommCareUser(state.domain, user)
                (item,), count = provider.get_user_items_and_count({assigned.id: assigned}, principal)
                assert count == len(item.findall("./villages_list/villages"))
                registered = casedata.CaseDatabase(user.user_id, name, (), ())
                others = [part.replace(GLOBAL_USER_ID.encode(), user.user_id.encode()) for part in global_items]
                xml = etree.tostring(item)
                result[name] = casedata.restore(registered, state.domain, [*others, xml])
                if name == "first":
                    result["unavailable"] = casedata.restore(registered, state.domain, others)
            return result

        assert operations.upload_lookup_workbook(state, _villages("first team"), replace=True).errors == []
        before = restores()
        before_rest = (
            operations.served_lookup_tables(state)["villages"],
            operations.served_lookup_rows(state, "villages", details=True),
        )
        before_ids = [row.id for row in LookupTableRow.objects.iter_rows(state.domain, tag="villages")]
        assert operations.upload_lookup_workbook(state, _villages("second team"), replace=True).errors == []
        after = restores()
        assert (
            operations.served_lookup_tables(state)["villages"],
            operations.served_lookup_rows(state, "villages", details=True),
        ) == before_rest
        assert [row.id for row in LookupTableRow.objects.iter_rows(state.domain, tag="villages")] == before_ids
        archive, xmlns = _compiled_app(state, record, app_id, tmp_path / "archive")

    with admitted(core_runner, archive) as opened:
        assert opened["admitted"], opened["problems"]

        def choices(restored, district):
            report = core_runner.evaluate(
                app=opened["app"],
                xmlns=xmlns,
                locale="en",
                restoreBase64=base64.b64encode(restored).decode(),
                answers=[{"path": "/data/district", "value": district}, {"path": "/data/village", "value": "1"}],
            )
            assert report["answers"][0]["result"] == "ok", report
            return [choice["value"] for choice in report["answers"][1]["choices"]]

        assert choices(before["first"], "1") == ["direct", "group", "place", "union"]
        assert choices(before["second"], "2") == ["other"]
        assert choices(before["first"], "2") == []
        with pytest.raises(CoreRunnerError, match="contents are accessible to the current user"):
            choices(before["empty"], "1")
        with pytest.raises(CoreRunnerError, match="Unable to find lookup table"):
            choices(before["unavailable"], "1")
        assert choices(after["first"], "1") == ["direct", "place", "union"]
        assert choices(after["second"], "1") == ["group"]
