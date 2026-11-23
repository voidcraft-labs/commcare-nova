"""Independent parity for an app's HQ lookup-resource claims.

The lookup tag belongs to a Project resource outside app.json. Core's parsed instance reads and the Search
itemset supply the referenced tags. The authorized lookup table list supplies their exact definitions, the
fixture list each table's rows, and, for a table whose definition or rows the plain list cannot carry, the row
detail resource each row's attributes (``proof/hq/operations.py::lookup_detail_targets``).

Beside the name classes, a held table's content classes are read off those answers as HQ's restore writes
them (``fixtures/fixturegenerators.py::ItemListsProvider.to_xml``): a field with properties or with several
values in a row is one element a value with its properties as attributes (``FIELD_VALUES_ENTRY``, at
``/<tag>/fields/<i>/properties``); a table's row attributes are attributes of each row's element
(``ROW_ATTRIBUTES_ENTRY``, at ``/<tag>/item_attributes``); and a field a row does not hold is one empty
element while a field it holds no value of is no element at all (``CELL_ABSENCE_ENTRY``, at
``/<tag>/fields/<i>``), which a device tells apart.
"""

from __future__ import annotations

from lxml import etree

from proof.checks import observations
from proof.checks.differences import Difference, pointer_token
from proof.checks.manifest_value_classes import instance_scheme

ALIAS_ENTRY = "expressions-and-data/tag-equal-to-an-instance-name-commcare-owns"
DOTTED_ENTRY = "expressions-and-data/tag-or-field-name-holding-a-period"
UNICODE_ENTRY = "expressions-and-data/tag-or-field-name-with-non-ascii-letters"
FIELD_VALUES_ENTRY = "expressions-and-data/fields-properties-and-multi-valued-cells-name-lang-en-name-name"
ROW_ATTRIBUTES_ENTRY = "expressions-and-data/item-attributes-and-per-row-attribute-values"
CELL_ABSENCE_ENTRY = "expressions-and-data/absent-field-vs-zero-values-vs-empty-string"
# Each content class's surface key: the model field whose value puts a table in it.
CONTENT_KEYS = {
    FIELD_VALUES_ENTRY: "lookup-model:TypeField.properties",
    ROW_ATTRIBUTES_ENTRY: "lookup-model:LookupTable.item_attributes",
    CELL_ABSENCE_ENTRY: "lookup-model:LookupTableRow.fields",
}
RESOURCE_ENTRIES = {ALIAS_ENTRY, DOTTED_ENTRY, UNICODE_ENTRY, *CONTENT_KEYS}
ARTIFACT = "lookup-tables"


def resource_entries(manifest, table):
    """Held name classes of this observed definition, each at its resource pointer."""
    tag = table["tag"]
    # HQ registers the schemes in the extracted manifest. The Search input root is another reserved name in Core.
    if (
        tag in {"__proto__", "hasOwnProperty"}
        or tag.lower() == "input"
        or manifest.item(f"instance-scheme:{instance_scheme(tag.lower())}") is not None
    ):
        yield "lookup-model:LookupTable.tag", f"/{pointer_token(tag)}/tag", ALIAS_ENTRY
    names = [(tag, "lookup-model:LookupTable.tag", "tag")]
    names.extend(
        (
            field["field_name"],
            "lookup-model:TypeField.name",
            f"fields/{index}/field_name",
        )
        for index, field in enumerate(table["fields"])
    )
    for name, key, member in names:
        if not name.isascii():
            yield key, f"/{pointer_token(tag)}/{member}", UNICODE_ENTRY
        elif "." in name:
            yield key, f"/{pointer_token(tag)}/{member}", DOTTED_ENTRY


def _objects(document, answer, resource):
    """None for an observed refusal; an absent, malformed or partial success cannot settle this use."""
    if not isinstance(answer, dict):
        raise observations.RecordIncomplete(f"{document}'s authored read lacks {resource}.")
    if not isinstance(answer.get("status"), int):
        raise observations.RecordIncomplete(f"{document}'s authored read lacks a status for {resource}.")
    if answer["status"] != 200:
        return None
    body = observations.answer_json(answer)
    if not isinstance(body, dict) or not isinstance(body.get("objects"), list):
        raise observations.RecordIncomplete(f"{document}'s authored read lacks {resource} objects.")
    meta = body.get("meta", {})
    if meta.get("next") or len(body["objects"]) != meta.get("total_count", len(body["objects"])):
        raise observations.RecordIncomplete(f"{document}'s authored read lacks all pages of {resource}.")
    return body["objects"]


