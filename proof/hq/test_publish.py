"""The harness publishes through HQ's import API, and HQ keeps what it keeps.

Contract: ``operations.publish`` applies Nova-shaped multipart uploads through
``app_import_api.py::_handle_import_app`` against HQ's state, so what HQ holds
afterwards is what HQ's own create and update leave. The plausible failures:
a request HQ's view parses differently from Nova's (so the app file never
arrives), an update applied to the wrong app, and state the save path writes
(Couch, blobs, the data dictionary) that the harness drops.

``operations.apply_media_upload`` applies a Nova-shaped media upload through
``app_import_api.py::_handle_upload_multimedia``, whose processing
(``hqmedia/tasks.py::process_bulk_upload_zip``) must run to the end inside
the call. The plausible failures: a processing that never runs (a task
queued and never executed, a ZIP the view never kept), media mapped into
another app, and a medium stored without its bytes, so the app HQ builds
afterwards names media HQ cannot serve. ``proof.observe.publish.upload_media``
records what the processing reported, each file it did not match with its
cause, which the bar names in its path: HQ gives one reason for a file the
app does not reference, one it references only as a logo (the one reference
the upload never maps, by design) and one it references as another type of
media, so a cause read wrongly merges a failure into the logo's expected
class or splits one symptom in two.

The expected values come from the uploaded document and HQ's source: HQ's
create re-mints every form's ``unique_id`` and drops the upload's
``build_spec`` (``models/applications.py::_import_app``), and HQ's update
writes the upload's form ids verbatim while keeping the app's id, build spec
and version history (``overwrite_app_from_source``).
"""

from __future__ import annotations

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import HQ_ROOT, CountingValidator, hq_test_app, nova_shaped_upload, timed

CONFIGURATION = Configuration(privileges={"CLOUDCARE", "VELLUM_SAVE_TO_CASE"})


def _uploaded_case_properties(app_json):
    properties = {}
    for module in app_json["modules"]:
        for form in module["forms"]:
            update = form["actions"].get("update_case", {}).get("update", {})
            properties.setdefault(module["case_type"], set()).update(update)
    return properties


def test_publish_creates_then_updates_the_app_hq_holds(hq, core_runner):
    source = hq_test_app()
    uploaded_form_ids = [f["unique_id"] for m in source["modules"] for f in m["forms"]]
    uploaded_xmlns = [f["xmlns"] for m in source["modules"] for f in m["forms"]]
    create = nova_shaped_upload(source, "Suite app")
    # A captured update names the app its capture peer created; publish
    # writes the id HQ minted into that field.
    update = nova_shaped_upload(source, "Suite app, renamed", app_id="captured-peer-app-id")

    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, record):
        from corehq.apps.data_dictionary.models import CaseProperty

        with timed("publish_create"):
            app_id, (created,) = operations.publish(state, [create])
        assert created.status == 201 and created.response == {"success": True, "app_id": app_id}
        a = operations.held_app(state, app_id)
        a_form_ids = [f.unique_id for f in a.get_forms()]
        assert not set(a_form_ids) & set(uploaded_form_ids)  # HQ's create re-mints every form id
        assert [f.xmlns for f in a.get_forms()] == uploaded_xmlns
        assert a.build_spec.version == CONFIGURATION.commcare_version  # the upload's 2.0.0 is dropped
        assert a.cloudcare_enabled is True  # the configuration grants CLOUDCARE
        assert a.name == "Suite app" and a.version == 1

        with timed("publish_create_and_update"):
            same_id, results = operations.publish(state, [create, update])
        assert same_id != app_id  # a fresh create makes another app
        assert [r.status for r in results] == [201, 200]

        with timed("publish_update"):
            result = operations.apply_upload(state, operations.with_app_id(update, app_id))
        assert result.status == 200
        assert result.response == {"success": True, "app_id": app_id, "version": 2}
        b = operations.held_app(state, app_id)
        assert [f.unique_id for f in b.get_forms()] == uploaded_form_ids  # written verbatim
        assert b.build_spec.version == CONFIGURATION.commcare_version
        assert b.name == "Suite app, renamed" and b.version == 2
        assert b.date_created == a.date_created

        # The save's data dictionary refresh wrote the properties the forms update.
        held = {}
        for prop in CaseProperty.objects.filter(case_type__domain=state.domain).select_related("case_type"):
            held.setdefault(prop.case_type.name, set()).add(prop.name)
        assert held == _uploaded_case_properties(source)

        # Nova's update reads the app back through app_source.
        served = operations.app_source(state, app_id)
        assert served["name"] == "Suite app, renamed"
        assert [f["xmlns"] for m in served["modules"] for f in m["forms"]] == uploaded_xmlns

    assert "cloudcare" in record.privilege_slugs_read()
    assert record.elasticsearch_reads  # the refresh's cache-clearing read, answered empty


