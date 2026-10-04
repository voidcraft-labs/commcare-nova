"""The case database each corpus document's sessions run over, and the restore that carries it.

A document's case database is made from its own case types (``document.json``,
``doc.caseTypes``; a control retains the database itself,
``document_case_database``), deterministically, so every run and every build
sees the same cases:

- cases of each case type the document declares, names as a parent, or
  gives a menu, parents before their children: ``CASES_PER_TYPE``, or as
  many as one of its properties has values (at most ``MAX_CASES_PER_TYPE``);
- each declared property takes values from its type (``VALUES``), then the
  values the document itself gives it (``document_values``: its options, the
  values a case list column maps, the literals a case list or search
  condition compares it with), case ``n`` taking the ``n``-th, so the
  document's own filters and mappings find cases they select. Every type
  whose values have an order holds values whose text order and numeric order
  differ ("10" and "2" for text, integers and selects; "10.5" and "2.25" for
  decimals), stored in an order that is neither, so a list sorted as text on
  one build, as a number on the other, or not sorted at all, shows which;
- a child or extension case type's case ``n`` indexes its parent type's case
  ``n`` (modulo their count), under the identifier ``parent`` that Nova's
  case blocks write for both relationships; a type that is its own parent
  chains its cases from the first, which has none;
- one worker (``USER_ID``, ``USERNAME``) owns every case, carries user data
  for each worker property the document declares and each user-data field
  its expressions read (``session-user`` terms), and has its usercase, as an
  HQ project with usercases gives every worker
  (``callcenter/sync_usercase.py::_get_user_case_fields``).

The restore is written by HQ's own restore code, as an OTA restore serves
it: ``casexml/apps/phone/restore.py::RestoreContent`` with HQ's sync and
registration elements (``casexml/apps/phone/xml.py::get_sync_element``,
``get_registration_element``), any fixtures the caller adds, and each case as
``get_case_element`` writes it for a phone holding nothing
(``data_providers/case/utils.py::CaseSyncUpdate``, then
``data_providers/case/load_testing.py::get_xml_for_response``), at case XML
V2. The cases are HQ's own ``CommCareCase`` objects, never saved;
``hq_cases`` makes a fresh set of them for each use, so HQ's case processing
(``proof.hq.operations.process_case_blocks``) applies a submission over the
same cases the session ran on, and no submission's changes reach another.

``lookup_fixtures`` uploads the lookup workbook Nova's push sends, through
HQ's upload, and returns the item lists HQ's restore serves for those tables
(``fixtures/fixturegenerators.py::ItemListsProvider``), for the builds HQ
makes; Nova's local archive carries its tables itself.

The case database is made from the document alone (``case_database``); what
reads HQ (``hq_cases``, ``restore``, ``lookup_fixtures``) imports it where it
runs, so this module imports without HQ.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta

CASES_PER_TYPE = 3
MAX_CASES_PER_TYPE = 8
USER_ID = "proof-worker-id"
USERNAME = "proof-worker"
USERCASE_TYPE = "commcare-user"
USERCASE_ID = "proof-worker-usercase"
INDEX_IDENTIFIER = "parent"
# Every case's history starts here, one minute apart, so each case's
# date_opened and date_modified are fixed and distinct. Not the session clock
# (proof.core.client.DEFAULT_CLOCK), whose spelling the runner marks.
EPOCH = datetime(2025, 12, 1, 8, 0, tzinfo=UTC)

# The values of each case property data type (lib/domain/casePropertyTypes.ts),
# in the encodings Core's case instance and CommCare's answers use, in the
# order the cases are stored. Where a type has an order, the storage order,
# the text order and the order as numbers (or in time) all differ: "10" and
# "2" sort one way as text and the other as numbers, and neither is the order
# the cases were stored in, so a list sorted either way, or not sorted, shows
# which it did.
VALUES = {
    "text": ("proof text", "10", "2"),
    "int": ("7", "10", "2"),
    "decimal": ("7", "10.5", "2.25"),
    "date": ("2026-01-10", "2001-02-03", "2025-12-31"),
    "time": ("14:30:00", "09:15:00", "23:45:00"),
    "datetime": ("2026-01-10T08:00:00.000Z", "2001-02-03T04:05:06.000Z", "2099-06-15T14:30:00.000Z"),
    "single_select": ("proof", "10", "2"),
    "multi_select": ("proof", "10 2", "2"),
    "geopoint": ("12.5 -8.25 0 0", "-33.9 18.4 10 5", "0 0 0 0"),
}
# The standard case properties (lib/domain/standardCaseProperties.ts): the
# case block's own fields, never a dynamic property.
STANDARD_PROPERTIES = frozenset(
    {"case_id", "case_name", "date_opened", "last_modified", "owner_id", "external_id", "status"}
)


@dataclass(frozen=True)
class CaseRecord:
    case_id: str
    case_type: str
    name: str
    owner_id: str
    opened_on: str
    modified_on: str
    external_id: str | None
    # Dynamic properties in the order the document declares them.
    properties: tuple[tuple[str, str], ...]
    # (identifier, referenced case type, referenced case id, relationship)
    indices: tuple[tuple[str, str, str, str], ...] = ()


@dataclass(frozen=True)
class CaseDatabase:
    user_id: str
    username: str
    user_data: tuple[tuple[str, str], ...]
    cases: tuple[CaseRecord, ...]


COMPARISONS = frozenset({"eq", "neq", "gt", "gte", "lt", "lte"})


def _type_values(prop):
    """The values one declared property takes from its data type, then from its options."""
    data_type = prop.get("data_type") or "text"
    if data_type not in VALUES:
        raise ValueError(
            f"The case property {prop.get('name')!r} declares the data type {data_type!r}, which the case database"
            f" has no values for (it knows {sorted(VALUES)}); add its values to proof/observe/casedata.py::VALUES."
        )
    options = [option["value"] for option in prop.get("options") or [] if isinstance(option.get("value"), str)]
    found = list(VALUES[data_type])
    if data_type == "multi_select" and len(options) > 1:
        found.append(f"{options[0]} {options[1]}")
    return [*found, *options]


def _literal(value):
    """A predicate literal's value as a case property holds it, or None for a literal no property holds."""
    if isinstance(value, dict) and value.get("kind") == "term":
        value = value.get("term")
    if not isinstance(value, dict) or value.get("kind") != "literal":
        return None
    raw = value.get("value")
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, (int, float)):
        return str(int(raw)) if float(raw).is_integer() else repr(raw)
    return raw if isinstance(raw, str) else None


