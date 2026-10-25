"""HQ's media resources, and its bulk media upload of Nova's zip, match Nova's archive.

Contract: for each media scenario HQ regenerates the form, suite, strings,
profile and media suite, and its media suite's local resources (path,
version and location) equal the local CCZ's; without media both are empty
and HQ maps nothing. Nova's import carries no multimedia map in any
scenario, so the app HQ imports maps nothing before the upload. With media,
HQ's whole bulk upload task over Nova's
upload zip completes with no error, unmatched or skipped file, classifies
four images, five audio files and two videos (one file of each format
defect 11's first half accepts among them: a BMP, an M4A, a FLAC, an Ogg
Vorbis, an Ogg Opus and a WebM, each in a slot of its kind, which HQ types by
its bytes, ``hqmedia/models.py::CommCareMultimedia.get_class_by_data``, as the
kind Nova gives it),
matches every file in the zip, maps each to the form path HQ derives from
it, stores exactly the uploaded bytes, and records the project space as each
file's owner. Every form HQ sends to Formplayer while doing so is one Core
certified (``MediaRuntimeTest.sourceFormsParseWithRealCoreBeforeHqMatching``)
and is validated by the Core runner.

Three more scenarios run HQ's real bulk upload over what Nova accepts by
platform. ``media-web-apps-on`` (an app that declares Web Apps only) adds an
ICO and an AVIF, seven files (five images, an audio file, a video), and
executes HQ storing each through Pillow in the proof image;
``media-android-on`` (Android only) adds raw AAC, AMR, MIDI, an HEVC MP4, an
MPEG-4 Part 2 MP4 and a VP8 MKV, eleven files (three images, four audio
files, four videos). Each completes with no error, unmatched or skipped
file, each file classed as its Nova kind and stored byte for byte. The
third, ``media-svg-refused``, is the one emission Nova would refuse, built
only so HQ's refusal is executed: one SVG among the base files stops the
whole upload ("Error while processing zip"), and no file of it is in the
app's multimedia map afterwards. The plausible failures: a variant Nova
accepts that HQ types as another kind or cannot store, and an SVG HQ would
store, either of which moves what Nova accepts.

``MediaRuntimeTest`` then installs both paths' media in Core, two ways. The
file-system install (Android's shape) installs each resource from a file
that exists and refuses one that doesn't. The archive install (Core's and
Formplayer's shape) registers Nova's local archive with Core's
``ArchiveFileRoot`` and installs each resource whether or not the archive
holds its file (``ArchiveFileReference.doesBinaryExist`` answers true), so an
archive install is not the bundling proof; the test then holds the archive to
an entry at each location's path whose SHA-256 is the hash the path names.
The plausible failures: a resource path or version HQ writes differently, a
zip entry HQ cannot match to Nova's paths, a format HQ types as another kind,
bytes HQ changes, and HQ validating a form other than the one Core parsed.
"""

import json

from lxml import etree

from proof.native.hq_support import hq_commit, hq_source_hashes, write_evidence
from proof.native.steps.media_emission import FORMAT_SCENARIOS, HQ_SOURCES, SCENARIOS

FAMILIES = ("media",)
# The class HQ's upload gives a file of each kind Nova gives it (``hqmedia/models.py``).
HQ_CLASS = {"image": "CommCareImage", "audio": "CommCareAudio", "video": "CommCareVideo"}


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


# The files of each scenario with media, by kind: (images, audio files, videos).
COUNTS = {
    "media-rich-on": (4, 5, 2),
    "media-only-on": (4, 5, 2),
    "media-web-apps-on": (5, 1, 1),
    "media-android-on": (3, 4, 4),
}


def _check_upload(record):
    result = record["bulkStatus"]
    uploaded = record["uploaded"]
    counts = COUNTS[record["scenario"]]
    assert result["complete"] and result["progress"]["percent"] == 100, result
    assert result["errors"] == [] and result["unmatched_count"] == 0 and result["skipped_files"] == [], result
    assert (result["image_count"], result["audio_count"], result["video_count"]) == counts, result
    assert len(uploaded) == sum(counts), record["scenario"]
    assert {info["original_path"] for group in result["matched_files"].values() for info in group} == set(uploaded)
    for path, file in uploaded.items():
        mapped = record["mapped"][file["reference"]]
        assert file["class"] == HQ_CLASS[file["novaKind"]], (path, file["novaKind"], file["class"])
        assert mapped["mediaType"] == file["class"], path
        assert mapped["bytes"] == file["bytes"], path
        assert mapped["fileHash"] == file["hash"] and mapped["heldByHash"], path
        assert mapped["owners"] == [record["domain"]], path


def test_hq_media_resources_and_bulk_upload_match_novas_archive(native):
    result = native.step("media")
    certificate = result["certificate"]
    assert certificate.mismatched == [], "Core certified different bytes than the validation sources hold"
    assert len(certificate.by_canonical) == 7
    results = []
    for record in result["records"]:
        name = record["scenario"]
        if name == "media-svg-refused":
            # HQ cannot store the SVG, and the error escapes the upload's loop, so the whole upload stops and
            # nothing of it is mapped, the files the zip holds beside the SVG included.
            assert record["multimediaMapBeforeUpload"] == 0, name
            assert any("Error while processing zip" in str(error) for error in record["bulkStatus"]["errors"]), (
                record["bulkStatus"]
            )
            assert record["mapped"] == {}, sorted(record["mapped"])
            results.append({"scenario": name, "bulkStatus": record["bulkStatus"]})
            continue
        local_media = etree.fromstring(record["localMediaSuite"])
        native_media = etree.fromstring(record["nativeMediaSuite"])
        assert _resource_shape(local_media) == _resource_shape(native_media), (
            name,
            _resource_shape(local_media),
            _resource_shape(native_media),
        )
        # Nova's import carries no multimedia map, enabled or not: the upload alone maps the media.
        assert record["multimediaMapBeforeUpload"] == 0, name
        if not record["enabled"]:
            assert len(local_media) == 0
            results.append({"scenario": name, "mediaResources": 0})
            continue
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
    assert SCENARIOS + FORMAT_SCENARIOS == [record["scenario"] for record in result["records"]]
