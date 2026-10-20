"""HQ's case search finds, over cases HQ's own receiver saved, exactly the cases each csql scenario means.

Contract: for each scenario of the ``csql`` family
(``lib/commcare/__tests__/csqlCompositionFixture.ts``), its cases are saved
through HQ's receiver (``hqcase/utils.py::submit_case_blocks``), so every
stored date and time is HQ's own spelling, and HQ's case search pillow
indexes them into the unit's Elasticsearch. Each sending's queries, as Core
builds them from the scenario's searches in the sending's session
(``CsqlCompositionRuntimeTest``, both suites, in each of its zones), are then
sent through HQ's own search (``case_search/utils.py::CaseSearchQueryBuilder``
over ``extract_search_request_config``, the path a worker's search takes
after Formplayer posts it), and the ids it finds are held to the fixture's.
Every query runs under each of ``CONFIGURATIONS``: without
``CASE_SEARCH_RELATED_LOOKUPS``, where a search the fixture marks
``relatedLookups`` is refused and every other must still find its ids (the
flag-free ancestor case id among them, part 06 §3.12); with the flag; and with
the project's ``default_timezone`` set to a zone none of the device zones
shares, which no search may read (the worker's ``today()`` is the device's
date, part 06 §3.4). The plausible failures: a comparison HQ answers as text
where Nova means an instant, a raw term HQ's index refuses, a value HQ reads
in its own day or zone, a query that needs a flag Nova did not ask for, and a
query HQ compiles and then finds a different set of cases with.

``datetime-equality`` (part 06 §3.13, finding 75) also keeps the gate the
emitter's closed instant range was cleared by: the range itself, written here
by hand in each spelling it may carry (``PROBES``), held to what the plan's
reading of HQ predicts. Every query's answer is recorded
(``csql-payload.evidence.json`` beside the family's artifacts, and a table in
the log), so a disagreement shows what HQ found.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from proof.native.families import ZONED_CLASSES
from proof.native.hq_support import hq_commit, native_check, sha256, write_evidence

FAMILIES = ("csql",)
DOMAIN = "nova-csql-evidence"
OWNER = "csql-owner"
CORE_CLASS = "CsqlCompositionRuntimeTest"
ZONE_LABELS = tuple(zone.label for zone in ZONED_CLASSES[CORE_CLASS])
# A project zone no device zone shares (UTC, Kiritimati, New York): HQ reads
# it for its own ``today()`` and a system date's day, so a search that reads
# neither finds the same cases under it.
PROJECT_ZONE = "Asia/Kolkata"
ADVANCED = "CASE_SEARCH_ADVANCED"
RELATED = "CASE_SEARCH_RELATED_LOOKUPS"
# (name, flags, the project's default_timezone or None for HQ's UTC default).
# Advanced search is on in each, as for every search family: HQ's search
# reads ``_xpath_query`` only under it (``utils.py::_require_case_search_advanced``).
CONFIGURATIONS = (
    ("related-lookups-off", frozenset({ADVANCED}), None),
    ("related-lookups-on", frozenset({ADVANCED, RELATED}), None),
    ("project-zone", frozenset({ADVANCED}), PROJECT_ZONE),
)

# From pull request 10 the query Nova emits for a datetime equality is the
# closed range (part 06 §3.13), and HQ's search over every emitted query must
# find the fixture's expected ids. Recorded in the evidence.
EMITTER_WRITES_RANGES = True

# --- datetime-equality ---------------------------------------------------------

AT_INSTANT = ["csql-visit-plus-0530", "csql-visit-minus-05", "csql-visit-zulu"]
OTHER = "csql-visit-other"
UNSEEN = "csql-visit-unseen"
OPENED = "csql-visit-opened"
NOT_AT_INSTANT = [OTHER, UNSEEN, OPENED]
ERROR = "error"
# HQ's stored spelling of 2026-01-02 04:30 UTC, whatever spelling was
# submitted (``form_processor/utils/xform.py::adjust_datetimes``).
STORED_INSTANT = "2026-01-02T04:30:00.000000Z"

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


def _project_zone(state, zone):
    """The project's ``default_timezone``, set as its settings page saves it."""
    from corehq.apps.domain.models import Domain
    from corehq.util.timezones.utils import get_timezone_for_domain

    label = f"csql project zone {zone}"
    with state.operation(label, hashlib.sha256(label.encode()).digest()):
        project = Domain.get_by_name(state.domain)
        project.default_timezone = zone
        project.save()
    read = get_timezone_for_domain(state.domain).zone
    assert read == zone, f"HQ reads the project's zone as {read!r} after it was set to {zone!r}"


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
    """What HQ saved for each case: its properties as stored, and its opened and modified instants."""
    from corehq.form_processor.models import CommCareCase

    stored = {}
    for case in scenario["cases"]:
        saved = CommCareCase.objects.get_case(case["id"], state.domain)
        stored[case["id"]] = {
            "properties": {key: saved.case_json.get(key) for key in case["properties"]},
            "openedOn": saved.opened_on.isoformat() if saved.opened_on else None,
            "modifiedOn": saved.modified_on.isoformat() if saved.modified_on else None,
            "closed": saved.closed,
        }
    return stored


