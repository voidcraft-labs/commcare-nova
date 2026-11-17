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
- ``appAttributes``: each attribute the person changes on the app settings page, where HQ lists it as an ``hq``
  setting (``static/app_manager/json/commcare-app-settings.yml``), posted as that page posts it
  (``{"hq": {...}}``, beside the custom properties the page holds, ``_page_custom_properties``) to
  ``views/settings.py::edit_commcare_settings`` (the page's save, ``views/apps.py::get_app_view_context``'
  ``urls.save``). That view runs ``edit_commcare_profile`` (which, under ``CUSTOM_PROPERTIES``, resets
  ``custom_properties`` to ``{}`` and stores the ones posted) and then ``views/apps.py::edit_app_attr`` with
  ``attr`` ``all``, which stores each attribute the body names under ``hq``. An attribute's own URL is no save the
  page makes, and ``edit_app_attr`` answers it with 400 for every attribute outside its short list,
  ``secure_submissions`` among them. The page's body names every setting it holds, and both views store only the
  settings a body names but the custom properties, which the page posts whole, so a body naming the person's
  change and the custom properties stores what the page's save stores of it. The page
  shows some of these settings to a previewer only (``preview: true``, ``commcare_settings.js``' ``visible``:
  ``secure_submissions`` is one), so the person who saves one is a previewer;
- ``buildProfiles``: the profiles posted as the language profiles page posts them (``{"profiles": [...]}``) to
  ``views/releases.py::LanguageProfilesView``;
- ``lookupTable``: the table A holds under its tag as a person keeps it. A mobile worker, a group and a location
  are made in the project space as HQ holds them (``proof.hq.operations.seed_mobile_worker``, ``seed_group``,
  ``seed_location``); the table is written as HQ's download writes it (``fixtures/download.py``: its rows by id,
  in its order), with a property on one field and an attribute and those three owners on every row, and
  uploaded through HQ's lookup upload without ``replace``, as HQ's upload page sends it by default
  (``fixtures/upload/run_upload.py::_run_upload``); then HQ's table editor gives it a description
  (``fixtures/views.py::update_tables``, the PUT the editor sends);
- ``addOns``: the add-ons section as the person saves it, posted as the section posts its switches (``on`` or
  empty, by slug) to ``views/apps.py::edit_add_ons``, which stores each slug it lists and no other. The section
  posts every slug HQ lists (``app_manager/js/add_ons.js``, ``EditAddOns``), and ``edit_add_ons`` fills an empty
  map with every slug before it stores the posted ones (``add_ons.get_dict``, ``add_ons.init_app``), so a save
  naming fewer is not what a person's page sends and is refused (``HqSideSaveRefused``);
- ``profileProperties``: each setting the person changes on the app settings page, posted as that page posts it
  (``{"properties": {...}}``, beside the custom properties the page holds) to
  ``views/settings.py::edit_commcare_profile``, which stores each beside the settings A holds (and, under
  ``CUSTOM_PROPERTIES``, resets ``custom_properties`` to ``{}`` and stores the posted ones, so A keeps each but one
  with an empty key or value);
- ``profileFeatures``: each profile feature the person changes on the same page (the worker activity level
  ``credentials`` among them), posted as that page posts it (``{"features": {...}}``, with the same custom
  properties) to the same view, which stores each beside the features A holds, with the same reset and refill.

Then the saves a person makes to the app's content (``proof/corpus/documents.ts::HqSideContentSaves``), each a menu
or form named by its place in the app HQ holds:

- ``formLabel`` and ``formResave``: a form opened in HQ's form builder and saved by its own Save
  (``proof/editors/vellum.py::open_and_save``, in the unit's editor driver), the first after one label is set in the
  app's first language (the run's ``edit``, made the way ``edit`` names);
- ``questions``: the form's source saved as the form builder saves it, a patch from the source HQ holds with its
  ``sha1`` (``views/forms.py::patch_xform``, ``xform_patch``), held to land as posted;
- ``formAttribute``: the form's settings posted by name to ``views/forms.py::edit_form_attr``;
- ``formActions``: the form's case management as the Case Management tab posts it
  (``views/forms.py::edit_form_actions``: the actions as HQ holds them, through ``make_multi``, and each new mapping
  as the ``case_mapping_diff``);
