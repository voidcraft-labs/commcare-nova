"""One released app, three real HQ workers, and an assigned rich fixture."""

from dataclasses import replace
from hashlib import sha256
from io import BytesIO
import json
from types import SimpleNamespace
from urllib.parse import parse_qs
from xml.etree import ElementTree
from zipfile import ZipFile

import pytest

from proof.formplayer import hq as formplayer_hq
from proof.hq import operations, redis as hq_redis
from proof.hq.state import Configuration, hq_check
from proof.matrix import retain
from proof.observe import casedata, hqside
from proof.webapps import steps
from proof.webapps.session import Session

FAMILIES = ("worker-journey",)
ROWS = (
    ("east-one", (("en", "Twin clinic"), ("fr", "Clinique jumelle"))),
    ("east-two", (("en", "Twin clinic"), ("fr", "Clinique jumelle"))),
    ("west-one", (("en", "West clinic"), ("fr", "Clinique ouest"))),
)
STAMP = "2025-02-01T12:00:00Z"


class FullRestores(formplayer_hq.HqViews):
    """Keep the actual OTA answers that Formplayer requested with no sync token."""

    def __init__(self, unit, username):
        super().__init__(unit, username)
        self.full = []

    def __call__(self, request):
        before = len(self.restores)
        answer = super().__call__(request)
        if len(self.restores) > before and not parse_qs(request.query).get("since"):
            self.full.append(answer.body)
        return answer


def _file_upload(name, field, data, content_type, **values):
    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart

    body = encode_multipart(BOUNDARY, {
        **values,
        field: SimpleUploadedFile(name, data, content_type=content_type),
    })
    return operations.Upload(body, MULTIPART_CONTENT)


def _database(worker, case, name):
    return casedata.CaseDatabase(worker, worker, (), (
        casedata.CaseRecord(case, "person", name, worker, STAMP, STAMP, None, ()),
    ))


def _assign(unit, first, second):
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow, LookupTableRowOwner, OwnerType

    operations.save_authored_tables(unit, [{
        "tag": "clinics",
        "is_global": False,
        "fields": [{"name": "name", "properties": ["lang"], "is_indexed": False}],
        "item_attributes": ["code"],
        "rows": [
            {
                "item_attributes": {"code": code},
                "fields": {"name": [
                    {"value": label, "properties": {"lang": language}}
                    for language, label in occurrences
                ]},
            }
            for code, occurrences in ROWS
        ],
    }])
    (table,) = LookupTable.objects.filter(domain=unit.domain, tag="clinics")
    made = list(LookupTableRow.objects.iter_rows(unit.domain, table_id=table.id))
    assert len(made) == len(ROWS)
    for row, owner in zip(made, (first, first, second), strict=True):
        LookupTableRowOwner.objects.create(
            domain=unit.domain, row_id=row.id, owner_type=OwnerType.User, owner_id=owner.user_id,
        )
    return {str(row.id) for row in made}


def _fixture_rows(root):
    fixtures = [node for node in root.iter() if node.get("id") == "item-list:clinics"]
    assert len(fixtures) <= 1, fixtures
    return [] if not fixtures else list(fixtures[0].findall("./clinics_list/clinics"))


def _restored_rows(restore, remote_ids):
    rows = _fixture_rows(ElementTree.fromstring(restore))
    for row in rows:
        assert set(row.attrib) == {"code"}, row.attrib
        assert all(field.tag == "name" and set(field.attrib) == {"lang"} for field in row)
        assert not any(identifier.encode() in ElementTree.tostring(row) for identifier in remote_ids)
    return [(row.get("code"), tuple((field.get("lang"), field.text) for field in row)) for row in rows]


def _generic_archive(archive_bytes):
    with ZipFile(BytesIO(archive_bytes)) as archive:
        suite = ElementTree.fromstring(archive.read("suite.xml"))
        assert not [node for node in suite.iter() if node.get("id") == "item-list:clinics"]
        assert b"jr://fixture/item-list:clinics" in archive.read("modules-0/forms-1.xml")
        assert not any(
            row[0].encode() in archive.read(name)
            for row in ROWS for name in archive.namelist()
            if name.endswith((".xml", ".txt", ".ccpr"))
        )


def _asset_bytes(unit, app_id, paths):
    app = operations.held_app(unit, app_id)
    credential = operations.seed_api_key(unit, unit.web_user.username, domain=unit.domain)
    for path in set(paths.values()):
        mapped = app.multimedia_map[f"jr://file/{path}"]
        answer = operations.media_file_read(unit, mapped.url, credential)
        assert answer.status == 200, (path, answer.status)
        assert sha256(answer.data).hexdigest() == path.rsplit("/", 1)[-1].removesuffix(".png")


def _read_from_hq(unit, app_id, credential, label):
    authoring = SimpleNamespace(
        state=unit,
        step=lambda name, seed: unit.operation(f"worker-journey:{label}:{name}", seed),
    )
    answers = retain.app_reads(authoring, app_id, credential)
    project, media = retain.project_data_reads(authoring, app_id, credential)
    base = SimpleNamespace(id="worker-journey", declaration=None, owner_rule_choices={})
    (answer,) = retain.run_bundle([{
        "id": label,
        "mode": "first-read",
        "input": retain.reading_input(answers, project, media, base, claims="counts"),
    }])
    assert answer["kind"] == "read", answer
    return answer