def _search(state, case_types, queries):
    """HQ's own search for one sending's ``_xpath_query`` values: each compiled in a case search context, then run together.

    Returns ``(compiled, ids or ERROR, error)``: whether HQ's compiler
    accepted every query, the ids HQ's search found (sorted), and HQ's
    error when it refused or failed.
    """
    from corehq.apps.case_search.models import extract_search_request_config
    from corehq.apps.case_search.utils import CaseSearchQueryBuilder, _get_helper

    from proof.hq.operations import compile_case_search

    try:
        for query in queries:
            compile_case_search(state, query, case_types)
    except Exception as error:  # HQ's refusal is the observation
        return False, ERROR, f"{type(error).__name__}: {error}"
    helper = _get_helper(None, state.domain, list(case_types), None)
    config = extract_search_request_config({"case_type": list(case_types), "_xpath_query": list(queries)})
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
        found = row["found"] if row["found"] == ERROR else ",".join(case.removeprefix("csql-") for case in row["found"]) or "-"
        mark = "ok " if row["agrees"] else "DIFFERS"
        lines.append(f"{mark:7} {row['label']:<{width}}  found {found}  query {' | '.join(row['queries'])}")
    return "\n".join(lines)


def _sent_in(sending, zone):
    """Whether Core sends ``sending`` in ``zone``'s JVM: every zone, unless it names one."""
    return sending.get("zone", zone) == zone


def _payloads(native, scenarios):
    """Each zone's records, after holding them to exactly the sendings Core sends in that zone."""
    records, digests = [], {}
    for zone in ZONE_LABELS:
        path = native.core_artifact("csql", f"nova-csql-payloads.{zone}.jsonl", CORE_CLASS, zone)
        digests[zone] = sha256(path.read_bytes())
        written = [json.loads(line) for line in path.read_text().splitlines() if line]
        assert [(r["scenario"], r["search"], r["sending"], r["carrier"], r["zone"]) for r in written] == [
            (scenario["id"], search["id"], sending["id"], carrier, zone)
            for scenario in scenarios
            for search in scenario["searches"]
            for carrier in ("local", "hq")
            for sending in search["sendings"]
            if _sent_in(sending, zone)
        ], f"{CORE_CLASS}[{zone}] wrote another set of sendings than the fixture's"
        records.extend(written)
    return records, digests


