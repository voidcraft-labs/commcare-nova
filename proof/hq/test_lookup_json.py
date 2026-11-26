"""Nova's JSON carrier of a lookup table, through HQ's own lookup resources, on HQ's state.

Contract: the requests Nova's carrier sends for a table the workbook cannot carry
(``lib/commcare/hq/lookupJson.ts``, held as ``fixtures/lookup-json-requests.json`` by
``lib/commcare/hq/__tests__/lookupJsonNative.test.ts``) do, through HQ's
``fixtures/resources/v0_1.py::LookupTableResource`` and ``v0_6.LookupTableItemResource`` with Nova's own API key
authentication (``operations.api_request``), exactly what the carrier's journal
(``lib/deployment/lookupJsonExecutor.ts``) assumes of them:

- **A ``types`` table is created by JSON.** The POST answers 201 with no body, so nothing names the table's id but
  its tag, which HQ then holds once (the executor finds an unanswered or answered create by its tag).
- **Rows are appended at HQ's own rank.** Each row POST answers 201 with the saved row: its minted id, and the rank
  HQ gave it, its largest plus one (0, 1, 2), never the body's.
- **A changed row and a moved row keep their ids.** A PUT of the whole row to its id replaces its fields, details
  and rank; sent twice it lands once, so a lost PUT answer is resent at its unchanged precondition.
- **A removed row goes by its id.** DELETE answers 204; sent again it answers 404 and removes nothing else.
- **No write recreates what is gone, and a lost POST is never resent blind.** A PUT to a deleted row answers 404 and
  makes no row; a POST of the same body again makes a second row under a new id, which is why the journal reads an
  unknown row create (any row the ledger does not know) and never resends it by equal values.
- **An HQ-side edit between two requests shows on the row's detail**, the read the executor makes of an exact id
  before it settles or writes.
- **The worker is served Nova's own fixture of the rows**: HQ's ``ItemListsProvider`` serves the table after every
  write as Nova's emitter builds the same rows (spaces at a value's ends kept, an empty occurrence with its
  property, an empty list of occurrences and the hall gone), element for element, ``user_id`` aside.

The plausible failures: HQ trimming or folding a value the workbook would, a row PUT that drops the row's rank or
details, a DELETE or PUT that touches a row of another id, and a create that names an id the executor would then
trust over its tag.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from lxml import etree

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

# The lookup resources answer only a project space whose plan grants API access (`HqBaseResource`).
CONFIGURATION = Configuration(privileges={"LOOKUP_TABLES", "API_ACCESS"})
REQUESTS = json.loads((Path(__file__).parent / "fixtures" / "lookup-json-requests.json").read_text(encoding="utf-8"))
TABLES = "/a/{domain}/api/lookup_table/v1/"
ROWS = "/a/{domain}/api/lookup_table_item/v2/"


def _shape(element):
    """An element as a reader of a fixture reads it: its tag, its attributes, its text, and its children in order;
    ``user_id`` aside, which HQ writes per worker."""
    attributes = {key: value for key, value in element.attrib.items() if key != "user_id"}
    return (element.tag, sorted(attributes.items()), element.text or "", [_shape(child) for child in element])


def _for_table(body, table_id):
    """A row body of the fixture, naming the table HQ made."""
    found = copy.deepcopy(body)
    assert found["data_type_id"] == REQUESTS["tableId"]
    found["data_type_id"] = table_id
    return found


def _rows(state, table_id):
    """HQ's rows of the table, by rank: each ``(id, rank, fields, details)`` as its model holds them."""
    from corehq.apps.fixtures.models import LookupTableRow

    return [
        (
            row.id.hex,
            row.sort_key,
            {name: [(value.value, dict(value.properties)) for value in values] for name, values in row.fields.items()},
            dict(row.item_attributes),
        )
        for row in LookupTableRow.objects.filter(domain=state.domain, table_id=table_id).order_by("sort_key", "id")
    ]