- ``moduleAttribute``: the menu's name posted to ``views/modules.py::edit_module_attr``;
- ``moduleDetail``: the Case List page's save of its columns with one added at the end
  (``views/modules.py::edit_module_detail_screens``), the list's own settings posted as HQ holds them;
- ``formsAddedAndRemoved``: a form deleted (``views/forms.py::delete_form``), a survey added
  (``views/forms.py::new_form``) and its questions saved through ``patch_xform``;
- ``order``: a menu and a form moved as the sidebar's drag posts them (``views/apps.py::rearrange``);
- ``mediaReplaced``: a picture uploaded at a path the app holds (``hqmedia/views.py::ProcessImageFileUploadView``),
  held to map the path to the document of the posted bytes.

``hq-side.json`` also states what Nova's next publish over the saves does (``republish``, with ``stopCode`` where
it stops, ``recorded``, what the review answers, where it records a review that finds nothing to bring in, and
``bringsIn``, the document the bring-in gives, where it brings the saves in), which the capture holds at emission
(``proof/corpus/publish.ts``); none is a save.

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


def _answer(unit, method, view, args, body: bytes, content_type: str, what, *, redirects=False):
    """HQ's answer to one request to the view named ``view`` (its URL reversed from ``args``), as the record keeps
    it: the view, the status and the start of the body. A view that raises or answers with an error stops the
    observation (``HqSideSaveRefused``). ``redirects`` admits the redirect a view whose page posts a form answers
    every save with (``views/utils.py::back_to_main``)."""
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
    if not (200 <= response.status_code < 300 or (redirects and response.status_code == 302)):
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


def _page_custom_properties(unit, app_id):
    """The custom properties the app settings page posts with every save, as it posts them.

    The page lists the custom properties A holds where the project space holds ``CUSTOM_PROPERTIES`` and A's
    profile has the key (``views/apps.py::get_app_view_context``' ``customProperties``), and its save posts each one
    whose key and value are both set (``commcare_settings.js``' ``serialize``), and ``{}`` where it lists none.
    ``edit_commcare_profile`` resets ``custom_properties`` to ``{}`` under the flag before it stores the posted ones,
    so a page's save keeps every custom property A holds but one with an empty key or value. A body without them
    would clear every one, Nova's ``cc-index-case-search-results`` among them, which no save of the page does."""
    from corehq import toggles

    from proof.hq import operations

    app = operations.held_app(unit, app_id)
    held = app.profile.get("custom_properties") if app.get_doc_type() == "Application" else None
    if not toggles.CUSTOM_PROPERTIES.enabled(unit.domain) or held is None:
        return {}
    return {key: value for key, value in held.items() if key and value}


def _settings_page_body(unit, app_id, settings):
    """The JSON body the app settings page's save posts: ``settings`` beside the custom properties it holds."""
    return _json_body({**settings, "custom_properties": _page_custom_properties(unit, app_id)})


def app_attributes(unit, app_id, attributes):
    """The app attributes saved as the app settings page saves them: one save, every attribute under ``hq``."""
    body, content_type = _settings_page_body(unit, app_id, {"hq": dict(sorted(attributes.items()))})
    return [
        _answer(
            unit,
            "POST",
            "edit_commcare_settings",
            [unit.domain, app_id],
            body,
            content_type,
            f"app attributes {sorted(attributes)}",
        )
    ]


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


def add_ons(unit, app_id, switches):
    """Every add-on switched on or off as the add-ons section saves it: ``on``, or empty for off."""
    from corehq.apps.app_manager.add_ons import _ADD_ONS

    if set(switches) != set(_ADD_ONS):
        raise HqSideSaveRefused(
            f"hq-side.json's addOns names {sorted(switches)}, and HQ's add-ons section posts every add-on HQ lists,"
            f" {sorted(_ADD_ONS)} (app_manager/js/add_ons.js, EditAddOns). State each at the value the section"
            " shows, with the person's switches changed."
        )
    body, content_type = _form([(slug, "on" if on else "") for slug, on in sorted(switches.items())])
    return [_answer(unit, "POST", "edit_add_ons", [unit.domain, app_id], body, content_type, "add-ons")]


