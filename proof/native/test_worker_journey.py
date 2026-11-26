"""One released app, three real HQ workers, and an assigned rich fixture."""

from contextlib import contextmanager
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
STAMP = "2025-02-01T12:00:00.000Z"
RESTORE = "{http://openrosa.org/http/response}"


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


def _fixture_rows(root, worker_id):
    (fixture,) = [node for node in root.iter() if node.get("id") == "item-list:clinics"]
    assert fixture.get("user_id") == worker_id, fixture.attrib
    (table,) = fixture
    assert table.tag == f"{RESTORE}clinics_list"
    return list(table)


def _restored_rows(restore, remote_ids, worker_id):
    rows = _fixture_rows(ElementTree.fromstring(restore), worker_id)
    for row in rows:
        assert row.tag == f"{RESTORE}clinics", row.tag
        assert set(row.attrib) == {"code"}, row.attrib
        assert all(field.tag == f"{RESTORE}name" and set(field.attrib) == {"lang"} for field in row)
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


def _asset_bytes(unit, app_id, paths, credential):
    app = operations.held_app(unit, app_id)
    for path in set(paths.values()):
        mapped = app.multimedia_map[f"jr://file/{path}"]
        answer = operations.media_file_read(unit, mapped.url, credential)
        assert answer.status == 200, (path, answer.status)
        assert sha256(answer.data).hexdigest() == path.rsplit("/", 1)[-1].removesuffix(".png")


def _read_from_hq(unit, app_id, credential, label, english, french, previous=None):
    authoring = SimpleNamespace(
        state=unit,
        step=lambda name, seed: unit.operation(f"worker-journey:{label}:{name}", seed),
    )
    answers = retain.app_reads(authoring, app_id, credential)
    project, media = retain.project_data_reads(authoring, app_id, credential)
    base = SimpleNamespace(id="worker-journey", declaration=None, owner_rule_choices={})
    key = retain.hold_key(
        ["field", {"$xmlns": [0, 1]}, ["clinic"]], json.loads(answers["source"].body),
    )
    english_slot = "/label_media/image"
    french_slot = "/label_media/mediaByLanguage/fra/image"
    options_slot = "/optionsSource"
    expected = {
        english_slot: retain.hold_value({"$projectFile": english}, base.id, media),
        french_slot: retain.hold_value({"$projectFile": french}, base.id, media),
    }
    request = {
        "id": label,
        "mode": "first-read",
        "input": retain.reading_input(answers, project, media, base, claims="counts"),
        "holds": [
            *({"key": key, "pointer": path, "value": expected.get(path)}
              for path in (english_slot, french_slot, options_slot)),
            {"key": "app", "pointer": "", "value": None},
        ],
    }
    if previous is not None:
        request.update(expected=previous, reviewChanges=True)
    (answer,) = retain.run_bundle([request])
    assert answer["kind"] == "read", answer
    assert all(item["named"] for item in answer["held"]), answer
    held = {item["pointer"]: item["found"] for item in answer["held"]}
    assert {path: held[path] for path in expected} == expected, answer
    return held[""], held[options_slot], answer.get("review")


def _edit_and_read_form_translation(unit, app_id, paths, credential, evidence):
    english = f"jr://file/{paths['formEnglish']}"
    old = f"jr://file/{paths['formFrench']}"
    new = f"jr://file/{paths['menuFrench']}"
    original, original_options, _ = _read_from_hq(unit, app_id, credential, "before", english, old)
    assert original_options["kind"] == "lookup"

    source = operations.held_app(unit, app_id).get_module(0).get_form(1).source
    assert source.count(old) == 1
    with unit.operation("worker-journey:edit-french", new.encode()):
        hqside.questions(unit, app_id, {"module": 0, "form": 1, "xform": source.replace(old, new)})
    edited, edited_options, review = _read_from_hq(unit, app_id, credential, "after", english, new, original)
    assert original_options == edited_options
    assert review["kind"] == "changes", review
    assert review["target"]["fields"] == edited["fields"]
    evidence("brought-in-label-paths", {"english": english, "frenchBefore": old, "frenchAfter": new})


# Labels are read from the actual HTML widget. Fixture keys and their order are
# independently asserted from HQ's complete restoring response.
_CHECK_CHOICES = {
    "eval": """() => [...document.querySelectorAll('#webforms .q input[type=radio]')]
        .map(input => input.labels[0].textContent.trim())"""
}


