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

Defect 5 also rests on what HQ does with the parts of a table Nova's push
cannot carry, and on how its upload view answers; each is held below over
the workbook Nova's push captured for ``targeted-hq-side-lookup``
(``export/minimum``'s content's ``lookups``):

- **The upload view's answers.** Through ``operations.api_request``, HQ's
  view with its decorators answers JSON on every path with its verdict in
  the body's ``code``, at HTTP 200: Nova's workbook is ``code`` 200 and HQ
  holds its table; a file that is no workbook and a request with no file
  are ``code`` 405 and write nothing, so a space that held no table holds
  none and a held table keeps its id and its rows.
- **Owners.** HQ's restore sends a global table's every row to every worker
  (``fixturegenerators.py::ItemListsProvider._get_global_items``), and a
  table that is not global only the rows a worker owns
  (``get_user_items_and_count``, the arm ``ItemListsProvider.__call__``
  takes for it). So owners take effect only on a table that is not global,
  and Nova's push over a global table keeps the table's id and every row's
  id and leaves no owner.
- **A description and an indexed field.** Both are part of HQ's table key
  (``upload/run_upload.py::table_key``), and no workbook carries a
  description (``upload/workbook.py::_FixtureWorkbook.iter_tables``). Nova's
  push over an identical table keeps its id and every row's id; over the
  same table given a description, or an indexed field, it leaves the tag
  under a new id with the description or the flag gone; and HQ's own
  download of a described table, uploaded back unchanged, makes the table
  again with no description, with ``replace`` and without.
"""

from __future__ import annotations

from io import BytesIO

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"LOOKUP_TABLES"})
# The document whose captured workbook stands for Nova's push (``proof/hq/conftest.py::DOCUMENTS`` names it).
PUSHED = "targeted-hq-side-lookup"


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


def _novas_workbook(documents):
    """The workbook Nova's push sends for ``targeted-hq-side-lookup``: one global table, ``district``."""
    return documents[PUSHED].exports["minimum"].content.lookups


def _held(state):
    """Each table HQ holds, by tag: its id, description, whether it is global, its fields with their indexed flags,
    and its rows' ids in order."""
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow

    return {
        table.tag: {
            "id": table.id,
            "description": table.description,
            "is_global": table.is_global,
            "indexed": [field.is_indexed for field in table.fields],
            "rows": [row.id for row in LookupTableRow.objects.iter_rows(state.domain, table_id=table.id)],
        }
        for table in LookupTable.objects.filter(domain=state.domain)
    }


def _multipart(fields):
    """A ``multipart/form-data`` body of ``(name, extra headers, value)`` parts, and its content type."""
    boundary = "nova-proof-boundary"
    body = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"{extra}\r\n\r\n'.encode() + value + b"\r\n"
        for name, extra, value in fields
    )
    return body + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def test_hqs_upload_view_answers_json_with_its_verdict_and_writes_only_what_it_takes(hq, core_runner, documents):
    import json

    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits

    captured = _novas_workbook(documents)
    configuration = documents[PUSHED].exports["minimum"].configuration.hq()
    with hq_check(configuration) as (state, _), hq_redis.shared(None), state.committing(), api_rate_limits(state):
        # The upload needs the account's Edit Data permission (``fixtures/dispatcher.py::require_can_edit_fixtures``).
        member = operations.seed_api_user(state, "member-upload@example.org", edit_data=True)

        def upload(body, content_type):
            answer = operations.api_request(
                state,
                "POST",
                f"/a/{state.domain}/fixtures/fixapi/",
                credential=member,
                body=body,
                content_type=content_type,
            )
            assert answer.status == 200 and answer.headers.get("Content-Type", "").startswith("application/json"), (
                answer.retained()
            )
            return json.loads(answer.body)

        not_a_workbook = _multipart(
            [
                ("replace", "", b"true"),
                ("file-to-upload", '; filename="tables.xlsx"\r\nContent-Type: application/octet-stream', b"no"),
            ]
        )
        no_file = _multipart([("replace", "", b"true")])

        # A space that holds no table: each refusal writes none.
        assert upload(*not_a_workbook)["code"] == 405
        assert upload(*no_file)["code"] == 405
        assert _held(state) == {}

        assert upload(captured.upload().body, captured.content_type)["code"] == 200
        taken = _held(state)
        assert list(taken) == ["district"] and len(taken["district"]["rows"]) == 2

        # A held table: each refusal leaves its id and its rows.
        assert upload(*not_a_workbook)["code"] == 405
        assert upload(*no_file)["code"] == 405
        assert _held(state) == taken


