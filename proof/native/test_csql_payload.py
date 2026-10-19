"""HQ's case search finds, over cases HQ's own receiver saved, exactly the cases each csql scenario means.

Contract: for each scenario of the ``csql`` family
(``lib/commcare/__tests__/csqlCompositionFixture.ts``), its cases are saved
through HQ's receiver (``hqcase/utils.py::submit_case_blocks``), so every
stored date and time is HQ's own spelling, and HQ's case search pillow
indexes them into the unit's Elasticsearch. Each query Core builds from the
scenario's searches (``CsqlCompositionRuntimeTest``, both suites) is then
sent through HQ's own search (``case_search/utils.py::CaseSearchQueryBuilder``
over ``extract_search_request_config``, the path a worker's search takes
after Formplayer posts it), and the ids it finds are held to the fixture's.
The plausible failures: a comparison HQ answers as text where Nova means an
instant, a raw term HQ's index refuses, and a query HQ compiles and then
finds a different set of cases with.

``datetime-equality`` (part 06 §3.13, finding 75) is also the gate on part
06's emitter change: before the emitter writes a closed instant range, this
module sends the range itself, written here by hand in each spelling the
range would carry (``PROBES``), and holds HQ's answer to what the plan's
reading of HQ predicts. Every query's answer is recorded
(``csql-payload.evidence.json`` beside the family's artifacts, and a table in
the log), so a disagreement shows what HQ found.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from proof.native.hq_support import hq_commit, native_check, sha256, write_evidence

FAMILIES = ("csql",)
DOMAIN = "nova-csql-evidence"
OWNER = "csql-owner"

# Pull request 10's emitter commit flips this to True: from then the query
# Nova emits for a datetime equality is the closed range, and HQ's search over
# it must find the fixture's expected ids. Until then each emitted query is
# held to what HQ answers today (``TODAY_EMITTED``), finding 75's text half.
EMITTER_WRITES_RANGES = False

# --- datetime-equality ---------------------------------------------------------

AT_INSTANT = ["csql-visit-plus-0530", "csql-visit-minus-05", "csql-visit-zulu"]
OTHER = "csql-visit-other"
UNSEEN = "csql-visit-unseen"
OPENED = "csql-visit-opened"
EVERY_VISIT = [*AT_INSTANT, OTHER, UNSEEN, OPENED]
NOT_AT_INSTANT = [OTHER, UNSEEN, OPENED]
ERROR = "error"
# HQ's stored spelling of 2026-01-02 04:30 UTC, whatever spelling was
# submitted (``form_processor/utils/xform.py::adjust_datetimes``).
STORED_INSTANT = "2026-01-02T04:30:00.000000Z"

# What HQ's search answers today for the query Nova's emitter writes
# (part 06 §3.13, "Finding 75"): text equality on ``case_properties.value.exact``
# finds no case for an equality and every case for ``!=``; a system date
# compared with ``=`` reaches Elasticsearch as a raw term, which the index's
# date formats refuse without seconds, so the search fails.
# FLIPS WITH THE EMITTER: once EMITTER_WRITES_RANGES is True these are no
# longer read; the fixture's expected ids are.
TODAY_EMITTED = {
    "eq-naive": [],
    "eq-zulu": [],
    "eq-minute": [],
    "eq-runtime": [],
    "neq-naive": EVERY_VISIT,
    "in-two": [],
    "date_opened-minute": ERROR,
    "last_modified-minute": ERROR,
}


def _eq(field, value):
    return f"({field} >= {value} and {field} <= {value})"


def _quoted(value):
    return f"'{value}'"


def _runtime(value):
    # The runtime value as Nova's emitter sends it today: HQ's ``datetime()``
    # over the answer (``value_functions.py::datetime_``).
    return f'datetime("{value}")'


# Each spelling of 2026-01-02 04:30 UTC a range bound may carry.
SEEN_SPELLINGS = {
    "naive": _quoted("2026-01-02T04:30:00"),
    "zulu": _quoted("2026-01-02T04:30:00Z"),
    "plus-05": _quoted("2026-01-02T09:30:00.000+05"),
    "plus-0530": _quoted("2026-01-02T10:00:00+05:30"),
    "minute": _quoted("2026-01-02T04:30"),
    "minute-plus-0530": _quoted("2026-01-02T10:00+05:30"),
    "millisecond-zulu": _quoted("2026-01-02T04:30:00.000Z"),
    "millisecond-naive": _quoted("2026-01-02T04:30:00.000"),
    "stored": _quoted(STORED_INSTANT),
    "runtime-plus-05": _runtime("2026-01-02T09:30:00.000+05"),
    "runtime-zulu": _runtime("2026-01-02T04:30:00.000Z"),
}
# A millisecond later: the range names one millisecond, so it finds none.
SEEN_MISSES = {
    "millisecond-later-zulu": _quoted("2026-01-02T04:30:00.001Z"),
    "millisecond-later-plus-05": _quoted("2026-01-02T09:30:00.001+05"),
}
# The same, for 2026-01-02 09:30 UTC, when the visit was opened and last modified.
OPENED_SPELLINGS = {
    "minute": _quoted("2026-01-02T09:30"),
    "zulu": _quoted("2026-01-02T09:30:00Z"),
    "plus-05": _quoted("2026-01-02T14:30:00.000+05"),
    "millisecond-zulu": _quoted("2026-01-02T09:30:00.000Z"),
}
OPENED_MISSES = {"millisecond-later-zulu": _quoted("2026-01-02T09:30:00.001Z")}


def _datetime_equality_probes():
    """The closed ranges part 06 §3.13 plans, by hand, with what its reading of HQ predicts each finds."""
    probes = []
    for name, value in SEEN_SPELLINGS.items():
        probes.append((f"eq/seen/{name}", _eq("seen", value), AT_INSTANT))
    for name, value in SEEN_MISSES.items():
        probes.append((f"eq/seen/{name}", _eq("seen", value), []))
    for name in ("naive", "plus-05", "minute", "runtime-zulu"):
        probes.append((f"neq/seen/{name}", f"not{_eq('seen', SEEN_SPELLINGS[name])}", NOT_AT_INSTANT))
    others = {
        "naive": _quoted("2026-01-02T05:30:00"),
        "plus-05": _quoted("2026-01-02T11:00:00.000+05:30"),
        "minute": _quoted("2026-01-02T05:30"),
    }
    for name, other in others.items():
        query = f"({_eq('seen', SEEN_SPELLINGS[name])} or {_eq('seen', other)})"
        probes.append((f"in/seen/{name}", query, [*AT_INSTANT, OTHER]))
    for field in ("date_opened", "last_modified"):
        for name, value in OPENED_SPELLINGS.items():
            probes.append((f"eq/{field}/{name}", _eq(field, value), [OPENED]))
        for name, value in OPENED_MISSES.items():
            probes.append((f"eq/{field}/{name}", _eq(field, value), []))
        probes.append(
            (f"neq/{field}/minute", f"not{_eq(field, OPENED_SPELLINGS['minute'])}", [*AT_INSTANT, OTHER, UNSEEN])
        )
    return probes


PROBES = {"datetime-equality": _datetime_equality_probes()}
# The stored spelling of each case's ``seen``, as the planning run observed it.
STORED = {"datetime-equality": {case: STORED_INSTANT for case in AT_INSTANT}}


# --- HQ ----------------------------------------------------------------------------


def _utc(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)


def _submit(state, scenario):
    """The scenario's cases, saved through HQ's own receiver in one operation of the unit."""
    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.hqcase.utils import submit_case_blocks

    from proof.hq import redis as hq_redis

    label = f"csql {scenario['id']} cases"
    blocks = []
    for case in scenario["cases"]:
        index = {
            index["identifier"]: (index["caseType"], index["caseId"], index["relationship"])
            for index in case.get("indices", ())
        }
        blocks.append(
            CaseBlock(
                case_id=case["id"],
                create=True,
                case_type=case["type"],
                case_name=case["name"],
                owner_id=OWNER,
                date_modified=_utc(case["modified"]),
                update=dict(case["properties"]),
                index=index or None,
                close=bool(case.get("closed")),
            ).as_text()
        )
    with hq_redis.shared(None), state.committing():
        with state.operation(label, hashlib.sha256(label.encode()).digest()):
            submit_case_blocks(blocks, state.domain, user_id=OWNER, device_id="proof")


def _stored(state, scenario):
    """What HQ saved for each case: ``seen`` as stored, and the case's opened and modified instants."""
    from corehq.form_processor.models import CommCareCase

    stored = {}
    for case in scenario["cases"]:
        saved = CommCareCase.objects.get_case(case["id"], state.domain)
        stored[case["id"]] = {
            "properties": {key: saved.case_json.get(key) for key in case["properties"]},
            "openedOn": saved.opened_on.isoformat() if saved.opened_on else None,
            "modifiedOn": saved.modified_on.isoformat() if saved.modified_on else None,
        }
    return stored


