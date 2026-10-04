"""Proof 1's identities, read from HQ's objects where HQ keeps each (``proof.checks.identity`` names them).

``app_identity`` reads every identity record of one app state (what each
holds is ``proof.checks.identity``'s list): the stored
document's (``stored_identity``) with each module's and form's
media paths as HQ lists them, each form's questions and case updates as HQ's
own readers list them, the case blocks of each form HQ built, the suite's
datums and endpoints, the case types HQ learns, and what the project space
holds that apps read by name.
"""

from __future__ import annotations

import json

from lxml import etree

from proof.checks.compare.xml_tree import parse_xml

CASE_XMLNS = "http://commcarehq.org/case/transaction/v2"
MODULE_KEYS = (
    "unique_id",
    "case_type",
    "session_endpoint_id",
    "case_list_session_endpoint_id",
    "form_session_endpoints",
)
FORM_KEYS = ("unique_id", "xmlns", "session_endpoint_id", "case_references_data")


def _json(value):
    """A JSON copy of what HQ holds (lazy strings and dates as text)."""
    return json.loads(json.dumps(value, default=str))


def stored_identity(doc):
    """The ``app.json`` identities of a stored app document."""
    record = {
        "_id": doc.get("_id"),
        "langs": doc.get("langs"),
        "build_profiles": {
            key: {"langs": value.get("langs")} for key, value in (doc.get("build_profiles") or {}).items()
        },
        "multimedia_map": {path: {} for path in (doc.get("multimedia_map") or {})},
        "modules": [],
    }
    for module in doc.get("modules", []):
        entry = {key: module[key] for key in MODULE_KEYS if key in module}
        search = module.get("search_config") or {}
        if "case_search_endpoint_id" in search:
            entry["search_config"] = {"case_search_endpoint_id": search["case_search_endpoint_id"]}
        entry["forms"] = [{key: form[key] for key in FORM_KEYS if key in form} for form in module.get("forms", [])]
        record["modules"].append(entry)
    return _json(record)


def data_namespace(source):
    """The namespace of an XForm's data node (its ``xmlns``), or None when it has none."""
    if not source:
        return None
    root = parse_xml(source)
    for element in root.iter():
        if isinstance(element.tag, str) and etree.QName(element).localname == "instance":
            for child in element:
                if isinstance(child.tag, str):
                    return etree.QName(child).namespace
            return None
    return None


def _case_blocks(form_xml):
    """The element path, from the data node, of every case transaction block in a built XForm."""
    root = parse_xml(form_xml)
    data = None
    for element in root.iter():
        if isinstance(element.tag, str) and etree.QName(element).localname == "instance":
            data = next((child for child in element if isinstance(child.tag, str)), None)
            break
    if data is None:
        return []
    blocks = []
    for element in data.iter():
        if isinstance(element.tag, str) and etree.QName(element).namespace == CASE_XMLNS:
            if etree.QName(element).localname == "case":
                names = []
                node = element
                while node is not None and node is not data.getparent():
                    names.append(etree.QName(node).localname)
                    node = node.getparent()
                blocks.append("/" + "/".join(reversed(names)))
    return blocks


def suite_identity(suite_xml):
    """The ``suite.xml`` identities: each entry's datum ids and every session endpoint id."""
    root = parse_xml(suite_xml)
    entries = []
    for entry in root:
        if not isinstance(entry.tag, str) or etree.QName(entry).localname != "entry":
            continue
        command = next(
            (c.get("id") for c in entry if isinstance(c.tag, str) and etree.QName(c).localname == "command"), None
        )
        datums = []
        for session in entry:
            if isinstance(session.tag, str) and etree.QName(session).localname == "session":
                for datum in session:
                    if isinstance(datum.tag, str) and etree.QName(datum).localname in ("datum", "instance-datum"):
                        datums.append(datum.get("id"))
        entries.append({"command": command, "datums": datums})
    endpoints = [
        element.get("id")
        for element in root
        if isinstance(element.tag, str) and etree.QName(element).localname == "endpoint"
    ]
    return {"entries": entries, "endpoints": endpoints}