def _choose_second_in_browser():
    return [
        {"mark": True},
        *steps.click("#webforms .q input[id$='-choice-1']"),
        {"awaitRequest": {"method": "POST", "pathname": steps.ANSWER}, "sinceMark": True, "unlessMissed": True},
        steps.SETTLE,
        *steps.submit_form(),
    ]


def _submitted_key(submissions):
    (submission,) = submissions
    return ElementTree.fromstring(submission.instance).findtext("{*}clinic")


def _same_label_different_keys(released, browser, bridge, evidence):
    from proof.formplayer import apps
    from proof.formplayer.walk import questions

    (answer,) = browser.answered("answer")
    (submitted,) = browser.answered("submit-all")
    assert int(json.loads(answer.body)["answer"]) == 1
    assert submitted.json()["status"] == "success"
    picked_in_browser = _submitted_key(bridge.submissions)

    # Use the browser's own menu route to open the same form and forward the
    # second ordinal directly. Formplayer has both keys even though the browser
    # sends the first ordinal for either same-named radio button.
    (last_menu,) = [
        exchange for exchange in browser.answered("navigate_menu")
        if exchange.json().get("session_id")
    ]
    with released.run("worker-journey-numbered-choice"):
        client = apps.web(released.runner, released)
        opened = client.navigate(json.loads(last_menu.body)["selections"])
        (clinic,) = questions(opened["tree"])
        assert clinic["choices"] == ["Clinique jumelle", "Clinique jumelle"]
        before = len(released.hq.submissions)
        response = client.submit(opened["session_id"], {clinic["ix"]: "2"})
        assert response["status"] == "success", response
        picked_by_number = _submitted_key(released.hq.submissions[before:])
    evidence("same-label-different-keys", {"browser": picked_in_browser, "formplayerOrdinal2": picked_by_number})
    assert (picked_in_browser, picked_by_number) == ("east-one", "east-two")


@pytest.fixture
def evidence(native, request):
    directory = native.out / "worker-journey-reads" / request.node.name
    directory.mkdir(parents=True, exist_ok=True)

    def keep(name, record):
        (directory / f"{name}.json").write_text(json.dumps(record, indent=2), encoding="utf-8")

    return keep