def _search(state, case_types, query):
    """HQ's own search for one ``_xpath_query``: compiled in a case search context, then run.

    Returns ``(compiled, ids or ERROR, error)``: whether HQ's compiler
    accepted the query, the ids HQ's search found (sorted), and HQ's
    error when it refused or failed.
    """
    from corehq.apps.case_search.models import extract_search_request_config
    from corehq.apps.case_search.utils import CaseSearchQueryBuilder, _get_helper

    from proof.hq.operations import compile_case_search

    try:
        compile_case_search(state, query, case_types)
    except Exception as error:  # HQ's refusal is the observation
        return False, ERROR, f"{type(error).__name__}: {error}"
    helper = _get_helper(None, state.domain, list(case_types), None)
    config = extract_search_request_config({"case_type": list(case_types), "_xpath_query": [query]})
    try:
        hits = CaseSearchQueryBuilder(helper, config.case_types).build_query(config.criteria).run().raw_hits
    except Exception as error:  # Elasticsearch's refusal, at search time
        return True, ERROR, f"{type(error).__name__}: {str(error)[:600]}"
    return True, sorted(hit["_id"] for hit in hits), None


def _verdict(observed, expected):
    expected = expected if expected == ERROR else sorted(expected)
    return observed == expected, expected


def _table(rows):
    width = max(len(row["label"]) for row in rows)
    lines = []
    for row in rows:
        found = row["found"] if row["found"] == ERROR else ",".join(case.removeprefix("csql-visit-") for case in row["found"]) or "-"
        mark = "ok " if row["agrees"] else "DIFFERS"
        lines.append(f"{mark:7} {row['label']:<{width}}  found {found}  query {row['query']}")
    return "\n".join(lines)


