"""A captured publish applies to HQ exactly as Nova's publish would, or not at all.

Contract: ``operations.publish_capture`` applies what Nova's real publish
client sent to its capture peer (``proof/corpus/writePublishCaptures.ts``,
run here as its command line runs) to HQ's import API: the create, then the
update Nova built over the profile it read back, with the id of the app the
create made (A). The update is applied only while HQ serves A with that
profile. And a configuration's case search, with sync on form entry, is
what HQ's own readers (``case_search/models.py``) see.

The plausible failures: an update applied to another app, or over a profile
Nova would not have read (so B is not what Nova's next publish leaves), a
capture whose bodies HQ's view cannot read, and a configuration whose case
search setting never reaches HQ, so a search document runs against a target
Nova's publish refuses.

The media upload Nova's publish sends after its import
(``lib/deployment/service.ts::uploadMediaBytes``) is replayed through HQ's
view (``operations.apply_media_upload``), and must leave the app's
``multimedia_map`` as HQ's own processing of that request's ZIP leaves it
(``hqmedia/tasks.py::process_bulk_upload_zip``, run here directly over the
ZIP read from the captured body by the standard library's MIME parser, as
``proof/native/steps/media_emission.py`` runs it). The plausible failures: a
replay that parses the body otherwise than HQ's view would, reaches no
processing, or maps into another app, so the lane's A keeps Nova's content
hashes, ids no HQ holds after a publish.

The documents are two of Nova's own publish-test apps
(``publishCaptureDocuments.ts``); each capture runs under its minimum
configuration, read from the capture's ``outcome.json``. The capture is
Nova's TypeScript, so it is produced where Nova's ``node_modules`` are
(``proof.native.produce``): read from the products the lane's corpus carries
(CI's shards mount no ``node_modules``), or produced here when it carries
none.
"""

import json

import pytest

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import timed
from proof.native import produce


@pytest.fixture(scope="module")
def captures(tmp_path_factory):
    """What Nova's publish sends for each document, as the capture writer lays it out."""
    root = tmp_path_factory.mktemp("publish-capture")
    log = root / "capture.log"
    products = produce.produced_directory()
    with timed("publish_capture_cli"):
        if products is not None:
            failure = produce.read_product(products, produce.PUBLISH_CAPTURE, root, log)
        else:
            _, failure = produce.produce_publish_captures(root, log)
    output = log.read_text(errors="replace")[-4000:] if log.is_file() else ""
    assert failure is None, f"The publish capture {failure}. Its output ({log}) ends:\n{output}"
    summary = (root / "summary.txt").read_text()
    assert summary.splitlines() == ["clinic-visits: minimum sent", "search-lookup-media: minimum sent"], summary
    return root / "out"


def _upload(directory, name):
    sidecar = json.loads((directory / f"{name}.json").read_text())
    return operations.Upload((directory / sidecar["body"]).read_bytes(), sidecar["contentType"]), sidecar


def _configuration(directory):
    """The configuration the capture ran under, as the harness's configuration."""
    captured = json.loads((directory / "outcome.json").read_text())["configuration"]
    return Configuration(
        flags=frozenset(captured["flags"]),
        case_search_enabled=captured["case_search_enabled"],
        domain=captured["domain"],
    )


def _apps(state):
    from corehq.apps.app_manager.dbaccessors import get_brief_apps_in_domain

    return [(app.name, app.version) for app in get_brief_apps_in_domain(state.domain)]


def test_a_captured_update_is_applied_to_the_app_its_create_made(hq, core_runner, captures):
    directory = captures / "clinic-visits" / "minimum"
    create, _ = _upload(directory, "create.import")
    update, sidecar = _upload(directory, "update-edited.import")
    with hq_check(_configuration(directory)) as (state, _):
        with timed("publish_capture"):
            app_id, created, updated = operations.publish_capture(
                state, create, update, sidecar["assumedSourceProfile"]
            )
        assert created.status == 201
        assert updated.status == 200 and updated.response == {"success": True, "app_id": app_id, "version": 2}
        assert _apps(state) == [("Clinic visits, renamed", 2)]
        assert operations.held_app(state, app_id).name == "Clinic visits, renamed"


def test_a_captured_update_over_a_profile_hq_does_not_hold_is_refused(hq, core_runner, captures):
    directory = captures / "clinic-visits" / "minimum"
    create, _ = _upload(directory, "create.import")
    update, sidecar = _upload(directory, "update-edited.import")
    assumed = sidecar["assumedSourceProfile"]
    other = {**assumed, "properties": {**assumed.get("properties", {}), "cc-proof-not-held": "yes"}}
    with hq_check(_configuration(directory)) as (state, _):
        with pytest.raises(operations.CapturedProfileNotHeld) as refusal:
            operations.publish_capture(state, create, update, other)
        assert json.dumps(other, sort_keys=True) in str(refusal.value)
        assert json.dumps(assumed, sort_keys=True) in str(refusal.value)
        # The create was applied and the update was not.
        assert _apps(state) == [("Clinic visits", 1)]


def test_a_search_capture_runs_where_case_search_is_on(hq, core_runner, captures):
    directory = captures / "search-lookup-media" / "minimum"
    configuration = _configuration(directory)
    assert configuration.case_search_enabled
    lookup, _ = _upload(directory, "create.lookup")
    create, _ = _upload(directory, "create.import")
    update, sidecar = _upload(directory, "update.import")
    with hq_check(configuration) as (state, _):
        from corehq.apps.case_search.models import case_search_enabled_for_domain

        assert case_search_enabled_for_domain(state.domain)
        pushed = operations.upload_lookup_workbook(
            state,
            operations.upload_field(lookup, "file-to-upload"),
            replace=operations.upload_field(lookup, "replace") == b"true",
        )
        assert pushed.errors == []
        app_id, _, updated = operations.publish_capture(state, create, update, sidecar["assumedSourceProfile"])
        assert updated.response == {"success": True, "app_id": app_id, "version": 2}
        assert _apps(state) == [("Patient follow-up", 2)]


