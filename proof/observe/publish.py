"""Nova's publishes applied through HQ's import, as Nova's publish client applies them (decision 14).

``create`` applies a configuration's captured first publish and returns the
app id HQ answered with. In the two-import layout (``Export.two_imports``) a
first publish is the empty shell's create, the fields of HQ's source the
content was built over held to HQ's own read of the shell, the lookup
workbook Nova's push sent (uploaded as the push uploads it: ``replace``),
then the content import, which fills the shell with A's id
(``operations.with_app_id``); HQ's refusal of either is the create's refusal,
and state A is HQ app version 2 (3 after media). In the legacy layout a
retained control replays it as one create, after its workbook, and its
state A is version 1 (2 after media). ``update`` applies a captured update
(the republish of D, or the publish of D′) over the app: before it, every
field of HQ's source the capture was built over (its sidecar's
``assumedSource``, ``Captured.assumed_source``) must be what HQ serves for
the app (``app_source``), or the captured bytes are not what Nova would send
there and the harness refuses (``operations.CapturedSourceNotHeld``); and
every lookup table the publish read before it decided (its sidecar's
``assumedResources``) must be what HQ's own table and row resources serve
(``operations.CapturedResourcesNotHeld``). Over a document whose
``hq-side.json`` a person saved in HQ, Nova's preflight stopped the
republish and the capture sent it again with what that person confirms
(the sidecar's ``confirmed``), so B lands only through that confirmation.
Where the republish followed a bring-in of those saves (the sidecar's
``broughtIn``), it names each menu and form by the id the bring-in read of
the app, and the capture read its peer's: a form HQ's ``new_form`` added
holds an id HQ minted, so that id is written in place of the peer's
(``held_ids``, ``operations.with_held_ids``), as A's id is in place of the
peer's app id.
``upload_media`` applies the media upload Nova's publish sends once a
content import landed (``lib/deployment/service.ts::uploadMediaBytes``), when
the captured import names one; the unit runs it as an operation of its own,
after the import's, as Nova sends it in a request of its own.

A publish binds its baseline to HQ's save counter
(``lib/commcare/hq/appSourceAtVersion.ts``), and the capture's peer models
that counter (``proof/corpus/targetPeer.ts``), so each write here is held to
the peer's count of the same write, where the capture recorded one (the
sidecar's ``saveCounter`` and ``mediaSaveCounter``): the create by where it
leaves the counter, an import and a media upload by how far each moves it,
and an import's acknowledged version to the counter right after it
(``operations.hold_save_counter``, ``CapturedCounterNotHeld``). A person's saves
in HQ between two publishes the peer counts as one save, the one fact Nova's
comparison within a publish reads, so they are held through the imports'
moves on either side of them, never by their number.

An app made in CommCare HQ (an ``hq-authored`` document) has no first
publish: ``create_authored`` makes its A again from the files the document
carries under ``authored/`` (``authored_files``), with HQ's own models, as
the app HQ's pages and models made (``proof/hq/operations.py::
save_authored_tables``, ``save_authored_places``,
``save_authored_practice_workers``, ``save_authored_app``), its media attached
as HQ's template loader attaches a file. It sends no import, so
it answers no refusal and no lookup upload.

Each returns what it saw as data: HQ's refusal of the upload (its status
and response), the result of the lookup workbook upload, and what HQ's
processing of the media reported.
"""

from __future__ import annotations

import hashlib
import json

from proof.observe.record import bytes_digest, digest

# Where an app made in CommCare HQ keeps the files its A is made again from, under its document's directory.
AUTHORED = "authored"
# The project data a base holds beside its app, each a file ``<name>.json`` under ``AUTHORED`` where the base holds
# any, made before the app in this order (``create_authored``): its lookup tables, its levels and places, and its
# practice workers.
AUTHORED_PROJECT_DATA = ("tables", "places", "practice-workers", "project-searches")