def profile_properties(unit, app_id, properties):
    """Each setting saved as the app settings page saves it."""
    body, content_type = _settings_page_body(unit, app_id, {"properties": dict(sorted(properties.items()))})
    return [_answer(unit, "POST", "edit_commcare_profile", [unit.domain, app_id], body, content_type, "app settings")]


def profile_features(unit, app_id, features):
    """Each profile feature saved as the app settings page saves it."""
    body, content_type = _settings_page_body(unit, app_id, {"features": dict(sorted(features.items()))})
    return [_answer(unit, "POST", "edit_commcare_profile", [unit.domain, app_id], body, content_type, "app features")]


# -- a person's saves to the app's content --------------------------------------------------------------------------


def _places(unit, app_id, place):
    """The ids HQ holds for the menu and the form at ``place`` (``{module, form}``, each from 0), and the form."""
    app = _operations().held_app(unit, app_id)
    module = app.get_module(place["module"])
    form = module.get_form(place["form"])
    return module.unique_id, form.unique_id, form


def _operations():
    from proof.hq import operations

    return operations


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def xform_patch(old: str, new: str) -> str:
    """The patch HQ's form builder posts for a save from ``old`` to ``new``: a diff-match-patch patch over the two
    sources encoded as the builder encodes them before it diffs (``encodeURI``, which ``views/forms.py::apply_patch``
    matches with ``ENCODE_URI_SAFE`` before it applies the patch)."""
    from urllib.parse import quote

    from corehq.apps.app_manager.views.forms import ENCODE_URI_SAFE
    from diff_match_patch import diff_match_patch

    dmp = diff_match_patch()
    return dmp.patch_toText(dmp.patch_make(quote(old, safe=ENCODE_URI_SAFE), quote(new, safe=ENCODE_URI_SAFE)))


def _patched(unit, app_id, form_unique_id, xform, what):
    """The form's source saved to ``xform`` as the form builder saves it (``views/forms.py::patch_xform``: a patch
    from the source HQ holds, with that source's ``sha1``), and held to land as posted: HQ answers a stale
    ``sha1`` with a conflict, and ``util.py::save_xform`` stores the bytes as posted where the form's ``xmlns`` is
    its own."""
    app = _operations().held_app(unit, app_id)
    source = app.get_form(form_unique_id).source
    body, content_type = _form([("patch", xform_patch(source, xform)), ("sha1", _sha1(source))])
    found = _answer(unit, "POST", "patch_xform", [unit.domain, app_id, form_unique_id], body, content_type, what)
    stored = _operations().held_app(unit, app_id).get_form(form_unique_id).source
    if stored != xform:
        raise HqSideSaveRefused(
            f"HQ's form builder save of {what} did not leave the source the harness posted ({found['body'][:200]!r});"
            " the harness posts the patch HQ's form builder posts, so look at what patch_xform now applies."
        )
    return found


def _form_builder_save(unit, ops, app_id, kind, value, driver, *, edit=None):
    """The form at ``value``'s place opened in HQ's form builder and saved by the builder's own Save
    (``proof/editors/vellum.py::open_and_save``), with ``edit`` made between the open and the save where it is
    given; the builder's run, held to have saved.

    The operation ``hq-side:<kind>``, keyed by the save, names it in A's key and reads what HQ's form designer page
    gives the builder (``vellum_options``, which HQ may write inside, as proof 4 reads it in an operation of its
    own). The run itself is made after that operation, between scopes, each of the builder's requests its own
    (``unit.request``), as proof 4 runs one (``proof/observe/proof4.py::vellum_run``): where the in-band audit
    chooses it (``PROOF_EDITOR_AUDIT``), it is first rerun on a fresh page in a fork of the unit, and the unit
    takes a mark only between scopes."""
    from proof.editors import vellum

    if driver is None:
        raise ValueError(f"hq-side.json's {kind} is saved in HQ's form builder, and the unit has no editor driver.")
    with ops(f"hq-side:{kind}", _digest(value)):
        _module_id, form_id, _form = _places(unit, app_id, value)
        lang = _operations().held_app(unit, app_id).langs[0]
        options = vellum.vellum_options(unit, app_id, form_id, lang=lang)
    run = vellum.open_and_save(driver, unit, app_id, form_id, options, edit=edit)
    if not run.saved or run.save_refusal is not None:
        raise HqSideSaveRefused(
            f"HQ's form builder did not save form {form_id}{' after the label edit' if edit else ''}"
            f" ({run.save_refusal}); the harness saves it as a person does, so look at what the builder now reports"
            " of the form."
        )
    return run


