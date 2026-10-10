"""HQ's Couch, in memory, answering the views HQ's paths query.

HQ's own test double, ``fakecouch.FakeCouchDb`` (``corehq/util/test_utils.py::
mock_out_couch`` installs it), answers a view only from rows a test registered
for that exact parameter set and returns no rows for anything else, and it
hands out the stored dictionary itself, so a document changed in memory
without a save changes what is "stored". ``ComputedViewCouch`` keeps its
document store and replaces both:

- every view a path queries is computed from the stored documents by that
  view's own map function (read from HQ's ``_design`` or ``couchapps`` source
  at the pin, and transcribed below view by view), ordered by CouchDB's view
  collation, and filtered and paged as CouchDB does;
- a view it does not compute, or a query parameter it does not implement,
  raises ``UnansweredView`` rather than answering as an empty view;
- documents are copied through JSON on every save and read, and so is
  every view row (whose keys and values the map functions take from the
  stored documents, and whose ``doc`` with ``include_docs`` is the stored
  document), as the wire copies them: ``raw_view`` copies the whole page it
  answers. HQ's wrappers change the dictionary they wrap
  (``LazyBlobDoc.wrap`` pops and replaces ``_attachments``), so a row
  handed out by reference would let a read change what is stored;
- ``_all_docs``, which HQ's media path posts to directly
  (``dimagi/utils/couch/bulk.py::get_docs`` through ``db._request_session``),
  is answered from the same store;
- every save, bulk save, delete and seed first calls each of
  ``write_listeners`` (``proof.hq.branch`` counts them as writes), and
  ``snapshot()`` / ``restore_snapshot()`` keep and put back every stored
  document exactly, in order.

Each stored document is kept with its JSON text (``json.dumps`` of it) from
when it was stored, so a read parses that text instead of writing the
document out again (``json.loads(json.dumps(doc))`` is ``json.loads`` of
the text ``json.dumps(doc)`` gave while ``doc`` is unchanged, and no stored
document is changed in place: every read and save copies). A text is kept
with the very object it was written from, and read again wherever the store
holds another object for that id. ``snapshot()`` is the text of each
document in store order, and ``restore_snapshot()`` keeps the stored object
of each document whose text is the snapshot's and parses the rest.
``PROOF_VERIFY_MEMOS=1`` writes every document out again wherever its kept
text is used, and the two must be equal (``MemoMismatch``).
"""

import json
import unicodedata
from functools import cmp_to_key

from fakecouch import FakeCouchDb

from proof.hq.boot import HarnessRefusal
from proof.hq.seams import VERIFY_MEMOS, MemoMismatch

COUCH_DB_NAME = "commcarehq"


class UnansweredView(HarnessRefusal):
    """HQ queried a view, or a view parameter, the harness does not compute."""


class CollationUnsupported(HarnessRefusal):
    """Two keys whose CouchDB order the harness cannot decide."""


# CouchDB collates strings with ICU's root collation. For printable ASCII its
# primary order is this sequence, letters compared without case; at the
# tertiary level a lowercase letter sorts before its uppercase form.
_ASCII_PRIMARY_ORDER = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz"
_PRIMARY = {ch: i for i, ch in enumerate(_ASCII_PRIMARY_ORDER)}


def _is_printable_ascii(text):
    return all(" " <= ch <= "~" for ch in text)


def _collate_strings(a, b):
    if a == b:
        return 0
    if not (_is_printable_ascii(a) and _is_printable_ascii(b)):
        if unicodedata.normalize("NFD", a) == unicodedata.normalize("NFD", b):
            return 0
        raise CollationUnsupported(
            f"The harness's Couch cannot order {a!r} against {b!r}: CouchDB orders "
            "strings by ICU's root collation, and the harness reproduces it for "
            "printable ASCII only. Use ASCII keys in the check's documents, or "
            "extend proof/hq/couch.py's collation."
        )
    primary_a = [_PRIMARY[ch.lower()] for ch in a]
    primary_b = [_PRIMARY[ch.lower()] for ch in b]
    if primary_a != primary_b:
        return -1 if primary_a < primary_b else 1
    tertiary_a = [ch.isupper() for ch in a]
    tertiary_b = [ch.isupper() for ch in b]
    return -1 if tertiary_a < tertiary_b else (1 if tertiary_a > tertiary_b else 0)