def _check(state, scenario, configuration, records, disagreements):
    """One scenario under one configuration: its cases saved, then every sending's queries searched."""
    name, flags, _ = configuration
    case_types = scenario["caseTypes"]
    searches = {search["id"]: search for search in scenario["searches"]}
    meant = {
        (search["id"], sending["id"]): sending["expected"]
        for search in scenario["searches"]
        for sending in search["sendings"]
    }
    _submit(state, scenario)
    stored = _stored(state, scenario)
    for case_id, spelling in STORED.get(scenario["id"], {}).items():
        if stored[case_id]["properties"].get("seen") != spelling:
            disagreements.append(f"{name}: {case_id} stored seen {stored[case_id]['properties'].get('seen')!r}")
    # One search per distinct query set: the same queries find the same cases.
    answers = {}
    rows = []
    for record in [r for r in records if r["scenario"] == scenario["id"]]:
        queries = tuple(record["queries"])
        if queries not in answers:
            answers[queries] = _search(state, case_types, queries)
        compiled, found, error = answers[queries]
        # Without the flag, HQ refuses a search that reads related cases.
        refused = searches[record["search"]].get("relatedLookups") and RELATED not in flags
        expected = ERROR if refused else meant[(record["search"], record["sending"])]
        agrees, expected = _verdict(found, expected)
        rows.append(
            {
                "label": f"{name} {record['search']}/{record['sending']}@{record['carrier']}[{record['zone']}]",
                "kind": "emitted",
                "configuration": name,
                "search": record["search"],
                "sending": record["sending"],
                "carrier": record["carrier"],
                "zone": record["zone"],
                "queries": list(queries),
                "compiled": compiled,
                "found": found,
                "error": error,
                "expected": expected,
                "meant": sorted(meant[(record["search"], record["sending"])]),
                "agrees": agrees,
            }
        )
    for probe, query, expected in PROBES.get(scenario["id"], ()):
        compiled, found, error = _search(state, case_types, (query,))
        agrees, expected = _verdict(found, expected)
        rows.append(
            {
                "label": f"{name} probe {probe}",
                "kind": "probe",
                "configuration": name,
                "probe": probe,
                "queries": [query],
                "compiled": compiled,
                "found": found,
                "error": error,
                "expected": expected,
                "agrees": agrees,
            }
        )
    return stored, rows


def test_hqs_search_finds_each_scenarios_meant_cases(native):
    family = native.family("csql")
    scenarios = [json.loads(line) for line in (family / "scenarios.jsonl").read_text().splitlines() if line]
    records, digests = _payloads(native, scenarios)
    observations, disagreements = [], []
    for configuration in CONFIGURATIONS:
        name, flags, project_zone = configuration
        for scenario in scenarios:
            with native_check(DOMAIN, flags=flags, case_search_enabled=True) as (state, _):
                if project_zone is not None:
                    _project_zone(state, project_zone)
                stored, rows = _check(state, scenario, configuration, records, disagreements)
            print(f"\ncsql {scenario['id']} under {name}: what HQ's search found\n{_table(rows)}")
            for row in rows:
                if not row["agrees"]:
                    because = f" ({row['error']})" if row["error"] else ""
                    disagreements.append(
                        f"{row['label']}: HQ found {row['found']}{because}, expected {row['expected']}; "
                        f"queries {row['queries']}"
                    )
            observations.append(
                {
                    "scenario": scenario["id"],
                    "configuration": name,
                    "flags": sorted(flags),
                    "projectZone": project_zone,
                    "cases": scenario["cases"],
                    "stored": stored,
                    "queries": rows,
                }
            )
    record = {
        "hqCommit": hq_commit(),
        "payloadsSha256": digests,
        "emitterWritesRanges": EMITTER_WRITES_RANGES,
        "scenarios": observations,
        "limits": "Cases saved through HQ's receiver and indexed by HQ's case search pillow into HQ's own "
        "Elasticsearch; each sending's queries sent through HQ's CaseSearchQueryBuilder as a worker's search is, "
        "without Formplayer's request or the results' XML. Probes are hand-written closed ranges, not Nova's "
        "emission. HQ's clock is not the device's: a query reading HQ's own today() would find a day the fixture "
        "does not name.",
    }
    write_evidence(family, "csql-payload", record)
    assert not disagreements, (
        f"HQ's search disagreed with {len(disagreements)} expectation(s) of the csql family "
        "(every answer is in csql-payload.evidence.json):\n  " + "\n  ".join(disagreements)
    )