def form_label(unit, ops, app_id, value, driver):
    """One question's label reworded in the app's first language in HQ's form builder: the form opened, the label
    set (``proof/editors/vellum.py::open_and_save``'s ``edit``, made the way ``value["edit"]`` names) and the
    builder's own Save pressed, through HQ's own views (``_form_builder_save``)."""
    run = _form_builder_save(
        unit,
        ops,
        app_id,
        "formLabel",
        value,
        driver,
        edit={"path": value["question"], "label": value["label"], "way": value["edit"]},
    )
    return [{"view": "patch_xform", "saves": [exchange.url_name for exchange in run.saves], "edit": value["edit"]}]


def form_resave(unit, ops, app_id, value, driver):
    """A form opened in HQ's form builder and saved with no change (``_form_builder_save``)."""
    run = _form_builder_save(unit, ops, app_id, "formResave", value, driver)
    return [{"view": "patch_xform", "saves": [exchange.url_name for exchange in run.saves]}]


def questions(unit, app_id, value):
    """A form's questions changed: its source saved to ``value["xform"]`` as the form builder saves it."""
    _module_id, form_id, _form = _places(unit, app_id, value)
    return [_patched(unit, app_id, form_id, value["xform"], f"the questions of form {form_id}")]


# The form attributes the harness saves, each a key ``views/forms.py::_edit_form_attr`` stores as posted.
FORM_ATTRIBUTES = ("post_form_workflow", "form_filter", "post_form_workflow_fallback")


def form_attribute(unit, app_id, value):
    """A form's own settings, posted by name to ``views/forms.py::edit_form_attr`` as the form settings page posts
    them (``ajax``, which the view reads as true where the post names none)."""
    _module_id, form_id, _form = _places(unit, app_id, value)
    attributes = value["attributes"]
    unknown = sorted(set(attributes) - set(FORM_ATTRIBUTES))
    if unknown:
        raise HqSideSaveRefused(
            f"hq-side.json's formAttribute names {unknown}; the harness saves {list(FORM_ATTRIBUTES)}, each stored by"
            " _edit_form_attr as posted."
        )
    body, content_type = _form(sorted(attributes.items()))
    return [
        _answer(
            unit,
            "POST",
            "edit_form_attr",
            [unit.domain, app_id, form_id, "all"],
            body,
            content_type,
            f"form settings {sorted(attributes)}",
        )
    ]


def form_actions(unit, app_id, value):
    """A form's case management saved as the Case Management tab saves it (``views/forms.py::edit_form_actions``):
    the actions as HQ holds them, in the tab's own shape (``form_action_diff.py::make_multi``), and each case
    property's new mapping as the ``case_mapping_diff`` the tab posts beside them."""
    from corehq.apps.app_manager.form_action_diff import make_multi

    _module_id, form_id, form = _places(unit, app_id, value)
    diff = {
        "update_case": {
            "add": {
                prop: [{"question_path": path, "update_mode": "always"}]
                for prop, path in sorted(value["update"].items())
            }
        }
    }
    body, content_type = _form(
        [("actions", json.dumps(make_multi(form.actions.to_json()))), ("case_mapping_diff", json.dumps(diff))]
    )
    return [
        _answer(
            unit,
            "POST",
            "edit_form_actions",
            [unit.domain, app_id, form_id],
            body,
            content_type,
            f"case management of form {form_id}",
        )
    ]


def module_attribute(unit, app_id, value):
    """A menu's name in the app's first language, as the menu settings page posts it
    (``views/modules.py::edit_module_attr``, ``name``)."""
    app = _operations().held_app(unit, app_id)
    module_id = app.get_module(value["module"]).unique_id
    body, content_type = _form([("name", value["name"])])
    return [
        _answer(
            unit,
            "POST",
            "edit_module_attr",
            [unit.domain, app_id, module_id, "name"],
            body,
            content_type,
            f"the name of menu {module_id}",
        )
    ]


