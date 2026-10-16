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

What HQ does with Nova's step 2 publish (part 01 of step 2's plan), each over
a corpus document's own capture (``proof/hq/conftest.py::DOCUMENTS``):

- The publish sequence (A3): the empty shell is created and HQ refuses to
  build it; the update that fills it leaves the update's ids, ``xmlns`` and
  attachments, and again moves nothing; HQ's two forms of an app that is gone
  (a soft delete and an id it never held) and their two neighbours (a linked
  app, an update naming no ``doc_type``) answer as Nova reads them; HQ's API
  limiter refuses a second import within a second before it runs; and an
  update writes none of the fields HQ excludes, and writes ``case_sharing``
  and ``cloudcare_enabled``, which it does not exclude. The plausible
  failures: a shell HQ could build (a build would hold HQ-minted ids), an
  update that leaves another app than it describes, and a reading of "gone"
  HQ does not give.
- No multimedia map (A4): an import with no map draws no warning under
  ``CAUTIOUS_MULTIMEDIA`` and the media upload maps every file, and a build
  made before the upload names no medium and installs, where one made from
  a create carrying Nova's former map names a medium HQ does not hold.
- A ``.ccz`` for one project space (A5): the working app serves every address
  a local archive names, and HQ answers an archive ahead of its app (a shell
  holding none of its forms) from what it holds: the restore, the receiver
  and the search context.
