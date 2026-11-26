"""HQ's own code, run over a check's HQ state.

Each operation calls the HQ function that does the work in production and
returns what HQ returned or held afterwards. None opens a seam: the test
owns its seams (``proof.hq.seams``) and opens them around the operations it
runs.

- ``publish``: each captured upload of Nova's publish client, applied through
  ``app_manager/views/app_import_api.py::_handle_import_app``;
- ``apply_media_upload``: a captured media upload of Nova's publish, applied
  through ``app_import_api.py::_handle_upload_multimedia``, which maps the
  media into the app (``hqmedia/tasks.py::process_bulk_upload_zip``);
- ``publish_capture``: a captured first publish (the shell's create and the
  content that fills it) and the update Nova built over it, each update
  applied only while HQ serves the source it was built over
  (``hold_assumed_source``);
- ``with_runtime_app_id``: a local archive whose runtime URLs name the app
  HQ holds in place of the placeholder its capture named;
- ``app_source``: ``app_manager/views/apps.py::app_source``, decorators and
  all, as Nova's update reads it;
- ``api_request``: a request to any of HQ's API views as Nova's client sends
  it, authenticated by an API key (``seed_api_user``, ``seed_api_key``), with
  HQ's authentication, permission and privilege checks and its rate limiter
  run (``proof.hq.seams.api_rate_limits``);
- ``build``: ``validate_app()``, ``create_all_files()`` and
  ``create_all_files(build_profile_id)`` for each build profile;
- ``process_case_blocks``: HQ's case processing of one submission up to its
  case database;
- ``save_standalone_report``: HQ's SQL and attachment save of a submission
  without case blocks, returning only its id for a fresh read;
- ``compile_case_search`` / ``compile_domain_filter``: HQ's case search
  query compiler, in a case search context and with only a domain;
- ``search_request_config``: HQ's reading of a case search request as
  Formplayer posts it;
- ``upload_lookup_workbook``: HQ's lookup table upload;
- ``hold_assumed_resources``: the lookup tables a captured publish was
  decided over, held to what HQ's own table and row resources serve
  (``CapturedResourcesNotHeld``);
- ``lookup_tables_read``, ``fixture_rows_read``, ``locations_read``,
  ``location_patch``, ``location_type_write``: the reads and writes Nova's
  client makes of HQ's lookup table, row, location and level resources,
  through ``api_request`` (the table list in the order of its tables' ids,
  ``lookup_tables_in_id_order``);
- ``app_list_read``, ``application_read``, ``api_access_read``,
  ``project_spaces_read``: the reads Nova's client makes to bring an app in,
  of HQ's app list, application resource, lookup table list (for one row, the
  API access check) and project-space list, through ``api_request``;
  ``client_request``: a request behind HQ's own middleware, for the one read
  whose answer may depend on it (a superuser's key, ``seed_api_superuser``);
  ``remote_app_through_hq``: a remote app saved by HQ's model;
- ``location_types_read`` and ``media_file_read``: the reads Nova's client
  makes of HQ's level resource and of one mapped file, through
  ``api_request`` (a file's answer keeps its bytes);
- ``save_authored_app``, ``save_authored_tables``, ``save_authored_places``,
  ``save_authored_practice_workers``: an app HQ's own pages and models made
  (``proof/hq-apps/<base>/``), and the lookup tables, places and practice
  workers it was made beside, made again by HQ's own models from what was
  retained of them; ``practice_worker``: one mobile worker made and put in
  practice mode as HQ's mobile worker pages do it.
"""

import json
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from email.parser import BytesHeaderParser
from typing import NamedTuple
from unittest.mock import patch

from proof.hq import buildcache
from proof.hq import requests as hq_requests
from proof.hq.boot import HarnessRefusal

# Publish -----------------------------------------------------------------


@dataclass(frozen=True)
class Upload:
    """One captured request body of Nova's ``importApp``, with its content type."""

    body: bytes
    content_type: str


@dataclass
class Published:
    status: int
    response: dict
    request_messages: list


class PublishRefused(AssertionError):
    """HQ refused an upload the harness applied."""


class CapturedSourceNotHeld(HarnessRefusal):
    """HQ serves the app with a source other than the one a captured import was built over."""


class CapturedResourcesNotHeld(HarnessRefusal):
    """HQ holds lookup tables other than the ones a captured publish read before it decided what to send."""


class CapturedCounterNotHeld(HarnessRefusal):
    """HQ's save counter moved over a write otherwise than the capture's peer counted it over the same write."""


# The app id a capture's content import and updates name, and a local archive's runtime URLs
# (``proof/corpus/publish.ts::PLACEHOLDER_APP_ID``). HQ mints the real one at the create.
PLACEHOLDER_APP_ID = "nova-proof-placeholder-app"


def _boundary(content_type):
    headers = BytesHeaderParser().parsebytes(f"Content-Type: {content_type}\r\n\r\n".encode())
    boundary = headers.get_param("boundary")
    if not boundary:
        raise ValueError(f"The captured upload's content type {content_type!r} names no multipart boundary.")
    return boundary.encode()


def _form_parts(body, boundary):
    """Split a multipart/form-data body into (headers, content) pairs by its framing."""
    delimiter = b"--" + boundary
    pieces = body.split(delimiter)
    if len(pieces) < 3 or not pieces[-1].startswith(b"--"):
        raise ValueError("The captured upload does not end with its closing multipart delimiter.")
    parts = []
    for piece in pieces[1:-1]:
        if not piece.startswith(b"\r\n") or not piece.endswith(b"\r\n"):
            raise ValueError("The captured upload has a multipart part that is not CRLF-framed.")
        head, separator, content = piece[2:-2].partition(b"\r\n\r\n")
        if not separator:
            raise ValueError("The captured upload has a multipart part without a header block.")
        parts.append((head, content))
    return pieces[0], parts, pieces[-1]


def _part_name(head):
    headers = BytesHeaderParser().parsebytes(head + b"\r\n\r\n")
    return headers.get_param("name", header="content-disposition")


def with_app_id(upload: Upload, app_id: str) -> Upload:
    """The upload with its ``app_id`` field set to the app HQ holds.

    Nova's update names the app HQ's create returned; a capture names the
    one its peer returned, so the harness writes HQ's id into that field and
    leaves every other byte as captured.
    """
    boundary = _boundary(upload.content_type)
    preamble, parts, epilogue = _form_parts(upload.body, boundary)
    names = [_part_name(head) for head, _ in parts]
    if names.count("app_id") != 1:
        raise ValueError(
            f"A captured update carries exactly one app_id field; this one carries {names.count('app_id')}."
        )
    delimiter = b"--" + boundary
    rebuilt = [preamble]
    for (head, content), name in zip(parts, names, strict=True):
        if name == "app_id":
            content = app_id.encode()
        rebuilt.append(b"\r\n" + head + b"\r\n\r\n" + content + b"\r\n")
    rebuilt.append(epilogue)
    return Upload(delimiter.join(rebuilt), upload.content_type)


class CapturedIdsNotHeld(HarnessRefusal):
    """A captured update names a menu or form id the capture's peer held that the app HQ holds has no place for."""


# The multipart field of an import that carries the application JSON (``app_import_api.py::_handle_import_app``).
APP_FILE = "app_file"


def _with_ids(value, ids):
    """``value`` (parsed JSON) with every string equal to a key of ``ids`` written as its value, and every key that
    names a form's source by its id (``<id>.xml``, ``_attachments``) written under the new id."""
    if isinstance(value, str):
        return ids.get(value, value)
    if isinstance(value, list):
        return [_with_ids(item, ids) for item in value]
    if isinstance(value, dict):
        renamed = {}
        for key, item in value.items():
            stem, dot, extension = key.rpartition(".")
            if dot and extension == "xml" and stem in ids:
                key = f"{ids[stem]}.xml"
            renamed[key] = _with_ids(item, ids)
        return renamed
    return value


def with_held_ids(upload: Upload, ids) -> Upload:
    """The upload with each menu or form id of ``ids`` (``{captured id: id HQ holds}``) written as HQ holds it.

    Nova's publish after a bring-in of changes made in CommCare HQ names
    each menu and form by the id its reading of HQ's app found
    (``lib/deployment/hqChanges/bringIn.ts``); a capture names the one its
    peer holds, which for a form HQ's ``new_form`` added is one the peer
    drew, where HQ minted its own. So the harness writes HQ's id wherever
    the application JSON names the peer's, as ``with_app_id`` writes the
    app's, and leaves every other field as captured. An id it finds again
    after the rewrite, inside a text it does not read, refuses
    (``CapturedIdsNotHeld``) rather than send a body naming both.
    """
    if not ids:
        return upload
    boundary = _boundary(upload.content_type)
    preamble, parts, epilogue = _form_parts(upload.body, boundary)
    names = [_part_name(head) for head, _ in parts]
    if names.count(APP_FILE) != 1:
        raise ValueError(
            f"A captured update carries exactly one {APP_FILE} field; this one carries {names.count(APP_FILE)}."
        )
    delimiter = b"--" + boundary
    rebuilt = [preamble]
    for (head, content), name in zip(parts, names, strict=True):
        if name == APP_FILE:
            written = json.dumps(_with_ids(json.loads(content), ids), ensure_ascii=False, separators=(",", ":"))
            left = sorted(captured for captured in ids if captured in written)
            if left:
                raise CapturedIdsNotHeld(
                    f"The captured update still names {left} after the harness wrote the ids HQ holds in their"
                    " place, inside a text it does not read as an id. Look at where Nova's application JSON names"
                    " a menu or form id."
                )
            content = written.encode()
        rebuilt.append(b"\r\n" + head + b"\r\n\r\n" + content + b"\r\n")
    rebuilt.append(epilogue)
    return Upload(delimiter.join(rebuilt), upload.content_type)