def _type_rank(value):
    if value is None:
        return 0
    if value is False:
        return 1
    if value is True:
        return 2
    if isinstance(value, (int, float)):
        return 3
    if isinstance(value, str):
        return 4
    if isinstance(value, list):
        return 5
    if isinstance(value, dict):
        return 6
    raise TypeError(f"{value!r} is not a JSON value")


def collate(a, b):
    """CouchDB's view collation: null, false, true, numbers, strings, arrays, objects."""
    rank_a, rank_b = _type_rank(a), _type_rank(b)
    if rank_a != rank_b:
        return -1 if rank_a < rank_b else 1
    if rank_a <= 2:
        return 0
    if rank_a == 3:
        return -1 if a < b else (1 if a > b else 0)
    if rank_a == 4:
        return _collate_strings(a, b)
    if rank_a == 5:
        for x, y in zip(a, b, strict=False):
            c = collate(x, y)
            if c:
                return c
        return -1 if len(a) < len(b) else (1 if len(a) > len(b) else 0)
    for (ka, va), (kb, vb) in zip(a.items(), b.items(), strict=False):
        c = _collate_strings(ka, kb) or collate(va, vb)
        if c:
            return c
    return -1 if len(a) < len(b) else (1 if len(a) > len(b) else 0)


def _raw_docid_order(a, b):
    # CouchDB breaks ties between equal keys by comparing document ids as raw bytes.
    a, b = a.encode(), b.encode()
    return -1 if a < b else (1 if a > b else 0)


# Each map function below is the view's map.js at the pin, transcribed. A
# JavaScript property that is absent reads as undefined: an undefined array
# element or key is emitted as null, and an undefined object member is left
# out of the emitted value.
_ABSENT = object()


def _js(doc, name):
    return doc.get(name, _ABSENT)


def _js_key(doc, name):
    return doc.get(name)


def _js_object(pairs):
    return {k: v for k, v in pairs if v is not _ABSENT}


def _app_doc_types(doc):
    return doc.get("doc_type") in ("Application", "RemoteApp", "LinkedApplication")


def _map_applications_brief(doc):
    # corehq/apps/app_manager/_design/views/applications_brief/map.js
    if _app_doc_types(doc) and doc.get("copy_of") is None:
        is_app = doc.get("doc_type") == "Application"
        is_linked = doc.get("doc_type") == "LinkedApplication"
        yield (
            [_js_key(doc, "domain"), _js_key(doc, "_id")],
            _js_object(
                [
                    ("doc_type", _js(doc, "doc_type")),
                    ("application_version", _js(doc, "application_version") if is_app else _ABSENT),
                    ("version", _js(doc, "version")),
                    ("_id", _js(doc, "_id")),
                    ("name", _js(doc, "name")),
                    ("build_spec", _js(doc, "build_spec")),
                    ("domain", _js(doc, "domain")),
                    ("langs", _js(doc, "langs")),
                    ("cached_properties", _js(doc, "cached_properties")),
                    ("case_sharing", _js(doc, "case_sharing")),
                    ("cloudcare_enabled", _js(doc, "cloudcare_enabled")),
                    ("mobile_ucr_sync_interval", _js(doc, "mobile_ucr_sync_interval")),
                    ("created_from_template", _js(doc, "created_from_template")),
                    ("family_id", _js(doc, "family_id")),
                    ("upstream_app_id", _js(doc, "upstream_app_id") if is_linked else None),
                    ("build_profiles", _js(doc, "build_profiles")),
                ]
            ),
        )