- Derived ids (A1): two apps of one project space may hold the same form ids;
  a keyword or a scheduled message resolves a form id a republish keeps in
  the next release; HQ keeps a form's validation verdict for 7 days under
  the app's and the form's id, and so a verdict cached before Nova's
  publish over a form still refuses HQ's download of the unbuilt app while a
  new version builds (part 02's 7-day App Preview statement); and HQ mints
  the id shapes Nova derives.
"""

from __future__ import annotations

import dataclasses
from contextlib import contextmanager

import pytest

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

    with hq_check(CONFIGURATION) as (state, record):
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
    assert record.elasticsearch_reads  # the refresh's cache-clearing read of the project space's case types


def test_an_import_that_carries_a_map_claims_its_media(hq, core_runner):
    """HQ's import reads the mapped media through Couch's _all_docs, outside
    couchdbkit (``hqmedia/models.py::get_media_objects`` -> ``iter_docs``), adds
    the project to each medium's valid domains, and first validates each form
    of a module that uses media through Formplayer
    (``ApplicationMediaMixin.all_media``). A fact about HQ that stays: Nova
    sends no such body from step 2, whose imports carry no map."""
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
    validator = CountingValidator()
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
    """Nova's imports carry no map: the upload after the import alone maps the media. A file the app does not
    reference stays unmatched, and so do one it references only as its logo and one it references as audio whose
    bytes HQ reads as an image. HQ gives all three one reason; the publish's record names each by its cause
    (``proof.observe.publish``)."""
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
    png = _png()
    files = {
        "commcare/image/module0.png": png,
        "commcare/image/unused.png": png,
        "commcare/image/logo.png": png,
        "commcare/audio/sound.mp3": png,
    }
    upload = _nova_shaped_media_upload(files)
    with hq_check(CONFIGURATION) as (state, _):
        from corehq.apps.hqmedia.models import CommCareImage, HQMediaMapItem

        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "Media app")])
        other_id, _ = operations.publish(state, [nova_shaped_upload(source, "Another app")])
        assert dict(operations.held_app(state, app_id).multimedia_map) == {}

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
        # The other app maps nothing: the upload named one app.
        assert dict(operations.held_app(state, other_id).multimedia_map) == {}

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


# The publish sequence (part 01, A3): a shell create, then the update that fills it -----------------------------

# ``lib/commcare/expander.ts::APP_SHELL_KEYS``, the keys of the empty shell a first publish creates, in its order:
# no ``add_ons``, which the update's overlay writes, no ``build_spec``, which HQ takes from its own default build,
# and ``auto_gps_capture`` only for a Connect app.
APP_SHELL_KEYS = (
    "doc_type",
    "application_version",
    "name",
    "langs",
    "translations",
    "auto_gps_capture",
    "modules",
    "_attachments",
)
# The shell of an app that is not a Connect app, as the three documents below are.
APP_SHELL_KEYS_WITHOUT_CONNECT = tuple(key for key in APP_SHELL_KEYS if key != "auto_gps_capture")
MEMBER = "member@example.org"
MISSING_APP = "nova-proof-missing-app"


def _app_file(upload):
    import json

    return json.loads(operations.upload_field(upload, "app_file"))


def _held_ids(app):
    return (
        [module.unique_id for module in app.modules],
        [form.unique_id for form in app.get_forms()],
        [form.xmlns for form in app.get_forms()],
    )


def _sent_ids(body):
    forms = [form for module in body["modules"] for form in module["forms"]]
    return (
        [module["unique_id"] for module in body["modules"]],
        [form["unique_id"] for form in forms],
        [form["xmlns"] for form in forms],
    )


@contextmanager
def _api(state):
    """What HQ's API needs beyond the check's seams (``proof/hq/test_retained_reads.py::_services``), its rate
    limiter's counts within their limits."""
    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits

    with hq_redis.shared(None), state.committing(), api_rate_limits(state):
        yield


@pytest.mark.parametrize(
    "document_id", ["navigation-base", "targeted-form-links-hidden-and-fallback", "case-list-inline"]
)
def test_a_shell_create_then_an_update_leaves_what_the_update_describes(hq, core_runner, documents, document_id):
    """The shell Nova's ``expandAppShell`` emits (the capture's ``create.body``) is created, HQ refuses to build it,
    and the update Nova sends over it leaves HQ holding the update's ids and ``xmlns`` and no attachment the
    update did not send; the same update applied again moves no identity."""
    from corehq.apps.app_manager.exceptions import AppValidationError

    from proof.hq.seams import build_seams

    export = documents[document_id].exports["minimum"]
    assert export.two_imports
    shell, content = _app_file(export.create.upload()), _app_file(export.content.upload())
    assert tuple(shell) == APP_SHELL_KEYS_WITHOUT_CONNECT
    assert shell["modules"] == [] and shell["_attachments"] == {}
    with hq_check(export.configuration.hq()) as (state, _):
        app_id, (created,) = operations.publish(state, [export.create.upload()])
        assert created.status == 201
        held = operations.held_app(state, app_id)
        assert held.version == 1 and held.modules == []
        assert [error["type"] for error in held.validate_app()] == ["no modules"]
        with build_seams(), pytest.raises(AppValidationError):
            held.make_build()
        update = operations.with_app_id(export.content.upload(), app_id)
        updated = operations.apply_upload(state, update)
        assert (updated.status, updated.response["version"]) == (200, 2)
        filled = operations.held_app(state, app_id)
        assert _held_ids(filled) == _sent_ids(content)
        assert {name for name in filled.blobs if name.endswith(".xml")} <= set(content["_attachments"])
        assert filled.build_spec.version == export.configuration.commcare_version
        again = operations.apply_upload(state, update)
        assert (again.status, again.response["version"]) == (200, 3)
        assert _held_ids(operations.held_app(state, app_id)) == _sent_ids(content)


def test_what_hq_answers_for_an_app_that_is_gone_linked_or_missing(hq, core_runner, documents):
    """HQ's two forms of "the app is gone" and their two neighbours, through HQ's own views: a soft delete serves
    the source read with ``doc_type: "Application-Deleted"``, refuses an update naming ``Application`` (400) and
    answers ``current_app_version`` 404, and takes an update that names no ``doc_type``; HQ's undo heals it. An id
    HQ never held answers 404 to all three. A linked app serves ``LinkedApplication``, refuses the update and
    answers ``current_app_version``."""
    import json

    export = documents["navigation-base"].exports["minimum"]
    with hq_check(export.configuration.hq()) as (state, _), _api(state):
        member = operations.seed_api_user(state, MEMBER)
        from proof.observe import publish

        app_id, refusal, _ = publish.create(state, export)
        assert refusal is None, refusal
        content = operations.with_app_id(export.content.upload(), app_id)
        body = _app_file(content)
        untyped = nova_shaped_upload({k: v for k, v in body.items() if k != "doc_type"}, body["name"], app_id=app_id)

        def doc_type(answer):
            assert answer.status == 200, answer.retained()
            return json.loads(answer.body)["doc_type"]

        assert doc_type(operations.source_read(state, app_id, member)) == "Application"
        assert operations.current_version_read(state, app_id, member).status == 200
        with state.fork():
            operations.delete_app_through_view(state, app_id)
            assert doc_type(operations.source_read(state, app_id, member)) == "Application-Deleted"
            refused = operations.import_request(state, content, member)
            assert (refused.status, json.loads(refused.body)) == (
                400,
                {
                    "success": False,
                    "error": "Uploaded app type 'Application' does not match existing app type 'Application-Deleted'",
                },
            )
            assert operations.current_version_read(state, app_id, member).status == 404
            with state.fork():
                # A body that names no doc_type writes into the deleted app, which is why every body Nova sends
                # names one.
                assert operations.import_request(state, untyped, member).status == 200
                assert doc_type(operations.source_read(state, app_id, member)) == "Application-Deleted"
            operations.undo_delete_app_through_view(state, app_id)
            assert doc_type(operations.source_read(state, app_id, member)) == "Application"
            assert operations.import_request(state, content, member).status == 200
            assert operations.current_version_read(state, app_id, member).status == 200
        missing = operations.with_app_id(export.content.upload(), MISSING_APP)
        assert operations.source_read(state, MISSING_APP, member).retained() == {"status": 404}
        answered = operations.import_request(state, missing, member)
        assert (answered.status, json.loads(answered.body)) == (
            404,
            {"success": False, "error": "Application not found"},
        )
        assert operations.current_version_read(state, MISSING_APP, member).status == 404
        with state.fork():
            operations.link_app_through_hq(state, app_id)
            assert doc_type(operations.source_read(state, app_id, member)) == "LinkedApplication"
            assert operations.import_request(state, content, member).status == 400
            assert operations.current_version_read(state, app_id, member).status == 200


class _HeldClock:
    """A stand-in for the ``time`` module HQ's rate counters read: ``time()`` answers ``now``, which moves only
    when the test moves it."""

    def __init__(self, now):
        self.now = now

    def time(self):
        return self.now


def test_hq_answers_429_before_an_import_runs(hq, core_runner, documents):
    """HQ's API limiter, at the floor of a project space with no mobile worker
    (``corehq/project_limits/rate_limiter.py::get_n_users_in_domain``), refuses a second import within one second
    with a decimal ``Retry-After``, before the import runs, so the app's version does not move; the same import
    after that wait is taken; and the source read is not counted. HQ's counters read their windows from
    ``time.time`` in ``rate_counter.py``, which the test holds still and moves on by the wait itself, so an import
    that takes longer than a window on a busy machine cannot carry the second request into a later one."""
    from unittest import mock

    from corehq.project_limits.rate_counter import rate_counter as hq_rate_counter

    from proof.hq import redis as hq_redis
    from proof.hq.seams import RedisCounters, rate_counters

    export = documents["navigation-base"].exports["minimum"]
    with hq_check(export.configuration.hq()) as (state, _), hq_redis.shared(None), state.committing():
        member = operations.seed_api_user(state, MEMBER)
        from proof.observe import publish

        app_id, refusal, _ = publish.create(state, export)
        assert refusal is None, refusal
        update = operations.with_app_id(export.content.upload(), app_id)
        clock = _HeldClock(1_000_000.25)
        with rate_counters(RedisCounters()) as counters, mock.patch.object(hq_rate_counter, "time", clock):
            for _ in range(3):
                assert operations.source_read(state, app_id, member).status == 200
            assert counters.counts == {}
            first = operations.import_request(state, update, member)
            version = operations.held_app(state, app_id).version
            second = operations.import_request(state, update, member)
            assert (first.status, second.status) == (200, 429)
            wait = float(second.headers["Retry-After"])
            assert 0 < wait <= 1
            assert operations.held_app(state, app_id).version == version
            clock.now += wait + 0.001
            assert operations.import_request(state, update, member).status == 200
            assert operations.held_app(state, app_id).version == version + 1


def test_an_update_writes_no_excluded_field(hq, core_runner, documents):
    """An update carrying the fields HQ's update excludes (``Application._update_excluded_fields`` and
    ``build_spec``) leaves each as HQ held it, and takes the app's name from the request's ``app_name``."""
    export = documents["navigation-base"].exports["minimum"]
    with hq_check(export.configuration.hq()) as (state, _):
        from proof.observe import publish

        app_id, refusal, _ = publish.create(state, export)
        assert refusal is None, refusal
        before = operations.held_app(state, app_id).to_json()
        body = _app_file(export.content.upload())
        carried = {
            **body,
            "build_profiles": {"nova-proof-profile": {"name": "Carried", "langs": ["en"]}},
            "custom_base_url": "https://example.org",
            "practice_mobile_worker_id": "nova-proof-practice-worker",
            "multimedia_map": {"jr://file/commcare/image/carried.png": {"media_type": "CommCareImage"}},
            "name": "A name the body carries",
            "build_spec": {"doc_type": "BuildSpec", "version": "2.0.0", "build_number": None, "latest": True},
        }
        updated = operations.apply_upload(state, nova_shaped_upload(carried, before["name"], app_id=app_id))
        assert updated.status == 200, updated.response
        after = operations.held_app(state, app_id).to_json()
        for key in ("build_profiles", "custom_base_url", "practice_mobile_worker_id", "multimedia_map", "name"):
            assert after.get(key) == before.get(key), key
        assert (
            after["build_spec"]["version"] == before["build_spec"]["version"] == export.configuration.commcare_version
        )


def test_an_update_carrying_case_sharing_and_web_apps_writes_both(hq, core_runner, documents):
    """``case_sharing`` and ``cloudcare_enabled`` are app content: neither is among the fields HQ's update excludes
    (``Application._update_excluded_fields``), so an update that carries the opposite of each stored value writes
    both, as ``lib/commcare/hqShells.ts::applicationShell`` and ``lib/commcare/types.ts::HqApplication`` state.
    Nova sends neither yet."""
    export = documents["navigation-base"].exports["minimum"]
    with hq_check(export.configuration.hq()) as (state, _):
        from proof.observe import publish

        app_id, refusal, _ = publish.create(state, export)
        assert refusal is None, refusal
        before = operations.held_app(state, app_id)
        body = _app_file(export.content.upload())
        assert "case_sharing" not in body and "cloudcare_enabled" not in body
        flipped = {
            **body,
            "case_sharing": not before.case_sharing,
            "cloudcare_enabled": not before.cloudcare_enabled,
        }
        updated = operations.apply_upload(state, nova_shaped_upload(flipped, before.name, app_id=app_id))
        assert updated.status == 200, updated.response
        after = operations.held_app(state, app_id)
    assert after.case_sharing is (not before.case_sharing)
    assert after.cloudcare_enabled is (not before.cloudcare_enabled)


# No multimedia_map (part 01, A4): the media upload alone maps an app's media ----------------------------------

MEDIA_DOCUMENT = "case-list-inline"
CAUTIOUS_MULTIMEDIA = "CAUTIOUS_MULTIMEDIA"
MISSING_MEDIA_WARNING = "missing multimedia file(s)"


def _zip_entries(media_upload):
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(operations.upload_field(media_upload, "bulk_upload_file"))) as archive:
        return sorted(name for name in archive.namelist() if not name.endswith("/"))