def _json(value):
    return json.loads(json.dumps(value, default=str))


def captured_digest(captured) -> bytes:
    """The digest of a captured request as HQ receives it: its body, its sidecar (which names any media upload sent
    after it), and the workbook pushed before it."""
    if captured is None:
        return digest(None).encode()
    parts = [bytes_digest(captured.body_path.read_bytes()), digest(captured.meta)]
    if captured.lookups is not None:
        parts.append(captured_digest(captured.lookups).decode())
    return digest(parts).encode()


def authored_files(root) -> dict:
    """The files an app made in CommCare HQ is made again from, by role, as paths relative to its document's
    directory ``root``: ``authored.app`` (``authored/app.json``, the app as HQ stores it), and, where the base holds
    them, ``authored.media`` (``media.json``, one row a mapped path), one role a file of ``authored/media/``
    (``authored.media.<name>``, each file the rows name), ``authored.tables``, ``authored.places`` and
    ``authored.practice-workers``, as ``proof/corpus/inputs.ts`` names them. The case seed (``authored/seed.json``)
    is no file A is made from: the unit reads it as the cases A's sessions run over
    (``proof.observe.unit.input_files``)."""
    directory = root / AUTHORED
    found = {"authored.app": f"{AUTHORED}/app.json"}
    if (directory / "media.json").is_file():
        found["authored.media"] = f"{AUTHORED}/media.json"
    if (directory / "media").is_dir():
        for name in sorted(path.name for path in (directory / "media").iterdir()):
            found[f"authored.media.{name}"] = f"{AUTHORED}/media/{name}"
    for name in AUTHORED_PROJECT_DATA:
        if (directory / f"{name}.json").is_file():
            found[f"authored.{name}"] = f"{AUTHORED}/{name}.json"
    return found


def first_publish_digest(export, root=None) -> bytes:
    """The digest of a configuration's first publish: of both imports in the two-import layout, each by
    ``captured_digest``, and of the one create in the legacy layout. For an app made in CommCare HQ, which has no
    first publish (``root`` its document's directory), the digest of every file A is made again from
    (``authored_files``), each with its role."""
    if root is not None:
        files = authored_files(root)
        return digest(
            [[role, bytes_digest((root / path).read_bytes())] for role, path in sorted(files.items())]
        ).encode()
    if not export.two_imports:
        return captured_digest(export.create)
    return digest([captured_digest(export.create).decode(), captured_digest(export.content).decode()]).encode()


def upload_lookups(unit, captured):
    """HQ's upload of the captured lookup workbook, as Nova's push makes it before the import; None without one."""
    if captured is None:
        return None
    from proof.hq import operations

    result = operations.upload_lookup_workbook(unit, captured.workbook(), replace=True)
    return _json({"success": result.success, "errors": list(result.errors), "messages": list(result.messages)})


def _refusal(result):
    if 200 <= result.status < 300 and result.response.get("success"):
        return None
    return {"status": result.status, "response": _json(result.response)}


# The one field of the content's assumed source a configuration without Web Apps answers otherwise: HQ's create
# sets ``cloudcare_enabled`` from the domain's ``CLOUDCARE`` privilege (``_create_app_from_doc``), and the capture
# peer grants it for every document that declares Web Apps, as the lane's configuration does.
WEB_APPS_SETTING = "cloudcare_enabled"