def _map_saved_app(doc):
    # corehq/apps/app_manager/_design/views/saved_app/map.js
    if _app_doc_types(doc) and doc.get("copy_of") is not None:
        is_linked = doc.get("doc_type") == "LinkedApplication"
        yield (
            [_js_key(doc, "domain"), _js_key(doc, "copy_of"), _js_key(doc, "version")],
            _js_object(
                [
                    ("doc_type", _js(doc, "doc_type")),
                    ("short_url", _js(doc, "short_url")),
                    ("short_odk_url", _js(doc, "short_odk_url")),
                    ("short_odk_media_url", _js(doc, "short_odk_media_url")),
                    ("version", _js(doc, "version")),
                    ("_id", _js(doc, "_id")),
                    ("name", _js(doc, "name")),
                    ("build_spec", _js(doc, "build_spec")),
                    ("text_input", _js(doc, "text_input")),
                    ("platform", _js(doc, "platform")),
                    ("copy_of", _js(doc, "copy_of")),
                    ("domain", _js(doc, "domain")),
                    ("built_on", _js(doc, "built_on")),
                    ("built_with", _js(doc, "built_with")),
                    ("build_comment", _js(doc, "build_comment")),
                    ("build_broken", _js(doc, "build_broken")),
                    ("comment_from", _js(doc, "comment_from")),
                    ("is_released", _js(doc, "is_released")),
                    ("case_sharing", _js(doc, "case_sharing")),
                    ("build_profiles", _js(doc, "build_profiles")),
                    ("vellum_case_management", bool(doc.get("vellum_case_management"))),
                    ("target_commcare_flavor", _js(doc, "target_commcare_flavor")),
                    ("family_id", _js(doc, "family_id")),
                    ("upstream_version", _js(doc, "upstream_version") if is_linked else None),
                    ("upstream_app_id", _js(doc, "upstream_app_id") if is_linked else None),
                ]
            ),
        )


def _map_applications(doc):
    # corehq/apps/app_manager/_design/views/applications/map.js
    if _app_doc_types(doc):
        yield [_js_key(doc, "domain"), _js_key(doc, "copy_of"), _js_key(doc, "version")], None
        yield [None, _js_key(doc, "copy_of"), _js_key(doc, "version")], None
        if doc.get("is_released") and doc.get("copy_of"):
            yield (
                ["^ReleasedApplications", _js_key(doc, "domain"), _js_key(doc, "copy_of"), _js_key(doc, "version")],
                None,
            )


def _map_saved_apps_auto_generated(doc):
    # corehq/couchapps/saved_apps_auto_generated/views/view/map.js (no reduce);
    # app_manager/tasks.py::prune_auto_generated_builds queries it after every build HQ makes.
    if doc.get("doc_type") in ("Application", "LinkedApplication") and doc.get("is_auto_generated", _ABSENT) not in (
        _ABSENT,
        None,
        False,
        0,
        "",
    ):
        yield (
            [_js_key(doc, "domain"), _js_key(doc, "copy_of")],
            _js_object(
                [
                    ("doc_type", _js(doc, "doc_type")),
                    ("_id", _js(doc, "_id")),
                    ("copy_of", _js(doc, "copy_of")),
                    ("domain", _js(doc, "domain")),
                    ("is_released", _js(doc, "is_released")),
                ]
            ),
        )


def _map_domains(doc):
    # corehq/apps/domain/_design/views/domains/map.js (reduce: _count)
    if doc.get("doc_type") == "Domain":
        yield _js_key(doc, "name"), None


def _map_domains_by_status(doc):
    # corehq/apps/domain/_design/views/by_status/map.js (reduce: _count)
    if doc.get("doc_type") == "Domain":
        yield [_js_key(doc, "is_active"), _js_key(doc, "name")], None


def _map_users_by_username(doc):
    # corehq/apps/users/_design/views/by_username/map.js (reduce: _count)
    if doc.get("base_doc") == "CouchUser":
        yield _js_key(doc, "username"), None


def _map_users_by_domain(doc):
    # corehq/apps/users/_design/views/by_domain/map.js (reduce: _count). A WebUser without memberships makes
    # the JavaScript throw, and CouchDB leaves a document whose map throws out of the view.
    if doc.get("base_doc") == "CouchUser":
        active = "active" if doc.get("is_active") else "inactive"
        if doc.get("doc_type") == "WebUser":
            for membership in doc.get("domain_memberships") or []:
                yield [active, membership.get("domain"), _js_key(doc, "doc_type"), _js_key(doc, "username")], None
        elif doc.get("doc_type") == "CommCareUser":
            yield [active, _js_key(doc, "domain"), _js_key(doc, "doc_type"), _js_key(doc, "username")], None


