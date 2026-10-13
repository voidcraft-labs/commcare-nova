"""The archive a state's record keeps is the one a worker installs from a file: HQ's own download, media included.

Contract (``proof.observe.build.device_archive``, kept by ``proof.observe.unit`` in each built state's record
as ``state.archive``): its entries are what HQ's archive download hands a device when a person asks for the app
and its multimedia together (``hqmedia/views.py::iter_app_files``). So every index file is the bytes HQ built
(the media profile under the name ``profile.ccpr``, the plain profiles left out, as Core's admission reads
them), and every file the media suite names at a local location is an entry holding the bytes Nova's publish
uploaded. The Android reader installs this archive (``proof.android``), and a device that installs it has
nothing left to fetch.

The plausible failures: the media left out (Android then asks HQ for each file over the network, which no test
of the reader answers, and reports the install failed), an entry named other than where the media suite looks
for it, a plain profile kept beside the media profile (a device would read the wrong one), and an archive
recorded for a state HQ could not build. The accepted case beside them: a document without media keeps exactly
its index files.
"""

from __future__ import annotations

import pytest

from proof.checks import cases
from proof.checks.compare.xml_tree import parse_xml
from proof.observe import unit

PROFILES = {"profile.xml", "profile.ccpr", "media_profile.xml", "media_profile.ccpr"}


def _document(document_id):
    for document in cases.load_corpus().emitted:
        if document.id == document_id:
            return document
    raise AssertionError(f"The corpus holds no document {document_id}, which this test reads.")


def _state(document, core_runner):
    """A's state record under the minimum configuration, observed without the hooks, and the blobs it names."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(unit, "HOOKS", ())
        records = unit.observe_document(document, core_runner=core_runner, configurations={"minimum"})
    return records.configurations["minimum"].a["state"], records.blobs


def _local_media(media_suite: bytes) -> set[str]:
    """Each path the media suite gives a local location, as an archive names it."""
    found = set()
    for location in parse_xml(media_suite).iter("location"):
        if location.get("authority") == "local":
            found.add(location.text.strip().removeprefix("./"))
    return found


@pytest.mark.parametrize(("document_id", "has_media"), [("case-list-inline", True), ("targeted-survey-menu", False)])
def test_a_states_archive_is_hqs_download_with_the_media_its_suite_names(core_runner, document_id, has_media):
    state, blobs = _state(_document(document_id), core_runner)
    files, entries = state["build"]["files"], state["archive"]["entries"]

    index = set(files) - PROFILES
    assert index <= set(entries)
    for name in index:
        assert entries[name] == files[name], f"{name} in the archive is not the file HQ built."
    assert entries["profile.ccpr"] == files["media_profile.ccpr"]
    assert not (PROFILES - {"profile.ccpr"}) & set(entries)

    media = set(entries) - index - {"profile.ccpr"}
    named = _local_media(blobs.get(entries["media_suite.xml"]))
    assert media == named, "The archive's media are not the files its media suite names at a local location."
    assert bool(media) is has_media
    for name in media:
        assert blobs.get(entries[name]), f"{name} is an empty entry."