def upload_field_names(upload: Upload):
    _, parts, _ = _form_parts(upload.body, _boundary(upload.content_type))
    return [_part_name(head) for head, _ in parts]


def upload_field(upload: Upload, name: str) -> bytes:
    """The content of the captured upload's one field called ``name``."""
    _, parts, _ = _form_parts(upload.body, _boundary(upload.content_type))
    found = [content for head, content in parts if _part_name(head) == name]
    if len(found) != 1:
        raise ValueError(f"The captured upload carries {len(found)} fields named {name!r}; the harness reads one.")
    return found[0]


def apply_upload(state, upload: Upload) -> Published:
    """Apply one upload through HQ's import API view body."""
    from corehq.apps.app_manager.views.app_import_api import _handle_import_app

    request = hq_requests.raw_post(state, f"/a/{state.domain}/apps/api/import_app/", upload.body, upload.content_type)
    response = _handle_import_app(request, state.domain)
    return Published(response.status_code, json.loads(response.content), hq_requests.messages(request))


@dataclass
class MediaUploaded:
    """HQ's answer to a media upload, and its report of the processing it ran (None where the view refused)."""

    status: int
    response: dict
    processing: dict | None


def apply_media_upload(state, app_id, upload: Upload) -> MediaUploaded:
    """Apply one media upload of Nova's publish through HQ's bulk multimedia API view body, to the app ``app_id``.

    Nova's publish sends one bounded batch of its remaining assets per ZIP
    once its import landed (``lib/deployment/service.ts::uploadMediaBytes``
    -> ``lib/commcare/client.ts::uploadAppMediaBundle``, ``POST
    /a/<domain>/apps/api/<app id>/multimedia/``). The view
    (``app_import_api.py::_handle_upload_multimedia``) keeps the ZIP
    (``hqmedia/utils.py::save_multimedia_upload``) and starts
    ``hqmedia/tasks.py::process_bulk_upload_zip``, which stores each file the
    app references as a ``CommCareMultimedia`` with its bytes and maps it
    into the app's ``multimedia_map`` (``create_mapping``), then saves the
    app. HQ's Celery runs tasks inline here (``CELERY_TASK_ALWAYS_EAGER``), so
    the media is mapped before this returns, where production maps it in a
    worker while Nova polls.

    The captured request names its capture peer's app in its path; HQ's view
    takes the app from its URL, so the request is sent to the app HQ holds
    and every byte of its body is as captured. ``processing`` is what HQ's
    status view serves Nova's poll
    (``_handle_multimedia_status`` -> ``BulkMultimediaStatusCache.get_response``).
    """
    from corehq.apps.app_manager.views.app_import_api import _handle_upload_multimedia
    from corehq.apps.hqmedia.cache import BulkMultimediaStatusCache

    request = hq_requests.raw_post(
        state, f"/a/{state.domain}/apps/api/{app_id}/multimedia/", upload.body, upload.content_type
    )
    response = _handle_upload_multimedia(request, state.domain, app_id)
    answered = json.loads(response.content)
    processing = None
    if response.status_code == 200 and answered.get("success"):
        status = BulkMultimediaStatusCache.get(answered["processing_id"])
        if status is None:
            raise PublishRefused(
                f"HQ accepted the media upload for {app_id} as {answered['processing_id']} and holds no status for"
                " it, so whether its media was mapped is unknown."
            )
        processing = status.get_response()
    return MediaUploaded(response.status_code, answered, processing)


def publish(state, uploads):
    """Apply Nova's captured uploads in order: a create, then updates of the app it made.

    Returns HQ's app id and each upload's result. An upload HQ refuses stops
    the publish, as it stops Nova's.
    """
    uploads = list(uploads)
    if not uploads:
        raise ValueError("A publish needs at least the create upload.")
    if "app_id" in upload_field_names(uploads[0]):
        raise ValueError("The first upload of a publish is the create, which carries no app_id.")
    results = []
    app_id = None
    for index, upload in enumerate(uploads):
        if index:
            upload = with_app_id(upload, app_id)
        result = _accepted(apply_upload(state, upload), f"upload {index + 1} of the publish")
        results.append(result)
        app_id = result.response["app_id"]
    return app_id, results


def _accepted(result: Published, what: str) -> Published:
    if not (200 <= result.status < 300 and result.response.get("success")):
        raise PublishRefused(f"HQ refused {what} with status {result.status}: {result.response}")
    return result


_ABSENT = object()


def _field(source, path):
    """The value at ``path`` (``build_spec.version``) in HQ's source, or ``_ABSENT``."""
    value = source
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            return _ABSENT
        value = value[key]
    return value


def source_differences(served, assumed):
    """Each field ``assumed`` names, by its path, whose value HQ's ``served`` source does not hold: ``[(path,
    assumed value, served value or None)]``. HQ returns each as stored, so JSON equality decides."""
    differences = []
    for path, value in sorted(assumed.items()):
        held = _field(served, path)
        if held is _ABSENT or held != value:
            differences.append((path, value, None if held is _ABSENT else held))
    return differences


def hold_assumed_source(state, app_id, assumed, what):
    """Refuse (``CapturedSourceNotHeld``) unless HQ's ``app_source`` serves the app with every field of
    ``assumed``: a captured import built over another source is not what Nova would send to this HQ."""
    differences = source_differences(app_source(state, app_id), assumed)
    if differences:
        named = "; ".join(
            f"{path}: the capture assumed {json.dumps(value, sort_keys=True)}, HQ serves"
            f" {json.dumps(held, sort_keys=True)}"
            for path, value, held in differences
        )
        raise CapturedSourceNotHeld(
            f"The {what} was built over a source HQ does not serve for the app ({app_id}): {named}. Nova's publish"
            " over this HQ would send other bytes, so the harness does not apply the captured ones. Capture the"
            " import over the source HQ holds (proof/corpus/publish.ts, PublishInput.source and the peer's shell"
            " source, proof/corpus/targetPeer.ts::shellSource)."
        )


def publish_capture(state, create: Upload, content: Upload, content_source, update: Upload, update_source):
    """Apply a captured publish: the shell's create, the content that fills it, then the update Nova built over A.

    Nova reads the app's source back through ``app_source`` after the create
    and before each update, and builds what it sends over it
    (``lib/deployment/importApplication.ts``); a capture records the fields of
    the source its peer answered with. So the shell is created, HQ's own read
    of it is held to the content's assumed source (``hold_assumed_source``),
    the content is applied with A's id (``with_app_id``), A's read is held to
    the update's assumed source, and the update is applied: over any other
    source the captured bytes are not what Nova would send to this HQ, and the
    harness refuses (``CapturedSourceNotHeld``), naming each differing field.

    Returns A's id and HQ's answer to the create, the content and the update.
    """
    app_id, (created,) = publish(state, [create])
    hold_assumed_source(state, app_id, content_source, "captured content")
    filled = _accepted(apply_upload(state, with_app_id(content, app_id)), "the captured content")
    hold_assumed_source(state, app_id, update_source, "captured update")
    updated = _accepted(apply_upload(state, with_app_id(update, app_id)), "the captured update")
    return app_id, created, filled, updated


# A local archive's runtime URLs: each ``(member, element, attribute)`` that names one, and the path segments
# after ``/a/<domain>/`` of the URLs that name the app (``lib/commcare/runtimeTarget.ts::runtimeUrls``,
# ``::profileServerProperties``): the search, the case fixture, the restore, and both receivers HQ's
# ``ApplicationBase.post_url`` picks between, the secure one where the project space's app submits securely
# (``receiverwrapper/urls.py``: ``receiver_post_with_app_id``, ``receiver_secure_post_with_app_id``).
_RUNTIME_URL_PLACES = (
    ("suite.xml", "query", "url"),
    ("suite.xml", "query", "value"),
    ("profile.ccpr", "property", "value"),
)
_APP_ID_PATHS = (
    ("phone", "search"),
    ("phone", "case_fixture"),
    ("phone", "restore"),
    ("receiver",),
    ("receiver", "secure"),
)


def _with_app_id_in_url(url, app_id):
    """``url`` with the placeholder app id replaced by ``app_id`` where it is one of the archive's runtime URLs
    that name the app: ``<origin>/a/<domain>/<path>/<placeholder>/``. Any other value is returned as it is."""
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return url
    segments = parts.path.split("/")
    # ["", "a", <domain>, *path, <app id>, ""]
    if len(segments) < 5 or segments[1] != "a" or segments[-1] != "" or segments[-2] != PLACEHOLDER_APP_ID:
        return url
    if tuple(segments[3:-2]) not in _APP_ID_PATHS:
        return url
    return urlunsplit(parts._replace(path="/".join([*segments[:-2], app_id, ""])))