def _hq_name(name, limit):
    if not isinstance(name, str) or not name or len(name) > limit or name.startswith("xml") or ":" in name:
        return False
    try:
        return etree.QName(name).localname == name
    except ValueError:
        return False


def _held_definition(table):
    """The storage, scope, shape and name preconditions of a Project lookup definition."""
    tag = table["tag"]
    fields = table.get("fields", [])
    names = [field["field_name"] for field in fields]
    return (
        _hq_name(tag, 32)
        and tag.lower() != "types"
        and not any(word in tag for word in ("casedb", "ledgerdb"))
        and table.get("is_global") is True
        and 0 < len(fields) <= 250
        and len(set(names)) == len(names)
        and all(_hq_name(name, 255) for name in names)
    )


def _cell_values(field):
    """A row's values of one field as the fixture list serves them: one string where every field of the row holds
    one value without properties, else ``{"field_list": [{"field_value", "properties"}]}``
    (``FixtureResource.dehydrate_fields``); None where the answer is neither."""
    if isinstance(field, str):
        return [field]
    if isinstance(field, dict) and isinstance(field.get("field_list"), list):
        values = [value.get("field_value") if isinstance(value, dict) else None for value in field["field_list"]]
        return values if all(isinstance(value, str) for value in values) else None
    return None


def _needs_details(table, rows):
    """Whether the reader reads each row's detail (``operations.lookup_detail_targets``)."""
    return bool(
        table.get("item_attributes")
        or any(field.get("properties") for field in table["fields"])
        or any(not isinstance(value, str) for row in rows for value in row["fields"].values())
    )


def _held_rows(document, table, observations_by_tag, details):
    """The table's rows where every value of them is one Nova holds, each row's detail where the reader reads one,
    and every row holds every row attribute the table names (HQ's restore raises on one that does not,
    ``to_xml``'s ``FixtureTypeCheckError``); None where they are not."""
    tag = table["tag"]
    rows = _objects(document, observations_by_tag.get(tag), f"{tag} rows")
    if rows is None or len(rows) > 5000:
        return None
    for row in rows:
        for field in row["fields"].values():
            values = _cell_values(field)
            if values is None:
                return None
            for value in values:
                if len(value.encode("utf-8", errors="surrogatepass")) > 65536:
                    return None
                try:
                    etree.Element("value").text = value
                except (ValueError, UnicodeEncodeError):
                    return None
    if _needs_details(table, rows):
        for row in rows:
            answer = details.get(row["id"])
            if not isinstance(answer, dict) or answer.get("status") != 200:
                raise observations.RecordIncomplete(f"{document}'s authored read lacks the detail of a {tag} row.")
            detail = observations.answer_json(answer)
            attributes = detail.get("item_attributes") if isinstance(detail, dict) else None
            if not isinstance(attributes, dict) or any(name not in attributes for name in table.get("item_attributes") or []):
                return None
    return rows


def content_entries(table, rows):
    """The content classes of a held table's definition and rows, each ``(key, where, entry)`` (the module's
    docstring)."""
    at = f"/{pointer_token(table['tag'])}"
    for index, field in enumerate(table["fields"]):
        held = [row["fields"].get(field["field_name"]) for row in rows]
        values = [None if value is None else _cell_values(value) for value in held]
        if field.get("properties") or any(value is not None and len(value) > 1 for value in values):
            yield CONTENT_KEYS[FIELD_VALUES_ENTRY], f"{at}/fields/{index}/properties", FIELD_VALUES_ENTRY
        if any(value is None or len(value) == 0 for value in values):
            yield CONTENT_KEYS[CELL_ABSENCE_ENTRY], f"{at}/fields/{index}", CELL_ABSENCE_ENTRY
    if table.get("item_attributes"):
        yield CONTENT_KEYS[ROW_ATTRIBUTES_ENTRY], f"{at}/item_attributes", ROW_ATTRIBUTES_ENTRY