def module_detail(unit, app_id, value):
    """A column added at the end of a menu's case list, posted as the Case List page posts its columns
    (``views/modules.py::edit_module_detail_screens``): ``type`` ``case``, every column HQ holds then the new one,
    and the list's own settings as HQ holds them, which ``_update_short_details`` sets from every post that names
    columns."""
    app = _operations().held_app(unit, app_id)
    module = app.get_module(value["module"])
    short = module.case_details.short
    columns = [column.to_json() for column in short.columns] + [value["column"]]
    body, content_type = _form(
        [
            ("type", json.dumps("case")),
            ("short", json.dumps(columns)),
            ("multi_select", json.dumps(short.multi_select)),
            ("auto_select", json.dumps(short.auto_select)),
            ("max_select_value", json.dumps(short.max_select_value)),
        ]
    )
    return [
        _answer(
            unit,
            "POST",
            "edit_module_detail_screens",
            [unit.domain, app_id, module.unique_id],
            body,
            content_type,
            f"the case list columns of menu {module.unique_id}",
        )
    ]


def forms_added_and_removed(unit, app_id, value):
    """A menu's form deleted (``views/forms.py::delete_form``, the form the menu's list offers to delete), then a
    survey added at its end as the menu's add button posts it (``views/forms.py::new_form``: ``form_type`` ``form``,
    ``case_action`` ``none``), whose questions the form builder then saves (``patch_xform``)."""
    app = _operations().held_app(unit, app_id)
    module = app.get_module(value["module"])
    removed = module.get_form(value["removed"]).unique_id
    found = [
        _answer(
            unit,
            "POST",
            "delete_form",
            [unit.domain, app_id, module.unique_id, removed],
            b"",
            "application/x-www-form-urlencoded; charset=UTF-8",
            f"the deletion of form {removed}",
            redirects=True,
        )
    ]
    body, content_type = _form([("form_type", "form"), ("case_action", "none")])
    found.append(
        _answer(
            unit,
            "POST",
            "new_form",
            [unit.domain, app_id, module.unique_id],
            body,
            content_type,
            f"a survey added to menu {module.unique_id}",
            redirects=True,
        )
    )
    added = _operations().held_app(unit, app_id).get_module(value["module"]).get_form(-1)
    if added.default_name() != value["added"]["name"]:
        raise HqSideSaveRefused(
            f"HQ named the survey it added to menu {module.unique_id} {added.default_name()!r}, and hq-side.json"
            f" states {value['added']['name']!r}."
        )
    found.append(_patched(unit, app_id, added.unique_id, value["added"]["xform"], "the added survey's questions"))
    return found


def order(unit, app_id, value):
    """A menu moved and a form moved within its menu, as the app manager's sidebar posts a drag
    (``views/apps.py::rearrange``, keys ``modules`` and ``forms``, ``from`` and ``to`` as places)."""
    found = []
    moved = value.get("modules")
    if moved is not None:
        body, content_type = _form([("from", str(moved["from"])), ("to", str(moved["to"]))])
        found.append(
            _answer(
                unit,
                "POST",
                "rearrange",
                [unit.domain, app_id, "modules"],
                body,
                content_type,
                "a menu moved",
                redirects=True,
            )
        )
    moved = value.get("forms")
    if moved is not None:
        module_id = _operations().held_app(unit, app_id).get_module(moved["module"]).unique_id
        body, content_type = _form(
            [
                ("from", str(moved["from"])),
                ("to", str(moved["to"])),
                ("from_module_uid", module_id),
                ("to_module_uid", module_id),
            ]
        )
        found.append(
            _answer(
                unit,
                "POST",
                "rearrange",
                [unit.domain, app_id, "forms"],
                body,
                content_type,
                "a form moved",
                redirects=True,
            )
        )
    return found


