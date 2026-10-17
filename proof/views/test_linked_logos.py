"""Defect 14, logos: a linked app made from an app Nova publishes, and from one that holds a path-only logo entry.

Contract: Nova's publish writes no ``logo_refs``. HQ's own Copy Application
view links that app, fails over an entry whose only key is ``path``, and
links again once the entry is gone or is the record HQ's uploader writes.
HQ's linked app pull reapplies every logo by its media object
(``models/applications.py::LinkedApplication.reapply_overrides``, which reads
each reference's ``m_id``), and HQ's own uploader
(``hqmedia/views.py::ProcessLogoFileUploadView``) always writes one, so a
path-only entry is the one shape the pull fails on; Nova's update takes such
an entry out (``lib/commcare/targetLogoRefs.ts::withoutPathOnlyLogoRefs``).
The plausible failures: a copy that fails over the app as Nova publishes it,
a copy that succeeds over a path-only entry (then the cleanup guards
nothing), one that still fails after the cleanup update, and an uploader
that, posted for a slot holding a path-only entry, leaves that entry in
place (then a logo a person uploads while a publish pushes its tables is
lost to that publish's cleanup).

One logo document is published as Nova publishes it into a project space
whose plan has release management and the logo uploader, and released as
HQ's Releases page releases one; a second project space is made for the
copy. HQ's own Copy Application view, asked as a person with a linked copy
ticked, makes the linked app from each release: of the app as Nova
published it, with a path-only entry written into the stored app, after
the update Nova sends over that entry, and once the uploader has stored
its record in the slot the path-only entry held.
"""

from __future__ import annotations

import base64
import dataclasses
import hashlib
import json

from proof.views.conftest import ask

DOCUMENT = "media-only"
TARGET = "nova-proof-downstream"
# A 1x1 PNG, the logo a person uploads.
LOGO = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
PASSWORD = "proof-linked-password"
# Where a person's browser has HQ's page open: HQ's own origin, as the requests here reach it (Django's request
# factory names the host ``testserver``), which HQ's CSRF check holds a form's Referer to.
ORIGIN = "https://testserver/"


def _session(unit, person, label):
    """The person signed in through HQ's own sign-in form: the cookie their browser then sends, and the CSRF token
    a page's form posts back."""
    from proof.formplayer import hq as formplayer_hq

    signed_in = formplayer_hq.sign_in(unit, person, PASSWORD, f"linked:{label}")
    return signed_in.cookie, signed_in.csrf


def _form(fields) -> tuple[bytes, str]:
    from urllib.parse import urlencode

    return urlencode(fields).encode(), "application/x-www-form-urlencoded"


