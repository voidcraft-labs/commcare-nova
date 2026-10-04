"""What a person saves in HQ over A before Nova's next publish, saved through HQ's own views (``hq-side.json``).

A corpus document may carry ``hq-side.json`` (``proof/corpus/documents.ts::HqSideSaves``): what a person saves in
HQ between Nova's first publish of it and the next. The unit saves it over A after A's create and media upload and
before A's build (``proof.observe.unit``), so A is what HQ holds when Nova publishes again, and B and B-edit are
published over it. Each save is an operation of its own, keyed by what it sends, and reaches HQ as the person's
page or upload reaches it: a request built as an editor's request is (``proof.hq.requests``), resolved through
HQ's URLconf and answered by the view it names, decorators and all.

- ``uiTranslations``: for each language, the texts A holds for it with the person's beside them, posted as the UI
  translations page posts them (``translations/js/bootstrap5/translations.js``: ``doc_id``, ``lang`` and
  ``translations``, each JSON) to ``views/apps.py::edit_app_ui_translations``;
- ``appAttributes``: each attribute posted as a setting's own save posts it (``{"hq": {attribute: value}}``) to
  ``views/apps.py::edit_app_attr``;
- ``buildProfiles``: the profiles posted as the language profiles page posts them (``{"profiles": [...]}``) to
  ``views/releases.py::LanguageProfilesView``;
- ``lookupTable``: the table A holds under its tag as a person keeps it. A mobile worker, a group and a location
  are made in the project space as HQ holds them (``proof.hq.operations.seed_mobile_worker``, ``seed_group``,
  ``seed_location``); the table is written as HQ's download writes it (``fixtures/download.py``: its rows by id,
  in its order), with a property on one field and an attribute and those three owners on every row, and
  uploaded through HQ's lookup upload without ``replace``, as HQ's upload page sends it by default
  (``fixtures/upload/run_upload.py::_run_upload``); then HQ's table editor gives it a description
  (``fixtures/views.py::update_tables``, the PUT the editor sends).

A save HQ refuses stops the observation (``HqSideSaveRefused``): the harness makes these saves, so a refusal is a
harness that no longer saves as a person does, not something of Nova's to judge. ``save`` returns what the unit
records of the saves: each one's kind and HQ's answer.
"""

from __future__ import annotations

import hashlib
import json

from proof.hq.boot import HarnessRefusal


class HqSideSaveRefused(HarnessRefusal):
    """HQ refused a save the harness made over A in a person's place."""


def _digest(value) -> bytes:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).digest()


def _answer(unit, method, view, args, body: bytes, content_type: str, what):
    """HQ's answer to one request to the view named ``view`` (its URL reversed from ``args``), as the record keeps
    it: the view, the status and the start of the body. A view that raises or answers with an error stops the
    observation (``HqSideSaveRefused``)."""
    from django.urls import resolve, reverse

    from proof.hq import requests as hq_requests

    path = reverse(view, args=args)
    match = resolve(path)
    request = hq_requests.raw(unit, method, path, body, content_type)
    try:
        response = match.func(request, *match.args, **match.kwargs)
    except HarnessRefusal:
        raise
    except Exception as error:
        raise HqSideSaveRefused(
            f"HQ's view refused the {what} the harness saves over A in a person's place ({method} {path}):"
            f" {type(error).__module__}.{type(error).__name__}: {error}. The harness saves it as HQ's page does;"
            " look at what the view now asks of the request or of the project space."
        ) from error
    content = response.content
    if not 200 <= response.status_code < 300:
        raise HqSideSaveRefused(
            f"HQ answered the {what} the harness saves over A in a person's place ({method} {path}) with"
            f" {response.status_code}: {content[:400]!r}. The harness saves it as HQ's page does; look at what the"
            " view now asks of the request."
        )
    return {"view": view, "status": response.status_code, "body": content.decode("utf-8", "replace")[:400]}


def _form(pairs):
    from urllib.parse import urlencode

    return urlencode(pairs).encode(), "application/x-www-form-urlencoded; charset=UTF-8"


def _json_body(value):
    return json.dumps(value).encode(), "application/json"


def ui_translations(unit, app_id, translations):
    """Each language's texts saved on the UI translations page, beside the texts A holds for it."""
    from proof.hq import operations

    found = []
    for lang, texts in sorted(translations.items()):
        held = dict(operations.held_app(unit, app_id).translations.get(lang) or {})
        body, content_type = _form(
            [
                ("doc_id", json.dumps(app_id)),
                ("lang", json.dumps(lang)),
                ("translations", json.dumps({**held, **texts})),
            ]
        )
        found.append(
            _answer(
                unit, "POST", "edit_app_ui_translations", [unit.domain, app_id], body, content_type, "UI translations"
            )
        )
    return found


def app_attributes(unit, app_id, attributes):
    """Each app attribute saved as the settings page's save of it sends it."""
    found = []
    for attribute, value in sorted(attributes.items()):
        body, content_type = _json_body({"hq": {attribute: value}})
        found.append(
            _answer(
                unit,
                "POST",
                "edit_app_attr",
                [unit.domain, app_id, attribute],
                body,
                content_type,
                f"app attribute {attribute}",
            )
        )
    return found


def build_profiles(unit, app_id, profiles):
    """The build profiles saved as the language profiles page saves them."""
    body, content_type = _json_body(
        {"profiles": [{"id": p["id"], "name": p["name"], "langs": list(p["langs"])} for p in profiles]}
    )
    return [_answer(unit, "POST", "build_profiles", [unit.domain, app_id], body, content_type, "build profiles")]