def _property(value):
    """The (case type, property) a predicate value reads, following an ancestor or related read to its type."""
    if isinstance(value, dict) and value.get("kind") == "term":
        value = value.get("term")
    if not isinstance(value, dict) or value.get("kind") != "prop":
        return None
    case_type, via = value.get("caseType"), value.get("via") or {"kind": "self"}
    if via.get("kind") == "ancestor":
        case_type = (via.get("via") or [{}])[-1].get("throughCaseType")
    elif via.get("kind") != "self":
        case_type = via.get("ofCaseType")
    name = value.get("property")
    return (case_type, name) if isinstance(case_type, str) and isinstance(name, str) else None


def document_values(doc):
    """The values the document itself gives each case property, by (case type, property), in document order.

    Read from the document's typed structures, never from expression text:
    each case list column that maps values (``mapping[].value`` beside its
    ``field``), and each case list or search condition that compares a
    property with literals (a comparison, ``in``, ``between``,
    ``multi-select-contains``).
    """
    found = {}

    def add(key, value):
        if key is not None and value is not None:
            found.setdefault(key, {}).setdefault(value, None)

    def walk(value):
        if isinstance(value, dict):
            kind = value.get("kind")
            if kind in COMPARISONS:
                add(_property(value.get("left")), _literal(value.get("right")))
                add(_property(value.get("right")), _literal(value.get("left")))
            elif kind == "in":
                for literal in value.get("values") or []:
                    add(_property(value.get("left")), _literal(literal))
            elif kind == "between":
                for bound in ("lower", "upper"):
                    add(_property(value.get("left")), _literal(value.get(bound)))
            elif kind == "multi-select-contains":
                for literal in value.get("values") or []:
                    add(_property(value.get("property")), _literal(literal))
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for module_id in doc.get("moduleOrder") or []:
        module = (doc.get("modules") or {}).get(module_id) or {}
        case_type = module.get("caseType")
        for column in (module.get("caseListConfig") or {}).get("columns") or []:
            if isinstance(column.get("field"), str) and isinstance(column.get("mapping"), list):
                for entry in column["mapping"]:
                    if isinstance(entry, dict) and isinstance(entry.get("value"), str):
                        add((case_type, column["field"]), entry["value"])
    walk(doc.get("modules"))
    return {key: list(values) for key, values in found.items()}


