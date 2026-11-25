"""Independent parity for an app's HQ lookup-resource claims.

The lookup tag belongs to a Project resource outside app.json. Core's parsed instance reads and the Search
itemset supply the referenced tags. The authorized lookup table list supplies their exact definitions.
"""

from __future__ import annotations

from lxml import etree

from proof.checks import observations
from proof.checks.differences import Difference, pointer_token
from proof.checks.manifest_value_classes import instance_scheme

ALIAS_ENTRY = "expressions-and-data/tag-equal-to-an-instance-name-commcare-owns"
DOTTED_ENTRY = "expressions-and-data/tag-or-field-name-holding-a-period"
UNICODE_ENTRY = "expressions-and-data/tag-or-field-name-with-non-ascii-letters"
RESOURCE_ENTRIES = {ALIAS_ENTRY, DOTTED_ENTRY, UNICODE_ENTRY}
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
        and not table.get("item_attributes")
        and 0 < len(fields) <= 250
        and len(set(names)) == len(names)
        and all(_hq_name(name, 255) for name in names)
        and not any(field.get("properties") for field in fields)
    )


def _held_rows(document, table, observations_by_tag):
    tag = table["tag"]
    rows = _objects(document, observations_by_tag.get(tag), f"{tag} rows")
    if rows is None or len(rows) > 5000:
        return False
    for row in rows:
        for field in row["fields"].values():
            if isinstance(field, dict):
                values = field.get("field_list", [])
                if len(values) != 1:
                    return False
                field = values[0]["field_value"]
            if not isinstance(field, str) or len(field.encode("utf-8", errors="surrogatepass")) > 65536:
                return False
            try:
                etree.Element("value").text = field
            except (ValueError, UnicodeEncodeError):
                return False
    return True


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
    expected = {
        (where, entry): key
        for table in references
        if accessible and _held_definition(table) and _held_rows(document, table, row_reads)
        for key, where, entry in resource_entries(manifest, table)
    }
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
            "lookup-model:TypeField.name"
            if where.endswith("/field_name")
            else "lookup-model:LookupTable.tag",
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
HQ_CHECKED_NAME = "expressions-and-data/non-ascii-lookup-name-in-a-condition-hq-checks"
CONDITION_ENTRIES = frozenset({OMITTED_INSTANCE, INTERPOLATED_COLUMN, HQ_CHECKED_NAME})


def _hq_xpath_name(name):
    """Whether js-xpath, the XPath reader HQ checks a display condition with (``xpath_validator``), reads ``name`` as
    a name: its ``NCName``, ``[A-Za-z_][A-Za-z0-9._-]*`` (``xpath.jisonlex``)."""
    return bool(name) and name.isascii() and (name[0].isalpha() or name[0] == "_") and all(
        c.isalnum() or c in "._-" for c in name
    )


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
    from corehq.apps.app_manager.xpath_validator import validate_xpath
    from proof.observe.manifest import expression_tree

    for m, (old_module, module) in enumerate(zip(base.get("modules", []), variant.get("modules", []))):
        for f, (old_form, form) in enumerate(zip(old_module["forms"], module["forms"])):
            text = form.get("form_filter")
            if not text or text == old_form.get("form_filter"):
                continue
            declared = get_instance_names(text)
            issues = set()
            for instance_id, columns in _lookup_condition_names(expression_tree(text)):
                tag = instance_id.removeprefix("item-list:")
                unread = [name for name in columns if not _hq_xpath_name(name)]
                if not _hq_xpath_name(tag) or unread:
                    # HQ's own check of the condition answers first: a name its reader does not read fails it.
                    valid, _ = validate_xpath(text, allow_case_hashtags=True)
                    if not valid:
                        if not _hq_xpath_name(tag):
                            issues.add(("lookup-model:LookupTable.tag", HQ_CHECKED_NAME))
                        if unread:
                            issues.add(("lookup-model:TypeField.name", HQ_CHECKED_NAME))
                        # Each name takes its first refusal, as Nova's rule gives one (``lookupPathNameIssue``).
                        columns = [name for name in columns if name not in unread]
                if _hq_xpath_name(tag) and instance_id not in declared:
                    issues.add(("lookup-model:LookupTable.tag", OMITTED_INSTANCE))
                elif instance_id in declared and any(dot_interpolate(name, "CURRENT") != name for name in columns):
                    issues.add(("lookup-model:TypeField.name", INTERPOLATED_COLUMN))
            for key, entry in sorted(issues):
                yield key, f"/modules/{m}/forms/{f}/form_filter", entry
