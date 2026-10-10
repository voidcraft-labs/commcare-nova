"""Defect 14, logos: a linked app made from an app whose logo Nova wrote, and from one whose logo HQ's uploader wrote.

Contract: Nova's publish writes each logo path-only (``logo_refs``, the slot's
path and no media object, ``lib/commcare/multimedia/logoEntry.ts``), since
HQ makes a logo's media object only through its session-authenticated logo
uploader (``hqmedia/views.py::ProcessLogoFileUploadView``). HQ's linked app
pull reapplies every logo by its media object
(``models/applications.py::LinkedApplication.reapply_overrides``, which reads
each reference's ``m_id``), so making a linked copy of such an app fails;
once a person uploads the logo through HQ's uploader the same app links. The
plausible failures: a copy that succeeds over Nova's references (then the
defect is not one), and one that fails for some other reason over the
uploaded logo (then the uploader is not what makes it work), which the
paired observation tells apart.

One logo document is published as Nova publishes it into a project space
whose plan has release management and the logo uploader, and released as
HQ's Releases page releases one; a second project space is made for the
copy. HQ's own Copy Application view, asked as a person with a linked copy
ticked, makes the linked app from the release, first over Nova's logo and
then over the logo uploaded through HQ's uploader view and released again.
"""

from __future__ import annotations

import base64
import dataclasses
import hashlib

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


def test_a_linked_copy_fails_over_novas_logo_and_succeeds_over_the_one_hqs_uploader_wrote(
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
    with published(document, "minimum", core_runner, configuration=configuration) as (unit, app_id, _):
        logos = operations.held_app(unit, app_id).logo_refs
        assert logos and all("m_id" not in ref for ref in logos.values()), logos
        slot = sorted(logos)[0]
        downstream = another_project_space(TARGET, configuration.privileges)
        with downstream, hq_redis.shared(None), unit.committing():
            with unit.operation("downstream", hashlib.sha256(b"linked-downstream").digest()):
                # The second project space as the harness seeds its own (``proof.hq.state``).
                unit.couch.seed(domain_document(dataclasses.replace(configuration, domain=TARGET)))
                person = WebUser.create(unit.domain, "proof-linker@example.com", PASSWORD, None, None, is_admin=True)
                person.add_domain_membership(TARGET, is_admin=True)
                person.save()
            cookie, token = _session(unit, person, "linker")

            # Over Nova's own logo, path-only: HQ's pull reads a media object the reference does not name.
            nova_build = _released(unit, app_id, "nova-logo")
            refused = _copy_linked(unit, app_id, nova_build, cookie, token, "nova-logo")
            assert refused.status == 500, (refused.status, refused.body[:400])
            assert b"m_id" in refused.body, refused.body[:400]

            # Over the logo a person uploads through HQ's own uploader, the same app links.
            body, content_type = _multipart("Filedata", "logo.png", LOGO, "image/png", [("csrfmiddlewaretoken", token)])
            uploaded = ask(
                unit,
                "POST",
                reverse(ProcessLogoFileUploadView.urlname, args=[unit.domain, app_id, slot]),
                body=body,
                headers=(
                    ("Content-Type", content_type),
                    ("Cookie", cookie),
                    ("Referer", ORIGIN),
                ),
                label="upload-logo",
            )
            assert uploaded.status == 200, (uploaded.status, uploaded.body[:400])
            assert "m_id" in operations.held_app(unit, app_id).logo_refs[slot]
            uploader_build = _released(unit, app_id, "uploaded-logo")
            linked = _copy_linked(unit, app_id, uploader_build, cookie, token, "uploaded-logo")
            assert linked.status == 302, (linked.status, linked.body[:400])
            made = [app for app in _linked_apps() if app.name == "Linked uploaded-logo"]
            assert made and all(slot in app.logo_refs and "m_id" in app.logo_refs[slot] for app in made), made