@contextmanager
def _journey(native, runner=None):
    from corehq.apps.users.models import CommCareUser
    from corehq.apps.users.util import normalize_username

    family = native.family("worker-journey")
    paths = json.loads((family / "media.json").read_text())
    _generic_archive((family / "archive.ccz").read_bytes())
    config = Configuration(privileges={"CLOUDCARE", "LOOKUP_TABLES"})
    with hq_redis.shared(None if runner is None else runner.redis_address), hq_check(config) as (unit, _):
        first_db = _database("worker-east", "case-east", "East patient")
        with unit.committing():
            published = operations.apply_upload(unit, _file_upload(
                "app.json", "app_file", (family / "app.json").read_bytes(), "application/json",
                app_name="Clinic rounds",
            ))
            assert published.status == 201 and published.response.get("success"), published
            app_id = published.response["app_id"]
            uploaded = operations.apply_media_upload(unit, app_id, _file_upload(
                "media.zip", "bulk_upload_file", (family / "media.zip").read_bytes(), "application/zip",
            ))
            assert uploaded.status == 200 and uploaded.processing, uploaded
            credential = operations.seed_api_key(unit, unit.web_user.username, domain=unit.domain)
            _asset_bytes(unit, app_id, paths, credential)

        with formplayer_hq.serve(
            unit, None, app_id, runner=runner, database=first_db,
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

            workers = (
                (released.worker, "en", "case-east", ROWS[:2], "English"),
                (second, "fr", "case-west", ROWS[2:], "French"),
                (third, "en", "case-unassigned", (), "English"),
            )

            yield released, paths, remote_ids, workers, credential


@pytest.mark.reader("webapps")
def test_two_grid_languages_use_only_each_workers_own_rich_fixture(
    native, hq, core_runner, formplayer_runner, editor_driver, evidence,
):
    with _journey(native, formplayer_runner) as (released, paths, remote_ids, workers, credential):
        unit = released.unit
        for worker, language, case, expected, caption in workers:
            bridge = FullRestores(unit, worker.username)
            profile = replace(released, worker=worker, hq=bridge)
            actions = [
                *steps.open_app("Clinic rounds"),
                *steps.choose("Rounds"), steps.SCREEN,
                *steps.choose("Visit"), *steps.select_case(case),
                steps.SCREEN, _CHECK_CHOICES,
            ]
            choices_step = len(actions) - 1
            if case == "case-east":
                actions.extend(_choose_second_in_browser())
            run = Session(profile, editor_driver).run(
                actions, name=f"worker-journey-{case}", worker_language=language,
            )
            evidence(case, run.screens)
            assert run.page_errors == []
            assert bridge.full, "Formplayer did not request a full HQ restore"
            assert [_restored_rows(body, remote_ids, worker.user_id) for body in bridge.full] == [
                list(expected)
            ] * len(bridge.full)
            menu, form = run.screens
            assert menu["menuLayout"] == "grid"
            (people,) = [command for command in menu["commands"] if command["text"] == "People"]
            assert paths[f"menu{caption}"].rsplit("/", 1)[-1] in (people["image"] or ""), people
            if not expected:
                assert not form.get("form"), form
                (error,) = [
                    exchange.json() for exchange in run.answered("navigate_menu")
                    if exchange.json().get("status") == "error"
                ]
                assert "clinics" in error["exception"] and "lookup table" in error["exception"], error
                continue
            (question,) = form["form"]["questions"]
            (image,) = [item["src"] for item in question["media"] if item["kind"] == "img"]
            assert paths[f"form{caption}"].rsplit("/", 1)[-1] in image
            assert run.value(choices_step) == [occurrences[1][1] for _, occurrences in expected]
            if case == "case-east":
                _same_label_different_keys(released, run, bridge, evidence)

        with unit.committing():
            _edit_and_read_form_translation(unit, released.app_id, paths, credential, evidence)


def _descendants(view):
    yield view
    for child in view.get("children", ()):
        yield from _descendants(child)


@pytest.mark.reader("android")
def test_android_grid_uses_each_workers_assigned_choices_and_installed_language_media(native, hq, core_runner, evidence):
    from proof.android import observe
    from proof.observe.record import Blobs

    labels = {occurrences[1][1] for _, occurrences in ROWS}
    with _journey(native) as (released, paths, _remote_ids, workers, _credential):
        archive = observe.release_archive(released)
        with ZipFile(BytesIO(archive)) as downloaded:
            for path in set(paths.values()):
                assert sha256(downloaded.read(path)).hexdigest() == path.rsplit("/", 1)[-1].removesuffix(".png")

        for worker, language, case, expected, caption in workers:
            blobs = Blobs()
            result = observe.app(
                replace(released, worker=worker),
                blobs,
                label=f"A:worker-journey-{case}",
                archive=archive,
                delivered=True,
                views=True,
            )
            answer = blobs.get_json(result["answer"])
            assert answer["install"] == "Installed", answer
            exchanges = blobs.get_json(result["hq"])
            assert any(
                exchange["url_name"] == "ota_restore"
                and exchange["status"] == 200
                and not parse_qs(exchange["url"].partition("?")[2]).get("since")
                and not exchange.get("unread")
                for exchange in exchanges
            ), exchanges
            walks = {
                name: walk for name, walk in answer["walks"].items()
                if (f"@language:{language}" in name if language != "en" else "@language:" not in name)
            }
            walked = [step for walk in walks.values() for step in walk.get("steps", ())]
            rendered = [
                item["image"]
                for step in walked for item in (step.get("menu") or {}).get("items", ())
                if item["id"] == "m0-case-list"
            ]
            assert rendered and all(
                image and image["held"] is True and image["uri"].endswith(paths[f"menu{caption}"])
                for image in rendered
            ), rendered
            screens = [
                screen for step in walked for screen in (step.get("form") or {}).get("screens", ())
                if any(question["reference"] == "/data/clinic[1]" for question in screen["questions"])
            ]
            if not expected:
                evidence(case, walks)
                report = json.dumps(walks)
                assert not screens and "clinics" in report and "lookup table" in report, walks
                continue
            evidence(case, screens)
            assert screens, answer["walks"].keys()
            for screen in screens:
                views = list(_descendants(screen["view"]))
                assert [view["text"] for view in views if view.get("text") in labels] == [
                    occurrences[1][1] for _, occurrences in expected
                ]
                pixels = [
                    descendant["centerPixel"]
                    for view in views if view.get("class") == "MediaLayout"
                    for descendant in _descendants(view) if "centerPixel" in descendant
                ]
                (pixel,) = pixels
                red, green, blue = bytes.fromhex(pixel[3:])
                if language == "fr":
                    assert green > max(red, blue), pixel
                else:
                    assert blue > max(red, green), pixel