def _with_nova_map(body, media_upload):
    """The app file with the map Nova sent before step 2 (``bundle.ts::buildMultimediaMap``): each path the
    media upload carries, mapped to Nova's content hash as its media id, an id no HQ media document holds."""
    from pathlib import PurePosixPath

    return {
        **body,
        "multimedia_map": {
            f"jr://file/{entry}": {
                "doc_type": "HQMediaMapItem",
                "multimedia_id": PurePosixPath(entry).stem,
                "media_type": "CommCareImage",
            }
            for entry in _zip_entries(media_upload)
        },
    }


def _first_publish(state, export):
    """Nova's first publish: the shell's create, then the content with A's id. Returns A's id and HQ's answer to
    the content."""
    app_id, _ = operations.publish(state, [export.create.upload()])
    filled = operations.apply_upload(state, operations.with_app_id(export.content.upload(), app_id))
    assert filled.status == 200, filled.response
    return app_id, filled


def test_cautious_multimedia_warns_only_for_a_map_hq_cannot_resolve(hq, core_runner, documents):
    """Under ``CAUTIOUS_MULTIMEDIA`` an import with no map draws no warning and the media upload after it maps
    every file; an import carrying Nova's former content-hash map draws "missing multimedia file(s)"
    (``models/applications.py::_update_valid_domains_for_media`` reaching ``get_media_objects``). An update
    discards the map an import carries (``_update_excluded_fields``), so the map reaches HQ on a create, as every
    first publish before step 2 sent it."""
    export = documents[MEDIA_DOCUMENT].exports["minimum"]
    assert export.content.media is not None and "multimedia_map" not in _app_file(export.content.upload())
    configuration = export.configuration.hq()
    cautious = dataclasses.replace(configuration, flags=configuration.flags | {CAUTIOUS_MULTIMEDIA})
    mapped = _with_nova_map(_app_file(export.content.upload()), export.content.media.upload())
    with hq_check(cautious) as (state, _):
        with state.fork():
            app_id, filled = _first_publish(state, export)
            assert "warnings" not in filled.response, filled.response
            media = operations.apply_media_upload(state, app_id, export.content.media.upload())
            assert media.processing["errors"] == [] and media.processing["unmatched_files"] == []
            matched = {info["path"] for infos in media.processing["matched_files"].values() for info in infos}
            assert matched == {f"jr://file/{entry}" for entry in _zip_entries(export.content.media.upload())}
        with state.fork():
            _, (warned,) = operations.publish(state, [nova_shaped_upload(mapped, mapped["name"])])
            assert warned.status == 201
            assert any(MISSING_MEDIA_WARNING in warning for warning in warned.response.get("warnings", []))