def test_hq_reads_case_search_as_the_configuration_sets_it(hq, core_runner):
    """Case search is on only where the configuration turns it on, and sync on form entry with it.

    HQ's own reader of sync on form entry answers False whenever
    ``settings.UNIT_TESTING`` is set, as it is under the harness's boot, so
    it is read here with that setting off: the row HQ's state writes is what
    it would read in a project space. Sync on form entry with case search off
    is refused before any state is made, since HQ never reads it there.
    """
    from corehq.apps.case_search.models import (
        case_search_enabled_for_domain,
        case_search_sync_cases_on_form_entry_enabled_for_domain,
    )
    from django.test import override_settings

    with pytest.raises(ValueError, match="case_search_sync_cases_on_form_entry_enabled_for_domain"):
        Configuration(sync_cases_on_form_entry=True)
    for enabled, sync in ((False, False), (True, False), (True, True)):
        configuration = Configuration(case_search_enabled=enabled, sync_cases_on_form_entry=sync)
        with hq_check(configuration) as (state, _):
            assert case_search_enabled_for_domain(state.domain) is enabled
            case_search_sync_cases_on_form_entry_enabled_for_domain.clear(state.domain)
            with override_settings(UNIT_TESTING=False):
                assert case_search_sync_cases_on_form_entry_enabled_for_domain(state.domain) is sync
            case_search_sync_cases_on_form_entry_enabled_for_domain.clear(state.domain)


def _uploaded_zip(upload):
    """The ZIP a captured media upload carries, read with the standard library's MIME parser."""
    from email.parser import BytesParser
    from email.policy import HTTP

    head = f"Content-Type: {upload.content_type}\r\n\r\n".encode()
    message = BytesParser(policy=HTTP).parsebytes(head + upload.body)
    found = [
        part.get_payload(decode=True)
        for part in message.iter_parts()
        if part.get_param("name", header="content-disposition") == "bulk_upload_file"
    ]
    assert len(found) == 1, "Nova's media upload carries one ZIP"
    return found[0]


def _media_held(state, app_id):
    """The app's multimedia map as HQ holds it, each item with the medium it names; HQ's minted ids are checked
    against their items and left out, since two processings mint their own."""
    from corehq.apps.hqmedia.models import CommCareMultimedia, HQMediaMapItem

    held = {}
    for path, item in operations.held_app(state, app_id).multimedia_map.items():
        media_class = CommCareMultimedia.get_doc_class(item.media_type)
        media = media_class.get(item.multimedia_id)
        held[path] = {
            "mediaType": item.media_type,
            "version": item.version,
            "uniqueIdIsHqs": item.unique_id == HQMediaMapItem.gen_unique_id(item.multimedia_id, path),
            "fileHash": media.file_hash,
            "bytes": media.get_display_file(return_type=False),
            "owners": list(media.owners),
            "validDomains": list(media.valid_domains),
            "heldByHash": media_class.get_by_hash(media.file_hash)._id == media._id,
        }
    return held


def test_a_captured_media_upload_maps_the_media_as_hqs_own_processing_of_its_zip(hq, core_runner, captures, tmp_path):
    directory = captures / "search-lookup-media" / "minimum"
    configuration = _configuration(directory)
    lookup, _ = _upload(directory, "create.lookup")
    create, _ = _upload(directory, "create.import")
    media, sidecar = _upload(directory, "create.media")
    archive = tmp_path / "multimedia.zip"
    archive.write_bytes(_uploaded_zip(media))
    with hq_check(configuration) as (state, _):
        from corehq.apps.hqmedia.cache import BulkMultimediaStatusCache, BulkMultimediaStatusCacheNfs
        from corehq.apps.hqmedia.tasks import process_bulk_upload_zip

        operations.upload_lookup_workbook(state, operations.upload_field(lookup, "file-to-upload"), replace=True)
        app_id, _ = operations.publish(state, [create])
        assert sidecar["path"] != f"/a/{state.domain}/apps/api/{app_id}/multimedia/"  # it names the peer's app
        nova_map = dict(operations.held_app(state, app_id).multimedia_map)
        assert nova_map, "the create maps the image by Nova's content hash"
        with state.fork():
            with timed("media_replay"):
                replayed = operations.apply_media_upload(state, app_id, media)
            lane = _media_held(state, app_id)
            lane_ids = {
                path: item.multimedia_id for path, item in operations.held_app(state, app_id).multimedia_map.items()
            }
        with state.fork():
            status = BulkMultimediaStatusCacheNfs("oracle", str(archive))
            status.save()
            process_bulk_upload_zip.run("oracle", state.domain, app_id, username=state.web_user.username)
            oracle_report = BulkMultimediaStatusCache.get("oracle").get_response()
            oracle = _media_held(state, app_id)

    assert replayed.status == 200 and replayed.processing["errors"] == []
    assert sorted(lane) == sorted(nova_map)
    assert lane == oracle
    for path, held in lane.items():
        assert held["uniqueIdIsHqs"] and held["heldByHash"], path
        assert held["owners"] == [configuration.domain] and held["validDomains"] == [configuration.domain], path
        assert lane_ids[path] != nova_map[path].multimedia_id, path
    assert [info["path"] for infos in replayed.processing["matched_files"].values() for info in infos] == [
        info["path"] for infos in oracle_report["matched_files"].values() for info in infos
    ]
    assert replayed.processing["unmatched_files"] == oracle_report["unmatched_files"]