def test_novas_json_requests_put_a_types_table_there_row_by_row(hq):
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow

    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits
    from proof.observe.casedata import served_fixtures

    with hq_check(CONFIGURATION) as (state, _), hq_redis.shared(None), state.committing(), api_rate_limits(state):
        publisher = operations.seed_api_user(state, "lookup-json@example.org", edit_data=True)
        tables, rows = TABLES.format(domain=state.domain), ROWS.format(domain=state.domain)

        def send(method, path, body=None):
            return operations.api_request(
                state,
                method,
                path,
                credential=publisher,
                body=b"" if body is None else json.dumps(body).encode("utf-8"),
            )

        # The create names no id: the table is found by its tag, which HQ holds once.
        created = send("POST", tables, REQUESTS["create"])
        assert created.status == 201 and created.body == "", created.retained()
        (table,) = LookupTable.objects.filter(domain=state.domain, tag="types")
        table_id = table.id.hex
        assert table.is_global
        assert [(field.field_name, list(field.properties)) for field in table.fields] == [
            ("name", []),
            ("alias", ["lang"]),
        ]
        assert list(table.item_attributes) == ["code"]
        # A second create at the tag writes nothing: HQ refuses a tag it holds.
        assert send("POST", tables, REQUESTS["create"]).status == 400
        assert LookupTable.objects.filter(domain=state.domain, tag="types").count() == 1

        # Each append answers its minted id and HQ's own rank.
        ids = []
        for index, body in enumerate(REQUESTS["appends"]):
            sent = _for_table(body, table_id)
            sent["sort_key"] = 100 + index  # a rank the body names is not the one HQ gives
            answer = send("POST", rows, sent)
            assert answer.status == 201, answer.retained()
            saved = json.loads(answer.body)
            assert saved["data_type_id"].replace("-", "") == table_id
            assert saved["sort_key"] == index
            ids.append(saved["id"].replace("-", ""))
        clinic, ward, hall = ids
        held = _rows(state, table_id)
        assert [row[0] for row in held] == ids
        # Every value exactly as sent: the spaces at a value's ends, an empty occurrence with its property, an empty
        # list of occurrences, and no key for a repeated field the row does not hold.
        assert held[0][2] == {"name": [("  Clinic  ", {})], "alias": [("", {"lang": "en"}), ("dispensaire", {})]}
        assert held[0][3] == {"code": " 007 "}
        assert held[1][2] == {"name": [("Ward", {})], "alias": []}
        assert held[2][2] == {"name": [("Hall", {})]}

        # A changed row keeps its id and its rank; the same PUT again lands once.
        change = _for_table(REQUESTS["change"]["body"], table_id)
        for _ in range(2):
            answer = send("PUT", f"{rows}{ids[REQUESTS['change']['row']]}/", change)
            assert answer.status in (200, 204), answer.retained()
        # The clinic moved after the others by a PUT of its whole row.
        move = _for_table(REQUESTS["move"]["body"], table_id)
        answer = send("PUT", f"{rows}{ids[REQUESTS['move']['row']]}/", move)
        assert answer.status in (200, 204), answer.retained()
        # The hall removed by its id; sent again, it answers 404 and removes nothing else.
        # ``obj_delete`` returns its ``HttpAccepted`` rather than raising it, so tastypie's ``delete_detail``
        # answers 204.
        assert send("DELETE", f"{rows}{ids[REQUESTS['remove']['row']]}/").status == 204
        assert send("DELETE", f"{rows}{hall}/").status == 404
        held = _rows(state, table_id)
        assert [(row[0], row[1]) for row in held] == [(ward, 1), (clinic, 3)]
        assert held[0][2]["name"] == [("Ward 2", {})]
        assert held[1][3] == {"code": " 007 "}

        # No write recreates what is gone: a PUT to the removed row answers 404 and makes no row.
        gone = _for_table(REQUESTS["appends"][2], table_id)
        assert send("PUT", f"{rows}{hall}/", gone).status == 404
        assert not LookupTableRow.objects.filter(id=hall).exists()

        # The worker is served Nova's own fixture of the rows.
        (written,) = served_fixtures(state)
        assert _shape(etree.fromstring(written)) == _shape(etree.fromstring(REQUESTS["served"]))

        # An edit in HQ between two requests shows on the row's detail, the exact read the executor makes.
        row = LookupTableRow.objects.get(id=ward)
        row.item_attributes = {"code": "edited in HQ"}
        row.save()
        detail = send("GET", f"{rows}{ward}/")
        assert detail.status == 200, detail.retained()
        assert json.loads(detail.body)["item_attributes"] == {"code": "edited in HQ"}

        # A lost POST resent blind would make a second row under a new id: the journal never does it.
        again = send("POST", rows, _for_table(REQUESTS["appends"][1], table_id))
        assert again.status == 201
        assert json.loads(again.body)["id"].replace("-", "") not in ids
        assert LookupTableRow.objects.filter(domain=state.domain, table_id=table_id).count() == 3