def _form_image_paths(read):
    doc = read["doc"]
    module = doc["moduleOrder"][0]
    form = doc["formOrder"][module][1]
    field = doc["fields"][doc["fieldOrder"][form][0]]
    bundle = field["label_media"]
    english = bundle["image"]
    french = bundle["mediaByLanguage"]["fra"]["image"]
    media = {item["assetId"]: item for item in read["media"]["files"]}
    return tuple(
        (media[asset]["paths"], media[asset]["contentHash"])
        for asset in (english, french)
    )


def _edit_and_read_form_translation(unit, app_id, paths, evidence):
    credential = operations.seed_api_key(unit, unit.web_user.username, domain=unit.domain)
    before = _read_from_hq(unit, app_id, credential, "before")
    expected_path = lambda slot: (
        [f"jr://file/{paths[slot]}"], paths[slot].rsplit("/", 1)[-1].removesuffix(".png"),
    )
    assert _form_image_paths(before) == (expected_path("formEnglish"), expected_path("formFrench"))

    form = operations.held_app(unit, app_id).get_module(0).get_form(1)
    source = form.source
    old = f"jr://file/{paths['formFrench']}"
    new = f"jr://file/{paths['menuFrench']}"
    assert source.count(old) == 1
    with unit.operation("worker-journey:edit-french", new.encode()):
        hqside.questions(unit, app_id, {"module": 0, "form": 1, "xform": source.replace(old, new)})
    after = _read_from_hq(unit, app_id, credential, "after")
    evidence("brought-in-label-paths", _form_image_paths(after))
    assert _form_image_paths(after) == (expected_path("formEnglish"), expected_path("menuFrench"))
    assert before["lookup"] == after["lookup"]



# Labels are read from the actual HTML widget. Fixture keys and their order are
# independently asserted from HQ's complete restoring response.
_CHECK_CHOICES = {
    "eval": """() => [...document.querySelectorAll('#webforms .q input[type=radio]')]
        .map(input => input.labels[0].textContent.trim())"""
}


@pytest.mark.reader("webapps")
def test_two_grid_languages_use_only_each_workers_own_rich_fixture(
    native, hq, core_runner, formplayer_runner, editor_driver, evidence,
):
    from corehq.apps.users.models import CommCareUser
    from corehq.apps.users.util import normalize_username

    family = native.family("worker-journey")
    paths = json.loads((family / "media.json").read_text())
    _generic_archive((family / "archive.ccz").read_bytes())
    config = Configuration(privileges={"CLOUDCARE", "LOOKUP_TABLES"})
    with hq_redis.shared(formplayer_runner.redis_address), hq_check(config) as (unit, _):
        first_db = _database("worker-east", "case-east", "East patient")
        with unit.committing():
            published = operations.apply_upload(unit, _file_upload(
                "app.json", "app_file", (family / "app.json").read_bytes(), "application/json",
                app_name="Clinic rounds",
            ))
            assert published.status == 200 and "app_id" in published.response, published
            app_id = published.response["app_id"]
            uploaded = operations.apply_media_upload(unit, app_id, _file_upload(
                "media.zip", "bulk_upload_file", (family / "media.zip").read_bytes(), "application/zip",
            ))
            assert uploaded.status == 200 and uploaded.processing, uploaded
            _asset_bytes(unit, app_id, paths)

        with formplayer_hq.serve(
            unit, None, app_id, runner=formplayer_runner, database=first_db,
        ) as released:
            _generic_archive(released.archive())

            def add_worker(slug, case, name):
                database = _database(f"worker-{slug}", case, name)
                worker = CommCareUser.create(
                    unit.domain, normalize_username(slug, unit.domain), formplayer_hq.PASSWORD,
                    created_by=None, created_via=None, uuid=database.user_id, user_data={},
                )
                formplayer_hq.save_cases(unit, database, worker)
                return worker

            with unit.committing():
                second = add_worker("west", "case-west", "West patient")
                third = add_worker("unassigned", "case-unassigned", "Unassigned patient")
                remote_ids = _assign(unit, released.worker, second)
                if unit.indexes is not None:
                    unit.indexes.settle()

            for worker, language, case, expected, caption in (
                (released.worker, "en", "case-east", ROWS[:2], "English"),
                (second, "fr", "case-west", ROWS[2:], "French"),
                (third, "en", "case-unassigned", (), "English"),
            ):
                bridge = FullRestores(unit, worker.username)
                profile = replace(released, worker=worker, hq=bridge)
                run = Session(profile, editor_driver).run([
                    *steps.open_app("Clinic rounds"),
                    *steps.choose("Rounds"), steps.SCREEN,
                    *steps.choose("Visit"), *steps.select_case(case),
                    steps.SCREEN, _CHECK_CHOICES,
                ], name=f"worker-journey-{case}", worker_language=language)
                evidence(case, run.screens)
                assert run.page_errors == []
                assert bridge.full, "Formplayer did not request a full HQ restore"
                assert [_restored_rows(body, remote_ids) for body in bridge.full] == [list(expected)] * len(bridge.full)
                menu, form = run.screens
                assert menu["menuLayout"] == "grid"
                (people,) = [command for command in menu["commands"] if command["text"] == "People"]
                assert paths[f"menu{caption}"].rsplit("/", 1)[-1] in (people["image"] or ""), people
                (question,) = form["form"]["questions"]
                (image,) = [item["src"] for item in question["media"] if item["kind"] == "img"]
                assert paths[f"form{caption}"].rsplit("/", 1)[-1] in image
                assert run.value(-1) == [occurrences[1][1] for _, occurrences in expected]

            with unit.committing():
                _edit_and_read_form_translation(unit, app_id, paths, evidence)