def _rewritten_member(xml: bytes, places, app_id):
    """The member's XML with each runtime URL that names the placeholder naming ``app_id``, parsed and written
    as XML; None where no URL names it."""
    from lxml import etree

    root = etree.fromstring(xml)
    changed = False
    for element_name, attribute in places:
        for element in root.iter(etree.Element):
            if etree.QName(element).localname != element_name:
                continue
            value = element.get(attribute)
            if value is None:
                continue
            rewritten = _with_app_id_in_url(value, app_id)
            if rewritten != value:
                element.set(attribute, rewritten)
                changed = True
    if not changed:
        return None
    return etree.tostring(root, xml_declaration=True, encoding="utf-8")


def with_runtime_app_id(archive: bytes, app_id: str) -> bytes:
    """The local archive with the placeholder app id its capture named (``PLACEHOLDER_APP_ID``) replaced by
    ``app_id``, the app HQ holds, in every runtime URL that names the app: the ``suite.xml`` member's search and
    case fixture URLs, and the ``profile.ccpr`` member's ``PostURL`` (the plain receiver or the secure one) and
    ``ota-restore-url``.

    Each member is parsed and written as XML, never edited as text, and every other member and every entry's
    name, order and compression are kept. It is the counterpart of ``with_app_id``, which names A in an update's
    ``app_id`` field: Nova compiles a local archive for the deployment it was published to, whose HQ app the
    capture could not know. An archive whose URLs name no placeholder (a control's pre-fix archive, which names
    no app) is returned as it is.
    """
    import io
    import zipfile

    places = {}
    for member, element, attribute in _RUNTIME_URL_PLACES:
        places.setdefault(member, []).append((element, attribute))
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        members = [(info, source.read(info)) for info in source.infolist()]
    rewritten = {}
    for info, data in members:
        if info.filename in places:
            replaced = _rewritten_member(data, places[info.filename], app_id)
            if replaced is not None:
                rewritten[info.filename] = replaced
    if not rewritten:
        return archive
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as target:
        for info, data in members:
            target.writestr(info, rewritten.get(info.filename, data))
    return out.getvalue()


def app_source(state, app_id):
    """The app's source as HQ's ``app_source`` view serves it to Nova's update."""
    from corehq.apps.app_manager.views.apps import app_source as view

    request = hq_requests.get(state, f"/a/{state.domain}/apps/source/{app_id}/")
    response = view(request, state.domain, app_id)
    if response.status_code != 200:
        raise PublishRefused(f"HQ's app_source answered {response.status_code} for {app_id}.")
    return json.loads(response.content)


def held_app(state, app_id):
    """The app as HQ holds it, freshly read (HQ memoizes builds on the object)."""
    from corehq.apps.app_manager.dbaccessors import get_app

    return get_app(state.domain, app_id)


# HQ's API, as Nova's client reaches it ---------------------------------------


class ApiCredential(NamedTuple):
    """A web user's API key, as Nova's client sends it (``Authorization: ApiKey <username>:<key>``)."""

    username: str
    key: str


@dataclass(frozen=True)
class HqAnswer:
    """HQ's answer to one API request: its status, the headers a reader of it reads (``Content-Type`` and
    ``Retry-After``, where the response carries them), and its body as text."""

    status: int
    headers: dict
    body: str

    def retained(self):
        """The answer as a retained read holds it (``proof/hq-reads/``): ``{status, headers, body}``, the headers
        and body left out where HQ sent none (a view that raised ``Http404`` is ``{"status": 404}``, one that raised
        ``PermissionDenied`` ``{"status": 403}``)."""
        return {
            "status": self.status,
            **({"headers": dict(sorted(self.headers.items()))} if self.headers else {}),
            **({"body": self.body} if self.body else {}),
        }


# The response headers an answer keeps: those Nova's client reads.
_ANSWER_HEADERS = ("Content-Type", "Retry-After")


def api_request(
    state,
    method: str,
    path: str,
    *,
    credential: ApiCredential | None,
    body: bytes = b"",
    content_type: str = "application/json",
) -> HqAnswer:
    """HQ's answer to one request to its API, as Nova's client sends it.

    The request is built with Django's ``RequestFactory`` and an
    ``Authorization: ApiKey <username>:<key>`` header for ``credential`` (none
    for ``None``), with none of ``proof/hq/requests.py``'s session state: the
    user is the anonymous one Django's authentication middleware gives a
    request with no session, and its project space is the one its path names,
    as HQ's ``UsersMiddleware`` sets it. Its path is resolved through HQ's
    URLconf and the view called with its decorators, so HQ's API key
    authentication, permission check, privilege check and rate limiter
    (``HQThrottle``) all run. Where the view or a decorator raises ``Http404``
    or ``PermissionDenied`` in place of returning a response, the answer is the
    status Django's handler gives it (404, 403) alone, which is all Nova reads
    of it. Run it under ``proof.hq.seams.api_rate_limits`` or
    ``rate_counters``, which hold the rate limiter's counts.
    """
    response = _api_response(state, method, path, credential=credential, body=body, content_type=content_type)
    return response if isinstance(response, HqAnswer) else _answered(response)


def _api_response(state, method, path, *, credential, body=b"", content_type="application/json"):
    """The Django response HQ's view gives the request ``api_request`` describes, or the ``HqAnswer`` of a raised
    ``Http404`` or ``PermissionDenied``."""
    from django.contrib.auth.models import AnonymousUser
    from django.core.exceptions import PermissionDenied
    from django.http import Http404
    from django.test import RequestFactory
    from django.urls import resolve

    headers = {} if credential is None else {"HTTP_AUTHORIZATION": f"ApiKey {credential.username}:{credential.key}"}
    request = RequestFactory().generic(method, path, data=body, content_type=content_type, **headers)
    request.user = AnonymousUser()
    match = resolve(request.path)
    if "domain" in match.kwargs:
        request.domain = match.kwargs["domain"]
    try:
        return match.func(request, *match.args, **match.kwargs)
    except Http404:
        return HqAnswer(404, {}, "")
    except PermissionDenied:
        return HqAnswer(403, {}, "")


def _content(response) -> bytes:
    if hasattr(response, "render") and not getattr(response, "is_rendered", True):
        response.render()
    return b"".join(response.streaming_content) if response.streaming else response.content


def _answered(response) -> HqAnswer:
    """A Django response as an ``HqAnswer``: its status, the headers Nova's client reads, and its body as text."""
    content = _content(response)
    kept = {name: response[name] for name in _ANSWER_HEADERS if response.has_header(name)}
    return HqAnswer(response.status_code, kept, content.decode("utf-8"))


# The password every API user the harness seeds holds; an API request authenticates by its key alone.
API_USER_PASSWORD = "nova-proof-api-user"


def seed_api_user(
    state, username: str, *, member=True, edit_apps=True, access_api=True, edit_locations=False, edit_data=False
) -> ApiCredential:
    """A web user with an active API key, made by HQ's own models: a member of the state's project space under a
    role holding exactly ``edit_apps``, ``access_api``, ``edit_locations`` and ``edit_data`` as given, or, with
    ``member`` false, a member of none. Returns the key's credential."""
    from corehq.apps.users.models import HqPermissions, WebUser
    from corehq.apps.users.models_role import UserRole

    if member:
        role = UserRole.create(
            state.domain,
            f"API {username}",
            permissions=HqPermissions(
                edit_apps=edit_apps, access_api=access_api, edit_locations=edit_locations, edit_data=edit_data
            ),
        )
        WebUser.create(state.domain, username, API_USER_PASSWORD, None, None, role_id=role.get_id)
    else:
        WebUser.create(None, username, API_USER_PASSWORD, None, None)
    return seed_api_key(state, username)


def seed_api_key(state, username: str, *, active=True, domain: str | None = None) -> ApiCredential:
    """A further API key of the web user ``username``, made by HQ's own model: inactive where ``active`` is
    false, and scoped to the project space ``domain`` where one is named (HQ's authentication accepts a scoped
    key only for that project space, ``HQApiKeyAuthentication.is_authenticated``)."""
    from corehq.apps.users.models import HQApiKey
    from django.contrib.auth.models import User

    user = User.objects.get(username=username)
    key = HQApiKey.objects.create(user=user, name=f"nova-proof-{username}", is_active=active, domain=domain or "")
    return ApiCredential(username, key.plaintext_key)


def seed_api_superuser(state, username: str) -> ApiCredential:
    """The member ``seed_api_user`` makes, with its key through ``seed_api_key``, then made a superuser by HQ's own
    model: ``is_superuser`` set on its ``WebUser`` and saved, which writes the flag to its Django user
    (``users/models.py::CouchUser.save``, ``sync_to_django_user``), where HQ's plan check reads it
    (``api/resources/__init__.py::HqBaseResource.dispatch``, ``request.user.is_superuser``). ``seed_api_user`` alone
    makes a role-scoped member and cannot make a superuser."""
    from corehq.apps.users.models import WebUser

    credential = seed_api_user(state, username)
    user = WebUser.get_by_username(username)
    user.is_superuser = True
    user.save()
    return credential


def source_read(state, app_id, credential: ApiCredential) -> HqAnswer:
    """``app_manager/views/apps.py::app_source`` for ``app_id``, as Nova's ``readHqAppSource`` reads it."""
    return api_request(state, "GET", f"/a/{state.domain}/apps/source/{app_id}/", credential=credential)


def import_request(state, upload: Upload, credential: ApiCredential) -> HqAnswer:
    """``app_manager/views/app_import_api.py::import_app_api`` with its decorators, as Nova's ``importApp`` sends
    it."""
    return api_request(
        state,
        "POST",
        f"/a/{state.domain}/apps/api/import_app/",
        credential=credential,
        body=upload.body,
        content_type=upload.content_type,
    )