def create(unit, export, *, plan_without_web_apps: bool = False):
    """Nova's first publish of D under the export's configuration: both imports of the two-import layout, or the
    one create of the legacy layout, each after the workbook the content names.

    ``plan_without_web_apps`` is for a test that publishes a document declaring Web Apps into a configuration
    without ``CLOUDCARE`` on purpose, a state Nova's own publish stops at (``hq_plan_lacks_web_apps``), to prove what
    HQ's update, its settings page and Web Apps do there: HQ's create stores ``cloudcare_enabled`` false where the
    capture peer, granting the privilege as the lane does for such a document, answered true. The content's hold
    then leaves out that one path and holds every other field and resource as ever (``update``).

    Returns ``(A's id or None, HQ's refusal of either import or None, the lookup upload's result or None)``.
    """
    from proof.hq import operations

    if not export.two_imports:
        lookups = upload_lookups(unit, export.create.lookups)
        result = operations.apply_upload(unit, export.create.upload())
        refusal = _refusal(result)
        return (None if refusal else result.response["app_id"]), refusal, lookups
    shell = operations.apply_upload(unit, export.create.upload())
    refusal = _refusal(shell)
    if refusal:
        return None, refusal, None
    app_id = shell.response["app_id"]
    operations.hold_save_counter(unit, app_id, export.create.save_counter, None, "the captured create")
    refusal, lookups = update(unit, app_id, export.content, "content", plan_without_web_apps=plan_without_web_apps)
    return (None if refusal else app_id), refusal, lookups


def authored_media(root):
    """Each mapped file of an app made in CommCare HQ, as ``operations.AuthoredMedia``: a row of its
    ``authored/media.json`` (in its order, which is path order) with the bytes of the file the row names, and the
    path's last segment as the name HQ's template loader hands ``attach_data``. Empty where the base maps no file."""
    from proof.hq.operations import AuthoredMedia

    directory = root / AUTHORED
    if not (directory / "media.json").is_file():
        return []
    rows = json.loads((directory / "media.json").read_text(encoding="utf-8"))
    return [
        AuthoredMedia(
            path=row["path"],
            data=(directory / row["file"]).read_bytes(),
            original_filename=row["path"].rsplit("/", 1)[-1],
        )
        for row in rows
    ]


def _save_practice_workers(unit, workers):
    """``operations.save_authored_practice_workers`` with what a worker's save reaches for: HQ's own Redis, where a
    user's save takes its lock (``proof.hq.redis.shared``), and the unit's commit callbacks (``unit.committing``),
    as every lane caller that saves a user holds them (``proof/formplayer/hq.py::create_worker``'s caller). The
    unit's operation indexes the workers as HQ's pillows do as it ends, so the app settings page proof 4 saves
    offers each (``views/apps.py``, ``get_practice_mode_mobile_workers``)."""
    from proof.hq import operations
    from proof.hq import redis as hq_redis

    with hq_redis.shared(None), unit.committing():
        operations.save_authored_practice_workers(unit, workers)


def create_authored(unit, document):
    """An app made in CommCare HQ made again in the unit from its document's ``authored/`` files: its lookup tables
    (``operations.save_authored_tables``), its levels and places (``save_authored_places``) and its practice workers
    (``save_authored_practice_workers``) where the base holds them, each before the app, so A's build, its restore and
    every walk run over a project space that holds them; then the app from its stored document, with its media
    attached (``save_authored_app``).

    Returns ``(A's id, None, None)`` in ``create``'s shape: nothing is imported, so HQ refuses nothing and no
    workbook is uploaded."""
    from proof.hq import operations

    from proof.hq.project_search import install_project_searches

    directory = document.root / AUTHORED
    for name, save in (
        ("project-searches", install_project_searches),
        ("tables", operations.save_authored_tables),
        ("places", operations.save_authored_places),
        ("practice-workers", _save_practice_workers),
    ):
        if (directory / f"{name}.json").is_file():
            save(unit, json.loads((directory / f"{name}.json").read_text(encoding="utf-8")))
    app = json.loads((directory / "app.json").read_text(encoding="utf-8"))
    return operations.save_authored_app(unit, app, authored_media(document.root)), None, None