def test_owners_take_effect_only_on_a_table_that_is_not_global_and_novas_push_drops_them(hq, core_runner, documents):
    from casexml.apps.phone.models import OTARestoreCommCareUser
    from corehq.apps.fixtures.fixturegenerators import ItemListsProvider
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow, LookupTableRowOwner, OwnerType
    from corehq.apps.users.models import CommCareUser

    captured = _novas_workbook(documents)
    with hq_check(CONFIGURATION) as (state, _):
        owner = CommCareUser.wrap(operations.seed_mobile_worker(state, "owner", "worker-owner"))
        other = CommCareUser.wrap(operations.seed_mobile_worker(state, "other", "worker-other"))
        assert operations.upload_lookup_workbook(state, captured.workbook(), replace=True).errors == []
        (table,) = LookupTable.objects.filter(domain=state.domain)
        first, second = LookupTableRow.objects.iter_rows(state.domain, table_id=table.id)
        LookupTableRowOwner.objects.create(
            domain=state.domain, row_id=first.id, owner_type=OwnerType.User, owner_id=owner.user_id
        )
        provider = ItemListsProvider()

        def served(worker):
            """The rows HQ's restore writes for ``worker``: the global arm for a global table, the owned arm for
            one that is not."""
            if table.is_global:
                (fixture,) = provider._get_global_items(table, state.domain)
            else:
                (fixture,), _ = provider.get_user_items_and_count(
                    {table.id: table}, OTARestoreCommCareUser(state.domain, worker)
                )
            (items,) = list(fixture)
            return len(list(items))

        assert table.is_global
        assert (served(owner), served(other)) == (2, 2)
        table.is_global = False
        table.save()
        assert (served(owner), served(other)) == (1, 0)

        table.is_global = True
        table.save()
        held = _held(state)
        assert operations.upload_lookup_workbook(state, captured.workbook(), replace=True).errors == []
        assert _held(state) == held
        assert list(LookupTableRowOwner.objects.filter(domain=state.domain)) == []


def test_a_description_or_an_indexed_field_makes_novas_push_make_the_table_again(hq, core_runner, documents):
    from corehq.apps.fixtures.download import _prepare_fixture
    from corehq.apps.fixtures.models import LookupTable
    from couchexport.export import export_raw
    from couchexport.models import Format

    captured = _novas_workbook(documents)

    def push():
        assert operations.upload_lookup_workbook(state, captured.workbook(), replace=True).errors == []
        (table,) = LookupTable.objects.filter(domain=state.domain)
        return table

    with hq_check(CONFIGURATION) as (state, _):
        pushed = push()
        held = _held(state)
        # Over an identical table: the same table, the same rows.
        push()
        assert _held(state) == held

        pushed.description = "The districts the health team visits"
        pushed.save()
        again = push()
        assert again.id != pushed.id and again.description == ""

        again.fields[0].is_indexed = True
        again.save()
        unindexed = push()
        assert unindexed.id != again.id and not any(field.is_indexed for field in unindexed.fields)

        for replace in (False, True):
            unindexed.description = "Kept in HQ"
            unindexed.save()
            # HQ's own download of the described table (``download.py::prepare_fixture_download`` without its
            # cached file), uploaded back unchanged.
            types, sheets = _prepare_fixture([unindexed.id.hex], state.domain)
            out = BytesIO()
            export_raw(
                (("types", sheets["types"]["headers"]), *((t.tag, sheets[t.tag]["headers"]) for t in types)),
                (("types", sheets["types"]["rows"]), *((t.tag, sheets[t.tag]["rows"]) for t in types)),
                out,
                Format.XLS_2007,
            )
            assert operations.upload_lookup_workbook(state, out.getvalue(), replace=replace).errors == []
            (made,) = LookupTable.objects.filter(domain=state.domain)
            assert made.id != unindexed.id and made.description == "", replace
            unindexed = made