@contextmanager
def lookup_tables_in_id_order():
    """``LookupTableResource``'s list, for the block, in the order of its tables' ids.

    HQ lists a project space's tables with no order of its own
    (``fixtures/resources/v0_1.py::LookupTableResource.obj_get_list``, through
    ``fixtures/models.py::LookupTableManager.by_domain``, a plain filter on
    a model with no ordering), so the list is in the order Postgres happens
    to hand the rows back in: where each row sits in the table, which
    depends on what was written and rolled back before in the worker's
    database and on when Postgres's own vacuum last ran. Every edit to a
    table writes its row anew, wherever the page has room. Every order is one
    HQ may give, and Nova reads the list by id and tag; the harness gives the
    same one in every state, as ``proof.formplayer.hq.cases_in_id_order``
    does for a restore's cases.
    """
    from unittest import mock

    from corehq.apps.fixtures.resources.v0_1 import LookupTableResource

    held = LookupTableResource.obj_get_list

    def obj_get_list(self, *args, **kwargs):
        return sorted(held(self, *args, **kwargs), key=lambda table: table.id.hex)

    with mock.patch.object(LookupTableResource, "obj_get_list", obj_get_list):
        yield


def lookup_tables_read(state, credential: ApiCredential) -> HqAnswer:
    """``fixtures/resources/v0_1.py::LookupTableResource``'s list, as Nova's ``listHqLookupTables`` reads it, in the
    order of its tables' ids (``lookup_tables_in_id_order``)."""
    with lookup_tables_in_id_order():
        return api_request(state, "GET", f"/a/{state.domain}/api/lookup_table/v1/?limit=100", credential=credential)


def fixture_rows_read(state, table_id, credential: ApiCredential, *, query="") -> HqAnswer:
    """``fixtures/resources/v0_1.py::FixtureResource`` filtered to one table, as Nova's ``readHqLookupTableRows``
    reads it; ``query`` is a further page's query as HQ's ``meta.next`` names it (``?fixture_type_id=...&offset=...``),
    resolved against the first page's address."""
    path = f"/a/{state.domain}/api/fixture/v1/"
    return api_request(state, "GET", f"{path}{query or f'?fixture_type_id={table_id}'}", credential=credential)


def lookup_detail_targets(table, rows):
    """The detail reads a first reading makes of one listed table whose definition or rows a plain row list cannot
    carry: a field with properties, a row attribute, or a row the list serves with its fields' values in the detailed
    form (``lib/commcare/hq/lookupSource.ts::readSelectedHqLookupRows`` and ``hasRichDefinition``). Returns ``[(kind,
    resource, remote id)]``: the table's definition (``lookupDefinition``, ``lookup_table``) and then each row in the
    list's order (``fixtureDetail``, ``lookup_table_item``), and nothing for a plain table. ``retain.py`` makes these
    reads of a base it retains and the unit of a document made in HQ, so both hand the reader the same answers."""
    if not (
        table.get("item_attributes")
        or any(field.get("properties") for field in table["fields"])
        or any(not isinstance(value, str) for row in rows for value in row["fields"].values())
    ):
        return []
    return [("lookupDefinition", "lookup_table", table["id"])] + [
        ("fixtureDetail", "lookup_table_item", row["id"]) for row in rows
    ]


def lookup_detail_read(state, resource, remote_id, credential: ApiCredential) -> HqAnswer:
    """One of ``fixtures/resources/v0_1.py``'s detail resources (``lookup_detail_targets``), as Nova's reader reads it."""
    return api_request(state, "GET", f"/a/{state.domain}/api/{resource}/v1/{remote_id}/", credential=credential)


def locations_read(state, credential: ApiCredential) -> HqAnswer:
    """``locations/resources/v0_6.py::LocationResource``'s list, as Nova's ``listHqLocations`` reads it."""
    return api_request(state, "GET", f"/a/{state.domain}/api/location/v2/?limit=1000", credential=credential)



def location_external_ids_read(state, credential: ApiCredential) -> HqAnswer:
    """The v1 LocationResource exposes external_id, which v2 omits."""
    return api_request(state, "GET", f"/a/{state.domain}/api/location/v1/?limit=1000", credential=credential)


@contextmanager
def location_types_in_id_order():
    """``LocationTypeResource``'s list, for the block, in the order of its levels' ids.

    The resource's queryset is ``LocationType.objects.all()`` filtered by the
    project space (``locations/resources/v0_5.py::LocationTypeResource.Meta``),
    a model with no ordering of its own, so the list is in the order Postgres
    hands the rows back in, as ``lookup_tables_in_id_order`` says of the
    lookup table list. Every order is one HQ may give, and Nova reads the
    levels by code (``lib/commcare/hq/locations.ts``); the harness gives the
    one of their ids, which follow the order they were made in.
    """
    from unittest import mock

    from corehq.apps.locations.resources.v0_5 import LocationTypeResource

    held = LocationTypeResource.get_object_list

    def get_object_list(self, request):
        return held(self, request).order_by("id")

    with mock.patch.object(LocationTypeResource, "get_object_list", get_object_list):
        yield


def location_types_read(state, credential: ApiCredential) -> HqAnswer:
    """``locations/resources/v0_5.py::LocationTypeResource``'s list, as Nova's ``listHqLocationTypes`` reads it:
    ``GET /a/<state.domain>/api/location_type/v1/?limit=1000`` through ``api_request``, in the order of the levels'
    ids (``location_types_in_id_order``). The resource asks for Edit Locations
    (``RequirePermissionAuthentication(HqPermissions.edit_locations)``)."""
    with location_types_in_id_order():
        return api_request(state, "GET", f"/a/{state.domain}/api/location_type/v1/?limit=1000", credential=credential)


@dataclass(frozen=True)
class MediaFileAnswer:
    """HQ's answer to the read of one mapped file: its status, the headers Nova's client reads, and its bytes."""

    status: int
    headers: dict
    data: bytes


def media_file_read(state, url: str, credential: ApiCredential) -> MediaFileAnswer:
    """The file at ``url``, the address HQ gives a map item (``hqmedia/models.py::HQMediaMapItem.url``,
    ``/hq/multimedia/file/<media type>/<multimedia id>/``), as Nova's ``readHqMediaFile`` reads it, through the
    request ``api_request`` makes. A file is bytes, so the answer keeps them as HQ sent them."""
    response = _api_response(state, "GET", url, credential=credential)
    if isinstance(response, HqAnswer):
        return MediaFileAnswer(response.status, {}, b"")
    kept = {name: response[name] for name in _ANSWER_HEADERS if response.has_header(name)}
    return MediaFileAnswer(response.status_code, kept, _content(response))


def location_patch(state, places, credential: ApiCredential) -> HqAnswer:
    """``LocationResource``'s ``patch_list`` over ``places`` (each a location's fields, as Nova's
    ``patchHqLocations`` sends a batch: ``{"objects": [...]}``)."""
    return api_request(
        state,
        "PATCH",
        f"/a/{state.domain}/api/location/v2/",
        credential=credential,
        body=json.dumps({"objects": list(places)}).encode(),
    )


def location_type_write(state, credential: ApiCredential, body) -> HqAnswer:
    """A POST to ``locations/resources/v0_5.py::LocationTypeResource``, the levels' resource, which Nova never
    writes."""
    return api_request(
        state,
        "POST",
        f"/a/{state.domain}/api/location_type/v1/",
        credential=credential,
        body=json.dumps(body).encode(),
    )


def current_version_read(state, app_id, credential: ApiCredential) -> HqAnswer:
    """``app_manager/views/releases.py::current_app_version`` for ``app_id``, as Check status reads it."""
    return api_request(state, "GET", f"/a/{state.domain}/apps/view/{app_id}/current_version/", credential=credential)


def save_counter(state, app_id) -> int:
    """The app's save counter as ``views/releases.py::current_app_version`` serves it as ``currentVersion``: the read
    that view makes (``dbaccessors.py::get_current_app_version``), with no request and no key, so a state holds no
    user it would not hold otherwise. ``proof/hq/test_publish.py`` holds the view's answer to it through HQ's
    URLconf."""
    from corehq.apps.app_manager.dbaccessors import get_current_app_version

    return get_current_app_version(state.domain, app_id)