def update(unit, app_id, captured, name, *, plan_without_web_apps: bool = False):
    """A captured update over the app HQ holds: ``(HQ's refusal or None, the lookup upload's result or None)``.

    Every field of HQ's source the capture names is held to HQ's own read first
    (``operations.hold_assumed_source``), whichever fields they are, and so is
    every lookup table the publish read before it decided what to send, its
    stop and its confirmation among them (``assumedResources``,
    ``operations.hold_assumed_resources``). With ``plan_without_web_apps`` the
    hold leaves out ``cloudcare_enabled`` alone: the update lands over an app
    HQ's create made without Web Apps, which Nova's own publish would have
    stopped at (``hq_plan_lacks_web_apps``), so a test can prove what HQ does
    there (``create``).
    """
    from proof.hq import operations

    assumed = captured.assumed_source
    if plan_without_web_apps:
        assumed = {path: value for path, value in assumed.items() if path != WEB_APPS_SETTING}
    operations.hold_assumed_source(unit, app_id, assumed, f"captured {name}")
    operations.hold_assumed_resources(unit, captured.meta.get("assumedResources"), f"captured {name}")
    lookups = upload_lookups(unit, captured.lookups)
    upload = operations.with_app_id(captured.upload(), app_id)
    upload = operations.with_held_ids(upload, held_ids(unit, app_id, captured.brought_in))
    before = operations.save_counter(unit, app_id)
    result = operations.apply_upload(unit, upload)
    refusal = _refusal(result)
    if refusal is None:
        operations.hold_save_counter(
            unit,
            app_id,
            captured.save_counter,
            before,
            f"the captured {name}",
            acknowledged=result.response.get("version"),
        )
    return refusal, lookups


def held_ids(unit, app_id, brought_in):
    """``{id the capture's peer held: id HQ holds}`` for each menu and form a bring-in's record names
    (``BroughtIn.identities``, each ``{entityKind, novaEntityUuid, uniqueId, xmlns}``) under another id than the app
    HQ holds gives it; empty where the update followed no bring-in.

    A form is the one HQ holds under the row's ``xmlns``, which the person's form keeps
    (``models/forms.py::FormSource.__set__`` stores the ``xmlns`` the posted XForm names); a menu is held under the
    row's own id, since no save the harness makes adds one. A row HQ's app has no place for refuses
    (``operations.CapturedIdsNotHeld``): the capture recorded a reading of an app HQ does not hold."""
    from proof.hq import operations

    if brought_in is None:
        return {}
    app = operations.held_app(unit, app_id)
    modules = {module.unique_id for module in app.get_modules()}
    forms = {form.xmlns: form.unique_id for form in app.get_forms() if form.form_type != "shadow_form" and form.xmlns is not None}
    shared = {form.unique_id for form in app.get_forms() if form.form_type == "shadow_form"}
    ids = {}
    for row in brought_in.identities:
        captured = row.get("uniqueId")
        if captured is None:
            continue
        if row.get("entityKind") == "module":
            if captured not in modules:
                raise operations.CapturedIdsNotHeld(
                    f"The bring-in's record names the menu {captured}, which the app HQ holds ({app_id}) does not"
                    " hold. The harness adds no menu in a person's place, so the capture read another app."
                )
            continue
        held = captured if captured in shared else forms.get(row.get("xmlns"))
        if held is None:
            raise operations.CapturedIdsNotHeld(
                f"The bring-in's record names the form {captured} under {row.get('xmlns')}, and the app HQ holds"
                f" ({app_id}) holds no form under that xmlns, so the capture read another app."
            )
        if held != captured:
            ids[captured] = held
    return ids


class MediaNotProcessed(AssertionError):
    """HQ accepted a media upload and its processing did not finish inside the operation that sent it."""


class MediaReportNotMapped(AssertionError):
    """HQ's report of a media upload names, for a path it matched, a file the app's map does not hold there.

    Nova checks each reported path and file identity against the current app map and the authenticated file bytes
    (``lib/deployment/mediaReceipt.ts::readMediaReceipt``). The report must agree with the map: after HQ processed the upload, the app's ``multimedia_map`` holds at every matched path the document
    the report names (``hqmedia/tasks.py::process_bulk_upload_zip``, ``app.create_mapping`` then
    ``get_media_info``)."""


