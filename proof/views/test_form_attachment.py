"""Defect 12, ``VIEW_FORM_ATTACHMENT``: who HQ serves the file a link write points at, with the flag and without.

Contract: a capture field that writes a link to its case stores the address
of HQ's form attachment endpoint for the submission it rode in
(``lib/commcare/xform/captureUrlNode.ts``, ``/api/form_attachment/v1/``,
which HQ's URLconf names ``api_form_attachment``). HQ serves that file
through ``reports/views.py::_can_view_form_attachment``: to anyone in the
project space where ``VIEW_FORM_ATTACHMENT`` is on, and otherwise only to a
person with the Submission History permission. So the flag is what a mobile
worker needs to open such a link from a case list or detail, and nothing a
person with that permission needs. The plausible failures: a gate that
lets the worker through without the flag (then Nova's check asks for a flag
nothing needs), one that refuses the worker with it (then the flag does not
do what Nova's check needs it for), and a view that answered nothing (no
file stored, no submission processed), which would pass every refusal.

One capture document is published as Nova publishes it, under a
configuration with the flag and one without; its form is submitted with a
photo by its mobile worker, through HQ's own receiver as a device posts it;
then the file is asked for at the address the link write names, by three
people signed in to HQ: the worker, the project space's administrator (who
holds Submission History), and a web user whose role does not hold it.
"""

from __future__ import annotations

import base64
import dataclasses
import hashlib
import uuid

from proof.views.conftest import ask

DOCUMENT = "case-capture-query"
FLAG = "VIEW_FORM_ATTACHMENT"
PHOTO = b"\xff\xd8\xff\xe0proof photo bytes\xff\xd9"
PASSWORD = "proof-attachment-password"


def _multipart(xml: bytes, photo_name: str) -> tuple[bytes, str]:
    """A device's submission: the form's instance and the photo beside it, as CommCare posts them."""
    boundary = "proof-attachment-boundary"
    parts = [
        (b"xml_submission_file", b"xml_submission_file.xml", b"text/xml", xml),
        (photo_name.encode(), photo_name.encode(), b"image/jpeg", PHOTO),
    ]
    body = b""
    for name, filename, content_type, content in parts:
        body += (
            b"--" + boundary.encode() + b"\r\n"
            b'Content-Disposition: form-data; name="' + name + b'"; filename="' + filename + b'"\r\n'
            b"Content-Type: " + content_type + b"\r\n\r\n" + content + b"\r\n"
        )
    body += b"--" + boundary.encode() + b"--\r\n"
    return body, f"multipart/form-data; boundary={boundary}"


def _instance(xmlns: str, instance_id: str, worker_id: str, photo_name: str) -> bytes:
    from xml.sax.saxutils import escape, quoteattr

    return (
        f"<?xml version='1.0' ?><data xmlns={quoteattr(xmlns)}><photo>{escape(photo_name)}</photo>"
        "<n0:meta xmlns:n0='http://openrosa.org/jr/xforms'>"
        f"<n0:deviceID>proof-device</n0:deviceID><n0:timeStart>2026-10-01T10:00:00Z</n0:timeStart>"
        f"<n0:timeEnd>2026-10-01T10:00:01Z</n0:timeEnd><n0:username>proof</n0:username>"
        f"<n0:userID>{escape(worker_id)}</n0:userID><n0:instanceID>{escape(instance_id)}</n0:instanceID>"
        "</n0:meta></data>"
    ).encode()


def _people(unit):
    """The worker, the administrator, and a web user without Submission History, each made by HQ's own models."""
    from corehq.apps.users.models import CommCareUser, HqPermissions, WebUser
    from corehq.apps.users.models_role import UserRole

    from proof.formplayer import hq as formplayer_hq

    formplayer_hq.default_roles(unit)
    worker = CommCareUser.create(
        unit.domain, f"proof-worker@{unit.domain}.commcarehq.org", PASSWORD, created_by=None, created_via=None
    )
    # An administrator holds every permission, Submission History among them (``DomainMembership.is_admin``).
    admin = WebUser.create(unit.domain, "proof-admin@example.com", PASSWORD, None, None, is_admin=True)
    role = UserRole.create(unit.domain, "Apps without history", permissions=HqPermissions(edit_apps=True))
    viewer = WebUser.create(unit.domain, "proof-no-history@example.com", PASSWORD, None, None, role_id=role.get_id)
    return worker, admin, viewer


def _asked(unit, path, person, label) -> int:
    from django.conf import settings

    from proof.formplayer import hq as formplayer_hq

    signed_in = formplayer_hq.sign_in(unit, person, PASSWORD, f"attachment:{label}")
    answer = ask(
        unit,
        "GET",
        path,
        headers=(("Cookie", f"{settings.SESSION_COOKIE_NAME}={signed_in.session}"),),
        label=f"file-{label}",
    )
    if answer.status == 200:
        assert answer.body == PHOTO, answer.body[:200]
    return answer.status


def test_a_link_writes_file_is_served_to_a_worker_only_under_the_flag_and_to_submission_history_either_way(
    hq, core_runner, view_documents, published
):
    from django.urls import reverse

    from proof.hq import operations
    from proof.hq import redis as hq_redis

    document = view_documents[DOCUMENT]
    statuses = {}
    for flagged in (True, False):
        configuration = document.exports["minimum"].configuration.hq()
        flags = configuration.flags | {FLAG} if flagged else configuration.flags - {FLAG}
        configuration = dataclasses.replace(configuration, flags=frozenset(flags))
        with published(document, "minimum", core_runner, configuration=configuration) as (unit, app_id, _):
            app = operations.held_app(unit, app_id)
            xmlns = next(form.xmlns for module in app.modules for form in module.get_forms())
            with hq_redis.shared(None), unit.committing():
                with unit.operation("people", hashlib.sha256(b"attachment-people").digest()):
                    worker, admin, viewer = _people(unit)
                instance_id = str(uuid.UUID(int=7))
                photo = "proof-photo.jpg"
                body, content_type = _multipart(_instance(xmlns, instance_id, worker.user_id, photo), photo)
                credentials = base64.b64encode(f"{worker.username}:{PASSWORD}".encode()).decode()
                received = ask(
                    unit,
                    "POST",
                    reverse("receiver_secure_post", args=[unit.domain]),
                    body=body,
                    headers=(("Content-Type", content_type), ("Authorization", f"Basic {credentials}")),
                    label="submission",
                )
                assert received.status == 201, (received.status, received.body[:400])
                path = reverse("api_form_attachment", args=[unit.domain, instance_id, photo])
                # The address Nova's link write stores is this endpoint's (captureUrlNode.ts).
                assert "/api/form_attachment/v1/" in path
                statuses[flagged] = {
                    "worker": _asked(unit, path, worker, f"worker-{flagged}"),
                    "administrator": _asked(unit, path, admin, f"admin-{flagged}"),
                    "without history": _asked(unit, path, viewer, f"viewer-{flagged}"),
                }
    assert statuses[True] == {"worker": 200, "administrator": 200, "without history": 200}, statuses
    assert statuses[False] == {"worker": 403, "administrator": 200, "without history": 403}, statuses