def hold_save_counter(state, app_id, recorded, before, what, *, acknowledged=None) -> int:
    """Holds HQ's save counter's move over one write the harness applied to the capture peer's over the same write
    (``recorded``, a sidecar's ``(before, after)``: ``proof/checks/corpus.py::Captured.save_counter``), and returns
    the counter after it.

    ``before`` is HQ's counter read right before the write, None for a create. A create is held by where it leaves
    the counter, which is the peer's ``after``; any other write by how far it moves it. Where HQ acknowledged an
    import's version (``acknowledged``), it must be the counter right after it, whatever the capture recorded. With
    nothing recorded (a capture made before the peer's counter was recorded) only that acknowledgement is held.
    Refuses with ``CapturedCounterNotHeld`` naming both counts: a publish binds its baseline to this counter
    (``lib/commcare/hq/appSourceAtVersion.ts``), so a peer that counts a write otherwise than HQ answered the
    capture with a counter Nova would never read."""
    after = save_counter(state, app_id)
    if acknowledged is not None and acknowledged != after:
        raise CapturedCounterNotHeld(
            f"HQ acknowledged {what} at version {acknowledged}, and its save counter read right after it is {after}."
            " Nova binds a publish's read back to the version an import acknowledges, so HQ's acknowledgement must"
            " be its counter; look at views/app_import_api.py::_handle_import_app and ApplicationBase.save at the pin."
        )
    if recorded is None:
        return after
    peer_before, peer_after = recorded
    if peer_before is None:
        held = before is None and after == peer_after
        hq_move, peer_move = f"to {after}", f"to {peer_after}"
    else:
        held = before is not None and after - before == peer_after - peer_before
        hq_move, peer_move = f"from {before} to {after}", f"from {peer_before} to {peer_after}"
    if not held:
        raise CapturedCounterNotHeld(
            f"HQ's save counter moved {hq_move} over {what}, and the capture's peer counted it {peer_move} over the"
            " same write (the sidecar's saveCounter). Nova's publish binds its baseline to that counter, so the peer"
            " models a write otherwise than HQ: correct how proof/corpus/targetPeer.ts counts this write, as"
            " proof/hq/test_publish.py::test_hqs_save_counter_moves_as_a_publish_binds_its_baseline reads HQ's."
        )
    return after


def _resource_read(state, path, credential: ApiCredential) -> HqAnswer:
    """A GET of a tastypie resource through ``api_request``, with a lookup that found nothing answered as tastypie
    answers it on a server: 404, alone.

    Tastypie answers an exception its view raised with a status of its own
    choosing (``tastypie/resources.py::Resource.wrap_view``, at 0.15.1, the
    version HQ's ``uv.lock`` pins): a ``NotFound``, ``ObjectDoesNotExist`` or
    ``Http404`` with a 404 (``Resource.get_response_class_for_exception``),
    except where the request names its server ``testserver``, as every
    request Django's ``RequestFactory`` builds does, where it raises the
    exception again for a test to see. A resource's ``obj_get`` that finds no
    document it admits raises ``ObjectDoesNotExist``
    (``api/util.py::get_object_or_not_exist``, ``object_does_not_exist``), so
    that answer reaches here raised, and is kept as the status HQ's server
    sends for it, which is all Nova reads of it, as ``api_request`` keeps a
    raised ``Http404``. Any other exception propagates, as a server answers it
    with a 500.
    """
    from django.core.exceptions import ObjectDoesNotExist
    from tastypie.exceptions import NotFound

    try:
        return api_request(state, "GET", path, credential=credential)
    except (NotFound, ObjectDoesNotExist):
        return HqAnswer(404, {}, "")


def app_list_read(state, credential: ApiCredential) -> HqAnswer:
    """``app_manager/views/cli.py::list_apps`` (``api_auth``, ``api_throttle``), as Nova's ``listHqApps`` reads it:
    ``GET /a/<state.domain>/apps/api/list_apps/`` through ``api_request``."""
    return api_request(state, "GET", f"/a/{state.domain}/apps/api/list_apps/", credential=credential)


def application_read(state, app_id, credential: ApiCredential) -> HqAnswer:
    """``api/resources/v0_4.py::ApplicationResource`` for ``app_id``, as Nova's ``readHqApplication`` reads it, with
    no ``extras``: ``GET /a/<state.domain>/api/application/v1/<app_id>/``, an id the resource admits no document for
    (``BaseApplicationResource.obj_get``) answered with its 404 (``_resource_read``)."""
    return _resource_read(state, f"/a/{state.domain}/api/application/v1/{app_id}/", credential)


def api_access_read(state, credential: ApiCredential) -> HqAnswer:
    """The API access check's read, as Nova's ``probeHqApiAccess`` makes it: one row of
    ``fixtures/resources/v0_1.py::LookupTableResource``'s list, ``GET /a/<state.domain>/api/lookup_table/v1/?limit=1``
    through ``api_request``, the list in the order of its tables' ids (``lookup_tables_in_id_order``), so the row a
    page of one holds is the same on every run."""
    with lookup_tables_in_id_order():
        return api_request(state, "GET", f"/a/{state.domain}/api/lookup_table/v1/?limit=1", credential=credential)


def _working_suite_expressions(source):
    """Source slots that can consume declarations from HQ's generated suite."""
    for module in source.get("modules") or []:
        forms = module.get("forms") or []
        yield module.get("module_filter")
        for form in forms:
            yield form.get("form_filter")
        for owner in (module, *forms):
            icons = owner.get("custom_icons") or []
            if icons and isinstance(icons[0], dict):
                yield icons[0].get("xpath")
        for screen in ("short", "long"):
            columns = ((module.get("case_details") or {}).get(screen) or {}).get("columns") or []
            for column in columns:
                # HQ keeps null entries in the column list.
                if isinstance(column, dict) and column.get("useXpathExpression"):
                    yield column.get("field")


def source_factory_answers(state, app_id, credential, source):
    """Actual source-project facts and working resources potentially consumed by the reader.
    The retained base keeps only requests the production reader made."""
    from urllib.parse import urlencode

    from corehq import toggles

    if source.status != 200:
        return
    supplied = json.loads(source.body)
    # Production resolves references on a reached detail, menu or form
    # command from HQ's actual suite. The harness collects candidate answers;
    # retain.py keeps only the requests the client made.
    suite_reads = not supplied.get("use_custom_suite") and any(
        isinstance(text, str) and ("instance" in text or "&" in text)
        for text in _working_suite_expressions(supplied)
    )
    resources = set()
    if suite_reads:
        for profile in (None, *(supplied.get("build_profiles") or {})):
            resources.add(("suite.xml", profile or ""))
    encoded = "&#" in source.body
    for flag, required in (
        (toggles.HIERARCHICAL_LOCATION_FIXTURE, "locations" in source.body),
        (toggles.MOBILE_UCR, "commcare:reports" in source.body or "commcare-reports" in source.body),
    ):
        if not encoded and not required:
            continue
        yield f"membership:{flag.slug}", project_spaces_read(state, credential)
        path = f"/api/user_domains/v1/?limit=100&feature_flag={flag.slug}"
        response = api_request(state, "GET", path, credential=credential)
        yield path, response
        if flag is not toggles.HIERARCHICAL_LOCATION_FIXTURE or response.status != 200:
            continue
        if not any(row.get("domain_name") == state.domain for row in json.loads(response.body)["objects"]):
            continue
        resources.add(("suite.xml", ""))
        for menu, module in enumerate(supplied.get("modules") or []):
            for index, form in enumerate(module.get("forms") or []):
                xml = (supplied.get("_attachments") or {}).get(f"{form.get('unique_id')}.xml")
                if isinstance(xml, str) and ("locations" in xml or "&#" in xml):
                    for profile in (None, *(supplied.get("build_profiles") or {})):
                        resources.add((f"modules-{menu}/forms-{index}.xml", profile or ""))
    for resource, profile in sorted(resources):
        query = "?" + urlencode({"profile": profile}) if profile else ""
        path = f"/a/{state.domain}/apps/download/{app_id}/{resource}{query}"
        # An edited app can fail HQ's suite generation while its source is
        # still readable. Retain Django's actual response to the client.
        yield path, client_request(state, "GET", path, credential=credential)
    if resources:
        yield "source-check", source_read(state, app_id, credential)


def project_spaces_read(state, credential: ApiCredential, *, feature_flag: str | None = None) -> HqAnswer:
    """``api/resources/v0_5.py::UserDomainsResource``, as Nova's ``listDomainsMatching`` reads it:
    ``GET /api/user_domains/v1/?limit=100``, with ``&feature_flag=<slug>`` where one is named, through
    ``api_request``."""
    query = "?limit=100" + (f"&feature_flag={feature_flag}" if feature_flag else "")
    return api_request(state, "GET", f"/api/user_domains/v1/{query}", credential=credential)


def client_request(state, method: str, path: str, *, credential: ApiCredential | None) -> HqAnswer:
    """HQ's answer to one request behind its own middleware (``settings.MIDDLEWARE``), as a client outside HQ sends
    it, with the credential's ``Authorization`` header as ``api_request`` writes it.

    The request is answered by the handler the lane answers Formplayer's
    requests with (``proof/formplayer/hq.py::respond``, over
    ``django_request``), so every middleware runs before the view, an
    exception is answered by HQ's ``handler500``, and what the middleware
    leaves on the thread (the request field audit keeps, the active language)
    is put back after it, as a server's next request would replace it. The
    answer is built as ``api_request`` builds one. Use the full path for reads
    whose response depends on middleware or on HQ's HTTP error handlers."""
    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer.client import HqRequest

    target, _, query = path.partition("?")
    headers = () if credential is None else (("Authorization", f"ApiKey {credential.username}:{credential.key}"),)
    with formplayer_hq._language_put_back():
        response = formplayer_hq.respond(formplayer_hq.django_request(HqRequest(method, target, query, headers, b"")))
        return _answered(response)


def session_post(state, view_name, *args, pairs=()):
    """A form POST of ``pairs`` the state's web user's browser makes to the view ``view_name`` (its URL's
    arguments after the project space), answered by it with its decorators."""
    from django.urls import resolve, reverse

    path = reverse(view_name, args=[state.domain, *args])
    request = hq_requests.form_post(state, path, pairs)
    match = resolve(path)
    return match.func(request, *match.args, **match.kwargs)