def hold_report_maps(unit, app_id, processing):
    """Holds HQ's report of a processed media upload to the app's map (``MediaReportNotMapped``): for every entry
    of ``matched_files``, ``multimedia_map[path].multimedia_id`` is the entry's ``m_id``. Returns how many entries
    it held."""
    from proof.hq import operations

    app = operations.held_app(unit, app_id)
    held = 0
    for media_class, infos in sorted(processing["matched_files"].items()):
        for info in infos:
            item = app.multimedia_map.get(info["path"])
            mapped = None if item is None else item.multimedia_id
            if mapped != info.get("m_id"):
                raise MediaReportNotMapped(
                    f"HQ's report of the media upload for {app_id} names {info.get('m_id')!r} ({media_class}) at"
                    f" {info['path']}, and the app's multimedia_map holds {mapped!r} there after the processing. Nova"
                    " verifies every reported identity against the current map before recording its bytes."
                )
            held += 1
    return held


def hold_media_bytes(unit, app_id, expected):
    """Compare the captured digest to the mapped file served by HQ's ViewMultimediaFile.get."""
    from corehq.apps.hqmedia.models import CommCareMultimedia

    from proof.hq import operations

    if not expected:
        return
    mapped = operations.held_app(unit, app_id).multimedia_map
    for path, digest in expected.items():
        item = mapped.get(path)
        if item is None or not item.multimedia_id:
            raise MediaReportNotMapped(f"HQ's app {app_id} has no mapped file at {path} for the verified receipt.")
        media = CommCareMultimedia.get_doc_class(item.media_type).get(item.multimedia_id)
        data = media.get_display_file(return_type=False)
        if data is None or hashlib.sha256(data).hexdigest() != digest:
            raise MediaReportNotMapped(f"HQ's app {app_id} serves different bytes at {path} from the capture.")


def _hold_uploaded_bytes(unit, app_id, upload, processing):
    """Hold each matched stored file to the submitted ZIP member the native job actually named."""
    import io
    import zipfile

    from proof.hq import operations

    expected = {}
    with zipfile.ZipFile(io.BytesIO(operations.upload_field(upload, "bulk_upload_file"))) as archive:
        for infos in processing["matched_files"].values():
            for info in infos:
                with archive.open(info["original_path"]) as member:
                    expected[info["path"]] = hashlib.file_digest(member, "sha256").hexdigest()
    hold_media_bytes(unit, app_id, expected)


def _logo_refs(app, path):
    """The logos of ``app`` (its ``logo_refs`` slugs) at the form path HQ's bulk upload reads the ZIP entry
    ``path`` as (``CommCareMultimedia.get_form_path``, compared lowercased as the upload matches)."""
    from corehq.apps.hqmedia.models import CommCareMultimedia

    form_path = CommCareMultimedia.get_form_path(path, lowercase=True)
    return sorted(slug for slug, ref in (app.logo_refs or {}).items() if str(ref.get("path", "")).lower() == form_path)


def _lowered(paths):
    return {path.lower() for path in paths}


