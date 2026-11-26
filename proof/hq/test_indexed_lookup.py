"""Native HQ storage, restore, and Core evaluation of Nova's typed indexed lookup."""

import base64
import json
from xml.etree import ElementTree

from proof.hq import operations
from proof.hq import redis as hq_redis
from proof.hq.check import hq_check
from proof.hq.seams import api_rate_limits, build_seams
from proof.hq.test_lookup_upload import _held
from proof.observe import casedata, publish
from proof.observe.build import build_state

DOCUMENT = "targeted-indexed-lookup"


def _compiled_form(state, record, app_id):
    with build_seams():
        built, _ = build_state(operations.held_app(state, app_id), record, "indexed-table")
    assert not built.errors and not built.raised, (built.errors, built.raised)
    assert built.files is not None
    return built.files["modules-0/forms-0.xml"]


def test_indexed_lookup_survives_publish_and_native_worker_search(hq, core_runner, documents):
    export = documents[DOCUMENT].exports["minimum"]
    workbook = export.content.lookups
    assert workbook is not None
    worker = casedata.CaseDatabase(casedata.USER_ID, "indexed-proof-worker", (), ())

    with (
        hq_check(export.configuration.hq()) as (state, record),
        hq_redis.shared(None),
        state.committing(),
        api_rate_limits(state),
    ):
        app_id, _ = operations.publish(state, [export.create.upload()])
        member = operations.seed_api_user(state, "member-indexed@example.org", edit_data=True)

        def upload_tables():
            answer = operations.api_request(
                state,
                "POST",
                f"/a/{state.domain}/fixtures/fixapi/",
                credential=member,
                body=workbook.upload().body,
                content_type=workbook.content_type,
            )
            assert answer.status == 200
            verdict = json.loads(answer.body)
            assert verdict["code"] == 200, verdict

        upload_tables()
        held = _held(state)
        assert list(held) == ["service_sites"]
        assert held["service_sites"]["is_global"] is True
        assert held["service_sites"]["indexed"] == [True, False]
        assert len(held["service_sites"]["rows"]) == 2

        upload_tables()
        assert _held(state) == held, "Republishing identical rows must preserve HQ table and row identities"
        filled = operations.apply_upload(state, operations.with_app_id(export.content.upload(), app_id))
        assert filled.status == 200, filled.response
        form = _compiled_form(state, record, app_id)

        (native_items,) = casedata.served_fixtures(state, worker.user_id)
        items = ElementTree.fromstring(b"<items>" + native_items + b"</items>")
        assert [item.tag for item in items] == ["schema", "fixture"], native_items
        restored = casedata.restore(worker, state.domain, [native_items])

    for key, name in (("west", "West clinic"), ("east", "East clinic"), ("absent", "")):
        report = core_runner.evaluate(
            formBase64=base64.b64encode(form).decode(),
            restoreBase64=base64.b64encode(restored).decode(),
            answers=[{"path": "/data/site_code", "value": key}],
            expressions=["/data/site_name"],
        )
        assert report["answers"][0]["result"] == "ok", report
        assert report["values"][0]["value"] == name, report


def test_republishing_the_hq_authored_app_preserves_its_indexed_village_filter(hq, core_runner, documents):
    document = documents["hq-lookups"]
    export = document.exports["minimum"]
    worker = casedata.CaseDatabase(casedata.USER_ID, "village-proof-worker", (), ())

    with hq_check(export.configuration.hq()) as (state, record):
        app_id, refusal, uploaded = publish.create_authored(state, document)
        assert refusal is None and uploaded is None
        before = _held(state)
        assert before["villages"]["indexed"] == [False, False, True]
        assert len(before["villages"]["rows"]) == 3
        assert export.republish is not None
        assert export.republish.lookups is None, "The HQ-owned table must stay in its project space"
        refusal, uploaded = publish.update(state, app_id, export.republish, "B")
        assert refusal is None and uploaded is None
        assert _held(state) == before

        form = _compiled_form(state, record, app_id)
        restored = casedata.restore(worker, state.domain, casedata.served_fixtures(state, worker.user_id))

    for district, village, available in (("1", "v2", ["v1", "v2"]), ("2", "v3", ["v3"])):
        result = core_runner.evaluate(
            formBase64=base64.b64encode(form).decode(),
            restoreBase64=base64.b64encode(restored).decode(),
            answers=[
                {"path": "/data/district", "value": district},
                {"path": "/data/village", "value": str(len(available))},
            ],
            expressions=["/data/village"],
        )
        assert [answer["result"] for answer in result["answers"]] == ["ok", "ok"], result
        assert [choice["value"] for choice in result["answers"][1]["choices"]] == available, result
        assert result["values"][0]["value"] == village, result
