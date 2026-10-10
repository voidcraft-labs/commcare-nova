"""HQ's side of the Connect proof: a form received by HQ's own receiver and forwarded by its own Connect repeater.

Connect never sees a form. It sees the JSON HQ's Connect repeater posts
(``corehq/motech/repeaters/models.py::ConnectFormRepeater``), which HQ's own
payload generator builds from the form HQ holds
(``repeater_generators.py::ConnectFormRepeaterPayloadGenerator.get_payload``):
the form through HQ's form API resource, kept to its domain, id, app id,
build id, received time and metadata, with every block in Connect's
namespace put back at its path under ``form``.

Nothing here builds that payload or calls a function on HQ's behalf. The
whole of it runs (``forwarding``): the project space holds a Connect
repeater as a person adds one (``ConnectFormRepeater`` over connection
settings that name Connect's receiver and authenticate by OAuth's client
credentials grant), a device's submission is posted to HQ's own receiver
view at the address its profile names (``device_request``, ``post_path``:
``receiverwrapper/views.py::post``, so ``SubmissionPost.run`` whole, its
locks, its case processing, its save and what it does on commit), HQ's own
signal registers the repeat record (``repeaters/signals.py::
create_form_repeat_records``), HQ's own task fires it
(``tasks.py::process_repeat_record``, which the harness's Celery runs where
it is queued), and HQ's own HTTP client asks Connect for a token and posts
the payload to the address a served Connect answers at
(``proof.connect.runtime.ConnectSession``), over a real connection. What HQ
keeps of each forward is read back from its repeat records (``forwards``),
and the payload is read where it arrived, in Connect.

The project space's admin sets the forwarder up as a person does, through
HQ's own pages in Chromium (``forwarding``, ``_drive_page``): signed in
through HQ's own sign-in form (``proof.formplayer.hq.sign_in``), they open
HQ's Connection Settings page
(``motech/views.py::ConnectionSettingsDetailView``) and type Connect's
receiver, OAuth's client credentials and their own address for
notifications into it, choosing the OAuth preset as its own script offers
it, and save; then they open HQ's Add Forwarder page for Connect
(``repeaters/views/repeaters.py::AddFormRepeaterView``, whose form lists the
project space's users from HQ's own Elasticsearch), choose that connection
and save. Each page is HQ's own, rendered by its view with its own
JavaScript bundle (built into the image from the page's entry), and every
request the browser makes is answered by the view HQ's URLconf names,
behind HQ's own middleware. What is stated of the project space
for that, each named where it is done: its plan has Data Forwarding
(``proof.hq.seams.also_granted``); the Add Forwarder page gives a forwarder
to production's Connect address one more status to retry on (404, for the
proxy in front of Connect), which the lane's Connect at another address is
then given through HQ's own model method, as production's has it; Connect is
reached at a loopback address over plain HTTP, where a deployment's is
reached over HTTPS, so oauthlib is told the transport is so
(``OAUTHLIB_INSECURE_TRANSPORT``, its own switch for it), and HQ's own check
of a forwarding address passes a loopback address while ``DEBUG`` is on, as
the lane's HQ is (``motech/requests.py::validate_user_input_url_for_repeaters``).

``Forwarded`` is what the package's own tests keep of one forward
(``proof/connect/conftest.py``).
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass


@dataclass(frozen=True)
class Forwarded:
    """What HQ's Connect repeater made of one submission: the payload as it reached Connect, the app and build
    it names, and whether HQ registered a forward for it."""

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


# Forwarding, end to end ------------------------------------------------------------------------------------

# The OAuth client HQ's connection settings name and Connect's HQ server holds: a credential of the lane's own
# two processes, made for each run and worth nothing outside it.
OAUTH_CLIENT = {"id": "proof-hq-connect-client", "secret": "proof-hq-connect-client-secret"}
CONNECTION_NAME = "CommCare Connect"
BOUNDARY = "proof-device-submission"


class ForwarderPageRefused(AssertionError):
    """HQ's Connection Settings or Add Forwarder page did not take the admin's form."""


def _admin_signed_in(unit, operation, label):
    """The project space's admin signed in through HQ's own sign-in form
    (``proof.formplayer.hq.admin_signed_in``)."""
    from proof.formplayer import hq as formplayer_hq

    return formplayer_hq.admin_signed_in(unit, operation, "connect", label)


# The headers that belong to the browser's connection to the origin, not to the request HQ is handed.
_BROWSER_TRANSPORT = {"host", "connection", "content-length", "accept-encoding"}


def _drive_page(unit, path, steps, signed_in, label):
    """HQ's page at ``path`` opened in Chromium for the signed-in admin and ``steps`` run on it, as their browser
    runs them: every request the page makes answered by the view HQ's URLconf names behind HQ's own middleware
    (``proof.formplayer.hq.respond``), each in a request of the unit, and HQ's static files by HQ's own finders.

    The lane has two names for HQ where a deployment has one (the browser's origin, and the address HQ answers
    as), so the ``Origin`` and ``Referer`` the browser wrote are sent under HQ's own, and HQ's CSRF check then
    judges the page's form as it judges production's. Returns the run's outcomes."""
    import hashlib
    from urllib.parse import urlsplit

    from django.conf import settings

    from proof.editors.client import PageResponse
    from proof.editors.hq import editor_build
    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer.client import HqRequest
    from proof.observe import services
    from proof.webapps import static

    driver = services.client_browser()
    browser = (driver.ready or {}).get("origin")
    editor_build()

    def answer(asked):
        parts = urlsplit(asked.url)
        held = static.serve(parts.path) if asked.method == "GET" else None
        if held is not None:
            return held
        headers = []
        for name, value in asked.headers.items():
            if name.lower() in _BROWSER_TRANSPORT:
                continue
            if browser and name.lower() in ("origin", "referer") and value.startswith(browser):
                value = formplayer_hq.PAGE_ORIGIN + value[len(browser) :]
            headers.append((name, value))
        body = asked.body or b""
        digest = hashlib.sha256(f"connect-page|{label}|{asked.method}|{asked.url}|".encode() + body).digest()
        with unit.committing(), unit.request(digest), formplayer_hq._language_put_back(), static.in_hq_root():
            response = formplayer_hq.respond(
                formplayer_hq.django_request(HqRequest(asked.method, parts.path, parts.query, tuple(headers), body))
            )
            if hasattr(response, "render") and not getattr(response, "is_rendered", True):
                response.render()
            content = b"".join(response.streaming_content) if response.streaming else response.content
        answered = [(name, value) for name, value in response.items()]
        answered += [("Set-Cookie", morsel.OutputString()) for morsel in response.cookies.values()]
        return PageResponse(response.status_code, answered, content)

    cookies = {settings.SESSION_COOKIE_NAME: signed_in.session, settings.CSRF_COOKIE_NAME: signed_in.csrf}
    with static.compiled():
        run = driver.run([{"goto": path}, {"settle": True}, *steps], answer=answer, cookies=cookies, deadline=180.0)
    return run["outcomes"]