def _unmatched_cause(app, archive, path):
    """Why HQ's bulk upload left the file it names ``path`` unmatched, decided as
    ``hqmedia/tasks.py::process_bulk_upload_zip`` decides it, over the uploaded
    ZIP (``archive``) and the app it matched the ZIP against:

    - ``unreadable``: HQ could not read the ZIP entry;
    - ``not_stored``: the app references the file as the media HQ reads its
      bytes as, so HQ matched it and did not store it (HQ names such a file by
      its ZIP entry, or by the form path it matched once it tried);
    - ``other_type``: the app references the file's form path only as media
      of another type than HQ reads its bytes as;
    - ``logo_refs``: the app references it only as a logo. App-level media is
      the one reference the upload never maps: it matches against
      ``app.get_all_paths_of_type``, which reads
      ``ApplicationMediaMixin.all_media``, every path of the app's modules
      and forms but its logos. Nova tells the person a logo used nowhere else
      is not carried (``lib/media/uploadOutcome.ts::interpretMediaAttach``);
    - ``no_reference``: the app does not reference it.
    """
    from corehq.apps.hqmedia.models import CommCareMultimedia

    if path not in archive.namelist():
        return "not_stored"
    try:
        data = archive.read(path)
    except Exception:
        return "unreadable"
    media_class = CommCareMultimedia.get_class_by_data(data, filename=path)
    form_path = CommCareMultimedia.get_form_path(path, lowercase=True)
    if media_class is not None and form_path in _lowered(app.get_all_paths_of_type(media_class.__name__)):
        return "not_stored"
    if form_path in _lowered(app.all_media_paths()):
        return "other_type"
    return "logo_refs" if _logo_refs(app, path) else "no_reference"


def _unmatched(unit, app_id, upload, unmatched_files):
    """Each file HQ's processing left unmatched, with its cause (``_unmatched_cause``) and the logos of the app at
    its path (``_logo_refs``), read from the app HQ holds after the processing. The processing changed only the
    ``multimedia_map`` it writes and the version and time ``ApplicationBase.save`` stamps, none of which either
    reads."""
    import io
    import zipfile

    from proof.hq import operations

    if not unmatched_files:
        return []
    app = operations.held_app(unit, app_id)
    with zipfile.ZipFile(io.BytesIO(operations.upload_field(upload, "bulk_upload_file"))) as archive:
        return [
            {
                **entry,
                "cause": _unmatched_cause(app, archive, entry["path"]),
                "logoRefs": _logo_refs(app, entry["path"]),
            }
            for entry in unmatched_files
        ]


def upload_media(unit, app_id, captured, *, counter=None):
    """Nova's media upload after an import HQ accepted, applied to the app HQ holds (``operations.apply_media_upload``).

    ``counter`` is the capture peer's save counter around the same upload (the import's sidecar's
    ``mediaSaveCounter``, ``Captured.media_save_counter``): HQ's counter's move over the processing is held to it
    (``operations.hold_save_counter``), where the capture recorded one.

    Every path the processing reports it matched is held to the app's map first
    (``hold_report_maps``), the report being what Nova records the file at each
    path from. Each mapped file is also compared with the submitted bytes. Returns HQ's refusal of the upload, or what its processing reported as
    Nova's status poll reads it: each file it matched to a reference of the
    app (by the reference it mapped and the media class it stored), each it
    did not match (with HQ's reason, its cause, ``_unmatched_cause``, and the
    logos of the app at its path) or skipped, and the errors it noted.
    """
    from proof.hq import operations

    upload = captured.upload()
    before = operations.save_counter(unit, app_id)
    result = operations.apply_media_upload(unit, app_id, upload)
    if result.processing is None:
        return {"refused": {"status": result.status, "response": _json(result.response)}}
    processing = result.processing
    if not processing.get("complete"):
        raise MediaNotProcessed(
            f"HQ accepted the media upload for {app_id} and its processing had not finished when the upload's"
            f" operation ended ({json.dumps(_json(processing), sort_keys=True)}). HQ's Celery runs the processing"
            " inline in the harness (CELERY_TASK_ALWAYS_EAGER), so an unfinished one never reached the task."
        )
    hold_report_maps(unit, app_id, processing)
    _hold_uploaded_bytes(unit, app_id, upload, processing)
    operations.hold_save_counter(unit, app_id, counter, before, "the captured media upload")
    return _json(
        {
            "refused": None,
            "matched": [
                {"path": info["path"], "class": media_class}
                for media_class, infos in sorted(processing["matched_files"].items())
                for info in infos
            ],
            "unmatched": _unmatched(unit, app_id, upload, processing["unmatched_files"]),
            "skipped": processing["skipped_files"],
            "errors": processing["errors"],
        }
    )