@pytest.fixture(scope="module")
def builds_before_media(hq, core_runner, documents):
    """HQ's builds of ``case-list-inline`` made between the import and the media upload, each arranged as HQ's
    archive download arranges it with its media (``proof.observe.build.device_archive``): from step 2's first
    publish, which carries no map, and, the paired case, from a create carrying Nova's former map (the first
    publish before step 2); and the first's media suite again after the upload."""
    from proof.hq.seams import build_seams
    from proof.observe.build import admit_build, build_state, device_archive

    export = documents[MEDIA_DOCUMENT].exports["minimum"]
    mapped = _with_nova_map(_app_file(export.content.upload()), export.content.media.upload())
    made = {}
    with hq_check(export.configuration.hq()) as (state, record):
        for side in ("without", "with-map"):
            with state.fork():
                if side == "without":
                    app_id, _ = _first_publish(state, export)
                else:
                    app_id, _ = operations.publish(state, [nova_shaped_upload(mapped, mapped["name"])])
                app = operations.held_app(state, app_id)
                with build_seams():
                    outcome, _ = build_state(app, record, side)
                admit_build(core_runner, app, outcome)
                made[side] = {
                    "errors": outcome.errors,
                    "mediaSuite": outcome.files["media_suite.xml"],
                    "admission": outcome.admission,
                    "archive": device_archive(outcome, app),
                    "mapped": dict(app.multimedia_map),
                }
                if side == "without":
                    operations.apply_media_upload(state, app_id, export.content.media.upload())
                    uploaded = operations.held_app(state, app_id)
                    with build_seams():
                        after, _ = build_state(uploaded, record, "after-upload")
                    made["after"] = {
                        "mediaSuite": after.files["media_suite.xml"],
                        "ids": sorted(item.multimedia_id for item in uploaded.multimedia_map.values()),
                    }
    return made


def _resources(media_suite):
    from lxml import etree

    root = etree.fromstring(media_suite if isinstance(media_suite, bytes) else media_suite.encode())
    return [element for element in root.iter(etree.Element) if etree.QName(element).localname == "resource"]


def _locations(media_suite):
    from lxml import etree

    return [
        location.text
        for resource in _resources(media_suite)
        for location in resource.iter(etree.Element)
        if etree.QName(location).localname == "location" and location.get("authority") == "remote"
    ]


def test_a_build_before_the_media_upload_names_no_media(builds_before_media):
    """A build HQ makes before the media upload names no medium, validates clean and is admitted by Core; after
    the upload its media suite names the medium HQ stored. The paired case, an import carrying Nova's former map,
    names a medium HQ does not hold."""
    without, mapped, after = (builds_before_media[side] for side in ("without", "with-map", "after"))
    assert without["mapped"] == {} and _resources(without["mediaSuite"]) == []
    assert without["errors"] == [] and without["admission"]["admitted"] is True
    assert after["ids"] and _resources(after["mediaSuite"])
    assert all(any(media_id in location for media_id in after["ids"]) for location in _locations(after["mediaSuite"]))
    assert mapped["mapped"] and _resources(mapped["mediaSuite"])
    hashes = {item["multimedia_id"] for item in mapped["mapped"].values()}
    assert all(any(media_id in location for media_id in hashes) for location in _locations(mapped["mediaSuite"]))


@pytest.mark.reader("android")
def test_a_build_made_before_its_media_installs_on_android(builds_before_media, tmp_path):
    """Android installs the archive of the build made before the media upload, and refuses the same build made
    from an import carrying Nova's former map, whose media it cannot fetch."""
    import zipfile

    from proof.observe import services

    reader = services.android()
    installs = {}
    for side in ("without", "with-map"):
        archive = tmp_path / f"{side}.ccz"
        with zipfile.ZipFile(archive, "w") as written:
            for name, content in builds_before_media[side]["archive"]["entries"]:
                written.writestr(name, content)
        installs[side] = reader.request("profile", archive=str(archive))["install"]
    assert installs == {"without": "Installed", "with-map": "MissingResourcesWithMessage"}


# A .ccz made for one project space (part 01, A5) ------------------------------------------------------------

ARCHIVE_DOCUMENT = "case-list-inline"
WORKER_PASSWORD = "proof-worker-password"
# The four profile properties a local archive names its server, project space and app by.
SERVER_PROPERTIES = ("ota-restore-url", "PostURL", "key_server", "cc_user_domain")


def _profile_properties(profile):
    from lxml import etree

    root = etree.fromstring(profile if isinstance(profile, bytes) else profile.encode())
    return {
        element.get("key"): element.get("value")
        for element in root.iter(etree.Element)
        if etree.QName(element).localname == "property"
    }


def _archive_member(archive, name):
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(archive)) as held:
        return held.read(name)


