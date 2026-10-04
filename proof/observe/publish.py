"""Nova's publishes applied through HQ's import, as Nova's publish client applies them (decision 14).

``create`` applies a configuration's captured create (and, before it, the
lookup workbook Nova's push sent, uploaded as the push uploads it:
``replace``), and returns the app id HQ answered with. ``update`` applies a
captured update (the republish of D, or the publish of D′) over the app:
before it, the profile HQ serves for the app (``app_source``) must be the
one the capture was built over, or the captured bytes are not what Nova
would send there and the harness refuses (``CapturedProfileNotHeld``).
``upload_media`` applies the media upload Nova's publish sends once an
import landed (``lib/deployment/service.ts::uploadMediaBytes``), when the
captured import names one; the unit runs it as an operation of its own,
after the import's, as Nova sends it in a request of its own.

Each returns what it saw as data: HQ's refusal of the upload (its status
and response), the result of the lookup workbook upload, and what HQ's
processing of the media reported.
"""

from __future__ import annotations

import json

from proof.observe.record import bytes_digest, digest


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


def create(unit, export):
    """Nova's first publish of D under the export's configuration.

    Returns ``(app id or None, HQ's refusal or None, the lookup upload's result or None)``.
    """
    from proof.hq import operations

    lookups = upload_lookups(unit, export.create.lookups)
    result = operations.apply_upload(unit, export.create.upload())
    refusal = _refusal(result)
    return (None if refusal else result.response["app_id"]), refusal, lookups


def update(unit, app_id, captured, name):
    """A captured update over the app HQ holds: ``(HQ's refusal or None, the lookup upload's result or None)``."""
    from proof.hq import operations

    served = operations.app_source(unit, app_id).get("profile")
    if served != captured.assumed_source_profile:
        raise operations.CapturedProfileNotHeld(
            f"The captured {name} was built over the profile"
            f" {json.dumps(captured.assumed_source_profile, sort_keys=True)}, but HQ's app_source serves the app"
            f" ({app_id}) with {json.dumps(served, sort_keys=True)}. Nova's publish"
            " over this HQ would carry another profile, so the harness does not apply the captured one."
        )
    lookups = upload_lookups(unit, captured.lookups)
    result = operations.apply_upload(unit, operations.with_app_id(captured.upload(), app_id))
    return _refusal(result), lookups


class MediaNotProcessed(AssertionError):
    """HQ accepted a media upload and its processing did not finish inside the operation that sent it."""


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
    its path (``_logo_refs``), read from the app HQ holds after the processing. The processing changed only its
    ``multimedia_map`` and the version and time ``ApplicationBase.save`` stamps, none of which either reads."""
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


def upload_media(unit, app_id, captured):
    """Nova's media upload after an import HQ accepted, applied to the app HQ holds (``operations.apply_media_upload``).

    Returns HQ's refusal of the upload, or what its processing reported as
    Nova's status poll reads it: each file it matched to a reference of the
    app (by the reference it mapped and the media class it stored), each it
    did not match (with HQ's reason, its cause, ``_unmatched_cause``, and the
    logos of the app at its path) or skipped, and the errors it noted.
    """
    from proof.hq import operations

    upload = captured.upload()
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
