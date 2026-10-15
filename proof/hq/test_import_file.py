"""HQ's import page takes Nova's HQ import file the way the file's own guide tells a person to.

Contract (part 01, A6): the HQ import file is always a ZIP holding the app
JSON, the lookup workbook and the media upload where the app has them, and a
``README.txt`` that renders the manual-import guide
(``lib/publish/manualImportGuide.ts``). The corpus writes each document's
file as ``/api/compile/json`` builds it (``Document.import_file``,
``proof/corpus/publish.ts::importFile``). A person follows the guide through
HQ's import page (``corehq/apps/domain/views/import_apps.py::ImportAppStepsView``):
step one takes the guide's own App URL, which HQ checks only for its shape
and a server other than its own (``domain/forms.py::ExtractAppInfoForm``),
and step two imports the app JSON under the name given
(``models/applications.py::import_app_from_doc``). The workbook is uploaded
first, with replace, and the media ZIP after, as the guide orders them.

A hand import is a create that carries forms, so HQ re-mints the file's form
ids and keeps its menu ids and every ``xmlns``. What it builds is what a
publish builds: HQ's build of the imported app and of state A differ only in
the app's id, the form ids HQ minted and the version each carries.

The plausible failures: a guide whose App URL HQ's page refuses (a person
could not start the import), a guide that names no alternative on the
server its URL names, an import file HQ's page reads as another app, and a
hand import that builds another app than a publish does.
"""

from __future__ import annotations

import json
import zipfile

import pytest

from proof.hq import operations
from proof.hq import requests as hq_requests
from proof.hq.check import hq_check

DOCUMENTS = ("navigation-base", "case-list-inline", "targeted-hq-side-lookup")
APP_NAME = "Imported by hand"
STEP_VIEW = "import_app_steps"


def _members(document):
    with zipfile.ZipFile(document.import_file) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def _app_json(members):
    (name,) = [name for name in members if name.endswith(".json")]
    return name, members[name]


def _guide_url(readme: str) -> str:
    """The App URL the guide tells a person to paste: its one line that is an app's address."""
    (url,) = [
        line.strip() for line in readme.splitlines() if line.strip().startswith("https://") and "/apps/view/" in line
    ]
    return url


def _step(state, action, pairs=(), files=None):
    """One step of HQ's import page, as its htmx form posts it, by the signed-in web user; HQ's rendered answer."""
    from django.urls import resolve, reverse

    path = reverse(STEP_VIEW, args=[state.domain])
    if files is None:
        request = hq_requests.form_post(state, path, pairs)
    else:
        body, content_type = _multipart(pairs, files)
        request = hq_requests.raw_post(state, path, body, content_type)
    request.META["HTTP_HQ_HX_ACTION"] = action
    match = resolve(path)
    response = match.func(request, *match.args, **match.kwargs)
    if hasattr(response, "render") and not getattr(response, "is_rendered", True):
        response.render()
    return response.status_code, response.content.decode("utf-8")


def _multipart(pairs, files):
    boundary = "----nova-proof-import-page"
    body = b""
    for name, value in pairs:
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    for name, (filename, content) in files.items():
        body += (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
            + content
            + b"\r\n"
        )
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def _media_upload(media_zip: bytes):
    body, content_type = _multipart((), {"bulk_upload_file": ("multimedia.zip", media_zip)})
    return operations.Upload(body, content_type)


def _hidden(html, name):
    """The value of the hidden field ``name`` the page's second step carries from the first."""
    from lxml import html as lxml_html

    (field,) = lxml_html.fromstring(html).xpath(f'//input[@name="{name}"]')
    return field.get("value")


def _import(state, document, name=APP_NAME):
    """The guide's steps over the document's import file: the workbook, the app through HQ's import page under
    ``name``, the media. Returns the imported app's id, the app JSON the file holds and HQ's media processing
    (None for an app with no media)."""
    from corehq.apps.app_manager.dbaccessors import get_brief_apps_in_domain

    members = _members(document)
    if "lookup-tables.xlsx" in members:
        uploaded = operations.upload_lookup_workbook(state, members["lookup-tables.xlsx"], replace=True)
        assert uploaded.errors == [], uploaded.errors
    status, first = _step(state, "extract_app_info_from_url", [("app_url", _guide_url(members["README.txt"].decode()))])
    assert status == 200 and 'name="app_file"' in first, first[:2000]
    before = {app.get_id for app in get_brief_apps_in_domain(state.domain)}
    member, app_json = _app_json(members)
    hidden = [(field, _hidden(first, field)) for field in ("source_server", "source_domain", "app_id")]
    status, _ = _step(state, "import_app", [("app_name", name), *hidden], {"app_file": (member, app_json)})
    assert status == 200
    (app_id,) = {app.get_id for app in get_brief_apps_in_domain(state.domain)} - before
    processing = None
    if "multimedia.zip" in members:
        processing = operations.apply_media_upload(state, app_id, _media_upload(members["multimedia.zip"])).processing
    return app_id, json.loads(app_json), processing


