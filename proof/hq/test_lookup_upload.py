"""HQ's lookup table upload, on HQ's state.

Contract: ``operations.upload_lookup_workbook`` runs HQ's
``fixtures/upload/run_upload.py::_run_upload`` over HQ's workbook reader, and
it resolves owners through HQ's own lookups (``users/by_username`` and
``groups/by_name`` in Couch, the locations table in Postgres) against the
owners the check seeded. The plausible failures: owner lookups the harness
answers with nothing (so every owner is silently "unknown"), and a replacing
upload whose deletes the harness's database does not carry out as HQ's does.
``_run_upload`` deletes the old table and its rows itself, and leaves their
owners to the ``ON DELETE CASCADE`` foreign keys HQ's migrations create
(``fixtures/migrations/0005_sqllookuptablemodels``; the models declare no
database constraint), so a database built from the models alone keeps the
old rows' owners.

A replacing upload whose table differs from the held one (its fields here)
makes HQ delete the table and create it again: the table and its rows get
new ids, and no owner row is left in HQ's database, neither the old rows'
nor any on the new rows (defect 5's mechanism).
"""

from __future__ import annotations

from io import BytesIO

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"LOOKUP_TABLES"})


def workbook(sheets) -> bytes:
    """An .xlsx written by HQ's own exporter, the format HQ's download gives."""
    from couchexport.export import export_raw
    from couchexport.models import Format

    out = BytesIO()
    export_raw(
        [(name, headers) for name, headers, _ in sheets],
        [(name, rows) for name, _, rows in sheets],
        out,
        format=Format.XLS_2007,
    )
    return out.getvalue()


OWNED_TABLE = [
    ("types", ("Delete(Y/N)", "table_id", "is_global?", "field 1", "field 2"), [("N", "district", "no", "id", "name")]),
    (
        "district",
        ("UID", "Delete(Y/N)", "field: id", "field: name", "user 1", "group 1", "location 1"),
        [(None, "N", "d1", "Delhi", "u1", "g1", "delhi_region")],
    ),
]

# Nova's push: the same tag with its own fields and no owner columns, replacing.
REPLACEMENT = [
    (
        "types",
        ("Delete(Y/N)", "table_id", "is_global?", "field 1", "field 2", "field 3"),
        [("N", "district", "no", "id", "name", "region")],
    ),
    (
        "district",
        ("UID", "Delete(Y/N)", "field: id", "field: name", "field: region"),
        [(None, "N", "d1", "Delhi", "North")],
    ),
]


def test_a_replacing_upload_recreates_the_table_and_leaves_no_owner(hq, core_runner):
    with hq_check(CONFIGURATION) as (state, _):
        from corehq.apps.fixtures.models import LookupTable, LookupTableRow, LookupTableRowOwner, OwnerType

        operations.seed_mobile_worker(state, "u1", "user-u1")
        operations.seed_group(state, "g1", "group-g1")
        location = operations.seed_location(state, "Delhi Region", "delhi_region")

        first = operations.upload_lookup_workbook(state, workbook(OWNED_TABLE), replace=False)
        assert first.errors == []
        (table,) = LookupTable.objects.filter(domain=state.domain)
        (row,) = LookupTableRow.objects.filter(domain=state.domain)
        owners = {(o.owner_type, o.owner_id) for o in LookupTableRowOwner.objects.filter(row_id=row.id)}
        assert owners == {
            (OwnerType.User, "user-u1"),
            (OwnerType.Group, "group-g1"),
            (OwnerType.Location, location.location_id),
        }

        second = operations.upload_lookup_workbook(state, workbook(REPLACEMENT), replace=True)
        assert second.errors == []
        (new_table,) = LookupTable.objects.filter(domain=state.domain)
        (new_row,) = LookupTableRow.objects.filter(domain=state.domain)
        assert new_table.tag == table.tag == "district"
        assert [f.name for f in new_table.fields] == ["id", "name", "region"]
        assert new_table.id != table.id and new_row.id != row.id
        # HQ's cascade removed the deleted row's owners; the new row has none.
        assert list(LookupTableRowOwner.objects.all()) == []