def test_hqs_search_finds_each_scenarios_meant_cases(native):
    family = native.family("csql")
    payloads = native.core_artifact("csql", "nova-csql-payloads.jsonl", "CsqlCompositionRuntimeTest")
    scenarios = [json.loads(line) for line in (family / "scenarios.jsonl").read_text().splitlines() if line]
    records = [json.loads(line) for line in payloads.read_text().splitlines() if line]
    assert [scenario["id"] for scenario in scenarios] == ["datetime-equality"]
    assert [(r["scenario"], r["search"], r["sending"], r["carrier"]) for r in records] == [
        (scenario["id"], search["id"], sending["id"], carrier)
        for scenario in scenarios
        for search in scenario["searches"]
        for carrier in ("local", "hq")
        for sending in search["sendings"]
    ]
    observations, disagreements = [], []
    for scenario in scenarios:
        case_types = scenario["caseTypes"]
        meant = {
            (search["id"], sending["id"]): sending["expected"]
            for search in scenario["searches"]
            for sending in search["sendings"]
        }
        # Advanced search on, as for every search family: HQ's search reads
        # ``_xpath_query`` only under it (``utils.py::_require_case_search_advanced``).
        with native_check(DOMAIN, flags={"CASE_SEARCH_ADVANCED"}, case_search_enabled=True) as (state, _):
            _submit(state, scenario)
            stored = _stored(state, scenario)
            for case_id, spelling in STORED.get(scenario["id"], {}).items():
                if stored[case_id]["properties"].get("seen") != spelling:
                    disagreements.append(f"{case_id} stored seen {stored[case_id]['properties'].get('seen')!r}")
            emitted = []
            for record in [r for r in records if r["scenario"] == scenario["id"]]:
                assert len(record["queries"]) == 1, record
                query = record["queries"][0]
                compiled, found, error = _search(state, case_types, query)
                if EMITTER_WRITES_RANGES:
                    expected = meant[(record["search"], record["sending"])]
                else:
                    # FLIPS WITH THE EMITTER: today's answer, finding 75's text half.
                    expected = TODAY_EMITTED[record["search"]]
                agrees, expected = _verdict(found, expected)
                label = f"emitted {record['search']}/{record['sending']}@{record['carrier']}"
                row = {
                    "label": label,
                    "kind": "emitted",
                    "search": record["search"],
                    "sending": record["sending"],
                    "carrier": record["carrier"],
                    "query": query,
                    "compiled": compiled,
                    "found": found,
                    "error": error,
                    "expected": expected,
                    "meant": sorted(meant[(record["search"], record["sending"])]),
                    "agrees": agrees,
                }
                emitted.append(row)
            probes = []
            for name, query, expected in PROBES.get(scenario["id"], ()):
                compiled, found, error = _search(state, case_types, query)
                agrees, expected = _verdict(found, expected)
                probes.append(
                    {
                        "label": f"probe {name}",
                        "kind": "probe",
                        "probe": name,
                        "query": query,
                        "compiled": compiled,
                        "found": found,
                        "error": error,
                        "expected": expected,
                        "agrees": agrees,
                    }
                )
        rows = emitted + probes
        print(f"\ncsql {scenario['id']}: what HQ's search found\n{_table(rows)}")
        for row in rows:
            if not row["agrees"]:
                because = f" ({row['error']})" if row["error"] else ""
                disagreements.append(
                    f"{row['label']}: HQ found {row['found']}{because}, expected {row['expected']}; query {row['query']}"
                )
        observations.append(
            {"scenario": scenario["id"], "cases": scenario["cases"], "stored": stored, "queries": rows}
        )
    record = {
        "hqCommit": hq_commit(),
        "payloadsSha256": sha256(payloads.read_bytes()),
        "emitterWritesRanges": EMITTER_WRITES_RANGES,
        "scenarios": observations,
        "limits": "Cases saved through HQ's receiver and indexed by HQ's case search pillow into HQ's own "
        "Elasticsearch; each query sent through HQ's CaseSearchQueryBuilder as a worker's search is, without "
        "Formplayer's request or the results' XML. Probes are hand-written closed ranges, not Nova's emission.",
    }
    write_evidence(family, "csql-payload", record)
    assert not disagreements, (
        f"HQ's search disagreed with {len(disagreements)} expectation(s) of the csql family "
        "(every answer is in csql-payload.evidence.json):\n  " + "\n  ".join(disagreements)
    )