def _suite_urls(suite):
    """Each search and case fixture URL the suite names (a ``<query>``'s ``url`` or ``value``)."""
    from lxml import etree

    root = etree.fromstring(suite)
    return [
        value
        for element in root.iter(etree.Element)
        if etree.QName(element).localname == "query"
        for value in (element.get("url"), element.get("value"))
        if value and value.startswith("http")
    ]


def _view_of(url):
    from urllib.parse import urlsplit

    from django.urls import resolve

    return resolve(urlsplit(url).path).url_name


def _related_column(body):
    """The app file with a column over the parent case's name added to its searching menu's case list, as an
    update that adds a related-case column sends it."""
    import copy

    edited = copy.deepcopy(body)
    module = edited["modules"][0]
    column = copy.deepcopy(next(c for c in module["case_details"]["short"]["columns"] if c["field"] == "case_name"))
    column.update({"field": "parent/name", "useXpathExpression": False})
    module["case_details"]["short"]["columns"].append(column)
    return edited


def test_a_working_app_serves_what_a_ccz_names(hq, core_runner, documents):
    """A local archive names the working app, which has no build: HQ's URLconf resolves the profile's three
    URLs and the suite's search and case fixture URLs to their views; ``get_app_cached`` and
    ``get_app_context_by_case_type`` answer for the working app's id and raise ``Http404`` for the placeholder a
    pre-fix archive named; ``get_app_and_build_ids`` gives the app with no build; an update that adds a
    related-case column is in the context at once; and the four profile strings the archive holds (with A's id
    written in, ``operations.with_runtime_app_id``) are the strings HQ's own ``create_all_files()`` writes."""
    from corehq.apps.app_manager.dbaccessors import get_app_cached
    from corehq.apps.case_search.utils import get_app_context_by_case_type
    from corehq.apps.receiverwrapper.util import get_app_and_build_ids
    from django.http import Http404

    from proof.hq.seams import build_seams
    from proof.observe.build import build_state

    document = documents[ARCHIVE_DOCUMENT]
    export = document.exports["minimum"]
    body = _app_file(export.content.upload())
    case_type = body["modules"][0]["case_type"]
    with hq_check(export.configuration.hq()) as (state, record):
        app_id, _ = _first_publish(state, export)
        archive = operations.with_runtime_app_id(document.local_ccz.read_bytes(), app_id)
        properties = _profile_properties(_archive_member(archive, "profile.ccpr"))
        assert {key: _view_of(properties[key]) for key in ("ota-restore-url", "PostURL", "key_server")} == {
            "ota-restore-url": "app_aware_restore",
            "PostURL": "receiver_post_with_app_id",
            "key_server": "key_server_url",
        }
        urls = _suite_urls(_archive_member(archive, "suite.xml"))
        assert urls and {_view_of(url) for url in urls} <= {"app_aware_remote_search", "case_fixture"}
        assert all(f"/{app_id}/" in url for url in urls)
        assert get_app_cached(state.domain, app_id).get_id == app_id
        for read in (get_app_cached, get_app_context_by_case_type):
            with pytest.raises(Http404):
                read(state.domain, "__APP_ID__")
        assert get_app_and_build_ids(state.domain, app_id) == (app_id, None)
        paths, _ = get_app_context_by_case_type(state.domain, app_id)
        assert "parent" not in paths.get(case_type, set())
        with build_seams():
            built, _ = build_state(operations.held_app(state, app_id), record, "A")
        held = _profile_properties(built.files["profile.ccpr"])
        assert {key: properties[key] for key in SERVER_PROPERTIES} == {key: held[key] for key in SERVER_PROPERTIES}
        with state.fork():
            edited = _related_column(body)
            updated = operations.apply_upload(state, nova_shaped_upload(edited, edited["name"], app_id=app_id))
            assert updated.status == 200, updated.response
            paths, _ = get_app_context_by_case_type(state.domain, app_id)
            assert "parent" in paths.get(case_type, set())


def _ask(state, request, label):
    """HQ's answer to a device's request, from its own handler and middleware (``proof.views.conftest.ask``)."""
    import hashlib

    from proof.formplayer import hq as formplayer_hq

    digest = hashlib.sha256(f"publish|{label}".encode()).digest()
    with state.request(digest), formplayer_hq._language_put_back():
        response = formplayer_hq.respond(formplayer_hq.django_request(request))
        content = b"".join(response.streaming_content) if response.streaming else response.content
    return response.status_code, content


def _submission(xmlns, case_type, case_id, instance_id, user_id, username):
    """A form of the document as a device sends it: the form's data node, a case block creating a case the worker
    owns, and the meta block."""
    from xml.sax.saxutils import escape, quoteattr

    return (
        f"<?xml version='1.0' ?><data xmlns={quoteattr(xmlns)}>"
        "<n0:case xmlns:n0='http://commcarehq.org/case/transaction/v2'"
        f" case_id={quoteattr(case_id)} date_modified='2026-10-01T10:00:00Z' user_id={quoteattr(user_id)}>"
        f"<n0:create><n0:case_name>Ahead</n0:case_name><n0:owner_id>{escape(user_id)}</n0:owner_id>"
        f"<n0:case_type>{escape(case_type)}</n0:case_type></n0:create></n0:case>"
        "<n1:meta xmlns:n1='http://openrosa.org/jr/xforms'>"
        "<n1:deviceID>proof-device</n1:deviceID><n1:timeStart>2026-10-01T10:00:00Z</n1:timeStart>"
        f"<n1:timeEnd>2026-10-01T10:00:01Z</n1:timeEnd><n1:username>{escape(username)}</n1:username>"
        f"<n1:userID>{escape(user_id)}</n1:userID><n1:instanceID>{escape(instance_id)}</n1:instanceID>"
        "</n1:meta></data>"
    ).encode()


