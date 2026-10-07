"""HQ's side of the Connect proof: a submission as HQ's receiver reads it, and what HQ's Connect repeater forwards.

Connect never sees a form. It sees the JSON HQ's Connect repeater posts
(``corehq/motech/repeaters/models.py::ConnectFormRepeater``), which HQ's own
payload generator builds from the form HQ holds
(``repeater_generators.py::ConnectFormRepeaterPayloadGenerator.get_payload``):
the form through HQ's form API resource (``api/resources/v0_4.py::
XFormInstanceResource`` over ``api/util.py::form_to_es_form``), kept to its
domain, id, app id, build id, received time and metadata, with every block
in Connect's namespace put back at its path under ``form``. So the payload's
shape is HQ's, produced here by that code and never written by hand.

The form it reads is the one HQ's receiver makes of a submission, by the
receiver's own steps in the receiver's order
(``form_processor/submission_post.py::SubmissionPost.run``, up to its case
processing): the app and build the receiver's URL names
(``receiverwrapper/util.py::get_app_and_build_ids``), the submission parsed
and its datetimes adjusted (``parsers/form.py::process_xform_xml``), and the
request's properties and the meta scrub put on the form
(``SubmissionPost._post_process_form``). HQ's case processing and its save
are not run here (proof 3 holds HQ's case processing of every submission,
``proof.observe.sessions``): neither changes a field the payload reads.

``forwards`` is the repeater's own word on whether it forwards the form
(``FormRepeater.allowed_to_forward``).

That is what the package's own tests read (``proof/connect/test_receiver.py``).
A document's unit (``proof.observe.connect``) runs the whole of it instead,
with nothing called on HQ's behalf (``forwarding``): the project space holds
a Connect repeater as a person adds one (``ConnectFormRepeater`` over
connection settings that name Connect's receiver and authenticate by OAuth's
client credentials grant), a device's submission is posted to HQ's own
receiver view at the address its profile names (``device_post``:
``receiverwrapper/views.py::post``, so ``SubmissionPost.run`` whole, its
locks, its case processing, its save and what it does on commit), HQ's own
signal registers the repeat record (``repeaters/signals.py::
create_form_repeat_records``), HQ's own task fires it
(``tasks.py::process_repeat_record``, which the harness's Celery runs where
it is queued), and HQ's own HTTP client asks Connect for a token and posts
the payload to the address a served Connect answers at
(``proof.connect.runtime.ConnectSession``), over a real connection. What HQ
keeps of each forward is read back from its repeat records (``forwards``).

What is stated of the project space for that, each named where it is done:
its plan has Data Forwarding (``proof.hq.seams.also_granted``); Connect is
reached at a loopback address over plain HTTP, where a deployment's is
reached over HTTPS, so oauthlib is told the transport is so
(``OAUTHLIB_INSECURE_TRANSPORT``, its own switch for it), and HQ's own check
of a forwarding address passes a loopback address while ``DEBUG`` is on, as
the lane's HQ is (``motech/requests.py::validate_user_input_url_for_repeaters``).
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from dataclasses import dataclass


@dataclass(frozen=True)
class Forwarded:
    """What HQ's Connect repeater makes of one submission."""

    app_id: str | None
    build_id: str | None
    forwards: bool
    payload: dict


def receiver_url(domain, receiver_id):
    """The receiver's path for a submission posted under ``receiver_id`` (an app's or a build's id), or with none."""
    from django.urls import reverse

    if receiver_id is None:
        return reverse("receiver_post", args=[domain])
    return reverse("receiver_post_with_app_id", args=[domain, receiver_id])


def forwarded(state, submission_xml: bytes, receiver_id: str | None) -> Forwarded:
    """HQ's Connect payload for ``submission_xml`` posted to the unit's project space under ``receiver_id``.

    ``receiver_id`` is the id in the URL the device posts to: the id HQ's
    build writes into its profile's ``PostURL``
    (``app_manager/models/applications.py::ApplicationBase.post_url``), or
    None for a post to the project space's receiver with no app named.
    """
    from corehq.apps.receiverwrapper.util import get_app_and_build_ids
    from corehq.form_processor.parsers.form import process_xform_xml
    from corehq.form_processor.submission_post import SubmissionPost
    from corehq.motech.repeaters.models import ConnectFormRepeater

    domain = state.domain
    app_id, build_id = get_app_and_build_ids(domain, receiver_id)
    post = SubmissionPost(
        instance=submission_xml,
        attachments={},
        domain=domain,
        app_id=app_id,
        build_id=build_id,
        path=receiver_url(domain, receiver_id),
    )
    form = process_xform_xml(domain, post.instance, post.attachments, post.auth_context.to_json()).submitted_form
    post._post_process_form(form)
    repeater = ConnectFormRepeater(domain=domain)
    payload = json.loads(repeater.generator.get_payload(None, form))
    return Forwarded(
        app_id=app_id, build_id=build_id, forwards=bool(repeater.allowed_to_forward(form)), payload=payload
    )


# Forwarding, end to end ------------------------------------------------------------------------------------