def _owner_id(kind, name):
    """A fixed id for an owner the harness makes in the project space, drawn from its name."""
    return f"{kind}-" + hashlib.sha256(name.encode()).hexdigest()[:24]


def table_workbook(table, rows, owners, field_property, row_attribute):
    """The table as HQ's download writes it (``fixtures/download.py``), a person's property, attribute and owners
    added: the ``types`` sheet and the table's own, each its headers and rows, as ``couchexport``'s ``export_raw``
    takes them."""
    fields = [field.name for field in table.fields]
    if field_property["field"] not in fields:
        raise ValueError(
            f"hq-side.json gives the field {field_property['field']!r} a property, and the table {table.tag} holds"
            f" the fields {fields}."
        )
    if len(row_attribute["values"]) != len(rows):
        raise ValueError(
            f"hq-side.json gives {len(row_attribute['values'])} values of the attribute {row_attribute['name']!r},"
            f" and the table {table.tag} holds {len(rows)} rows."
        )
    position = fields.index(field_property["field"]) + 1
    types_headers = (
        "Delete(Y/N)",
        "table_id",
        "is_global?",
        *(f"field {index}" for index in range(1, len(fields) + 1)),
        "property 1",
        f"field {position} : property 1",
    )
    types_row = (
        "N",
        table.tag,
        "yes" if table.is_global else "no",
        *fields,
        row_attribute["name"],
        field_property["property"],
    )
    field_headers = []
    for name in fields:
        if name == field_property["field"]:
            field_headers += [f"{name}: {field_property['property']} 1", f"field: {name} 1"]
        else:
            field_headers.append(f"field: {name}")
    headers = (
        "UID",
        "Delete(Y/N)",
        *field_headers,
        f"property: {row_attribute['name']}",
        "user 1",
        "group 1",
        "location 1",
    )
    sheet_rows = []
    for row, attribute in zip(rows, row_attribute["values"], strict=True):
        values = []
        for name in fields:
            held = row.fields[name][0].value if row.fields.get(name) else ""
            if name == field_property["field"]:
                values += [field_property["value"], held]
            else:
                values.append(held)
        sheet_rows.append(
            (
                row.id.hex,
                "N",
                *values,
                attribute,
                owners["user"],
                owners["group"],
                owners["location"]["siteCode"],
            )
        )
    return [("types", types_headers, [types_row]), (table.tag, headers, sheet_rows)]


def _xlsx(sheets) -> bytes:
    from io import BytesIO

    from couchexport.export import export_raw
    from couchexport.models import Format

    out = BytesIO()
    export_raw(
        [(name, headers) for name, headers, _ in sheets],
        [(name, rows) for name, _, rows in sheets],
        out,
        format=Format.XLS_2007,
    )
    return out.getvalue()


def lookup_table(unit, spec):
    """The table A holds under ``spec["tag"]`` as a person keeps it: its owners made, the table uploaded with a
    property, an attribute and owners, then described."""
    from corehq.apps.fixtures.models import LookupTable, LookupTableRow

    from proof.hq import operations

    owners = spec["owners"]
    operations.seed_mobile_worker(unit, owners["user"], _owner_id("user", owners["user"]))
    operations.seed_group(unit, owners["group"], _owner_id("group", owners["group"]))
    operations.seed_location(unit, owners["location"]["name"], owners["location"]["siteCode"])
    table = LookupTable.objects.get(domain=unit.domain, tag=spec["tag"])
    rows = list(LookupTableRow.objects.iter_rows(unit.domain, tag=spec["tag"]))
    sheets = table_workbook(table, rows, owners, spec["fieldProperty"], spec["rowAttribute"])
    uploaded = operations.upload_lookup_workbook(unit, _xlsx(sheets), replace=False)
    if uploaded.errors:
        raise HqSideSaveRefused(
            f"HQ's lookup upload refused the {spec['tag']} table the harness uploads over A in a person's place:"
            f" {list(uploaded.errors)}. The harness writes it as HQ's download does; look at what the upload now"
            " reads of the workbook."
        )
    table = LookupTable.objects.get(domain=unit.domain, tag=spec["tag"])
    body, content_type = _json_body(
        {
            "tag": table.tag,
            "is_global": table.is_global,
            "description": spec["description"],
            "fields": {field.name: {} for field in table.fields},
        }
    )
    described = _answer(
        unit,
        "PUT",
        "update_lookup_tables",
        [unit.domain, table.id.hex],
        body,
        content_type,
        f"description of the {spec['tag']} table",
    )
    return [{"view": "_run_upload", "messages": [str(message) for message in uploaded.messages]}, described]


SAVES = (
    ("uiTranslations", lambda unit, app_id, value: ui_translations(unit, app_id, value)),
    ("appAttributes", lambda unit, app_id, value: app_attributes(unit, app_id, value)),
    ("buildProfiles", lambda unit, app_id, value: build_profiles(unit, app_id, value)),
    ("lookupTable", lambda unit, app_id, value: lookup_table(unit, value)),
)


def save(unit, ops, app_id, saves):
    """Every save ``saves`` (``hq-side.json``) names, each an operation of ``ops`` keyed by what it saves, in
    ``SAVES``' order; what HQ answered each, by its kind."""
    unknown = sorted(set(saves) - {kind for kind, _ in SAVES})
    if unknown:
        raise ValueError(
            f"hq-side.json names {unknown}, which the harness does not save; it saves {[kind for kind, _ in SAVES]}."
        )
    found = {}
    for kind, run in SAVES:
        if kind not in saves:
            continue
        with ops(f"hq-side:{kind}", _digest(saves[kind])):
            found[kind] = run(unit, app_id, saves[kind])
    return found
