"""Proof 1, identity: every external identity equal between A and B, and on the local path.

- A publish with no edit: every identity record (``proof.checks.identity``)
  of A against B's.
- A publish after an edit: the same identities of every entity outside the
  batch's footprint, each paired by its Nova id. Each module and form is
  placed on the wire by the layout the corpus records for D and D'
  (``document.json``'s ``wire.modules``, ``proof/corpus/footprint.ts::
  wireLayout``), and each language by its tag (``document.json``'s ``wire.languages``). Compared:
  the app id; each outside module's and form's identities, media paths,
  questions, case writes, case blocks and session datums; each outside
  language's code; the build profiles HQ keeps; the case types (with their
  properties and index identifiers) that no footprint module declares and no
  footprint form writes, nor any case type related to one; each lookup table
  the footprint does not name, by its table id; and the project's location
  type codes and custom data field slugs.

  A field in the footprint always brings its form, and a form its module
  (``batchFootprint``), so an outside form holds no edited field. An entry's
  session datums are compared while its module is outside the footprint
  too: HQ derives them from the module's configuration and its case list
  chain (``suite_xml/sections/entries.py::EntriesHelper.get_datum_meta_module``),
  so an edit of the module may change them by design.
- The local path: two ``.ccz`` exports of one unchanged document carry the
  same form ``xmlns`` and profile ``uniqueid``, and the second's version is
  no lower than the first's, as Core's installer reads each archive.

Identities read from HQ's build (the suite's datums, each form's case
blocks) are compared only when HQ built both states. A comparison that
cannot run is reported only where the bar does not already report why
(decision 12: one class per symptom): HQ's refusal of a publish
(``import@<state>``) and a build step that raised (``<step>@<state>``) are
the bar's, and nothing more is reported for them (a build HQ did not
complete is always one whose step raised: ``create_all_files()`` writes the
files or raises, ``proof.observe.build.build_state``); a refusal the bar
does not report names its cause in its path (``/no-<state>``,
``local.ccz`` ``/no-second-local-export``).
"""

from __future__ import annotations

from proof.checks.compare.json_tree import compare_json
from proof.checks.differences import Difference
from proof.checks.identity import compare_identities, data_maps, local_identity


def _without_build_identities(identities):
    kept = {artifact: record for artifact, record in identities.items() if artifact != "suite.xml"}
    for artifact, record in kept.items():
        if artifact.startswith("form:") and "case_blocks" in record:
            kept[artifact] = {key: value for key, value in record.items() if key != "case_blocks"}
    return kept


def _missing(document, observed, states):
    """Nothing where HQ refused the publish that makes a missing state (the bar's ``import@<state>``), else one
    refusal naming the first state HQ holds none of (``/no-<state>``).

    ``states`` are in the order the unit makes them, each over the one
    before (B and B-edit are published over A, and only where HQ accepted A:
    ``proof.observe.unit.observe_configuration``), so a refused A is why
    every later state is missing too, and the first missing state is why
    the later ones are.
    """
    refused = {refusal.state for refusal in observed.refusals}
    missing = [name for name, state in states if state is None]
    if not missing or any(name in refused for name in missing):
        return []
    cause = f"/no-{missing[0]}"
    return [
        Difference("proof1", document, "build", cause, cause, "refused", None, f"HQ holds no {missing[0]} to compare.")
    ]


def republish_identity(document, observed):
    """Every identity difference between A and B for a publish with no edit."""
    if observed.a is None or observed.b is None:
        return _missing(document, observed, (("A", observed.a), ("B", observed.b)))
    a, b = dict(observed.a.identities), dict(observed.b.identities)
    if not (observed.a.build.complete and observed.b.build.complete):
        a, b = _without_build_identities(a), _without_build_identities(b)
    for artifact in set(a) & set(b):
        if artifact.startswith("form:"):
            a[artifact], b[artifact] = _common_order(a[artifact], b[artifact])
    return compare_identities(a, b, document=document)


def _placed(modules):
    """Each module uuid -> its wire index, and each form uuid -> (module index, form index)."""
    placed_modules, placed_forms = {}, {}
    for m, module in enumerate(modules):
        placed_modules[module["uuid"]] = m
        for f, form in enumerate(module["forms"]):
            placed_forms[form] = (m, f)
    return placed_modules, placed_forms


def _entry(suite, command):
    for index, entry in enumerate((suite or {}).get("entries", [])):
        if entry.get("command") == command:
            return index, entry
    return None, None


def lookup_tags(document_json):
    lookup = document_json.get("lookup") or {}
    return {definition["id"]: definition["tag"] for definition in lookup.get("definitions", [])}


