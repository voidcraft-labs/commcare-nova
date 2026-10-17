"""Defect 14, logos: what HQ does with an app's ``logo_refs``, which Nova's publish leaves to HQ's own uploader.

Contract: Nova's publish writes no ``logo_refs``, puts no logo-only file in
its media upload, and over an app whose ``logo_refs`` holds an entry whose
only key is ``path`` sends the dict without it
(``lib/commcare/targetLogoRefs.ts::withoutPathOnlyLogoRefs``); a person adds
the logo in HQ. That rests on four things HQ does, each run here:

- HQ's own uploader (``hqmedia/views.py::ProcessLogoFileUploadView``) stores
  a full record for its slot, ``m_id`` and ``path`` among its keys, and
  answers 404 on a plan without the Custom CommCare Logo Uploader;
- an update that names ``logo_refs`` replaces the dict whole, and one that
  names none keeps it (``models/applications.py::_merge_source_into_app``);
- HQ's build writes a logo into the profile from ``logo_refs`` only under
  the privilege (``Application.create_profile``);
- the media upload Nova sends, which holds no file only the logo uses, maps
  every file it holds and reports none unmatched
  (``hqmedia/tasks.py::process_bulk_upload_zip``).

The plausible failures: an uploader record without ``m_id`` (then HQ's
linked app pull fails over it as over a path-only entry), an update that
merges the dict (then Nova's cleanup would not take the entry out, and a
publish that names no ``logo_refs`` would not keep a person's logo), and a
logo that reaches HQ's builds without the privilege.
"""

from __future__ import annotations

import base64
import dataclasses
import hashlib
import json

from proof.hq import operations
from proof.hq.check import hq_check

# A 1x1 PNG, the logo a person uploads.
LOGO = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
SLOTS = ("hq_logo_web_apps", "hq_logo_android_home")
PRIVILEGE = "COMMCARE_LOGO_UPLOADER"
# Where a person's browser has HQ's page open: HQ's own origin, as the requests here reach it (Django's request
# factory names the host ``testserver``), which HQ's CSRF check holds a form's Referer to.
ORIGIN = "https://testserver/"


def _configuration(export, granted):
    held = export.configuration.hq()
    privileges = held.privileges | {PRIVILEGE} if granted else held.privileges - {PRIVILEGE}
    return dataclasses.replace(held, privileges=frozenset(privileges))


def _published(state, export):
    from proof.observe import publish

    app_id, refusal, _ = publish.create(state, export)
    assert refusal is None, refusal
    return app_id


def _upload(state, app_id, slot):
    """HQ's own uploader, posted ``LOGO`` for ``slot`` by the project space's admin signed in through HQ's sign-in
    form; answered by the view HQ's URLconf names, behind its middleware. Returns the status."""
    from corehq.apps.hqmedia.views import ProcessLogoFileUploadView
    from django.urls import reverse

    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer.client import HqRequest
    from proof.hq import redis as hq_redis

    with hq_redis.shared(None):
        signed_in = formplayer_hq.admin_signed_in(state, state.operation, "logo", slot)
        boundary = "proof-logo-boundary"
        body = (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="csrfmiddlewaretoken"\r\n\r\n'
                f"{signed_in.csrf}\r\n"
                f'--{boundary}\r\nContent-Disposition: form-data; name="Filedata"; filename="logo.png"\r\n'
                "Content-Type: image/png\r\n\r\n"
            ).encode()
            + LOGO
            + f"\r\n--{boundary}--\r\n".encode()
        )
        headers = (
            ("Content-Type", f"multipart/form-data; boundary={boundary}"),
            ("Cookie", signed_in.cookie),
            ("Referer", ORIGIN),
        )
        path = reverse(ProcessLogoFileUploadView.urlname, args=[state.domain, app_id, slot])
        with state.committing(), state.request(hashlib.sha256(f"logo|{slot}".encode()).digest()):
            with formplayer_hq._language_put_back():
                request = formplayer_hq.django_request(HqRequest("POST", path, "", headers, body))
                return formplayer_hq.respond(request).status_code


