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
- ``publish_capture``: a captured create and the update Nova built over it,
  applied only while HQ holds the profile the update was built from;
- ``app_source``: ``app_manager/views/apps.py::app_source``, decorators and
  all, as Nova's update reads it;
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
- ``upload_lookup_workbook``: HQ's lookup table upload.
"""

import json
import uuid
from dataclasses import dataclass, field
from email.parser import BytesHeaderParser

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


class CapturedProfileNotHeld(HarnessRefusal):
    """HQ holds a profile for the created app other than the one a captured update was built from."""


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

    Nova's publish sends every asset the app's export carries as one ZIP
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


def publish_capture(state, create: Upload, update: Upload, assumed_source_profile):
    """Apply a captured publish: its create, then the update Nova built over the app the create made.

    Nova's update reads the app's profile back through ``app_source`` and
    builds the app it sends from it (``lib/deployment/importApplication.ts``),
    and a capture records the profile its peer answered with. So the create
    is applied, the profile HQ now serves for the app (A) is read through
    HQ's own view, and the captured update is applied, with A's id, only
    when that is the profile it was built from: over any other profile the
    captured bytes are not what Nova would send to this HQ, and the harness
    refuses (``CapturedProfileNotHeld``), naming both.

    Returns A's id and HQ's answer to the create and to the update.
    """
    app_id, (created,) = publish(state, [create])
    held = app_source(state, app_id).get("profile")
    if held != assumed_source_profile:
        raise CapturedProfileNotHeld(
            "The captured update was built over the profile "
            f"{json.dumps(assumed_source_profile, sort_keys=True)}, but HQ's app_source serves the app its create "
            f"made ({app_id}) with {json.dumps(held, sort_keys=True)}. Nova's update over this HQ would carry "
            "another profile, so the harness does not apply the captured one. Capture the update over the profile "
            "HQ holds (proof/corpus/publish.ts, PublishInput.sourceProfile)."
        )
    updated = _accepted(apply_upload(state, with_app_id(update, app_id)), "the captured update")
    return app_id, created, updated


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
