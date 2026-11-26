"""Native HQ storage, restore, and Core evaluation of Nova's typed indexed lookup."""

import base64
import json
from xml.etree import ElementTree

from proof.hq import operations
from proof.hq import redis as hq_redis
from proof.hq.check import hq_check
from proof.hq.seams import api_rate_limits
from proof.hq.test_lookup_upload import _held
from proof.observe import casedata

DOCUMENT = "targeted-indexed-lookup"


def test_indexed_lookup_survives_publish_and_native_worker_search(
    hq, core_runner, documents
):
    export = documents[DOCUMENT].exports["minimum"]
    workbook = export.content.lookups
    assert workbook is not None
    worker = casedata.CaseDatabase(casedata.USER_ID, "indexed-proof-worker", (), ())

    with (
        hq_check(export.configuration.hq()) as (state, _),
        hq_redis.shared(None),
        state.committing(),
        api_rate_limits(state),
    ):
        app_id, _ = operations.publish(state, [export.create.upload()])
        member = operations.seed_api_user(
            state, "member-indexed@example.org", edit_data=True
        )

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
        assert _held(state) == held, (
            "Republishing identical rows must preserve HQ table and row identities"
        )
        filled = operations.apply_upload(
            state, operations.with_app_id(export.content.upload(), app_id)
        )
        assert filled.status == 200, filled.response
        form = operations.held_app(state, app_id).get_module(0).get_form(0).source

        (native_items,) = casedata.served_fixtures(state, worker.user_id)
        items = ElementTree.fromstring(b"<items>" + native_items + b"</items>")
        assert [item.tag for item in items] == ["schema", "fixture"], native_items
        restored = casedata.restore(worker, state.domain, [native_items])

    for key, name in (("west", "West clinic"), ("east", "East clinic"), ("absent", "")):
        report = core_runner.evaluate(
            formBase64=base64.b64encode(form.encode()).decode(),
            restoreBase64=base64.b64encode(restored).decode(),
            answers=[{"path": "/data/site_code", "value": key}],
            expressions=["/data/site_name"],
        )
        assert report["answers"][0]["result"] == "ok", report
        assert report["values"][0]["value"] == name, report