def test_hq_answers_an_archive_ahead_of_its_app_from_what_it_holds(hq, core_runner, documents):
    """HQ holds the shell of the document's first publish and nothing more (the capture's create without its
    content), an app that holds none of the archive's menus, forms or searches. Under that app's id, for a worker
    who owns one case of the document's case type: HQ's receiver takes a form of the document, whose ``xmlns`` no
    form of the app holds, records it under the app's id with no build, and applies its case block, so the worker
    owns the case (``receiverwrapper/util.py::get_app_and_build_ids`` reads the app's id and nothing of its
    forms); HQ's restore answers 200 and carries the case (``ota/views.py::get_restore_response`` reads no menu,
    list or form); and ``get_app_context_by_case_type`` holds no relationship path and no child case type for the
    case type, so a search from the archive gets no related case from HQ."""
    import base64
    import uuid

    from corehq.apps.case_search.utils import get_app_context_by_case_type
    from corehq.apps.users.models import CommCareUser
    from corehq.form_processor.models import CommCareCase, XFormInstance

    from proof.connect import hq as connect_hq
    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer.client import HqRequest
    from proof.hq import redis as hq_redis

    export = documents[ARCHIVE_DOCUMENT].exports["minimum"]
    body = _app_file(export.content.upload())
    xmlns = body["modules"][0]["forms"][0]["xmlns"]
    case_type = body["modules"][0]["case_type"]
    case_id, instance_id = str(uuid.UUID(int=31)), str(uuid.UUID(int=32))
    with hq_check(export.configuration.hq()) as (state, _), hq_redis.shared(None), state.committing():
        app_id, _ = operations.publish(state, [export.create.upload()])
        assert operations.held_app(state, app_id).modules == []
        formplayer_hq.default_roles(state)
        username = f"proof-worker@{state.domain}.commcarehq.org"
        worker = CommCareUser.create(state.domain, username, WORKER_PASSWORD, created_by=None, created_via=None)
        submission = _submission(xmlns, case_type, case_id, instance_id, worker.user_id, username)
        path = connect_hq.receiver_url(state.domain, app_id)
        status, _ = _ask(state, connect_hq.device_request(path, username, WORKER_PASSWORD, submission), "receive")
        assert status == 201
        form = XFormInstance.objects.get_form(instance_id, state.domain)
        assert (form.app_id, form.build_id, form.xmlns) == (app_id, None, xmlns)
        case = CommCareCase.objects.get_case(case_id, state.domain)
        assert (case.type, case.owner_id) == (case_type, worker.user_id)
        credentials = base64.b64encode(f"{username}:{WORKER_PASSWORD}".encode()).decode()
        restore = HqRequest(
            "GET",
            f"/a/{state.domain}/phone/restore/{app_id}/",
            "version=2.0&device_id=proof-device",
            (("Authorization", f"Basic {credentials}"),),
            b"",
        )
        status, restored = _ask(state, restore, "restore")
        assert status == 200 and case_id.encode() in restored
        paths, child_case_types = get_app_context_by_case_type(state.domain, app_id)
        assert not paths.get(case_type) and not child_case_types.get(case_type)


# Derived ids (part 01, A1): what HQ does with the ids a publish sends -----------------------------------------

ID_DOCUMENT = "navigation-base"


def _renamed_menu(body, name):
    import copy

    edited = copy.deepcopy(body)
    edited["modules"][0]["name"] = {lang: name for lang in edited["modules"][0]["name"]}
    return edited


def _with_form_id(body, old, new):
    """The app file with the form id ``old`` written as ``new`` wherever the file writes it (an opaque id, so a
    replacement over the serialized file is the id's every occurrence)."""
    import json

    return json.loads(json.dumps(body).replace(old, new))


def _released(state, app_id):
    """HQ's build of the app, made by its own ``make_build`` and released as its Releases page releases one
    (``proof.webapps.hq``). The task that prunes old automatic builds is not started."""
    from proof.hq.seams import build_seams
    from proof.webapps import hq as webapps_hq

    with build_seams():
        build = webapps_hq._make_build(state, operations.held_app(state, app_id))
    webapps_hq._release(state, app_id, build._id)
    return build._id


def test_two_apps_of_one_project_space_may_hold_the_same_form_ids(hq, core_runner, documents):
    """A form id is not unique in a project space: each of HQ's readers of one names the app too. Two apps
    holding the same form ids (``navigation-base`` published twice, one with a menu renamed): each app's
    ``get_form`` returns its own form, and ``MessagingEvent.get_form_name_or_none`` names each app's own menu."""
    from corehq.apps.sms.models import MessagingEvent

    export = documents[ID_DOCUMENT].exports["minimum"]
    body = _app_file(export.content.upload())
    form_id = body["modules"][0]["forms"][0]["unique_id"]
    with hq_check(export.configuration.hq()) as (state, _):
        first, _ = _first_publish(state, export)
        second, _ = operations.publish(state, [export.create.upload()])
        renamed = _renamed_menu(body, "Renamed visits")
        assert operations.apply_upload(state, nova_shaped_upload(renamed, renamed["name"], app_id=second)).status == 200
        for app_id in (first, second):
            app = operations.held_app(state, app_id)
            assert app.get_form(form_id).get_app().get_id == app_id
            assert app.get_form(form_id).get_module().unique_id == body["modules"][0]["unique_id"]
        names = [MessagingEvent.get_form_name_or_none(state.domain, app_id, form_id) for app_id in (first, second)]
        assert "Renamed visits" not in names[0] and "Renamed visits" in names[1], names