def delete_app_through_view(state, app_id):
    """HQ's ordinary delete of the app, through ``views/apps.py::delete_app`` as a person's Delete makes it: a
    soft delete, which leaves the document with ``doc_type`` ``Application-Deleted``
    (``models/applications.py::ApplicationBase.delete_app``)."""
    response = session_post(state, "delete_app", app_id)
    if response.status_code != 302:
        raise PublishRefused(f"HQ's delete_app answered {response.status_code} for {app_id}.")


def undo_delete_app_through_view(state, app_id):
    """HQ's undo of that delete, through ``views/apps.py::undo_delete_app``, which restores the app it names."""
    response = session_post(state, "undo_delete_app", app_id)
    if response.status_code != 302:
        raise PublishRefused(f"HQ's undo_delete_app answered {response.status_code} for {app_id}.")


# The project space a linked app the harness makes names as its master; no app of it is read.
LINKED_MASTER_DOMAIN = "nova-proof-master"


def link_app_through_hq(state, app_id, master_id="nova-proof-master-app"):
    """The app turned into a linked one as HQ's operator command turns it
    (``corehq/apps/linked_domain/applications.py::link_app``): the same document as a ``LinkedApplication`` whose
    master is an app of another project space."""
    from corehq.apps.app_manager.models import LinkedApplication
    from corehq.apps.linked_domain.applications import link_app

    held = held_app(state, app_id).to_json()
    link_app(LinkedApplication.wrap({**held, "doc_type": "LinkedApplication"}), LINKED_MASTER_DOMAIN, master_id)


def remote_app_through_hq(state, name="Remote app") -> str:
    """A ``RemoteApp`` document made and saved by HQ's model in the state's project space
    (``models/applications.py::RemoteApp.new_app``, ``ApplicationBase.save``). Returns its id."""
    from corehq.apps.app_manager.models import RemoteApp

    app = RemoteApp.new_app(state.domain, name)
    app.save()
    return app.get_id


# Build -------------------------------------------------------------------


@dataclass
class Build:
    app: object
    errors: list
    files: dict
    profile_files: dict = field(default_factory=dict)
    form_validations: list = field(default_factory=list)

    def saved_build(self):
        """This build as HQ keeps a saved build, for the next build's version comparison.

        HQ's ``make_build`` copies the app (``convert_app_to_build``) and stores
        each built file as the attachment ``files/<path>``; ``set_form_versions``
        reads a form's previous source back from there. The copy is held in
        HQ's blob store (with its metadata rows), not saved to Couch.
        """
        from copy import deepcopy

        from corehq.apps.app_manager.const import NON_BUILD_APP_KEYS

        doc = deepcopy(self.app.to_json())
        for key in NON_BUILD_APP_KEYS:
            doc.pop(key, None)
        copy = type(self.app).wrap(doc)
        copy.convert_app_to_build(self.app._id, None)
        copy._id = uuid.uuid4().hex
        attachments = dict(self.app.get_attachments())
        for files in (self.files, *self.profile_files.values()):
            for path, content in files.items():
                attachments[f"files/{path}"] = content

        def put_all():
            for name, content in attachments.items():
                copy.put_attachment(content, name)

        with copy.atomic_blobs(save=lambda: None):
            put_all()
        # The bytes each attachment holds, which the next build reads back while the blob store holds them
        # (proof.hq.buildcache).
        buildcache.keep_attachments(copy, attachments)
        return copy


@contextmanager
def build_copy_saves(app):
    """Render at the working app's address with the save semantics of HQ's build copy.

    make_build renders a copy whose copy_of is set. ApplicationBase.save therefore leaves its version alone
    when validation adds missing menu ids or the media suite prunes unused mappings. Keep HQ's actual save,
    including those changes, at every such call. Other objects and explicit version decisions keep their own
    behavior.
    """
    model = type(app)
    save = model.save

    def save_build(candidate, response_json=None, increment_version=None, **params):
        if candidate is app and increment_version is None:
            increment_version = False
        return save(candidate, response_json=response_json, increment_version=increment_version, **params)

    with patch.object(model, "save", save_build):
        yield


class FormNotValidated(AssertionError):
    """A form of the app did not reach Formplayer's validation during its build."""


def _xmlns_of(xml):
    from lxml import etree

    root = etree.fromstring(xml)
    for element in root.iter():
        if etree.QName(element).localname == "instance":
            for child in element:
                return etree.QName(child).namespace
    return None


def build(app, record):
    """HQ's build of ``app`` under the seams the caller opened.

    ``record`` is the ``SeamRecord`` of the form validation seam; the build
    fails if any form with a source did not reach it.
    """
    for form in app.get_forms():
        form.clear_validation_cache()
    sent_before = len(record.form_validations)
    with build_copy_saves(app):
        errors = app.validate_app()
        files = app.create_all_files()
        profile_files = {profile_id: app.create_all_files(profile_id) for profile_id in app.build_profiles}
    sent = record.form_validations[sent_before:]
    validated = {_xmlns_of(v.xml) for v in sent}
    missing = [form.unique_id for form in app.get_forms() if form.source and form.xmlns not in validated]
    if missing:
        raise FormNotValidated(
            f"HQ built the app without sending forms {missing} to Formplayer's "
            "validation, so the Core runner never judged them."
        )
    return Build(app=app, errors=errors, files=files, profile_files=profile_files, form_validations=sent)


# Case processing -----------------------------------------------------------


@dataclass
class CaseProcessing:
    case_blocks: list
    touched: dict
    refusal: Exception | None


def _known_case_refusals():
    """The errors HQ answers as a refused submission rather than a failure.

    ``form_processor/submission_post.py::SubmissionPost.run`` catches exactly
    these around its case and ledger processing, saves the form as an error
    and answers the phone with a processing failure. Any other exception is
    one HQ logs and re-raises.
    """
    from casexml.apps.case.exceptions import (
        CaseValueError,
        IllegalCaseId,
        InvalidCaseIndex,
        PhoneDateValueError,
        UsesReferrals,
    )
    from corehq.apps.commtrack.exceptions import MissingProductId

    return (IllegalCaseId, UsesReferrals, MissingProductId, PhoneDateValueError, InvalidCaseIndex, CaseValueError)


def process_case_blocks(state, submission_xml: bytes, cases=(), attachments=None):
    """HQ's case processing of one submission, up to its case database.

    The submission is read the way HQ reads a new form with the files the
    device sent beside it (``form_processor/parsers/form.py::_create_new_xform``:
    the form's JSON, its datetimes adjusted, its meta scrubbed, and each file
    kept on the unsaved form as an ``Attachment``, with ``form.xml``);
    ``attachments`` maps each file's name to ``(content, content type)``.
    Then HQ's per-form case step runs as
    ``casexml/apps/case/xform.py::_get_or_update_cases`` runs it:
    ``get_cases_from_forms`` applies each case update (reading the case blocks
    and their ``date_modified``, and a case attachment's file from the form's
    files) to a ``CaseDbCacheSQL`` holding ``cases``, where a case not held
    there is looked up in the check's database, and ``_validate_indices``
    refuses an index to a case that exists nowhere. A refusal HQ answers as a
    refused submission (``_known_case_refusals``) ends processing and is
    returned; any other exception propagates, as HQ re-raises it (a file the
    form does not carry raises ``AttachmentNotFound``).

    The case database is opened as ``SubmissionPost.run`` opens it (deleted
    cases may be updated, the form is the database's cached form) except for
    its lock: HQ locks each case in Redis only to serialize concurrent
    submissions, which a check never makes.
    """
    from casexml.apps.case.xform import _validate_indices, extract_case_blocks
    from corehq.form_processor.backends.sql.casedb import CaseDbCacheSQL
    from corehq.form_processor.interfaces.processor import FormProcessorInterface
    from corehq.form_processor.parsers.form import _create_new_xform
    from django.core.files.uploadedfile import SimpleUploadedFile

    files = {
        name: SimpleUploadedFile(name, content, content_type=content_type)
        for name, (content, content_type) in sorted((attachments or {}).items())
    }
    xform = _create_new_xform(state.domain, submission_xml, attachments=files).submitted_form

    blocks = []
    with CaseDbCacheSQL(
        domain=state.domain, deleted_ok=True, wrap=True, initial=list(cases), xforms=[xform]
    ) as case_db:
        try:
            blocks = extract_case_blocks(xform)
            touched = FormProcessorInterface(case_db.domain).get_cases_from_forms(case_db, [xform])
            _validate_indices(case_db, touched.values())
        except _known_case_refusals() as refusal:
            return CaseProcessing(blocks, {}, refusal)
    return CaseProcessing(blocks, touched, None)


# Standalone form retention -------------------------------------------------


def save_standalone_report(state, submission_xml: bytes):
    """Save a case-free submission through HQ's actual form and attachment writer.

    ``_create_new_xform`` only constructs an unsaved model with a cached
    parsed body. ``FormProcessorSQL.save_processed_models`` saves the SQL
    row and ``form.xml`` blob, including the real attachment writer's
    ``on_commit`` callback. It must run in a fresh database's autocommit
    state, not a rollback unit. Returning the id makes callers read a new
    model through ``XFormInstance.objects.get_form(id, domain=...)`` rather
    than presenting the parser's cached body as retained data.

    Case-bearing submissions need HQ's case processing too; this operation
    refuses them rather than silently saving a form without its effects.
    """
    from casexml.apps.case.xform import extract_case_blocks
    from corehq.form_processor.backends.sql.processor import FormProcessorSQL
    from corehq.form_processor.interfaces.processor import ProcessedForms
    from corehq.form_processor.parsers.form import _create_new_xform

    form = _create_new_xform(state.domain, submission_xml, attachments={}).submitted_form
    if extract_case_blocks(form):
        raise HarnessRefusal("A standalone report must not carry case blocks; use HQ's case processing for them.")
    FormProcessorSQL.save_processed_models(ProcessedForms(form, None), cases=[])
    return form.form_id