def test_native_json_keeps_a_segmented_value_beyond_the_workbook_cell_limit(hq):
    from corehq.apps.fixtures.models import LookupTable
    from django.conf import settings

    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits
    from proof.observe.casedata import served_fixtures

    value = " " + "🌱" * 17_000 + ' "'
    assert len(value.encode("utf-8")) > 64 * 1024
    assert len(value.encode("utf-16-le")) // 2 > 32767

    with hq_check(CONFIGURATION) as (state, _), hq_redis.shared(None), state.committing(), api_rate_limits(state):
        publisher = operations.seed_api_user(state, "paged-lookup@example.org", edit_data=True)

        def send(method, path, body=None):
            return operations.api_request(
                state,
                method,
                path.format(domain=state.domain),
                credential=publisher,
                body=b"" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8"),
            )

        assert send("POST", TABLES, REQUESTS["create"]).status == 201
        table = LookupTable.objects.get(domain=state.domain, tag="types")
        for text in ("Clinic", value):
            body = _for_table(REQUESTS["appends"][0], table.id.hex)
            body["fields"]["name"]["field_list"][0]["field_value"] = text
            saved = send("POST", ROWS, body)
            assert saved.status == 201, saved.retained()
            row_id = json.loads(saved.body)["id"].replace("-", "")
            detail = send("GET", ROWS + row_id + "/")
            assert detail.status == 200, detail.retained()
            assert json.loads(detail.body)["fields"]["name"]["field_list"][0]["field_value"] == text

        (fixture,) = served_fixtures(state)
        values = etree.fromstring(fixture).xpath("./types_list/types/name/text()")
        assert values == ["Clinic", value]

        # The pinned HQ settings disable Django's default JSON body ceiling.
        # The row resource accepts and keeps a body larger than that default.
        assert settings.DATA_UPLOAD_MAX_MEMORY_SIZE is None
        body = _for_table(REQUESTS["appends"][0], table.id.hex)
        field = body["fields"]["name"]["field_list"][0]
        field["field_value"] = ""
        envelope = len(json.dumps(body, ensure_ascii=False).encode("utf-8"))
        field["field_value"] = "x" * (2_621_441 - envelope)
        assert send("POST", ROWS, body).status == 201
        assert _rows(state, table.id.hex)[-1][2]["name"] == [(field["field_value"], {})]