def document_lookup_tags(document, *, edit=False):
    """Each lookup table's tag by its id in D (or D', ``edit``): from its ``document.json``, or the tags a control
    retains (``Document.derived``)."""
    held = document.derived("lookupTags", edit=edit)
    if held is not None:
        return dict(held)
    return lookup_tags(document.edit_document if edit else document.document)


def _common_order(record_a, record_b):
    """Both forms' question order kept to the questions both hold: a question added or removed is its own
    difference, and does not move the others."""
    if record_a is None or record_b is None:
        return record_a, record_b
    common = set(record_a.get("questions", {})) & set(record_b.get("questions", {}))
    return tuple(
        {**record, "order": [path for path in record.get("order", []) if path in common]}
        for record in (record_a, record_b)
    )


def _footprint_case_types(app_json, modules, identities, footprint):
    """The case types a footprint module declares or a footprint form writes, on one side."""
    found = set()
    for m, module in enumerate(modules):
        if module["uuid"] in footprint and m < len(app_json["modules"]):
            case_type = app_json["modules"][m].get("case_type")
            if case_type:
                found.add(case_type)
        for f, form in enumerate(module["forms"]):
            if form in footprint:
                found.update((identities.get(f"form:{m}.{f}") or {}).get("case_updates", {}))
    return found


def _related(case_types, *records):
    """``case_types`` with every case type related to one by an index, either way, on either side.

    HQ carries properties along each relationship (``ParentCasePropertyBuilder``
    learns a child's ``parent/<property>`` on the parent, and the parent's
    properties on the child), so an edit of one reaches the other.
    """
    neighbours = {}
    for record in records:
        for child, entry in record.items():
            for parents in entry.get("indices", {}).values():
                for parent in parents:
                    neighbours.setdefault(child, set()).add(parent)
                    neighbours.setdefault(parent, set()).add(child)
    reached, frontier = set(case_types), list(case_types)
    while frontier:
        for other in neighbours.get(frontier.pop(), ()):
            if other not in reached:
                reached.add(other)
                frontier.append(other)
    return reached