# The OAuth client HQ's connection settings name and Connect's HQ server holds: a credential of the lane's own
# two processes, made for each run and worth nothing outside it.
OAUTH_CLIENT = {"id": "proof-hq-connect-client", "secret": "proof-hq-connect-client-secret"}
CONNECTION_NAME = "CommCare Connect"
BOUNDARY = "proof-device-submission"


@contextmanager
def forwarding(unit, connect_url: str, operation, label: str):
    """The unit's project space forwarding each form it receives to the Connect at ``connect_url``, for the
    block: Data Forwarding on its plan, and a Connect repeater over connection settings naming Connect's receiver
    and its token address, made in an operation of the unit. The caller holds the fork that takes them back."""
    from urllib.parse import urlsplit

    from corehq import privileges
    from corehq.motech.const import OAUTH2_CLIENT
    from corehq.motech.models import ConnectionSettings
    from corehq.motech.repeaters.models import ConnectFormRepeater

    from proof.hq.boot import GUARD
    from proof.hq.seams import also_granted

    address = urlsplit(connect_url)
    GUARD.admit(address.hostname, address.port or 80)
    insecure = os.environ.get("OAUTHLIB_INSECURE_TRANSPORT")
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"
    try:
        with also_granted(privileges.DATA_FORWARDING):
            with operation(f"connect:repeater@{label}", b"connect-repeater"):
                settings = ConnectionSettings(
                    domain=unit.domain,
                    name=CONNECTION_NAME,
                    url=f"{connect_url}/api/receiver/",
                    auth_type=OAUTH2_CLIENT,
                    client_id=OAUTH_CLIENT["id"],
                    token_url=f"{connect_url}/o/token/",
                )
                settings.plaintext_client_secret = OAUTH_CLIENT["secret"]
                settings.save()
                ConnectFormRepeater.objects.create(
                    domain=unit.domain, name=CONNECTION_NAME, connection_settings_id=settings.id
                )
            yield
    finally:
        if insecure is None:
            os.environ.pop("OAUTHLIB_INSECURE_TRANSPORT", None)
        else:
            os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = insecure


def forwards(unit) -> list:
    """What HQ keeps of each form it was to forward, in the order it registered them: the form, the state HQ
    left its repeat record in, and each attempt's state with the start of what HQ wrote of the answer."""
    from corehq.motech.repeaters.models import RepeatRecord, State

    found = []
    for record in RepeatRecord.objects.filter(domain=unit.domain).order_by("registered_at", "id"):
        found.append(
            {
                "form": record.payload_id,
                "state": State(record.state).name,
                "attempts": [
                    {"state": State(attempt.state).name, "message": (attempt.message or "")[:300]}
                    for attempt in record.attempt_set.all()
                ],
            }
        )
    return found


def post_path(profile: bytes | None, domain: str) -> str:
    """Where a device posts a form for the app whose profile this is: the path of its ``PostURL`` property, or
    the project space's receiver with no app named where the profile names none (``None`` for no profile)."""
    from urllib.parse import urlsplit

    from proof.checks.compare.xml_tree import parse_xml

    if profile is not None:
        for element in parse_xml(profile).iter():
            if isinstance(element.tag, str) and element.tag.rsplit("}", 1)[-1] == "property":
                if element.get("key") == "PostURL" and element.get("value"):
                    return urlsplit(element.get("value")).path
    return receiver_url(domain, None)


def device_request(path: str, username: str, password: str, submission_xml: bytes):
    """A form as a device posts it to HQ's receiver: the instance as the ``xml_submission_file`` part of a
    multipart body, with the worker's own credentials."""
    import base64

    from proof.formplayer.client import HqRequest

    body = (
        (
            f"--{BOUNDARY}\r\n"
            'Content-Disposition: form-data; name="xml_submission_file"; filename="form.xml"\r\n'
            "Content-Type: text/xml\r\n\r\n"
        ).encode()
        + submission_xml
        + f"\r\n--{BOUNDARY}--\r\n".encode()
    )
    credentials = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    return HqRequest(
        method="POST",
        path=path,
        query="",
        headers=(
            ("Content-Type", f"multipart/form-data; boundary={BOUNDARY}"),
            ("Authorization", f"Basic {credentials}"),
        ),
        body=body,
    )


META_XMLNS = "http://openrosa.org/jr/xforms"
HQ_XMLNS = "http://commcarehq.org/xforms"


def with_fix(submission: bytes, fix: str) -> bytes:
    """``submission`` with ``fix`` written into its meta's location node; the same bytes where it holds none.

    A submission's location is the one value no code the lane runs writes: HQ's build adds the node and the
    action that fills it (``xform.py::XForm._add_meta_2``, ``orx:pollsensor``), and only CommCare Android runs
    that action (``org/commcare/android/javarosa/PollSensorAction.java``)."""
    from lxml import etree

    from proof.checks.compare.xml_tree import parse_xml

    root = parse_xml(submission)
    nodes = root.findall(f"{{{META_XMLNS}}}meta/{{{HQ_XMLNS}}}location")
    if not nodes:
        return submission
    for node in nodes:
        node.text = fix
    return etree.tostring(root, encoding="utf-8", xml_declaration=True)