def test_manual_json_install_then_native_app_import_reads_exact_lookup_value(hq, core_runner, documents, tmp_path):
    """A fresh destination keeps the JSON-installed data through manual app import and native runtime."""
    import base64
    from dataclasses import replace
    from zipfile import ZipFile

    from corehq.apps.app_manager.dbaccessors import get_brief_apps_in_domain
    from corehq.apps.fixtures.models import LookupTable

    from proof.formplayer.test_shared_lookup_journey import _manual_import
    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits
    from proof.hq.test_indexed_lookup import _compiled_app
    from proof.hq.test_lookup_upload import workbook
    from proof.observe import casedata
    from proof.observe.sessions import admitted

    document = documents["hq-lookup-types"]
    with ZipFile(document.import_file) as archive:
        app_path, = [path for path in archive.namelist() if path.endswith(".json")]
        manual_app = archive.read(app_path)

    # HQ JSON and JavaRosa can both carry this value past the workbook ceiling.
    value = "s" * 65_535
    configuration = replace(
        document.exports["minimum"].configuration.hq(),
        domain="manual-lookup-json",
        privileges=CONFIGURATION.privileges | {"CLOUDCARE"},
    )
    worker = casedata.CaseDatabase(casedata.USER_ID, "manual-lookup-worker", (), ())
    with hq_check(configuration) as (state, record), hq_redis.shared(None), state.committing(), api_rate_limits(state):
        assert not LookupTable.objects.filter(domain=state.domain).exists()
        editor = operations.seed_api_user(state, "manual-lookup-editor@example.org", edit_data=True)

        def send(method, endpoint, body):
            result = operations.api_request(
                state, method, endpoint.format(domain=state.domain), credential=editor,
                body=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            )
            assert result.status == 201, result.retained()
            return result

        fields = ("id", "name", "description")
        send("POST", TABLES, {
            "tag": "types",
            "is_global": True,
            "fields": [{"field_name": field, "properties": []} for field in fields],
            "item_attributes": [],
        })
        table = LookupTable.objects.get(domain=state.domain, tag="types")
        for rank, row in enumerate([("first", "First visit", "Meet the family"), ("follow_up", "Follow-up", value)]):
            send("POST", ROWS, {
                "data_type_id": table.id.hex,
                "fields": {
                    field: {"field_list": [{"field_value": text, "properties": {}}]}
                    for field, text in zip(fields, row, strict=True)
                },
                "item_attributes": {},
                "sort_key": rank,
            })
        before = _rows(state, table.id.hex)
        assert before[1][2]["description"] == [(value, {})]

        # The existing workbook remains an independent carrier in this package.
        ordinary = workbook([
            ("types", ("Delete(Y/N)", "table_id", "is_global?", "field 1", "field 2"),
             [("N", "sites", "yes", "id", "name")]),
            ("sites", ("UID", "Delete(Y/N)", "field: id", "field: name"),
             [(None, "N", "home", "At home")]),
        ])
        result = operations.upload_lookup_workbook(state, ordinary, replace=False)
        assert result.errors == [], result.errors
        assert not list(get_brief_apps_in_domain(state.domain))
        imported = _manual_import(state, manual_app)
        assert {app.get_id for app in get_brief_apps_in_domain(state.domain)} == {imported.get_id}
        assert _rows(state, table.id.hex) == before
        app, xmlns = _compiled_app(state, record, imported.get_id, tmp_path / "manual")
        restored = casedata.restore(worker, state.domain, casedata.served_fixtures(state, worker.user_id))

    with admitted(core_runner, app) as install:
        assert install["admitted"], install["problems"]
        observed = core_runner.evaluate(
            app=install["app"],
            xmlns=xmlns,
            locale="en",
            restoreBase64=base64.b64encode(restored).decode(),
            answers=[{"path": "/data/visit_type", "value": "2"}, {"path": "/data/site", "value": "1"}],
            expressions=["/data/visit_type", "/data/site", "/data/visit_description"],
        )
        assert [answer["result"] for answer in observed["answers"]] == ["ok", "ok"], observed
        visit_type, site, description = [item["value"] for item in observed["values"]]
        assert (visit_type, site) == ("follow_up", "home")
        assert len(description) == len(value) and description == value


def test_native_read_checks_lookup_edit_permission_and_the_api_keys_role(hq):
    """Nova's defensive authorization read must prove the role and scoped key can edit data."""
    from django.contrib.auth.models import User
    from corehq.apps.users.models import HQApiKey, HqPermissions
    from corehq.apps.users.models_role import UserRole

    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits

    with hq_check(CONFIGURATION) as (state, _), hq_redis.shared(None), state.committing(), api_rate_limits(state):
        allowed = operations.seed_api_user(state, "lookup-editor@example.org", edit_apps=False, edit_data=True)
        denied = operations.seed_api_user(state, "app-editor@example.org", edit_apps=True, edit_data=False)
        no_data = UserRole.create(
            state.domain, "API read only", permissions=HqPermissions(access_api=True, edit_data=False)
        )
        limited = HQApiKey.objects.create(
            user=User.objects.get(username=allowed.username),
            name="lookup proof role scope",
            is_active=True,
            domain=state.domain,
            role_id=no_data.get_id,
        )
        narrowed = operations.ApiCredential(allowed.username, limited.plaintext_key)
        url = f"/a/{state.domain}/api/device-log/v1/?limit=1&device_id=00000000000000000000000000000000"
        approved = operations.api_request(state, "GET", url, credential=allowed)
        assert approved.status == 200, approved.retained()
        assert json.loads(approved.body)["objects"] == []
        for credential in (denied, narrowed):
            refused = operations.api_request(state, "GET", url, credential=credential)
            assert refused.status in (401, 403), refused.retained()