def edit_identity(document, observed, wire_before, wire_after, footprint, tables_before, tables_after):
    """Every identity difference between A and B-edit for the entities outside the footprint.

    ``wire_before`` and ``wire_after`` are D's and D''s wire placement:
    ``{"modules": [{uuid, forms}], "languages": [{tag, code}]}``.
    """
    if observed.a is None or observed.b is None:
        return _missing(document, observed, (("A", observed.a), ("B-edit", observed.b)))
    a, b = observed.a.identities, observed.b.identities
    if not (observed.a.build.complete and observed.b.build.complete):
        a, b = _without_build_identities(a), _without_build_identities(b)
    found = []

    def compare(artifact, before, after, path, at):
        found.extend(
            compare_json(
                before,
                after,
                check="proof1",
                document=document,
                artifact=artifact,
                data_maps=data_maps(artifact),
                root_path=path,
                root_at=at,
            )
        )

    app_a, app_b = a["app.json"], b["app.json"]
    compare("app.json", app_a["_id"], app_b["_id"], "/_id", "/_id")
    compare("app.json", app_a["build_profiles"], app_b["build_profiles"], "/build_profiles", "/build_profiles")

    # Each language keeps its code: the code HQ holds at the language's wire
    # position in A against the one it holds at its position in B.
    def held_code(langs, index):
        return langs[index] if langs and index < len(langs) else None

    places_b = {entry["tag"]: index for index, entry in enumerate(wire_after["languages"])}
    for index, entry in enumerate(wire_before["languages"]):
        tag = entry["tag"]
        if tag in places_b and tag not in footprint:
            compare(
                "app.json",
                held_code(app_a["langs"], index),
                held_code(app_b["langs"], places_b[tag]),
                "/langs/*",
                f"/langs/{index}",
            )

    modules_a, forms_a = _placed(wire_before["modules"])
    modules_b, forms_b = _placed(wire_after["modules"])
    for uuid, m_a in sorted(modules_a.items(), key=lambda item: item[1]):
        if uuid in footprint or uuid not in modules_b:
            continue
        m_b = modules_b[uuid]
        module_a = {k: v for k, v in app_a["modules"][m_a].items() if k != "forms"}
        module_b = {k: v for k, v in app_b["modules"][m_b].items() if k != "forms"}
        compare("app.json", module_a, module_b, "/modules/*", f"/modules/{m_a}")
    for uuid, (m_a, f_a) in sorted(forms_a.items(), key=lambda item: item[1]):
        if uuid in footprint or uuid not in forms_b:
            continue
        m_b, f_b = forms_b[uuid]
        record_a, record_b = _common_order(a.get(f"form:{m_a}.{f_a}"), b.get(f"form:{m_b}.{f_b}"))
        compare(
            "app.json",
            app_a["modules"][m_a]["forms"][f_a],
            app_b["modules"][m_b]["forms"][f_b],
            "/modules/*/forms/*",
            f"/modules/{m_a}/forms/{f_a}",
        )
        compare(f"form:{m_a}.{f_a}", record_a, record_b, "", "")
        modules_outside = (
            wire_before["modules"][m_a]["uuid"] not in footprint and wire_after["modules"][m_b]["uuid"] not in footprint
        )
        if modules_outside and "suite.xml" in a and "suite.xml" in b:
            index_a, entry_a = _entry(a["suite.xml"], f"m{m_a}-f{f_a}")
            _, entry_b = _entry(b["suite.xml"], f"m{m_b}-f{f_b}")
            if entry_a is not None or entry_b is not None:
                compare(
                    "suite.xml",
                    (entry_a or {}).get("datums"),
                    (entry_b or {}).get("datums"),
                    "/entries/*/datums",
                    f"/entries/{index_a}/datums",
                )

    # The case types HQ learns: each one no footprint module declares and no
    # footprint form writes, nor related to such a one, keeps its properties
    # and index identifiers.
    reached = _related(
        _footprint_case_types(app_a, wire_before["modules"], a, footprint)
        | _footprint_case_types(app_b, wire_after["modules"], b, footprint),
        a["case_types"],
        b["case_types"],
    )
    compare(
        "case_types",
        {case_type: record for case_type, record in a["case_types"].items() if case_type not in reached},
        {case_type: record for case_type, record in b["case_types"].items() if case_type not in reached},
        "",
        "",
    )

    # Lookup tables are the Project's, named by table id in D and D': each one
    # the footprint does not name keeps its tag, fields and field properties.
    tables_a, tables_b = {}, {}
    for table_id, tag in sorted(tables_before.items()):
        if table_id in footprint or table_id not in tables_after:
            continue
        tag_after = tables_after[table_id]
        tables_a[tag] = {"tag": tag, **(a["project"]["lookup_tables"].get(tag) or {})}
        tables_b[tag] = {"tag": tag_after, **(b["project"]["lookup_tables"].get(tag_after) or {})}
    compare("project", tables_a, tables_b, "/lookup_tables", "/lookup_tables")
    for key in ("location_types", "custom_data_fields"):
        compare("project", a["project"][key], b["project"][key], f"/{key}", f"/{key}")
    return found


def local_identity_differences(document, reports):
    """The local path: form xmlns and profile uniqueid equal, the version no lower."""
    first, again = reports.get("local.ccz"), reports.get("local-again.ccz")
    if first is None or again is None:
        return [
            Difference(
                "proof1",
                document,
                "local.ccz",
                "/no-second-local-export",
                "/no-second-local-export",
                "refused",
                None,
                "The document carries no second local export to compare the first with.",
            )
        ]
    before, after = local_identity(first), local_identity(again)
    found = compare_json(
        {"uniqueid": before["profile"]["uniqueid"], "entries": before["entries"]},
        {"uniqueid": after["profile"]["uniqueid"], "entries": after["entries"]},
        check="proof1",
        document=document,
        artifact="local.ccz",
    )
    version_before, version_after = before["profile"]["version"], after["profile"]["version"]
    try:
        lower = int(version_after) < int(version_before)
    except (TypeError, ValueError):
        lower = True
    if lower:
        found.append(
            Difference(
                "proof1", document, "local.ccz", "/version", "/version", "changed", version_before, version_after
            )
        )
    return found


def document_identity(document, records):
    """Proof 1's differences on one document, judged from its records: every publish, the edit, the local path."""
    from proof.checks import observations

    found = []
    for name in sorted(document.exports):
        found += republish_identity(document.id, observations.republish_view(records, name))
    if document.edit is not None and document.edit.exports:
        before = {"modules": document.wire_modules, "languages": document.wire_languages}
        after = {"modules": document.edit_wire_modules, "languages": document.edit_wire_languages}
        tables_before = document_lookup_tags(document)
        tables_after = document_lookup_tags(document, edit=True)
        for name in document.edit.exports:
            found += edit_identity(
                document.id,
                observations.edit_view(records, name),
                before,
                after,
                document.edit.footprint,
                tables_before,
                tables_after,
            )
    from proof.checks import android

    found += android.identity(document.id, android.document_record(records))
    return found + local_identity_differences(document.id, observations.local_reports(records))