def media_replaced(unit, app_id, value):
    """The file at a path the app already holds replaced, as HQ's media page uploads a picture there
    (``hqmedia/views.py::ProcessImageFileUploadView``: ``path`` and ``originalPath`` the path, the file as
    ``Filedata``), and held to land: the app's map points the path at the document of the new bytes."""
    import base64

    from corehq.apps.hqmedia.models import CommCareImage
    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart

    data = base64.b64decode(value["base64"])
    name = value["path"].rsplit("/", 1)[-1]
    body = encode_multipart(
        BOUNDARY,
        {
            "path": value["path"],
            "originalPath": value["path"],
            "Filedata": SimpleUploadedFile(name, data, content_type=value["mimeType"]),
        },
    )
    found = _answer(
        unit,
        "POST",
        "hqmedia_uploader_image",
        [unit.domain, app_id],
        body,
        MULTIPART_CONTENT,
        f"the picture at {value['path']}",
    )
    item = _operations().held_app(unit, app_id).multimedia_map.get(value["path"])
    expected = CommCareImage.get_by_data(data)
    if item is None or item.multimedia_id != expected._id:
        raise HqSideSaveRefused(
            f"HQ's media upload of the picture at {value['path']} left the app's map at"
            f" {None if item is None else item.multimedia_id}, not the document of the posted bytes; the harness posts"
            " it as HQ's media page does, so look at what the upload now maps."
        )
    return [found]


def _in_operation(save):
    """``save`` made as one operation of ``ops``, ``hq-side:<kind>``, keyed by what it saves."""

    def run(unit, ops, app_id, kind, value, driver=None):
        with ops(f"hq-side:{kind}", _digest(value)):
            return save(unit, app_id, value)

    return run


def _in_form_builder(save):
    """``save`` made in HQ's form builder: it opens its own operation and runs the builder after it
    (``_form_builder_save``)."""

    def run(unit, ops, app_id, kind, value, driver=None):
        return save(unit, ops, app_id, value, driver)

    return run


SAVES = (
    ("uiTranslations", _in_operation(ui_translations)),
    ("appAttributes", _in_operation(app_attributes)),
    ("buildProfiles", _in_operation(build_profiles)),
    ("lookupTable", _in_operation(lambda unit, app_id, value: lookup_table(unit, value))),
    ("addOns", _in_operation(add_ons)),
    ("profileProperties", _in_operation(profile_properties)),
    ("profileFeatures", _in_operation(profile_features)),
    ("formLabel", _in_form_builder(form_label)),
    ("formResave", _in_form_builder(form_resave)),
    ("questions", _in_operation(questions)),
    ("formAttribute", _in_operation(form_attribute)),
    ("formActions", _in_operation(form_actions)),
    ("moduleAttribute", _in_operation(module_attribute)),
    ("moduleDetail", _in_operation(module_detail)),
    ("formsAddedAndRemoved", _in_operation(forms_added_and_removed)),
    ("order", _in_operation(order)),
    ("mediaReplaced", _in_operation(media_replaced)),
)
# The saves HQ's form builder makes, which need the unit's editor driver.
FORM_BUILDER_SAVES = ("formLabel", "formResave")
# What ``hq-side.json`` states beside the saves: what Nova's next publish over them does, where its review finds
# nothing to bring in, what the review answers, and, where it brings them in, the document the bring-in gives and
# whether the capture also publishes over the same saves.
STATEMENTS = ("republish", "stopCode", "recorded", "bringsIn", "alsoPublishesOver")


def save(unit, ops, app_id, saves, *, driver=None):
    """Every save ``saves`` (``hq-side.json``) names, in ``SAVES``' order, each keyed in ``ops`` by what it saves;
    what HQ answered each, by its kind. ``driver`` is the unit's editor driver, which the form builder's saves
    (``FORM_BUILDER_SAVES``) run in, after their operation (``_form_builder_save``)."""
    unknown = sorted(set(saves) - {kind for kind, _ in SAVES} - set(STATEMENTS))
    if unknown:
        raise ValueError(
            f"hq-side.json names {unknown}, which the harness does not save; it saves {[kind for kind, _ in SAVES]}."
        )
    found = {}
    for kind, run in SAVES:
        if kind not in saves:
            continue
        found[kind] = run(unit, ops, app_id, kind, saves[kind], driver=driver)
    return found