# Case search ---------------------------------------------------------------


def compile_case_search(state, xpath, case_types):
    """HQ's CSQL compiler in the context HQ's case search builds.

    ``case_search/utils.py::CaseSearchQueryBuilder._build_filter_from_xpath``
    compiles with ``SearchFilterContext(domain, fuzzy, helper)`` and the helper
    from ``_get_helper``, the one place that marks the context as a case
    search (which is what gates related-case lookups).
    """
    from corehq.apps.case_search.filter_dsl import SearchFilterContext, build_filter_from_xpath
    from corehq.apps.case_search.utils import _get_helper

    helper = _get_helper(None, state.domain, list(case_types), None)
    return build_filter_from_xpath(xpath, context=SearchFilterContext(state.domain, False, helper))


def compile_domain_filter(state, xpath):
    """HQ's CSQL compiler with only a domain, as HQ's non-search callers compile."""
    from corehq.apps.case_search.filter_dsl import build_filter_from_xpath

    return build_filter_from_xpath(xpath, domain=state.domain)


def search_request_config(state, app_id, pairs):
    """HQ's reading of a case search request, sent as Formplayer sends it.

    Formplayer posts the search's ``(name, value)`` pairs form-encoded
    (``formplayer/services/CaseSearchHelper.java`` -> ``WebClient.postFormData``);
    ``ota/views.py::app_aware_search`` reads them as
    ``dict(request.POST.lists())``, so every value is a list, and hands that
    to ``case_search/models.py::extract_search_request_config``. A request
    HQ refuses raises ``CaseSearchUserError``, which the view answers with 400.
    """
    from corehq.apps.case_search.models import extract_search_request_config

    request = hq_requests.form_post(state, f"/a/{state.domain}/phone/search/{app_id}/", pairs)
    request_dict = dict(request.POST.lists())
    return extract_search_request_config(request_dict)


# Lookup tables -------------------------------------------------------------


def upload_lookup_workbook(state, workbook: bytes, *, replace):
    """HQ's lookup table upload of an ``.xlsx`` workbook, as Nova's push sends it."""
    from io import BytesIO

    from corehq.apps.fixtures.upload.run_upload import _run_upload
    from corehq.apps.fixtures.upload.workbook import get_workbook

    return _run_upload(state.domain, get_workbook(BytesIO(workbook)), replace=replace)


def seed_mobile_worker(state, username, user_id):
    """A mobile worker HQ can resolve by name (lookup table owners)."""
    from corehq.apps.users.models import CommCareUser
    from corehq.apps.users.util import normalize_username

    user = CommCareUser(username=normalize_username(username, state.domain), domain=state.domain, is_active=True)
    doc = user.to_json()
    doc["_id"] = user_id
    return state.couch.seed(doc)


def seed_group(state, name, group_id):
    """A group HQ can resolve by name (lookup table owners)."""
    from corehq.apps.groups.models import Group

    doc = Group(domain=state.domain, name=name).to_json()
    doc["_id"] = group_id
    return state.couch.seed(doc)


def seed_location(state, name, site_code, location_type="district"):
    """A location HQ can resolve by name or site code, saved through HQ's own model."""
    from corehq.apps.locations.models import LocationType, SQLLocation

    loc_type, _ = LocationType.objects.get_or_create(
        domain=state.domain, name=location_type, defaults={"code": location_type}
    )
    return SQLLocation.objects.create(domain=state.domain, name=name, site_code=site_code, location_type=loc_type)


def _dehydrated(resource, request, objects):
    """Each object as ``resource`` serves it (``full_dehydrate``), as the JSON its serializer writes."""
    from django.core.serializers.json import DjangoJSONEncoder

    return [
        json.loads(
            json.dumps(
                resource.full_dehydrate(resource.build_bundle(obj=obj, request=request)).data, cls=DjangoJSONEncoder
            )
        )
        for obj in objects
    ]


def served_lookup_tables(state):
    """Every lookup table of the project space as ``fixtures/resources/v0_1.py::LookupTableResource`` serves it, by
    its tag, without the tag itself, the id HQ minted for it or its address."""
    from corehq.apps.fixtures.resources.v0_1 import LookupTableResource

    resource = LookupTableResource()
    request = hq_requests.get(state, f"/a/{state.domain}/api/lookup_table/v1/")
    tables = resource.obj_get_list(resource.build_bundle(request=request), state.domain)
    return {
        served["tag"]: {key: value for key, value in served.items() if key not in ("id", "resource_uri", "tag")}
        for served in _dehydrated(resource, request, tables)
    }


def served_lookup_rows(state, tag, *, details=False):
    """Read the selected table in native fixture order. The fixture list drops singleton properties and row
    attributes; where Nova read selected row details, use the same detail resource on the listed row IDs."""
    from corehq.apps.fixtures.models import LookupTable
    from corehq.apps.fixtures.resources.v0_1 import FixtureResource, LookupTableItemResource

    table = LookupTable.objects.get(domain=state.domain, tag=tag)
    resource = FixtureResource()
    request = hq_requests.get(state, f"/a/{state.domain}/api/fixture/v1/", {"fixture_type_id": table.id.hex})
    rows = resource.obj_get_list(resource.build_bundle(request=request), domain=state.domain)
    if not details:
        return [{"fields": served["fields"]} for served in _dehydrated(resource, request, rows)]
    items = LookupTableItemResource()
    result = []
    for row in rows:
        pk = row.id.hex
        detail_request = hq_requests.get(state, f"/a/{state.domain}/api/lookup_table_item/v1/{pk}/")
        item = items.obj_get(items.build_bundle(request=detail_request), pk=pk, domain=state.domain)
        detail, = _dehydrated(items, detail_request, [item])
        if detail["id"] != pk or detail["data_type_id"] != table.id.hex:
            raise CapturedResourcesNotHeld(f"The selected row did not belong to the lookup table {tag}.")
        result.append({"fields": detail["fields"], "item_attributes": detail["item_attributes"]})
    return result


def resource_differences(state, assumed):
    """Each table ``assumed`` (a capture's ``assumedResources``) names whose definition, or rows where it names
    them, HQ does not serve as assumed: ``[(tag, what, assumed, served)]``. The ids HQ mints are left out on both
    sides, as an app's id is written into a captured update (``with_app_id``)."""
    unread = sorted(set(assumed) - {"lookupTables"})
    if unread:
        raise CapturedResourcesNotHeld(
            f"A captured publish names {unread} among the resources it read, and the harness holds only lookup"
            " tables to HQ's answers. Hold each kind the capture reads (proof/corpus/publish.ts, AssumedResources)."
        )
    served = served_lookup_tables(state)
    differences = []
    for table in assumed.get("lookupTables", []):
        tag = table["tag"]
        held = served.get(tag)
        if held != table["table"]:
            differences.append((tag, "definition", table["table"], held))
            continue
        if "rows" in table:
            detailed = any("item_attributes" in row for row in table["rows"])
            rows = served_lookup_rows(state, tag, details=detailed)
            if rows != table["rows"]:
                differences.append((tag, "rows", table["rows"], rows))
    return differences


def hold_assumed_resources(state, assumed, what):
    """Refuse (``CapturedResourcesNotHeld``) unless HQ's own resources serve every lookup table ``assumed`` names as
    the capture's peer answered it: a publish decided over other tables is not the one Nova would make here."""
    if not assumed:
        return
    differences = resource_differences(state, assumed)
    if differences:
        named = "; ".join(
            f"the {kind} of {tag}: the capture assumed {json.dumps(value, sort_keys=True)}, HQ serves"
            f" {json.dumps(held, sort_keys=True)}"
            for tag, kind, value, held in differences
        )
        raise CapturedResourcesNotHeld(
            f"The {what} was decided over lookup tables HQ does not hold: {named}. Nova's publish over this HQ would"
            " compare and push over other tables, so the harness does not apply the captured bytes. Model HQ's"
            " tables in the capture's peer as HQ holds them (proof/corpus/targetPeer.ts)."
        )


# Apps made in HQ -------------------------------------------------------------


@dataclass(frozen=True)
class AuthoredMedia:
    """One mapped file of an authored app: a row of its media.json with the file's bytes."""

    # The full path the app's references hold (media.json's ``path``).
    path: str
    data: bytes
    # The path's last segment, as HQ's template loader passes it to ``attach_data``.
    original_filename: str


class AuthoredAppNotMade(HarnessRefusal):
    """An authored app's retained files do not make the app they were retained from."""