def _typed(selector, value):
    return {"until": "webapps/fill", "arg": {"selector": selector, "value": value}}


def _chosen(selector, value):
    return {"until": "pages/choose", "arg": {"selector": selector, "value": value}}


def _saved(path, text):
    """The page's own submit button clicked, then HQ's answer to the form it posts, and, where HQ answered it with
    a redirect, the page it sent the browser to loaded."""
    return [
        {"until": "webapps/click", "arg": {"selector": "form button[type='submit']", "text": text, "visible": True}},
        {"followRedirect": {"method": "POST", "pathname": path}},
        {"settle": True},
    ]


@contextmanager
def forwarding(unit, connect_url: str, operation, label: str):
    """The unit's project space forwarding each form it receives to the Connect at ``connect_url``, for the
    block: Data Forwarding on its plan, and the connection settings and Connect forwarder its admin saves through
    HQ's own pages. The caller holds the fork that takes them back."""
    from urllib.parse import urlsplit

    from corehq import privileges
    from corehq.motech.const import OAUTH2_CLIENT
    from corehq.motech.models import ConnectionSettings
    from corehq.motech.repeaters.models import ConnectFormRepeater
    from corehq.motech.repeaters.views.repeaters import DomainForwardingOptionsView
    from corehq.motech.views import ConnectionSettingsDetailView
    from django.urls import reverse

    from proof.hq.boot import GUARD
    from proof.hq.seams import also_granted

    address = urlsplit(connect_url)
    GUARD.admit(address.hostname, address.port or 80)
    insecure = os.environ.get("OAUTHLIB_INSECURE_TRANSPORT")
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"
    try:
        with also_granted(privileges.DATA_FORWARDING):
            signed_in = _admin_signed_in(unit, operation, label)
            settings_path = reverse(ConnectionSettingsDetailView.urlname, kwargs={"domain": unit.domain})
            # What the admin types and chooses; every other control is left as the page draws it. A token address
            # is kept only under the "(Custom)" preset: with any other, the page's save drops it
            # (``motech/forms.py::ConnectionSettingsForm.save``), and HQ then asks no address for a token.
            _drive_page(
                unit,
                settings_path,
                [
                    _typed("#id_name", CONNECTION_NAME),
                    _typed("#id_notify_addresses_str", unit.web_user.username),
                    _typed("#id_url", f"{connect_url}/api/receiver/"),
                    _chosen("#id_auth_type", OAUTH2_CLIENT),
                    {"settle": True},
                    _typed("#id_client_id", OAUTH_CLIENT["id"]),
                    _typed("#id_plaintext_client_secret", OAUTH_CLIENT["secret"]),
                    _chosen("#id_auth_preset", "CUSTOM"),
                    {"settle": True},
                    _typed("#id_token_url", f"{connect_url}/o/token/"),
                    *_saved(settings_path, "Save"),
                ],
                signed_in,
                f"connection-settings@{label}",
            )
            settings = ConnectionSettings.objects.filter(domain=unit.domain, name=CONNECTION_NAME).first()
            if settings is None:
                raise ForwarderPageRefused(
                    f"HQ's Connection Settings page ({settings_path}) saved no connection named {CONNECTION_NAME!r}"
                    " when the admin saved it."
                )
            forwarder_path = (
                f"{reverse(DomainForwardingOptionsView.urlname, args=[unit.domain])}new/ConnectFormRepeater/"
            )
            _drive_page(
                unit,
                forwarder_path,
                [
                    _chosen("#id_connection_settings_id", str(settings.id)),
                    *_saved(forwarder_path, "Start Forwarding"),
                ],
                signed_in,
                f"connect-forwarder@{label}",
            )
            if not ConnectFormRepeater.objects.filter(domain=unit.domain).exists():
                raise ForwarderPageRefused(
                    f"HQ's Add Forwarder page ({forwarder_path}) saved no Connect forwarder when the admin saved it."
                )
            with operation(f"connect:retry-404@{label}", b"connect-retry-404"):
                # HQ's Add Forwarder page gives a forwarder whose address is production's Connect one more status
                # to retry on (``views/repeaters.py::AddFormRepeaterView.make_repeater``, for the 404 a proxy in
                # front of Connect answers while it is overloaded). The lane's Connect is at another address, so
                # the forwarder the page saved is given it here, as production's has it.
                (repeater,) = ConnectFormRepeater.objects.filter(domain=unit.domain)
                repeater.add_backoff_code(404)
                repeater.save()
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
                # What HQ wrote of the answer: where it sent the form and the status it got (the body, which for
                # a failure is the page Connect rendered, is Connect's to keep).
                "attempts": [
                    {"state": State(attempt.state).name, "message": "\n".join((attempt.message or "").splitlines()[:2])}
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