def _case_types(doc):
    """Every case type the document declares, names as a parent or gives a menu, parents first."""
    declared = {case_type["name"]: case_type for case_type in doc.get("caseTypes") or []}
    names = list(declared)
    for case_type in declared.values():
        parent = case_type.get("parent_type")
        if parent and parent not in names:
            names.append(parent)
    for module_id in doc.get("moduleOrder") or []:
        case_type = (doc.get("modules") or {}).get(module_id, {}).get("caseType")
        if case_type and case_type not in names:
            names.append(case_type)
    names = [name for name in names if name != USERCASE_TYPE]
    ordered, placed = [], set()

    def place(name, seen=()):
        if name in placed:
            return
        if name in seen:
            raise ValueError(f"The document's case types name each other as parents in a cycle through {name!r}.")
        parent = (declared.get(name) or {}).get("parent_type")
        if parent and parent != name:
            place(parent, (*seen, name))
        placed.add(name)
        ordered.append(name)

    for name in names:
        place(name)
    return [(name, declared.get(name) or {"name": name, "properties": []}) for name in ordered]


def _session_user_fields(value, found):
    """The user-data fields the document's expressions read (``session-user`` terms), in document order."""
    if isinstance(value, dict):
        if value.get("kind") == "session-user" and isinstance(value.get("field"), str):
            found.setdefault(value["field"], None)
        for item in value.values():
            _session_user_fields(item, found)
    elif isinstance(value, list):
        for item in value:
            _session_user_fields(item, found)
    return found