def test_a_form_id_a_republish_keeps_still_resolves_after_a_release(hq, core_runner, documents):
    """A keyword or a scheduled message names a form by its id and resolves it in the app's newest released
    build. After an update that keeps the id and a new release, the keyword's ``get_app_module_form`` resolves the
    form in the new build. The paired refusal: after an update that changes the id (written by hand into the
    update), both the keyword's and a scheduled message's ``get_memoized_app_module_form`` resolve the old id until
    the new build is released, and nothing after."""
    from corehq.apps.sms.handlers.keyword import get_app_module_form
    from corehq.apps.sms.messages import MSG_FORM_NOT_FOUND
    from corehq.messaging.scheduling.models import SMSSurveyContent

    export = documents[ID_DOCUMENT].exports["minimum"]
    body = _app_file(export.content.upload())
    form_id = body["modules"][0]["forms"][0]["unique_id"]
    changed = "0123456789abcdef0123456789abcdef"
    with hq_check(export.configuration.hq()) as (state, _):
        app_id, _ = _first_publish(state, export)
        first = _released(state, app_id)

        def keyword(form):
            app, _, found, error, code = get_app_module_form(state.domain, app_id, form)
            return (app.get_id, found.unique_id) if not error else code

        def scheduled(form):
            app, _, found, _ = SMSSurveyContent(app_id=app_id, form_unique_id=form).get_memoized_app_module_form(
                state.domain
            )
            return None if found is None else (app.get_id, found.unique_id)

        assert keyword(form_id) == (first, form_id)
        with state.fork():
            assert operations.apply_upload(state, operations.with_app_id(export.content.upload(), app_id)).status == 200
            kept = _released(state, app_id)
            assert keyword(form_id) == (kept, form_id)
        with state.fork():
            edited = _with_form_id(body, form_id, changed)
            assert (
                operations.apply_upload(state, nova_shaped_upload(edited, edited["name"], app_id=app_id)).status == 200
            )
            assert keyword(form_id) == (first, form_id) and scheduled(form_id) == (first, form_id)
            assert keyword(changed) == MSG_FORM_NOT_FOUND and scheduled(changed) is None
            released = _released(state, app_id)
            assert keyword(changed) == (released, changed) and scheduled(changed) == (released, changed)
            assert keyword(form_id) == MSG_FORM_NOT_FOUND and scheduled(form_id) is None


def _refused_by_core(xml):
    """The form with a calculation Core's parser refuses, written into its first bind as XML."""
    from lxml import etree

    root = etree.fromstring(xml.encode() if isinstance(xml, str) else xml)
    bind = next(element for element in root.iter(etree.Element) if etree.QName(element).localname == "bind")
    bind.set("calculate", "1 +")
    return etree.tostring(root, encoding="unicode")


def _validation_errors(app):
    return [error for error in app.validate_app() if error.get("type") == "validation error"]


def test_an_update_keeps_a_forms_validation_verdict_for_seven_days(hq, core_runner, documents):
    """HQ keeps each form's last validation verdict for 7 days under a key of the app's id and the form's id
    (``models/forms.py::FormBase.validation_cache``), clears it only when the form's source is set in HQ
    (``FormSource.__set__``), and an import clears nothing. So with a form id an update keeps, HQ's check of the
    unbuilt app answers from the kept verdict: a broken form an update writes passes, a form saved broken in HQ
    keeps failing after an update writes it valid again, six days later too, and is checked afresh seven days
    after the verdict was kept."""
    import datetime as dt

    import time_machine

    export = documents[ID_DOCUMENT].exports["minimum"]
    body = _app_file(export.content.upload())
    form_id = body["modules"][0]["forms"][0]["unique_id"]
    valid = body["_attachments"][f"{form_id}.xml"]
    broken = {**body, "_attachments": {**body["_attachments"], f"{form_id}.xml": _refused_by_core(valid)}}
    with hq_check(export.configuration.hq()) as (state, _):
        app_id, _ = _first_publish(state, export)
        update = operations.with_app_id(export.content.upload(), app_id)
        assert _validation_errors(operations.held_app(state, app_id)) == []
        assert operations.apply_upload(state, nova_shaped_upload(broken, broken["name"], app_id=app_id)).status == 200
        assert _validation_errors(operations.held_app(state, app_id)) == []
        app = operations.held_app(state, app_id)
        app.get_form(form_id).source = _refused_by_core(valid)
        app.save()
        kept_at = dt.datetime.now(dt.UTC)
        assert _validation_errors(operations.held_app(state, app_id))
        assert operations.apply_upload(state, update).status == 200
        assert _validation_errors(operations.held_app(state, app_id))
        with time_machine.travel(kept_at + dt.timedelta(days=6), tick=False):
            assert _validation_errors(operations.held_app(state, app_id))
        with time_machine.travel(kept_at + dt.timedelta(days=7, seconds=1), tick=False):
            assert _validation_errors(operations.held_app(state, app_id)) == []


def test_a_capture_is_applied_only_over_the_lookup_tables_it_read(hq, core_runner, documents):
    """A captured update names the lookup tables its publish read before it decided what to send
    (``assumedResources``), and the HQ side holds them to HQ's own table and row resources first
    (``operations.hold_assumed_resources``). ``lookup-app``'s republish read the regions table as Nova's own push
    left it: over that push the hold holds, and once a person keeps the table in HQ with a field property, an
    attribute and owners (``targeted-hq-side-lookup``'s save, made on regions through HQ's own upload and table
    editor), HQ holds another definition and the hold refuses naming the table. (``targeted-hq-side-lookup``'s own
    republish stops before it sends anything, so it captures no update to hold.)"""
    from proof.hq import redis as hq_redis
    from proof.observe import hqside, publish

    document = documents["lookup-app"]
    export = document.exports["minimum"]
    assumed = export.republish.meta["assumedResources"]
    assert [table["tag"] for table in assumed["lookupTables"]] == ["regions"]
    kept = documents["targeted-hq-side-lookup"].hq_side["lookupTable"]
    kept = {
        **kept,
        "tag": "regions",
        "fieldProperty": {**kept["fieldProperty"], "field": "label"},
        "rowAttribute": {**kept["rowAttribute"], "values": ["upland", "coastal", "upland"]},
    }
    with hq_check(export.configuration.hq()) as (state, _), hq_redis.shared(None), state.committing():
        app_id, refusal, lookups = publish.create(state, export)
        assert refusal is None and lookups["errors"] == [], (refusal, lookups)
        operations.hold_assumed_resources(state, assumed, "captured republish")
        hqside.lookup_table(state, kept)
        with pytest.raises(operations.CapturedResourcesNotHeld, match="the definition of regions"):
            operations.hold_assumed_resources(state, assumed, "captured republish")