def save_authored_app(state, document: dict, media) -> str:
    """An app HQ's own models made, saved again from its stored document: the same menu ids, form ids, xmlns and
    content. Returns the id HQ gives it.

    ``document`` is a base's ``app.json`` (the app as HQ stores it, with
    ``_attachments`` as ``{"<form unique id>.xml": "<source text>"}``). Its
    attachments are taken out, the rest made an app by the class its
    ``doc_type`` names through ``from_source``, as
    ``models/applications.py::_create_app_from_doc`` makes one
    (``Application.from_source`` removes ``_meta_fields``, sets the domain and
    wraps), and the forms stored by ``save_attachments``, whose
    ``corehq/blobs/mixin.py::atomic_blobs`` saves the app as its block ends,
    as ``_import_app``'s own call does. ``_import_app`` itself is not called:
    its ``export_json`` runs ``scrub_source``, which mints a new id for every
    form (``update_form_unique_ids(source, ids_map={})``), and A holds the ids
    the emission read. Nor are ``_create_app_from_doc``'s three writes made
    (``convert_build_to_app``, ``date_created``, ``cloudcare_enabled`` from the
    plan): each would change a field the retained app holds as its author left
    it.

    Each of ``media`` (``AuthoredMedia``) is attached as
    ``views/apps.py::load_app_from_slug`` attaches a template's file:
    ``CommCareMultimedia.get_class_by_data``, ``get_by_data``, ``attach_data``,
    ``add_domain(owner=True)`` and ``app.create_mapping`` at the full path
    the app's map holds. A file the project space holds no document of yet is
    given the id the retained map names for its path before ``attach_data``
    gives it one, so A maps each path to the multimedia id HQ's answers named
    when the app was read; ``create_mapping`` then writes the map item HQ wrote
    then (its ``unique_id`` is ``HQMediaMapItem.gen_unique_id`` of that id and
    the path).
    """
    from corehq.apps.app_manager.util import get_correct_app_class
    from corehq.apps.hqmedia.models import CommCareMultimedia

    source = json.loads(json.dumps(document))
    attachments = source.pop("_attachments", None) or {}
    app = get_correct_app_class(source).from_source(source, state.domain)
    app.save_attachments(dict(sorted(attachments.items())))
    for item in media:
        held = app.multimedia_map.get(item.path)
        if held is None:
            raise AuthoredAppNotMade(
                f"media.json names the file at {item.path}, and the app's multimedia_map holds no such path. The two"
                " are written by one retain step (proof/matrix/retain.py); write them again from one run."
            )
        media_class = CommCareMultimedia.get_class_by_data(item.data)
        if media_class is None:
            raise AuthoredAppNotMade(
                f"CommCare HQ reads the file retained for {item.path} as no image, audio or video"
                " (CommCareMultimedia.get_class_by_data), so it cannot attach it."
            )
        multimedia = media_class.get_by_data(item.data)
        if not multimedia._id:
            multimedia._id = held.multimedia_id
        elif multimedia._id != held.multimedia_id:
            raise AuthoredAppNotMade(
                f"The file retained for {item.path} is the document {multimedia._id} in this project space, and the"
                f" app maps the path to {held.multimedia_id}: two retained files hold the same bytes under two ids."
            )
        multimedia.attach_data(item.data, original_filename=item.original_filename, username=state.web_user.username)
        multimedia.add_domain(state.domain, owner=True)
        app.create_mapping(multimedia, item.path)
    return app._id


def save_authored_tables(state, tables) -> None:
    """Each lookup table of an authored base and its rows, made with HQ's own models
    (``fixtures/models.py::LookupTable``, ``LookupTableRow``) from the base's ``tables.json``: one object a table,
    ``{tag, is_global, description, fields: [{name, properties, is_indexed}], item_attributes, rows: [{fields:
    {<name>: [{value, properties}]}, item_attributes}]}``, its rows in ``sort_key`` order."""
    from corehq.apps.fixtures.models import Field, LookupTable, LookupTableRow, TypeField

    for table in tables:
        made = LookupTable.objects.create(
            domain=state.domain,
            tag=table["tag"],
            is_global=table["is_global"],
            description=table.get("description", ""),
            fields=[
                TypeField(name=field["name"], properties=list(field["properties"]), is_indexed=field["is_indexed"])
                for field in table["fields"]
            ],
            item_attributes=list(table["item_attributes"]),
        )
        for sort_key, row in enumerate(table["rows"]):
            LookupTableRow.objects.create(
                domain=state.domain,
                table=made,
                fields={
                    name: [Field(value=value["value"], properties=dict(value["properties"])) for value in values]
                    for name, values in row["fields"].items()
                },
                item_attributes=dict(row["item_attributes"]),
                sort_key=sort_key,
            )


def save_authored_places(state, places) -> None:
    """Each level and place of an authored base, parents first, made with HQ's own models
    (``locations/models.py::LocationType``, ``SQLLocation``) from the base's ``places.json``: ``{levels: [{name,
    code, parent, shares_cases, view_descendants}], places: [{location_id, name, site_code, level, parent, metadata,
    archived}], fields: [{slug, label}]}``, each ``parent`` its parent's code or site code. Each place keeps the
    ``location_id`` HQ gave it when the base was made, which Nova's reading keys a place by
    (``lib/commcare/hq/locations.ts``), and an archived place is archived by HQ's own ``SQLLocation.archive``.

    The project space's location fields definition is made first, where ``fields`` names any, as the Locations
    Fields page saves one (``custom_data_fields/edit_model.py::CustomDataModelMixin.save_custom_fields``:
    ``CustomDataFieldsDefinition.set_fields`` and its ``save``, under ``locations/views.py::LocationFieldsView``'s
    ``field_type``): HQ's flat location list writes a place's ``location_data`` only for the fields it defines
    (``locations/fixtures.py::get_location_data_fields``)."""
    from corehq.apps.custom_data_fields.models import CustomDataFieldsDefinition, Field
    from corehq.apps.locations.models import LocationType, SQLLocation
    from corehq.apps.locations.views import LocationFieldsView

    fields = places.get("fields") or []
    if fields:
        definition = CustomDataFieldsDefinition.get_or_create(state.domain, LocationFieldsView.field_type)
        definition.set_fields([Field(slug=field["slug"], label=field["label"]) for field in fields])
        definition.save()
    levels = {}
    for level in places["levels"]:
        levels[level["code"]] = LocationType.objects.create(
            domain=state.domain,
            name=level["name"],
            code=level["code"],
            parent_type=None if level["parent"] is None else levels[level["parent"]],
            shares_cases=level.get("shares_cases", False),
            view_descendants=level.get("view_descendants", False),
        )
    made = {}
    for place in places["places"]:
        location = SQLLocation(
            domain=state.domain,
            location_id=place["location_id"],
            name=place["name"],
            site_code=place["site_code"],
            location_type=levels[place["level"]],
            parent=None if place["parent"] is None else made[place["parent"]],
            metadata=dict(place["metadata"]),
        )
        location.save()
        made[place["site_code"]] = location
    for place in places["places"]:
        if place["archived"] and not made[place["site_code"]].is_archived:
            made[place["site_code"]].archive()


# The password every practice worker the lane makes signs in with. No reader signs in as one: HQ's build writes the
# worker's stored restore (``practice_user_restore.xml``), and nothing reads the password.
PRACTICE_WORKER_PASSWORD = "proof-practice-worker-password"


def practice_worker(state, username, user_id="") -> str:
    """A mobile worker of the project space in practice mode, made as HQ's mobile worker pages make one: the worker
    by ``CommCareUser.create`` (under ``user_id`` where given, else the id HQ mints), then practice mode turned on by
    ``ota/utils.py::turn_on_demo_mode``, the function the worker page's practice mode switch runs
    (``users/views/mobile/users.py::toggle_demo_mode``, through ``users/tasks.py::turn_on_demo_mode_task``). It marks
    the worker ``is_demo_user`` and stores the worker's restore (``ota/models.py::DemoUserRestore``), which HQ's build
    writes as ``practice_user_restore.xml`` (``Application.create_practice_user_restore``) wherever the plan has
    practice mode. ``username`` is the part before the project space's domain (``CommCareUser.raw_username``).
    Returns the worker's id.

    ``turn_on_demo_mode`` answers an error rather than raising one (it reports the exception and returns
    ``{"errors": [...]}``), so an answer that names one refuses the worker by name."""
    from corehq.apps.ota.utils import turn_on_demo_mode
    from corehq.apps.users.models import CommCareUser
    from corehq.apps.users.util import format_username

    worker = CommCareUser.create(
        state.domain,
        format_username(username, state.domain),
        PRACTICE_WORKER_PASSWORD,
        created_by=None,
        created_via=None,
        uuid=user_id,
    )
    answer = turn_on_demo_mode(worker, state.domain)
    if answer.get("errors"):
        raise AuthoredAppNotMade(
            f"CommCare HQ did not put the mobile worker {username} in practice mode"
            f" (ota/utils.py::turn_on_demo_mode answered {answer['errors']}), so no app can name it as its practice"
            " worker. Its exception is the one HQ reported just before (notify_exception)."
        )
    return worker._id


def save_authored_practice_workers(state, workers) -> None:
    """Each practice worker of an authored base, made again from the base's ``practice-workers.json`` (one object a
    worker, ``{user_id, username}``) by ``practice_worker``, under the id HQ gave it when the base was made, which the
    app's ``practice_mobile_worker_id`` names. HQ's build looks that worker up under any plan
    (``suite_xml/generator.py::SuiteGenerator.generate_suite`` asks ``Application.get_practice_user`` wherever
    ``supports_practice_users``) and raises ``PracticeUserException`` for an id no practice worker of the project
    space holds (``app_manager/util.py::get_and_assert_practice_user_in_domain``), so the worker is made before the
    app is built."""
    for worker in workers:
        practice_worker(state, worker["username"], worker["user_id"])