def test_an_app_that_maps_media_claims_its_media_and_validates_its_forms_on_import(hq, core_runner):
    """HQ's import reads the mapped media through Couch's _all_docs, outside
    couchdbkit (``hqmedia/models.py::get_media_objects`` -> ``iter_docs``), adds
    the project to each medium's valid domains, and first validates each form
    of a module that uses media through Formplayer
    (``ApplicationMediaMixin.all_media``)."""
    source = hq_test_app()
    path = "jr://file/commcare/image/module0.png"
    source["modules"][0]["media_image"] = {"en": path}
    source["multimedia_map"] = {
        path: {
            "doc_type": "HQMediaMapItem",
            "multimedia_id": "media-image-1",
            "media_type": "CommCareImage",
            "unique_id": "media-image-1",
            "version": None,
        }
    }
    validator = CountingValidator(core_runner)
    with hq_check(CONFIGURATION, validate=validator) as (state, record):
        from corehq.apps.hqmedia.models import CommCareImage

        image = CommCareImage(valid_domains=[]).to_json()
        image["_id"] = "media-image-1"
        state.couch.seed(image)

        app_id, (created,) = operations.publish(state, [nova_shaped_upload(source, "Media app")])
        assert created.status == 201
        assert state.couch.mock_docs["media-image-1"]["valid_domains"] == [state.domain]
        assert list(operations.held_app(state, app_id).multimedia_map) == [path]
    assert validator.calls == 2


def _png():
    """An image HQ ships (``hqmedia/static/hqmedia/images/invalid_image.png``), as an upload's bytes."""
    return (HQ_ROOT / "corehq/apps/hqmedia/static/hqmedia/images/invalid_image.png").read_bytes()


def _nova_shaped_media_upload(files):
    """A multipart body shaped as Nova's ``uploadAppMediaBundle`` sends it: ``waf_padding``, then the ZIP of
    ``files`` (``{path: bytes}``) as ``bulk_upload_file`` named ``multimedia.zip``."""
    import io
    import zipfile

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zipped:
        for path, content in files.items():
            zipped.writestr(path, content)
    boundary = "----formdata-undici-0123456789"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="waf_padding"\r\n\r\n'.encode()
        + b"x" * 16384
        + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="bulk_upload_file";'
        f' filename="multimedia.zip"\r\nContent-Type: application/zip\r\n\r\n'.encode()
        + archive.getvalue()
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return operations.Upload(body, f"multipart/form-data; boundary={boundary}")


def _unreadable_entry_archive():
    """A ZIP whose one entry fails its CRC check when read."""
    import io
    import zipfile

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as zipped:
        zipped.writestr("commcare/image/module0.png", b"x" * 64)
    return zipfile.ZipFile(io.BytesIO(archive.getvalue().replace(b"x" * 64, b"y" * 64)))