@pytest.mark.parametrize("document_id", DOCUMENTS)
def test_hqs_import_page_takes_the_file_as_the_guide_says(hq, core_runner, documents, document_id):
    from django.test import override_settings

    from proof.hq.seams import build_seams
    from proof.observe.build import build_state

    document = documents[document_id]
    export = document.exports["minimum"]
    url = _guide_url(_members(document)["README.txt"].decode())
    with hq_check(export.configuration.hq()) as (state, record):
        # Step one checks the URL's shape and that its server is not HQ's own; it never opens the link.
        with override_settings(SERVER_ENVIRONMENT="india"):
            _, refused = _step(state, "extract_app_info_from_url", [("app_url", url)])
            assert "The source app url matches the current server" in refused
            _, alternative = _step(
                state, "extract_app_info_from_url", [("app_url", url.replace("https://india.", "https://www."))]
            )
            assert 'name="app_file"' in alternative
        _, elsewhere = _step(
            state, "extract_app_info_from_url", [("app_url", "https://example.org/a/x/apps/view/" + "0" * 32 + "/")]
        )
        assert "The URL must be from a valid CommCare server" in elsewhere
        app_id, sent, processing = _import(state, document)
        app = operations.held_app(state, app_id)
        sent_forms = [form for module in sent["modules"] for form in module["forms"]]
        assert [module.unique_id for module in app.modules] == [module["unique_id"] for module in sent["modules"]]
        assert [form.xmlns for form in app.get_forms()] == [form["xmlns"] for form in sent_forms]
        assert not {form.unique_id for form in app.get_forms()} & {form["unique_id"] for form in sent_forms}
        assert app.build_spec.version == export.configuration.commcare_version
        assert (app.name, app.created_from_template) == (APP_NAME, "import_app")
        if processing is not None:
            assert processing["errors"] == [] and processing["unmatched_files"] == []
        with build_seams():
            built, _ = build_state(app, record, "imported")
        assert built.errors == [] and built.files is not None


def test_a_hand_import_builds_the_app_a_publish_builds(hq, core_runner, documents):
    """HQ's build of the app imported by hand, under the app's own name, and its build of state A, with the
    imported app's ids mapped to A's by position (proof 2's comparison, ``proof.observe.alignment``), differ only
    where each names its own app's id or version."""
    from proof.checks import proof2
    from proof.hq.seams import build_seams
    from proof.observe import publish
    from proof.observe.alignment import align_positions, aligned_app
    from proof.observe.build import build_state

    for document_id in DOCUMENTS:
        document = documents[document_id]
        export = document.exports["minimum"]
        with hq_check(export.configuration.hq()) as (state, record):
            app_id, refusal, _ = publish.create(state, export)
            assert refusal is None, refusal
            if export.content.media is not None:
                operations.apply_media_upload(state, app_id, export.content.media.upload())
            published = operations.held_app(state, app_id)
            with build_seams():
                a_build, _ = build_state(published, record, "A")
            imported_id, _, _ = _import(state, document, published.name)
            imported = operations.held_app(state, imported_id)
            alignment = align_positions(published.to_json(), imported.to_json())
            with build_seams():
                b_build, _ = build_state(aligned_app(imported, alignment), record, "imported")
        differences = proof2.build_differences(document_id, a_build, b_build, alignment, rules=())
        unexplained = [
            difference
            for difference in differences
            if not any(
                value is not None and (app_id in str(value) or imported_id in str(value))
                for value in (difference.before, difference.after)
            )
            and "version" not in difference.path.lower()
        ]
        assert unexplained == [], (document_id, [(d.artifact, d.path, d.before, d.after) for d in unexplained[:20]])
