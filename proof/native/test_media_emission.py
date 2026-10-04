"""HQ's media resources, and its bulk media upload of Nova's zip, match Nova's archive.

Contract: for each media scenario HQ regenerates the form, suite, strings,
profile and media suite, and its media suite's local resources (path,
version and location) equal the local CCZ's; without media both are empty
and HQ maps nothing. With media, HQ's whole bulk upload task over Nova's
upload zip completes with no error, unmatched or skipped file, classifies
three images, one audio and one video, matches every file in the zip, maps
each to the form path HQ derives from it, stores exactly the uploaded bytes,
and records the project space as each file's owner. Every form HQ sends to
Formplayer while doing so is one Core certified
(``MediaRuntimeTest.sourceFormsParseWithRealCoreBeforeHqMatching``) and is
validated by the Core runner. ``MediaRuntimeTest`` then installs both paths'
media in Core. The plausible failures: a resource path or version HQ writes
differently, a zip entry HQ cannot match to Nova's paths, bytes HQ changes,
and HQ validating a form other than the one Core parsed.
"""

import json

from lxml import etree

from proof.native.hq_support import hq_commit, hq_source_hashes, write_evidence
from proof.native.steps.media_emission import HQ_SOURCES, SCENARIOS

FAMILIES = ("media",)


def _resource_shape(root):
    # IDs, descriptors and remote HQ locations legitimately differ; the local
    # locations, emitted path metadata and version must agree. Core's
    # InstallerFactory ignores the media path when it chooses an installer.
    return sorted(
        (media.get("path"), resource.get("version"), location.text)
        for media in root.findall("media")
        for resource in media.findall("resource")
        for location in resource.findall("location")
        if location.get("authority") == "local"
    )


def _check_upload(record):
    result = record["bulkStatus"]
    uploaded = record["uploaded"]
    assert result["complete"] and result["progress"]["percent"] == 100, result
    assert result["errors"] == [] and result["unmatched_count"] == 0 and result["skipped_files"] == [], result
    assert (result["image_count"], result["audio_count"], result["video_count"]) == (3, 1, 1), result
    assert {info["original_path"] for group in result["matched_files"].values() for info in group} == set(uploaded)
    for path, file in uploaded.items():
        mapped = record["mapped"][file["reference"]]
        assert mapped["mediaType"] == file["class"], path
        assert mapped["bytes"] == file["bytes"], path
        assert mapped["fileHash"] == file["hash"] and mapped["heldByHash"], path
        assert mapped["owners"] == [record["domain"]], path


def test_hq_media_resources_and_bulk_upload_match_novas_archive(native):
    result = native.step("media")
    certificate = result["certificate"]
    assert certificate.mismatched == [], "Core certified different bytes than the validation sources hold"
    assert len(certificate.by_canonical) == 4
    results = []
    for record in result["records"]:
        name = record["scenario"]
        local_media = etree.fromstring(record["localMediaSuite"])
        native_media = etree.fromstring(record["nativeMediaSuite"])
        assert _resource_shape(local_media) == _resource_shape(native_media), (
            name,
            _resource_shape(local_media),
            _resource_shape(native_media),
        )
        if not record["enabled"]:
            assert len(local_media) == 0 and record["multimediaMapBeforeUpload"] == 0
            results.append({"scenario": name, "mediaResources": 0})
            continue
        assert len(record["uploaded"]) == 5
        _check_upload({**record, "domain": "nova-media-proof"})
        results.append(
            {"scenario": name, "mediaResources": len(record["uploaded"]), "bulkStatus": record["bulkStatus"]}
        )
    exports = native.family("media")
    write_evidence(
        exports,
        "media-emission",
        {
            "hqCommit": hq_commit(),
            "hqSourceHashes": hq_source_hashes(HQ_SOURCES),
            "novaSourceHashes": json.loads((exports / "media-source-hashes.json").read_text()),
            "results": results,
            "nativeValidatedSources": certificate.digests,
            "validationCalls": certificate.calls,
            "privilegesRead": {record["scenario"]: record["privilegesRead"] for record in result["records"]},
            "limits": "Native import, form/detail/menu/profile/media-suite generation and the full bulk multimedia "
            "task on HQ's Couch and blob store. Formplayer's validation is the Core runner, for sources Core "
            "certified only. No network, rendered client or media playback.",
        },
    )
    assert SCENARIOS == [record["scenario"] for record in result["records"]]