def _stamp(minutes):
    return (EPOCH + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def case_database(document_json) -> CaseDatabase:
    """The case database of one corpus document, from its ``document.json``."""
    doc = document_json["doc"]
    user_data = {}
    for slug in sorted(
        prop["slug"] for prop in (doc.get("userProperties") or {}).values() if isinstance(prop.get("slug"), str)
    ):
        user_data[slug] = f"proof {slug}"
    for field in _session_user_fields(doc, {}):
        user_data.setdefault(field, f"proof {field}")

    given = document_values(doc)
    types = _case_types(doc)
    values_of = {}
    for name, case_type in types:
        declared = [prop for prop in case_type.get("properties") or [] if isinstance(prop.get("name"), str)]
        properties = {prop["name"]: _type_values(prop) for prop in declared}
        properties.setdefault("case_name", list(VALUES["text"]))
        for (owner, prop), values in given.items():
            if owner == name and prop in properties:
                properties[prop] = list(dict.fromkeys([*properties[prop], *values]))
        values_of[name] = (declared, properties)
    ids = {
        name: [
            f"{name}-{n + 1}"
            for n in range(min(MAX_CASES_PER_TYPE, max(CASES_PER_TYPE, *map(len, properties.values()))))
        ]
        for name, (_, properties) in values_of.items()
    }
    cases, stamp = [], 0
    for name, case_type in types:
        declared, properties = values_of[name]
        parent = case_type.get("parent_type")
        relationship = case_type.get("relationship") or "child"
        for n in range(len(ids[name])):
            values = {prop: options[n % len(options)] for prop, options in properties.items()}
            case_name = values["case_name"]
            indices = ()
            if parent == name:
                # A type that is its own parent: a chain from the first case, which has none (Core refuses a
                # case indexing itself, CaseXmlParser).
                if n:
                    indices = ((INDEX_IDENTIFIER, parent, ids[name][n - 1], relationship),)
            elif parent:
                parents = ids[parent]
                indices = ((INDEX_IDENTIFIER, parent, parents[n % len(parents)], relationship),)
            cases.append(
                CaseRecord(
                    case_id=ids[name][n],
                    case_type=name,
                    name=case_name,
                    owner_id=USER_ID,
                    opened_on=_stamp(stamp),
                    modified_on=_stamp(stamp),
                    external_id=values.get("external_id"),
                    properties=tuple(
                        (prop["name"], values[prop["name"]])
                        for prop in declared
                        if prop["name"] not in STANDARD_PROPERTIES
                    ),
                    indices=indices,
                )
            )
            stamp += 1
    cases.append(
        CaseRecord(
            case_id=USERCASE_ID,
            case_type=USERCASE_TYPE,
            name=USERNAME,
            owner_id=USER_ID,
            opened_on=_stamp(stamp),
            modified_on=_stamp(stamp),
            external_id=None,
            properties=(("hq_user_id", USER_ID), ("username", USERNAME), *sorted(user_data.items())),
        )
    )
    return CaseDatabase(USER_ID, USERNAME, tuple(user_data.items()), tuple(cases))


def database_json(database: CaseDatabase) -> dict:
    """The database as JSON, as a control retains it (``proof.checks.controls``)."""
    return asdict(database)


def database_from_json(value) -> CaseDatabase:
    """The database a control retains (``database_json``)."""
    return CaseDatabase(
        user_id=value["user_id"],
        username=value["username"],
        user_data=tuple(tuple(pair) for pair in value["user_data"]),
        cases=tuple(
            CaseRecord(
                **{
                    **case,
                    "properties": tuple(tuple(pair) for pair in case["properties"]),
                    "indices": tuple(tuple(index) for index in case["indices"]),
                }
            )
            for case in value["cases"]
        ),
    )


def document_case_database(document, *, edit=False) -> CaseDatabase:
    """The case database of D (or D', ``edit``): made from its ``document.json``, or, for a control, the one it
    retains (``Document.derived``), so a control reads the same cases whatever shape Nova's document takes."""
    held = document.derived("caseDatabase", edit=edit)
    if held is not None:
        return database_from_json(held)
    return case_database(document.edit_document if edit else document.document)


def database_digest(database: CaseDatabase) -> str:
    """``sha256:<hex>`` of the database as canonical JSON: what a key reads of a document's cases."""
    written = json.dumps(asdict(database), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(written.encode()).hexdigest()


# HQ ------------------------------------------------------------------------


def _datetime(text):
    """A stamp as HQ's case models hold one: naive, in UTC (HQ's case processing compares it with the
    submission's naive date_modified, ``backends/sql/update_strategy.py::_apply_case_update``)."""
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ")


def hq_cases(database: CaseDatabase, domain):
    """The database's cases as HQ's ``CommCareCase`` objects, made anew on every call and never saved."""
    from corehq.form_processor.models import CommCareCase, CommCareCaseIndex

    made = []
    for case in database.cases:
        made.append(
            CommCareCase(
                domain=domain,
                case_id=case.case_id,
                type=case.case_type,
                name=case.name,
                owner_id=case.owner_id,
                opened_on=_datetime(case.opened_on),
                opened_by=database.user_id,
                modified_on=_datetime(case.modified_on),
                modified_by=database.user_id,
                server_modified_on=_datetime(case.modified_on),
                closed=False,
                external_id=case.external_id,
                case_json=dict(case.properties),
                indices=[
                    {
                        "domain": domain,
                        "case_id": case.case_id,
                        "identifier": identifier,
                        "referenced_type": referenced_type,
                        "referenced_id": referenced_id,
                        "relationship_id": CommCareCaseIndex.RELATIONSHIP_MAP[relationship],
                    }
                    for identifier, referenced_type, referenced_id, relationship in case.indices
                ],
            )
        )
    return made


def restore(database: CaseDatabase, domain, fixtures=()) -> bytes:
    """The OTA restore HQ writes for the database's worker: sync, registration, ``fixtures``, then every case.

    ``fixtures`` are restore items as HQ caches them (``lookup_fixtures``). It
    runs inside a check's HQ state and seams (``proof.hq.check.hq_check``):
    HQ's case writer reads a flag (``MM_CASE_PROPERTIES``, in
    ``casexml/apps/case/xml/generator.py::_sync_attachments``).
    """
    from types import SimpleNamespace

    from casexml.apps.case.xml import V2
    from casexml.apps.phone.data_providers.case.load_testing import get_xml_for_response
    from casexml.apps.phone.data_providers.case.utils import CaseSyncUpdate
    from casexml.apps.phone.restore import RestoreContent
    from casexml.apps.phone.xml import get_registration_element, get_sync_element

    worker = SimpleNamespace(
        username=database.username,
        password="",
        user_id=database.user_id,
        date_joined=EPOCH,
        user_session_data=dict(database.user_data),
    )
    # get_xml_for_response asks the restore state how many times to repeat each case (load testing only).
    state = SimpleNamespace(version=V2, get_safe_loadtest_factor=lambda total: 1)
    cases = hq_cases(database, domain)
    with RestoreContent(database.username, items=True) as content:
        content.append(get_sync_element("proof-sync"))
        content.append(get_registration_element(worker))
        for fixture in fixtures:
            content.append(fixture)
        for case in cases:
            content.extend(get_xml_for_response(CaseSyncUpdate(case, None), state, len(cases)))
        with content.get_fileobj() as written:
            return written.read()


def lookup_fixtures(state, captured, user_id=USER_ID):
    """HQ's item-list fixtures for the tables Nova's push sends in ``captured`` (a lookup workbook capture).

    The workbook is uploaded through HQ's own upload (``replace``, as Nova's
    push sends it), then each table HQ holds is served as
    ``ItemListsProvider`` serves a global table: its items written as HQ caches
    them (``_get_global_items``, then ``casexml/apps/phone/utils.py::
    write_fixture_items_to_io``), with HQ's global user id replaced by the
    worker's (``_get_or_cache_global_fixture``). The cache and its Redis lock
    around that are skipped: the harness refuses Redis, and they hold no
    content. Nova's tables are all global (``lib/commcare/lookup/workbook.ts``,
    ``is_global?`` ``yes``).

    Where HQ would serve the worker no table the app reads, this raises
    ``LookupTablesNotServed`` with the reason as data, for proof 3 to report:
    a table HQ holds per owner (the restore here serves only global tables),
    or an upload HQ answers as failed. HQ's upload at the pin never answers
    failed (``fixtures/upload/definitions.py::FixtureUploadResult.success`` is
    set only when it is made): what it cannot read raises, and what it lists
    as errors (an owner it does not know) leaves the rows added, which the bar
    reports.
    """
    from casexml.apps.phone.utils import GLOBAL_USER_ID, write_fixture_items_to_io
    from corehq.apps.fixtures.fixturegenerators import ItemListsProvider
    from corehq.apps.fixtures.models import LookupTable

    from proof.hq import operations

    uploaded = operations.upload_lookup_workbook(state, captured.workbook(), replace=True)
    if not uploaded.success:
        raise LookupTablesNotServed(
            {
                "why": "HQ answered Nova's lookup workbook upload as failed, so it serves the app no tables.",
                "workbook": captured.body_path.name,
                "errors": [str(error) for error in uploaded.errors],
            }
        )
    provider = ItemListsProvider()
    fixtures = []
    for table in sorted(LookupTable.objects.by_domain(state.domain), key=lambda table: table.tag):
        if not table.is_global:
            raise LookupTablesNotServed(
                {
                    "why": "HQ holds a lookup table per owner after Nova's upload, and Nova's push uploads every"
                    " table as global; the restore here serves only global tables.",
                    "workbook": captured.body_path.name,
                    "table": table.tag,
                }
            )
        with write_fixture_items_to_io(provider._get_global_items(table, state.domain)) as written:
            fixtures.append(written.getvalue().replace(GLOBAL_USER_ID.encode(), user_id.encode()))
    return fixtures


class LookupTablesNotServed(AssertionError):
    """HQ would not serve the app's worker the lookup tables Nova's push sent; ``reason`` says why, as JSON."""

    def __init__(self, reason):
        super().__init__(reason["why"])
        self.reason = reason