def differences(document, manifest, tags, reads, claims):
    """A referenced and admissible resource receives exactly its observed name-class claims."""
    data = reads.get("projectData", {})
    definitions = _objects(document, data.get("lookupTables"), "the lookup definition list") if tags else []
    references = [table for table in definitions or [] if table["tag"] in tags]
    row_reads = data.get("fixtureRows", {})
    # A permission or availability failure while fetching any referenced table stops the whole request.
    # A repeatable 500 from HQ itself is attributed to that table's rows by the production transport.
    accessible = True
    for table in references:
        answer = row_reads.get(table["tag"])
        if not isinstance(answer, dict) or not isinstance(answer.get("status"), int):
            raise observations.RecordIncomplete(f"{document}'s authored read lacks {table['tag']} rows.")
        status = answer["status"]
        if status != 200 and (status < 500 or status in (502, 503, 504)):
            accessible = False
    details = data.get("fixtureDetails") or {}
    expected = {}
    for table in references:
        if not (accessible and _held_definition(table)):
            continue
        rows = _held_rows(document, table, row_reads, details)
        if rows is None:
            continue
        for key, where, entry in (*resource_entries(manifest, table), *content_entries(table, rows)):
            expected[(where, entry)] = key
    actual = {
        (record.where, record.entry): record.standing
        for record in claims
        if record.artifact == ARTIFACT and record.entry in RESOURCE_ENTRIES
    }
    found = []
    for where, entry in sorted(expected.keys() | actual.keys()):
        pair = (where, entry)
        if pair in expected and actual.get(pair) == "held":
            continue
        key = expected.get(
            pair,
            CONTENT_KEYS.get(entry)
            or ("lookup-model:TypeField.name" if where.endswith("/field_name") else "lookup-model:LookupTable.tag"),
        )
        what = (
            "unseen"
            if pair not in expected
            else "unclaimed"
            if pair not in actual
            else "standing"
        )
        path = f"/{pointer_token(key)}/{what}"
        found.append(
            Difference(
                "parity",
                document,
                "claims@A",
                path,
                f"{path}@{ARTIFACT}{where}",
                "changed",
                {"standing": "held", "entries": [entry]} if pair in expected else None,
                {"standing": actual[pair], "entry": entry} if pair in actual else None,
            )
        )
    return found


OMITTED_INSTANCE = "expressions-and-data/lookup-table-instance-undiscovered-in-suite"
INTERPOLATED_COLUMN = "expressions-and-data/dotted-column-interpolated-in-suite"


def _lookup_condition_names(tree):
    """Yield the literal fixture instance and each column its parsed location path selects or tests."""
    if not isinstance(tree, list) or not tree:
        return
    if tree[0] == "path" and tree[1].startswith("instance:item-list:"):
        instance_id = tree[1].removeprefix("instance:")
        names = set()

        def columns(node):
            if not isinstance(node, list) or not node:
                return
            if node[0] == "path":
                if node[1] == "relative":
                    names.update(test for axis, test, _ in node[4] if axis == "child")
            else:
                for part in node:
                    columns(part)

        # The first two steps identify the list and row tags. A predicate on
        # that row and the result path following it refer to its columns.
        names.update(test for axis, test, _ in tree[4][2:] if axis == "child")
        for predicate in tree[3]:
            columns(predicate)
        yield instance_id, names
    for nested in tree:
        yield from _lookup_condition_names(nested)


def changed_form_condition_refusals(base, variant):
    """Uses at changed form conditions. HQ's own parser identifies the lookup and column; its actual suite
    discovery and dot interpolation determine each failing class without reading the variant's expected result."""
    from corehq.apps.app_manager.suite_xml.post_process.instances import get_instance_names
    from corehq.apps.app_manager.xpath import dot_interpolate
    from proof.observe.manifest import expression_tree

    for m, (old_module, module) in enumerate(zip(base.get("modules", []), variant.get("modules", []))):
        for f, (old_form, form) in enumerate(zip(old_module["forms"], module["forms"])):
            text = form.get("form_filter")
            if not text or text == old_form.get("form_filter"):
                continue
            declared = get_instance_names(text)
            issues = set()
            for instance_id, columns in _lookup_condition_names(expression_tree(text)):
                if instance_id not in declared:
                    issues.add(("lookup-model:LookupTable.tag", OMITTED_INSTANCE))
                elif any(dot_interpolate(name, "CURRENT") != name for name in columns):
                    issues.add(("lookup-model:TypeField.name", INTERPOLATED_COLUMN))
            for key, entry in sorted(issues):
                yield key, f"/modules/{m}/forms/{f}/form_filter", entry