def _multipart(name, filename, content, content_type, fields) -> tuple[bytes, str]:
    boundary = "proof-logo-boundary"
    body = b""
    for key, value in fields:
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
    body += (
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode()
    body += content + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def _released(unit, app_id, label):
    from proof.hq import operations
    from proof.webapps import hq as webapps_hq

    with unit.operation(f"release:{label}", hashlib.sha256(label.encode()).digest()):
        build = webapps_hq._make_build(unit, operations.held_app(unit, app_id))
        webapps_hq._release(unit, app_id, build._id)
    return build._id


def _copy_linked(unit, app_id, build_id, cookie, token, label):
    from django.urls import reverse

    body, content_type = _form(
        [
            ("app", app_id),
            ("domain", TARGET),
            ("name", f"Linked {label}"),
            ("linked", "on"),
            ("build_id", build_id),
            ("csrfmiddlewaretoken", token),
        ]
    )
    return ask(
        unit,
        "POST",
        reverse("copy_app", args=[unit.domain]),
        body=body,
        headers=(("Content-Type", content_type), ("Cookie", cookie), ("Referer", ORIGIN)),
        label=f"copy-{label}",
    )


def _linked_apps():
    from corehq.apps.linked_domain.applications import get_linked_apps_for_domain

    return get_linked_apps_for_domain(TARGET)


# The slot a path-only entry held: Web Apps' logo.
SLOT = "hq_logo_web_apps"


def _path_only_written(unit, app_id, label):
    """A path-only entry written into the stored app in ``SLOT``, at the path of an image the app's media map
    holds: the shape HQ's uploader never writes."""
    from proof.hq import operations

    with unit.operation(f"path-only:{label}", hashlib.sha256(f"path-only|{label}".encode()).digest()):
        app = operations.held_app(unit, app_id)
        paths = sorted(path for path, item in app.multimedia_map.items() if item.media_type == "CommCareImage")
        assert paths, f"the app holds no image to point a logo entry at: {sorted(app.multimedia_map)}"
        app.logo_refs = {SLOT: {"path": paths[0]}}
        app.save()


def _cleanup_update(unit, app_id, export):
    """Nova's update over an app whose ``logo_refs`` holds a path-only entry alone: the captured update with
    ``logo_refs`` set to what ``withoutPathOnlyLogoRefs`` leaves of that dict, an empty one."""
    from proof.hq import operations

    upload = operations.with_app_id(export.republish.upload(), app_id)
    application = json.loads(operations.upload_field(upload, "app_file"))
    assert "logo_refs" not in application, "Nova's update carries logo_refs over an app that holds none"
    application["logo_refs"] = {}
    fields = [
        (name, operations.upload_field(upload, name).decode())
        for name in operations.upload_field_names(upload)
        if name != "app_file"
    ]
    body, content_type = _multipart(
        "app_file", "app.json", json.dumps(application).encode(), "application/json", fields
    )
    result = operations.apply_upload(unit, operations.Upload(body, content_type))
    assert result.status == 200 and result.response.get("success"), (result.status, result.response)


def test_a_linked_copy_fails_over_a_path_only_logo_entry_and_succeeds_without_one(
    hq, core_runner, view_documents, published
):
    from corehq.apps.hqmedia.views import ProcessLogoFileUploadView
    from corehq.apps.users.models import WebUser
    from django.urls import reverse

    from proof.hq import operations
    from proof.hq import redis as hq_redis
    from proof.hq.seams import another_project_space
    from proof.hq.state import domain_document

    document = view_documents[DOCUMENT]
    configuration = document.exports["minimum"].configuration.hq()
    configuration = dataclasses.replace(
        configuration,
        privileges=frozenset(configuration.privileges | {"RELEASE_MANAGEMENT", "COMMCARE_LOGO_UPLOADER"}),
    )
    with published(document, "minimum", core_runner, configuration=configuration) as (unit, app_id, export):
        assert not operations.held_app(unit, app_id).logo_refs
        # Nova's media upload after the content, which maps the app's images.
        with unit.operation("media", hashlib.sha256(b"linked-media").digest()):
            media = operations.apply_media_upload(unit, app_id, export.content.media.upload())
        assert media.status == 200, media.response
        downstream = another_project_space(TARGET, configuration.privileges)
        with downstream, hq_redis.shared(None), unit.committing():
            with unit.operation("downstream", hashlib.sha256(b"linked-downstream").digest()):
                # The second project space as the harness seeds its own (``proof.hq.state``).
                unit.couch.seed(domain_document(dataclasses.replace(configuration, domain=TARGET)))
                person = WebUser.create(unit.domain, "proof-linker@example.com", PASSWORD, None, None, is_admin=True)
                person.add_domain_membership(TARGET, is_admin=True)
                person.save()
            cookie, token = _session(unit, person, "linker")

            def copied(label):
                build = _released(unit, app_id, label)
                return _copy_linked(unit, app_id, build, cookie, token, label)

            # The app as Nova publishes it, with no logo entry: it links.
            published_copy = copied("as-published")
            assert published_copy.status == 302, (published_copy.status, published_copy.body[:400])

            # Over a path-only entry: HQ's pull reads a media object the entry does not name.
            _path_only_written(unit, app_id, "first")
            refused = copied("path-only")
            assert refused.status == 500, (refused.status, refused.body[:400])
            assert b"m_id" in refused.body, refused.body[:400]

            # After the update Nova sends over it, which empties the dict: it links again.
            _cleanup_update(unit, app_id, export)
            assert operations.held_app(unit, app_id).logo_refs == {}
            cleaned = copied("cleaned")
            assert cleaned.status == 302, (cleaned.status, cleaned.body[:400])

            # HQ's uploader, posted for the slot that holds a path-only entry, leaves its own record there, and
            # the app links over it.
            _path_only_written(unit, app_id, "again")
            body, content_type = _multipart("Filedata", "logo.png", LOGO, "image/png", [("csrfmiddlewaretoken", token)])
            uploaded = ask(
                unit,
                "POST",
                reverse(ProcessLogoFileUploadView.urlname, args=[unit.domain, app_id, SLOT]),
                body=body,
                headers=(
                    ("Content-Type", content_type),
                    ("Cookie", cookie),
                    ("Referer", ORIGIN),
                ),
                label="upload-logo",
            )
            assert uploaded.status == 200, (uploaded.status, uploaded.body[:400])
            assert "m_id" in operations.held_app(unit, app_id).logo_refs[SLOT]
            linked = copied("uploaded-logo")
            assert linked.status == 302, (linked.status, linked.body[:400])
            made = [app for app in _linked_apps() if app.name == "Linked uploaded-logo"]
            assert made and all(SLOT in app.logo_refs and "m_id" in app.logo_refs[SLOT] for app in made), made