def test_a_media_upload_maps_each_file_the_app_references_into_that_app_with_its_bytes(hq, core_runner):
    """Nova's create maps its media by content hash (``bundle.ts::buildMultimediaMap``), ids no HQ holds; the
    upload after it is what HQ maps the media from. A file the app does not reference stays unmatched, and so
    do one it references only as its logo and one it references as audio whose bytes HQ reads as an image. HQ
    gives all three one reason; the publish's record names each by its cause (``proof.observe.publish``)."""
    import io
    import zipfile
    from types import SimpleNamespace

    from proof.observe import publish

    source = hq_test_app()
    path = "jr://file/commcare/image/module0.png"
    source["modules"][0]["media_image"] = {"en": path}
    source["modules"][0]["media_audio"] = {"en": "jr://file/commcare/audio/sound.mp3"}
    source["logo_refs"] = {
        "hq_logo_web_apps": {"path": "jr://file/commcare/image/Logo.png"},
        "hq_logo_android_home": {"path": "jr://file/commcare/audio/sound.mp3"},
    }
    source["multimedia_map"] = {path: {"multimedia_id": "novas-content-hash", "media_type": "CommCareImage"}}
    png = _png()
    files = {
        "commcare/image/module0.png": png,
        "commcare/image/unused.png": png,
        "commcare/image/logo.png": png,
        "commcare/audio/sound.mp3": png,
    }
    upload = _nova_shaped_media_upload(files)
    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        from corehq.apps.hqmedia.models import CommCareImage, HQMediaMapItem

        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "Media app")])
        other_id, _ = operations.publish(state, [nova_shaped_upload(source, "Another app")])
        assert operations.held_app(state, app_id).multimedia_map[path].multimedia_id == "novas-content-hash"

        with state.fork():
            recorded = publish.upload_media(state, app_id, SimpleNamespace(upload=lambda: upload))
        with timed("media_upload"):
            result = operations.apply_media_upload(state, app_id, upload)
        assert result.status == 200 and result.response["success"] is True
        processing = result.processing
        assert processing["complete"] is True and processing["errors"] == []
        assert [info["path"] for info in processing["matched_files"]["CommCareImage"]] == [path]
        unmatched = ["commcare/image/unused.png", "commcare/image/logo.png", "commcare/audio/sound.mp3"]
        assert [file["path"] for file in processing["unmatched_files"]] == unmatched
        assert {file["reason"] for file in processing["unmatched_files"]} == {
            "Did not match any Image paths in application."
        }

        app = operations.held_app(state, app_id)
        item = app.multimedia_map[path]
        image = CommCareImage.get(item.multimedia_id)
        assert item.media_type == "CommCareImage"
        assert item.unique_id == HQMediaMapItem.gen_unique_id(item.multimedia_id, path)
        assert image.get_display_file(return_type=False) == png
        assert image.file_hash == CommCareImage.generate_hash(png)
        assert state.domain in image.owners and state.domain in image.valid_domains
        # The other app keeps Nova's map: the upload named one app.
        assert operations.held_app(state, other_id).multimedia_map[path].multimedia_id == "novas-content-hash"

        # HQ's other reasons, which this upload reaches none of, are read from the same app and ZIP: a file the
        # app references as the media its bytes are (named by its entry, or by the form path HQ matched), and an
        # entry HQ could not read.
        with zipfile.ZipFile(io.BytesIO(operations.upload_field(upload, "bulk_upload_file"))) as archive:
            assert publish._unmatched_cause(app, archive, "commcare/image/module0.png") == "not_stored"
            assert publish._unmatched_cause(app, archive, path) == "not_stored"
        with _unreadable_entry_archive() as archive:
            assert publish._unmatched_cause(app, archive, "commcare/image/module0.png") == "unreadable"
    assert recorded["refused"] is None and recorded["matched"] == [{"path": path, "class": "CommCareImage"}]
    # The logo is found case-blind, as the upload compares every path it matches (``process_bulk_upload_zip``);
    # one the app also references elsewhere is not the logo's cause.
    assert [(file["path"], file["cause"], file["logoRefs"]) for file in recorded["unmatched"]] == [
        (unmatched[0], "no_reference", []),
        (unmatched[1], "logo_refs", ["hq_logo_web_apps"]),
        (unmatched[2], "other_type", ["hq_logo_android_home"]),
    ]
    assert recorded["skipped"] == [] and recorded["errors"] == []