def _map_users_by_location_id(doc):
    # corehq/couchapps/users_extra/views/users_by_location_id/map.js (reduce: _count)
    if doc.get("base_doc") == "CouchUser":
        if doc.get("doc_type") == "CommCareUser" and doc.get("location_id"):
            yield (
                [_js_key(doc, "domain"), _js_key(doc, "location_id"), _js_key(doc, "doc_type"), _js_key(doc, "_id")],
                None,
            )
        elif doc.get("doc_type") == "WebUser":
            # A WebUser without memberships makes the JavaScript throw, and
            # CouchDB leaves a document whose map throws out of the view.
            for membership in doc.get("domain_memberships") or []:
                if membership.get("location_id"):
                    yield (
                        [
                            membership.get("domain"),
                            membership.get("location_id"),
                            _js_key(doc, "doc_type"),
                            _js_key(doc, "_id"),
                        ],
                        None,
                    )


def _map_groups_by_name(doc):
    # corehq/apps/groups/_design/views/by_name/map.js
    if doc.get("doc_type") == "Group":
        yield [_js_key(doc, "domain"), _js_key(doc, "name")], None
        reporting = doc.get("reporting", _ABSENT)
        if reporting is _ABSENT or (reporting not in (None, False, 0, "")):
            yield ["^Reporting", _js_key(doc, "domain"), _js_key(doc, "name")], None


def _map_groups_by_user(doc):
    # corehq/apps/groups/_design/views/by_user/map.js (no reduce): a group without ``users`` makes the
    # JavaScript throw, and CouchDB leaves a document whose map throws out of the view.
    if doc.get("doc_type") == "Group":
        for user in doc.get("users") or []:
            yield user, [_js(doc, "domain"), _js(doc, "name")]


def _map_schemas_by_xmlns_or_case_type(doc):
    # corehq/couchapps/schemas_by_xmlns_or_case_type/views/view/map.js (reduce: _count); the user case HQ
    # makes for a worker adds its properties to the case type's inferred export schema
    # (export/dbaccessors.py::get_case_inferred_schema).
    if doc.get("doc_type") in ("FormExportDataSchema", "FormInferredSchema"):
        yield (
            [
                _js_key(doc, "domain"),
                _js_key(doc, "doc_type"),
                _js_key(doc, "app_id"),
                _js_key(doc, "xmlns"),
                _js_key(doc, "created_on"),
            ],
            None,
        )
    elif doc.get("doc_type") in ("CaseExportDataSchema", "CaseInferredSchema"):
        yield (
            [_js_key(doc, "domain"), _js_key(doc, "doc_type"), _js_key(doc, "case_type"), _js_key(doc, "created_on")],
            None,
        )


def _map_program_by_code(doc):
    # corehq/couchapps/program_by_code/views/view/map.js
    if doc.get("doc_type") == "Program":
        yield [_js_key(doc, "domain"), _js_key(doc, "code")], None


def _map_mobile_auth_key_records(doc):
    # corehq/apps/mobile_auth/_design/views/key_records/map.js (no reduce): the key records a device's sign-in
    # asks HQ's key server view for (MobileAuthKeyRecord.key_for_time).
    if doc.get("doc_type") == "MobileAuthKeyRecord":
        yield [_js_key(doc, "domain"), _js_key(doc, "user_id"), _js_key(doc, "valid")], None


def _map_hqmedia_by_hash(doc):
    # corehq/apps/hqmedia/_design/views/by_hash/map.js (no reduce);
    # hqmedia/models.py::CommCareMultimedia.get_by_hash queries it by key.
    if doc.get("doc_type") in ("CommCareMultimedia", "CommCareImage", "CommCareAudio", "CommCareVideo"):
        yield _js_key(doc, "file_hash"), None


def _map_apps_with_submissions(doc):
    # corehq/couchapps/apps_with_submissions/views/view/map.js (reduce: _count), which
    # app_manager/dbaccessors.py::get_built_app_ids_with_submissions_for_app_id queries for the builds an export
    # reads (the form processor marks a build as having submissions when a form names it).
    if (
        doc.get("doc_type") in ("Application", "RemoteApp", "LinkedApplication", "Application-Deleted")
        and doc.get("copy_of") is not None
        and doc.get("has_submissions")
    ):
        yield [_js_key(doc, "domain"), _js_key(doc, "copy_of"), _js_key(doc, "version")], None