def form_identities(app, built_files):
    """Each form's ``form:<m>.<f>`` identities, from the app HQ holds and the XForms HQ built."""
    from corehq.apps.app_manager.exceptions import XFormException
    from corehq.apps.export.models.new import FormExportDataSchema

    records = {}
    for form in app.get_forms():
        module_index, form_index = form.get_module().id, form.id
        record = {"xmlns": data_namespace(form.source)}
        try:
            listed = form.get_questions(app.langs, include_triggers=True, include_groups=True)
        except XFormException as error:
            # HQ cannot read the form's questions (the bar reports why); proof 1 compares that verdict.
            record["questions_unreadable"] = str(error)
            listed = []
        questions = {}
        for question in listed:
            entry = {
                "repeat": question.get("repeat"),
                "class": FormExportDataSchema.datatype_mapping[question["type"]].__name__,
            }
            if question.get("options"):
                entry["options"] = [option["value"] for option in question["options"]]
            questions[question["value"]] = entry
        record["questions"] = questions
        record["order"] = [question["value"] for question in listed]
        record["case_updates"] = {
            case_type: {name: {} for name in sorted(names)} for case_type, names in form.get_all_case_updates().items()
        }
        built = (built_files or {}).get(f"modules-{module_index}/forms-{form_index}.xml")
        if built is not None:
            record["case_blocks"] = _case_blocks(built)
        records[f"form:{module_index}.{form_index}"] = _json(record)
    return records


def case_identity(app):
    """The ``case_types`` HQ learns from the app: properties and index identifiers per case type."""
    from corehq.apps.app_manager.app_schemas.case_properties import ParentCasePropertyBuilder

    builder = ParentCasePropertyBuilder.for_app(app, defaults=("name",), exclude_invalid_properties=True)
    case_types = sorted(app.get_case_types())
    properties = builder.get_case_property_map(case_types)
    parents = builder.get_parent_type_map(case_types)
    record = {}
    for case_type in case_types:
        record[case_type] = {
            "properties": {name: {} for name in properties.get(case_type, [])},
            "indices": {identifier: sorted(types) for identifier, types in parents.get(case_type, {}).items()},
        }
    return _json(record)


def _owners(domain, rows):
    """Each row's owners (``LookupTableRowOwner``), by row id, as ``<owner type>:<owner id>``, sorted."""
    from corehq.apps.fixtures.models import LookupTableRowOwner, OwnerType

    found = {row.id: [] for row in rows}
    for owner in LookupTableRowOwner.objects.filter(domain=domain, row_id__in=list(found)):
        found[owner.row_id].append(f"{OwnerType(owner.owner_type).name.lower()}:{owner.owner_id}")
    return {row_id: sorted(owners) for row_id, owners in found.items()}


def project_identity(domain):
    """The ``project`` identities HQ's state holds for the project space.

    Each lookup table is keyed by its tag, which apps read it by: its id, its
    description, its fields with their properties, its row attributes, and
    each row in the table's order (``iter_rows``: by sort key, the order every
    restore serves them in) with its id, its attributes and its owners
    (``LookupTableRowOwner``).
    """
    from corehq.apps.custom_data_fields.models import Field
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow
    from corehq.apps.locations.models import LocationType

    tables = {}
    for table in LookupTable.objects.filter(domain=domain):
        rows = list(LookupTableRow.objects.iter_rows(domain, table_id=table.id))
        owners = _owners(domain, rows)
        tables[table.tag] = {
            "id": table.id.hex,
            "description": table.description,
            "fields": {field.name: {"properties": list(field.properties)} for field in table.fields},
            "item_attributes": list(table.item_attributes),
            "rows": [
                {"id": row.id.hex, "item_attributes": dict(row.item_attributes), "owners": owners[row.id]}
                for row in rows
            ],
        }
    location_types = {code: {} for code in LocationType.objects.filter(domain=domain).values_list("code", flat=True)}
    custom = {}
    for slug, field_type in Field.objects.filter(definition__domain=domain).values_list(
        "slug", "definition__field_type"
    ):
        custom.setdefault(field_type, {})[slug] = {}
    return _json({"lookup_tables": tables, "location_types": location_types, "custom_data_fields": custom})


def _media(item, mapped):
    return {path: {"mapped": path in mapped} for path in sorted(item.all_media_paths())}


def media_identity(app, stored):
    """``stored`` (``stored_identity``'s record) with each module's and form's media paths."""
    mapped = set(app.multimedia_map or {})
    for module, entry in zip(app.get_modules(), stored["modules"], strict=True):
        entry["media"] = _media(module, mapped)
        for form, form_entry in zip(module.get_forms(), entry["forms"], strict=True):
            form_entry["media"] = _media(form, mapped)
    return stored


def app_identity(app, built_files, domain):
    """Every identity record of one app state, by artifact."""
    records = {"app.json": media_identity(app, stored_identity(app.to_json()))}
    records.update(form_identities(app, built_files))
    if built_files is not None and "suite.xml" in built_files:
        records["suite.xml"] = suite_identity(built_files["suite.xml"])
    records["case_types"] = case_identity(app)
    records["project"] = project_identity(domain)
    return records
