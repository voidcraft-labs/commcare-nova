"""Explicit synthetic probe for the native HQ fixture reader at the workbook boundary.

Select this file in proof-slice, or run it directly with:
    node proof/run.mjs --workers 1 proof/hq/manual_probes/test_lookup_json_scale_probe.py
"""

import hashlib
import json
import os
from pathlib import Path
import resource
from time import monotonic

from proof.hq import operations
from proof.hq import redis as hq_redis
from proof.hq.check import hq_check
from proof.hq.seams import api_rate_limits
from proof.hq.test_lookup_json import CONFIGURATION

ROWS = 499_998


def test_native_fixture_pagination_reloads_the_table_at_one_row_past_workbook(hq, monkeypatch):
    from corehq.apps.fixtures.models import Field, LookupTable, LookupTableRow, TypeField

    with hq_check(CONFIGURATION) as (state, _), hq_redis.shared(None), state.committing(), api_rate_limits(state):
        started = monotonic()
        table = LookupTable.objects.create(
            domain=state.domain, tag="large_fixture", is_global=True, fields=[TypeField(name="code")],
        )
        for start in range(0, ROWS, 2_000):
            LookupTableRow.objects.bulk_create([
                LookupTableRow(
                    domain=state.domain, table_id=table.id, sort_key=ordinal,
                    fields={"code": [Field(value=f"{ordinal:06d}")]},
                )
                for ordinal in range(start, min(start + 2_000, ROWS))
            ])
        setup_seconds = monotonic() - started
        editor = operations.seed_api_user(
            state, "lookup-scale-reader@example.org", edit_data=True,
        )
        seen = 0
        native_rows = LookupTableRow.objects.iter_rows

        def count_native_rows(*args, **kwargs):
            nonlocal seen
            for row in native_rows(*args, **kwargs):
                seen += 1
                yield row

        monkeypatch.setattr(LookupTableRow.objects, "iter_rows", count_native_rows)
        source = f"/a/{state.domain}/api/fixture/v1/?fixture_type_id={table.id.hex}"
        rss_before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        started = monotonic()
        first = operations.api_request(state, "GET", source + "&limit=1", credential=editor)
        first_seconds = monotonic() - started
        rss_after_first = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        assert first.status == 200, first.status
        assert len(json.loads(first.body)["objects"]) == 1
        assert seen == ROWS

        seen = 0
        started = monotonic()
        maximum = operations.api_request(state, "GET", source + "&limit=0", credential=editor)
        maximum_seconds = monotonic() - started
        rss_after_maximum = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        assert maximum.status == 200, maximum.status
        assert seen == ROWS
        body = maximum.body.encode("utf-8")
        page = json.loads(body)
        assert len(page["objects"]) == 1_000
        assert page["meta"]["total_count"] == ROWS
        assert page["objects"][0]["fields"]["code"] == "000000"
        assert page["objects"][-1]["fields"]["code"] == "000999"

        seen = 0
        last_offset = ROWS - ROWS % 1_000
        started = monotonic()
        last = operations.api_request(state, "GET", source + f"&limit=1000&offset={last_offset}", credential=editor)
        last_seconds = monotonic() - started
        rss_after_last = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        assert last.status == 200, last.status
        assert seen == ROWS
        last_page = json.loads(last.body)
        assert len(last_page["objects"]) == 998
        assert last_page["meta"]["total_count"] == ROWS
        assert last_page["objects"][0]["fields"]["code"] == "499000"
        assert last_page["objects"][-1]["fields"]["code"] == "499997"

        metrics = {
            "rows": ROWS,
            "physical_workbook_rows": ROWS + 3,
            "setup_seconds": round(setup_seconds, 3),
            "one_row_http_seconds": round(first_seconds, 3),
            "maximum_page_seconds": round(maximum_seconds, 3),
            "last_page_seconds": round(last_seconds, 3),
            "hq_models_per_http_page": ROWS,
            "maximum_http_rows": 1_000,
            "minimal_full_http_pages": (ROWS + 999) // 1_000,
            "maximum_page_response_bytes": len(body),
            "maximum_page_digest": hashlib.sha256(body).hexdigest(),
            "process_peak_kib": [rss_before, rss_after_first, rss_after_maximum, rss_after_last],
        }
        output = Path(os.environ.get("PROOF_OUT") or "/tmp") / "native-large-lookup-inventory.json"
        output.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