def _map_exports_forms_by_app(doc):
    # corehq/couchapps/exports_forms_by_app/views/view/map.js, which couchforms/analytics.py::
    # get_form_analytics_metadata queries (grouped, with its reduce below) for the app, menu and form a form
    # export names its forms after.
    if not (
        doc.get("doc_type") in ("Application", "Application-Deleted", "LinkedApplication", "LinkedApplication-Deleted")
        and doc.get("copy_of") is None
    ):
        return
    deleted = doc.get("doc_type") in ("Application-Deleted", "LinkedApplication-Deleted")
    app = {"name": doc.get("name"), "langs": doc.get("langs"), "id": doc.get("_id")}
    for m, module in enumerate(doc.get("modules") or []):
        for f, form in enumerate(module.get("forms") or []):
            if form.get("xmlns"):
                value = {
                    "xmlns": form["xmlns"],
                    "app": app,
                    "module": {"name": module.get("name"), "id": m},
                    "form": {"name": form.get("name"), "id": f},
                    "app_deleted": deleted,
                }
                yield [doc.get("domain"), doc.get("_id"), form["xmlns"]], value
                yield [doc.get("domain"), {}, form["xmlns"]], value
    registration = doc.get("user_registration")
    if registration and registration.get("xmlns"):
        value = {
            "xmlns": registration["xmlns"],
            "app": app,
            "is_user_registration": True,
            "app_deleted": deleted,
        }
        yield [doc.get("domain"), doc.get("_id"), registration["xmlns"]], value
        yield [doc.get("domain"), {}, registration["xmlns"]], value


def _reduce_exports_forms_by_app(values):
    # corehq/couchapps/exports_forms_by_app/views/view/reduce.js, line for line.
    value, submissions = None, 0
    for each in values:
        each = dict(each)
        submissions += each.get("submissions") or 0
        if value is None:
            value = each
        elif (value.get("app") and each.get("app")) or value.get("duplicate") or each.get("duplicate"):
            if not (value.get("app") and each.get("app")):
                value = value if value.get("app") else each
            elif value.get("app_deleted") != each.get("app_deleted"):
                value = each if value.get("app_deleted") else value
            else:
                value = value if len(each["app"]["name"]) > len(value["app"]["name"]) else each
            value["duplicate"] = True
        elif not value.get("app") and each.get("app"):
            value = each
    value["submissions"] = submissions
    return value


def _map_by_domain_doc_type_date(doc):
    # corehq/couchapps/by_domain_doc_type_date/views/view/map.js (reduce: _count), which
    # domain/dbaccessors.py::get_docs_in_domain_by_class queries for a project space's documents of a class.
    if not doc.get("domain"):
        return
    doc_type = doc.get("doc_type")
    if doc_type in ("CommCareCase", "CommCareCase-Deleted"):
        date = _js_key(doc, "opened_on")
    elif doc_type in (
        "XFormInstance",
        "XFormInstance-Deleted",
        "XFormError",
        "XFormDuplicate",
        "XFormDeprecated",
        "XFormArchived",
        "SubmissionErrorLog",
    ):
        date = _js_key(doc, "received_on")
    elif doc_type in ("CommCareUser", "WebUser"):
        date = _js_key(doc, "created_on")
    elif doc_type in ("MessageLog", "CallLog", "SMSLog", "EventLog"):
        date = _js_key(doc, "date")
    elif doc_type in (
        "Application",
        "Application-Deleted",
        "RemoteApp",
        "RemoteApp-Deleted",
        "LinkedApplication",
        "LinkedApplication-Deleted",
    ):
        date = _js_key(doc, "built_on") if doc.get("copy_of") else None
    else:
        date = None
    yield [_js_key(doc, "domain"), doc_type, date], None


