"""The same native lookup choices survive an adopted app edit and a manual installation."""

from dataclasses import replace
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

from lxml import etree

from proof.formplayer import apps, hq as formplayer
from proof.formplayer.walk import questions
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.test_lookup_upload import workbook
from proof.observe import casedata, publish

DOCUMENT = "hq-shared-table-journey"
TAG = "visit_sites"
CHOICES = ["Hill clinic", "River clinic"]


def _table(unit):
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow

    table = LookupTable.objects.get(domain=unit.domain, tag=TAG)
    rows = [
        (row.id, row.fields["code"][0].value, row.fields["name"][0].value)
        for row in LookupTableRow.objects.iter_rows(unit.domain, table_id=table.id)
    ]
    return table, rows


def _identities(app):
    menu, = app.get_modules()
    form, = menu.forms
    return menu.unique_id, form.unique_id, form.xmlns


def _observe(unit, app_id, runner, label):
    database = casedata.CaseDatabase(
        user_id=casedata.USER_ID, username=casedata.USERNAME, user_data=(), cases=()
    )
    observed = {}
    with formplayer.serve(unit, None, app_id, runner=runner, database=database, label=label) as served:
        for language, caption in (("en", "Clinic"), ("fra", "Clinique")):
            with served.run(f"{label}-{language}"):
                web = apps.web(runner, served, locale=language)
                opened = web.navigate(["0", "0"])
                site, = [node for node in questions(opened["tree"]) if node.get("binding") == "/data/site"]
                assert site["caption"] == caption, site
                assert site["choices"] == CHOICES, site
                before = len(served.hq.submissions)
                submitted = web.submit(opened["session_id"], {site["ix"]: "1"})
                assert submitted["status"] == "success", submitted
                received, = served.hq.submissions[before:]
                data = etree.fromstring(received.instance)
                assert data.findtext("{*}site") == "north"
                observed[language] = {"choices": site["choices"], "caption": caption, "xmlns": etree.QName(data).namespace}
    return observed



def _manual_import(unit, app_file):
    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart
    from django.urls import resolve, reverse

    from proof.hq import requests

    path = reverse("import_app_steps", args=[unit.domain])
    upload = encode_multipart(BOUNDARY, {
        "app_name": "Clinic visits",
        "app_file": SimpleUploadedFile("visits.json", app_file, content_type="application/json"),
        "source_server": "india",
        "source_domain": "x",
        "app_id": "0" * 32,
    })
    request = requests.raw_post(unit, path, upload, MULTIPART_CONTENT)
    request.META.update(HTTP_HQ_HX_ACTION="import_app", HTTP_HX_REQUEST="true")
    view = resolve(path)
    response = view.func(request, *view.args, **view.kwargs)
    assert response.status_code == 200 and response.has_header("HX-Push-Url"), response
    app_id, = parse_qs(urlsplit(response["HX-Push-Url"]).query)["new_app_id"]
    return operations.held_app(unit, app_id)


def test_workers_use_the_shared_table_after_an_adopted_publish_and_manual_setup(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    from corehq.apps.app_manager.models import import_app_from_doc
    from corehq.apps.fixtures.download import _prepare_fixture
    from corehq.apps.fixtures.models import LookupTable

    document = formplayer_documents[DOCUMENT]
    configuration = document.exports["minimum"].configuration.hq()
    with hq_check(configuration) as (unit, _):
        with unit.operation("shared-table:source", DOCUMENT.encode()):
            app_id, _, _ = publish.create_authored(unit, document)
            app = operations.held_app(unit, app_id)
            sibling = import_app_from_doc(app.export_json(dump_json=False), unit.domain, {"name": "Outreach visits"})
            original_entities = _identities(app)
            sibling_entities = _identities(sibling)
            original_table, original_rows = _table(unit)
        with unit.operation("shared-table:publish", DOCUMENT.encode()):
            refusal, uploaded = publish.update(
                unit, app_id, document.edit.exports["minimum"].update, "shared-table edit"
            )
            assert refusal is None and uploaded is None, (refusal, uploaded)
            edited = operations.held_app(unit, app_id)
            assert edited.langs == ["fra", "en"]
            assert _identities(edited) == original_entities
            assert _identities(operations.held_app(unit, sibling.get_id)) == sibling_entities
            current_table, current_rows = _table(unit)
            assert current_table.id == original_table.id and current_rows == original_rows
            _, sheets = _prepare_fixture([str(current_table.id)], unit.domain)
            selected_table = workbook([(name, items["headers"], items["rows"]) for name, items in sheets.items()])
        after_publish = _observe(unit, app_id, formplayer_runner, "source")
        assert {entry["xmlns"] for entry in after_publish.values()} == {original_entities[2]}

    with ZipFile(document.import_file) as archive:
        guide = archive.read("README.txt").decode()
        assert "uses the existing table in nova-proof" in guide and "selected-table export" in guide
        app_member, = [name for name in archive.namelist() if name.endswith(".json")]
        manual_app = archive.read(app_member)
        assert not any(name.endswith(".xlsx") for name in archive.namelist())

    with hq_check(replace(configuration, domain="second-clinic")) as (unit, _):
        with unit.operation("shared-table:manual-setup", DOCUMENT.encode()):
            assert not LookupTable.objects.filter(domain=unit.domain, tag=TAG).exists()
            result = operations.upload_lookup_workbook(unit, selected_table, replace=False)
            assert result.errors == []
            target_table, target_rows = _table(unit)
            assert target_table.id != original_table.id
            assert [(code, label) for _, code, label in target_rows] == [
                (code, label) for _, code, label in original_rows
            ]
            imported = _manual_import(unit, manual_app)
        after_manual = _observe(unit, imported.get_id, formplayer_runner, "manual")
        assert imported.get_id != app_id
        assert {entry["xmlns"] for entry in after_manual.values()} == {_identities(imported)[2]}
    evidence("shared-table-workers", {"direct": after_publish, "manual": after_manual})