def test_hqs_uploader_stores_a_full_record_only_on_a_plan_with_the_logo_uploader(hq, core_runner, documents):
    export = documents["media-only"].exports["minimum"]
    found = {}
    for granted in (True, False):
        with hq_check(_configuration(export, granted)) as (state, _):
            app_id = _published(state, export)
            assert not operations.held_app(state, app_id).logo_refs
            status = _upload(state, app_id, SLOTS[0])
            stored = operations.held_app(state, app_id).logo_refs or {}
            found[granted] = (status, sorted(stored.get(SLOTS[0], {})))
    assert found[False] == (404, []), found
    status, keys = found[True]
    assert status == 200 and {"m_id", "path"} <= set(keys) and len(keys) == 10, found


def _with_logo_refs(upload, app_id, logo_refs):
    """The captured update with its app naming ``logo_refs``, every other field as captured."""
    from proof.hq.operations import Upload

    upload = operations.with_app_id(upload, app_id)
    application = json.loads(operations.upload_field(upload, "app_file"))
    assert "logo_refs" not in application, "Nova's update names logo_refs"
    application["logo_refs"] = logo_refs
    boundary = "proof-logo-update-boundary"
    body = b""
    for name in operations.upload_field_names(upload):
        content = json.dumps(application).encode() if name == "app_file" else operations.upload_field(upload, name)
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if name == "app_file":
            disposition += '; filename="app.json"\r\nContent-Type: application/json'
        body += f"--{boundary}\r\n{disposition}\r\n\r\n".encode() + content + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return Upload(body, f"multipart/form-data; boundary={boundary}")


def test_an_update_naming_logo_refs_replaces_the_dict_and_one_naming_none_keeps_it(hq, core_runner, documents):
    export = documents["media-only"].exports["minimum"]
    with hq_check(_configuration(export, True)) as (state, _):
        app_id = _published(state, export)
        for slot in SLOTS:
            assert _upload(state, app_id, slot) == 200
        uploaded = operations.held_app(state, app_id).logo_refs
        assert sorted(uploaded) == sorted(SLOTS)

        # Nova's update as it stands names no logo_refs: both of the person's logos stay.
        kept = operations.apply_upload(state, operations.with_app_id(export.content.upload(), app_id))
        assert kept.status == 200, kept.response
        assert operations.held_app(state, app_id).logo_refs == uploaded

        # An update naming one path-only entry replaces the dict with it, and neither of the person's stays.
        path_only = {SLOTS[0]: {"path": uploaded[SLOTS[0]]["path"]}}
        replaced = operations.apply_upload(state, _with_logo_refs(export.content.upload(), app_id, path_only))
        assert replaced.status == 200, replaced.response
        assert operations.held_app(state, app_id).logo_refs == path_only

        # The cleanup's own update over that dict, which empties it, leaves it empty.
        emptied = operations.apply_upload(state, _with_logo_refs(export.content.upload(), app_id, {}))
        assert emptied.status == 200, emptied.response
        assert operations.held_app(state, app_id).logo_refs == {}


def test_hqs_build_writes_an_uploaded_logo_into_the_profile_only_with_the_privilege(hq, core_runner, documents):
    from corehq.apps.app_manager.const import ANDROID_LOGO_PROPERTY_MAPPING
    from lxml import etree

    from proof.hq.seams import SeamRecord, flags, privileges

    export = documents["media-only"].exports["minimum"]
    granted = _configuration(export, True)
    with hq_check(granted) as (state, _):
        app_id = _published(state, export)
        assert _upload(state, app_id, SLOTS[1]) == 200
        app = operations.held_app(state, app_id)
        keys = set(ANDROID_LOGO_PROPERTY_MAPPING.values())
        found = {}
        for name, configuration in (("granted", granted), ("withheld", _configuration(export, False))):
            record = SeamRecord()
            with flags(configuration, record), privileges(configuration, record):
                profile = etree.fromstring(app.create_profile())
            found[name] = sorted(node.get("key") for node in profile.iter("property") if node.get("key") in keys)
    assert found == {"granted": [ANDROID_LOGO_PROPERTY_MAPPING[SLOTS[1]]], "withheld": []}, found


def test_the_media_upload_nova_sends_reports_no_file_unmatched(hq, core_runner, documents):
    from proof.observe import publish

    for document_id in ("media-rich", "media-only"):
        export = documents[document_id].exports["minimum"]
        assert export.content.media is not None, document_id
        with hq_check(export.configuration.hq()) as (state, _):
            app_id = _published(state, export)
            uploaded = publish.upload_media(state, app_id, export.content.media)
            assert uploaded["refused"] is None and uploaded["unmatched"] == [], (document_id, uploaded)
            assert not operations.held_app(state, app_id).logo_refs, document_id