# view name -> (map function, reduce), the reduce being CouchDB's built-in
# _count or None when the view has no reduce.
VIEWS = {
    "app_manager/applications_brief": (_map_applications_brief, None),
    "app_manager/applications": (_map_applications, None),
    "app_manager/saved_app": (_map_saved_app, None),
    "saved_apps_auto_generated/view": (_map_saved_apps_auto_generated, None),
    "domain/domains": (_map_domains, "_count"),
    "domain/by_status": (_map_domains_by_status, "_count"),
    "users/by_username": (_map_users_by_username, "_count"),
    "users/by_domain": (_map_users_by_domain, "_count"),
    "users_extra/users_by_location_id": (_map_users_by_location_id, "_count"),
    "groups/by_name": (_map_groups_by_name, None),
    "groups/by_user": (_map_groups_by_user, None),
    "program_by_code/view": (_map_program_by_code, None),
    "mobile_auth/key_records": (_map_mobile_auth_key_records, None),
    "schemas_by_xmlns_or_case_type/view": (_map_schemas_by_xmlns_or_case_type, "_count"),
    "hqmedia/by_hash": (_map_hqmedia_by_hash, None),
    "by_domain_doc_type_date/view": (_map_by_domain_doc_type_date, "_count"),
    "apps_with_submissions/view": (_map_apps_with_submissions, "_count"),
    "exports_forms_by_app/view": (_map_exports_forms_by_app, _reduce_exports_forms_by_app),
}

# The query parameters the computed views implement. ``stale`` is accepted
# and has no effect: the harness's views are always current.
_VIEW_PARAMETERS = {
    "key",
    "keys",
    "startkey",
    "endkey",
    "descending",
    "limit",
    "skip",
    "include_docs",
    "reduce",
    "group",
    "stale",
    "inclusive_end",
}


def _json_copy(value):
    return json.loads(json.dumps(value))


def _decoded_query(params):
    """Query parameters of a raw request: each value is JSON-encoded on the wire."""
    return {name: json.loads(value) for name, value in params.items()}


def _keys_equal(a, b):
    # Keys the harness cannot order are unequal unless canonically equivalent
    # (``_collate_strings`` returns 0 for those before it would refuse).
    try:
        return collate(a, b) == 0
    except CollationUnsupported:
        return False


class _AllDocsSession:
    """Answers the one raw request HQ makes around couchdbkit: POST _all_docs."""

    def __init__(self, db):
        self._db = db

    def post(self, url, data=None, headers=None, params=None):
        if url != self._db.uri + "/_all_docs":
            raise UnansweredView(
                f"HQ posted to {url} on the harness's Couch, which answers only "
                "_all_docs; add the request to proof/hq/couch.py if a path needs it."
            )
        params = _decoded_query(params or {})
        unknown = set(params) - {"include_docs"}
        if unknown:
            raise UnansweredView(f"_all_docs with parameters {sorted(unknown)} is not computed by the harness's Couch")
        keys = json.loads(data)["keys"]
        return _JsonResponse(self._db.all_docs_rows(keys, include_docs=bool(params.get("include_docs"))))


class _JsonResponse:
    status_code = 200

    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        return None

    def json(self):
        return _json_copy(self._body)