def _unbuilt_download(state, app_id):
    """HQ's download of the unbuilt app (``views/cli.py::direct_ccz`` with ``latest=save``), the reference
    Formplayer installs an app by its id from (``util/SessionUtils.java::getReferenceToLatest``): its status, and
    for a refusal the text of its body."""
    from django.urls import resolve, reverse

    from proof.hq import requests as hq_requests

    path = reverse("direct_ccz", args=[state.domain])
    match = resolve(path)
    response = match.func(
        hq_requests.get(state, path, {"app_id": app_id, "latest": "save"}), *match.args, **match.kwargs
    )
    return response.status_code, "" if response.streaming else response.content.decode("utf-8", "replace")


def _new_version(state, app_id):
    """Whether HQ's ``make_build`` builds a new version of the app (validating a copy under a new id)."""
    from proof.hq.seams import build_seams
    from proof.webapps import hq as webapps_hq

    try:
        with build_seams():
            webapps_hq._make_build(state, operations.held_app(state, app_id))
    except webapps_hq.ReleaseRefused:
        return "refused"
    return "built"


def test_a_cached_form_verdict_outlives_an_import_and_a_new_version_checks_afresh(hq, core_runner, documents):
    """The 7-day App Preview statement (part 02, Work item B): over ``navigation-base``, one state after another,
    the form's own check (``FormBase.validate_form`` through ``validate_app``), HQ's download of the unbuilt app
    (``views/cli.py::direct_ccz``, ``latest=save``) and a new version (``ApplicationBase.make_build``):

    - Nova's publish: the check passes, the download answers the archive, a version builds;
    - one form's source replaced with a broken one through the path the form builder's save writes it
      (``models/forms.py::FormSource.__set__``), then checked: the check fails, the download answers 400 with
      "Cannot make new version", a version is refused;
    - Nova's publish over it, the form Nova's again: the check still fails with the old error and the download
      still answers 400, but a version builds, since ``make_build`` validates a copy under a new id;
    - that form's source set once more through the form builder's save path, nothing changed: the cached verdict
      is gone, and all three pass.

    So what the stale verdict reaches is the unbuilt app, never a build a worker installs, and only a save
    through the form's own editor path clears it (``proof/editors/test_vellum.py`` makes that save in Vellum)."""
    from proof.hq import redis as hq_redis

    export = documents[ID_DOCUMENT].exports["minimum"]
    body = _app_file(export.content.upload())
    form_id = body["modules"][0]["forms"][0]["unique_id"]
    seen = {}
    with hq_check(export.configuration.hq()) as (state, _), hq_redis.shared(None), state.committing():
        app_id, _ = _first_publish(state, export)

        def observe(name):
            seen[name] = (
                bool(_validation_errors(operations.held_app(state, app_id))),
                *_unbuilt_download(state, app_id),
                _new_version(state, app_id),
            )

        observe("published")
        app = operations.held_app(state, app_id)
        valid = app.get_form(form_id).source
        app.get_form(form_id).source = _refused_by_core(valid)
        app.save()
        observe("broken in HQ")
        assert operations.apply_upload(state, operations.with_app_id(export.content.upload(), app_id)).status == 200
        assert operations.held_app(state, app_id).get_form(form_id).source == valid
        observe("published over it")
        app = operations.held_app(state, app_id)
        app.get_form(form_id).source = app.get_form(form_id).source
        app.save()
        observe("saved in the form builder")

    failing, status, text, version = seen["published"]
    assert (failing, status, version) == (False, 200, "built"), seen["published"]
    for name in ("broken in HQ", "published over it"):
        failing, status, text, _ = seen[name]
        assert failing and status == 400 and "Cannot make new version" in text, (name, seen[name][:2])
    assert seen["broken in HQ"][3] == "refused" and seen["published over it"][3] == "built"
    failing, status, _, version = seen["saved in the form builder"]
    assert (failing, status, version) == (False, 200, "built"), seen["saved in the form builder"]


def test_hq_mints_the_id_shapes_nova_derives(hq, core_runner, documents):
    """A menu and a form HQ's own views make (``views/modules.py::new_module``, ``views/forms.py::new_form``) hold
    the id shapes ``lib/commcare/wireIdentity.ts`` derives: 32 lower case hex for a menu or form id, and
    ``http://openrosa.org/formdesigner/`` with an upper case hyphenated UUID for an ``xmlns``."""
    import re

    export = documents[ID_DOCUMENT].exports["minimum"]
    with hq_check(export.configuration.hq()) as (state, _):
        app_id, _ = _first_publish(state, export)
        before = len(operations.held_app(state, app_id).modules)
        operations.session_post(state, "new_module", app_id, pairs=[("module_type", "survey"), ("name", "Made")])
        module = operations.held_app(state, app_id).modules[before]
        operations.session_post(state, "new_form", app_id, module.unique_id, pairs=[("form_type", "form")])
        made = operations.held_app(state, app_id).modules[before]
    hex32 = re.compile(r"[0-9a-f]{32}")
    xmlns = re.compile(
        r"http://openrosa\.org/formdesigner/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}"
    )
    assert hex32.fullmatch(made.unique_id)
    assert made.get_forms() and all(hex32.fullmatch(form.unique_id) for form in made.get_forms())
    assert all(xmlns.fullmatch(form.xmlns) for form in made.get_forms())