class ComputedViewCouch(FakeCouchDb):
    """``FakeCouchDb`` whose views are computed from its stored documents."""

    def __init__(self, dbname=COUCH_DB_NAME):
        super().__init__()
        self.dbname = dbname
        self.uri = f"proof-couch://{dbname}"
        self._request_session = _AllDocsSession(self)
        # Called with no arguments before each save, bulk save, delete or seed.
        self.write_listeners: list = []
        # Each stored document's JSON text, by its id, with the stored object it is the text of.
        self._texts: dict[str, tuple[dict, str]] = {}

    def _writing(self):
        for listener in self.write_listeners:
            listener()

    def _store(self, docid, text):
        """Store the document ``text`` is the JSON of as ``docid``'s, keeping the text with it."""
        stored = json.loads(text)
        self.mock_docs[docid] = stored
        self._texts[docid] = (stored, text)
        return stored

    def _text(self, docid, stored):
        """``json.dumps(stored)`` for the document the store holds as ``docid``: the text kept with that very
        object, or written out now and kept."""
        held = self._texts.get(docid)
        if held is not None and held[0] is stored:
            if VERIFY_MEMOS and json.dumps(stored) != held[1]:
                raise MemoMismatch(
                    f"The stored Couch document {docid!r} no longer writes out as the JSON text kept with it, so"
                    " something changed it in place, and proof/hq/couch.py must stop keeping its text."
                )
            return held[1]
        text = json.dumps(stored)
        self._texts[docid] = (stored, text)
        return text

    def _copy(self, docid, stored):
        """A copy of the stored document, as JSON copies it (``_json_copy``)."""
        return json.loads(self._text(docid, stored))

    def snapshot(self) -> dict:
        """Every stored document's JSON text, by its id, in store order: nothing stored is shared with it."""
        return {docid: self._text(docid, stored) for docid, stored in self.mock_docs.items()}

    def restore_snapshot(self, snapshot: dict):
        """Put the store back to exactly what ``snapshot`` holds; the store's dictionary stays the same object.

        A document the store holds as the snapshot's text stays the object it is; every other one is parsed.
        """
        docs, texts = {}, {}
        for docid, text in snapshot.items():
            held = self._texts.get(docid)
            stored = self.mock_docs.get(docid)
            if held is not None and held[0] is stored and (held[1] is text or held[1] == text):
                if VERIFY_MEMOS and json.dumps(stored) != text:
                    raise MemoMismatch(
                        f"The stored Couch document {docid!r} no longer writes out as the JSON text kept with it,"
                        " so a restore cannot keep it, and proof/hq/couch.py must parse every document it restores."
                    )
            else:
                stored = json.loads(text)
            docs[docid] = stored
            texts[docid] = (stored, text)
        self.mock_docs.clear()
        self.mock_docs.update(docs)
        self._texts = texts

    # Documents ----------------------------------------------------------

    def get(self, docid, rev=None, wrapper=None):
        doc = self._copy(docid, super().get(docid, rev=rev))
        return wrapper(doc) if wrapper else doc

    def open_doc(self, docid, **params):
        doc = self.mock_docs.get(docid)
        return None if doc is None else self._copy(docid, doc)

    def doc_exist(self, docid):
        return docid in self.mock_docs

    def save_doc(self, doc, **params):
        self._writing()
        super().save_doc(doc, **params)
        self._store(doc["_id"], json.dumps(doc))

    def save_docs(self, docs, *args, **params):
        self._writing()
        # FakeCouchDb's bulk save stores a document itself when it skips
        # save_doc (new_edits=False); store a copy either way.
        results = super().save_docs(docs, *args, **params)
        for doc in docs:
            if self.mock_docs.get(doc.get("_id")) is doc:
                self._store(doc["_id"], json.dumps(doc))
        return results

    bulk_save = save_docs

    def delete_doc(self, doc, **params):
        self._writing()
        docid = doc["_id"] if isinstance(doc, dict) else doc
        super().delete_doc(docid)
        self._texts.pop(docid, None)

    def seed(self, doc):
        """Store a document as it would be after an earlier save, without HQ's save.

        Returns a copy of what is stored, as a read would.
        """
        if not doc.get("_id"):
            raise ValueError("A seeded Couch document needs an _id.")
        self._writing()
        stored = _json_copy(doc)
        stored.setdefault("_rev", "1-proof")
        stored = self._store(stored["_id"], json.dumps(stored))
        return self._copy(stored["_id"], stored)

    def all_docs_rows(self, keys, include_docs):
        rows = []
        for key in keys:
            doc = self.mock_docs.get(key)
            if doc is None:
                rows.append({"key": key, "error": "not_found"})
                continue
            row = {"id": key, "key": key, "value": {"rev": doc.get("_rev")}}
            if include_docs:
                row["doc"] = self._copy(key, doc)
            rows.append(row)
        return {"total_rows": len(self.mock_docs), "offset": 0, "rows": rows}

    # Views --------------------------------------------------------------

    def raw_view(self, view_name, params):
        # couchdbkit hands the view parameters over as Python values.
        params = {name: value for name, value in params.items() if value is not None}
        if view_name == "_all_docs":
            return self._all_docs_view(params)
        name = view_name
        if name.startswith("_design/"):
            design, _, view = name[len("_design/") :].partition("/_view/")
            name = f"{design}/{view}"
        if name not in VIEWS:
            raise UnansweredView(
                f"HQ queried the Couch view {name!r}, which the harness's Couch does "
                "not compute. Add its map function (from the view's map.js at the "
                "pin) to proof/hq/couch.py's VIEWS if a path needs it."
            )
        unknown = set(params) - _VIEW_PARAMETERS
        if unknown:
            raise UnansweredView(
                f"HQ queried {name!r} with {sorted(unknown)}, which the harness's Couch does not implement."
            )
        map_function, reduce_function = VIEWS[name]
        rows = [
            {"id": doc_id, "key": key, "value": value}
            for doc_id, doc in self.mock_docs.items()
            for key, value in map_function(doc)
        ]
        view_size = len(rows)
        rows = self._select(rows, params)
        wants_reduce = reduce_function is not None and params.get("reduce", True)
        if wants_reduce:
            if params.get("include_docs"):
                raise UnansweredView(f"{name!r} was queried with include_docs on its reduce")

            def reduced(values):
                # CouchDB's built-in _count, or the view's own reduce.
                return len(values) if reduce_function == "_count" else reduce_function([row for row in values])

            if not params.get("group"):
                return {"rows": [{"key": None, "value": reduced([row["value"] for row in rows])}] if rows else []}
            # Grouped: one row a distinct key, in the view's order, each its rows' reduce.
            groups: list[tuple] = []
            for row in rows:
                if groups and _keys_equal(groups[-1][0], row["key"]):
                    groups[-1][1].append(row["value"])
                else:
                    groups.append((row["key"], [row["value"]]))
            return _json_copy({"rows": [{"key": key, "value": reduced(values)} for key, values in groups]})
        # A row's key, value and doc are taken from the stored document; the
        # copy keeps what HQ wraps from a row apart from what is stored.
        return _json_copy(self._page(rows, params, view_size))

    def _select(self, rows, params):
        order = cmp_to_key(lambda x, y: collate(x["key"], y["key"]) or _raw_docid_order(x["id"], y["id"]))
        descending = bool(params.get("descending"))
        if "keys" in params:
            selected = []
            for wanted in params["keys"]:
                matching = [row for row in rows if _keys_equal(row["key"], wanted)]
                matching.sort(key=cmp_to_key(lambda x, y: _raw_docid_order(x["id"], y["id"])), reverse=descending)
                selected.extend(matching)
            return selected
        if "key" in params:
            matching = [row for row in rows if _keys_equal(row["key"], params["key"])]
            matching.sort(key=cmp_to_key(lambda x, y: _raw_docid_order(x["id"], y["id"])), reverse=descending)
            return matching
        rows = sorted(rows, key=order, reverse=descending)
        inclusive_end = params.get("inclusive_end", True)
        if "startkey" in params:
            start = params["startkey"]
            rows = [r for r in rows if (collate(r["key"], start) <= 0 if descending else collate(r["key"], start) >= 0)]
        if "endkey" in params:
            end = params["endkey"]

            def before_end(r):
                c = collate(r["key"], end)
                if descending:
                    return c >= 0 if inclusive_end else c > 0
                return c <= 0 if inclusive_end else c < 0

            rows = [r for r in rows if before_end(r)]
        return rows

    def _page(self, rows, params, view_size):
        """The rows ``params`` select, each with the stored document under ``include_docs``.

        It refers to what is stored; ``raw_view`` hands out a copy of it.
        """
        skip = int(params.get("skip", 0))
        rows = rows[skip:]
        if params.get("limit") is not None:
            rows = rows[: int(params["limit"])]
        out = []
        for row in rows:
            row = dict(row)
            if params.get("include_docs"):
                row["doc"] = self.mock_docs[row["id"]]
            out.append(row)
        # CouchDB's total_rows counts the whole view, not the selected rows.
        return {"total_rows": view_size, "offset": skip, "rows": out}

    def _all_docs_view(self, params):
        unknown = set(params) - {"keys", "include_docs"}
        if unknown or "keys" not in params:
            raise UnansweredView(
                f"HQ queried _all_docs with {sorted(params)}; the harness's Couch answers _all_docs by keys only."
            )
        return self.all_docs_rows(params["keys"], include_docs=bool(params.get("include_docs")))
