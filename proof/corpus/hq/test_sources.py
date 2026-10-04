"""HQ's self-check files: the test JSONs the research counted, and archives HQ built.

Contract: the self-check apps copied from the checkouts hold every test JSON
the research found to build clean (so the check that each builds as the
research found has all 17 to build), leave out only the one HQ's import
cannot receive from its file, and take only archives HQ built. The
plausible failures: an upstream rename silently shrinking the set the
research's count rests on, and an archive another tool built passing as
HQ's.
"""

from __future__ import annotations

import io
import json
import zipfile

from lxml import etree

from proof.corpus.hq import sources


def test_the_test_jsons_hold_every_app_the_research_built_clean():
    apps, left_out = sources.hq_test_apps()
    stems = {app.source["path"].removeprefix(sources.TEST_DATA.as_posix() + "/").removesuffix(".json") for app in apps}
    assert sources.BUILDS_CLEAN <= stems
    assert len(sources.BUILDS_CLEAN) == 17
    assert [item.path.name for item in left_out] == ["app_case_detail_instances.json"]
    assert json.loads(left_out[0].path.read_text())["external_blobs"]
    assert all(not json.loads(app.path.read_text()).get("external_blobs") for app in apps)


def _with_profile_update(archive_path, update, tmp_path):
    """A copy of the archive whose profile's update source is ``update``."""
    source = zipfile.ZipFile(archive_path)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as copy:
        for name in source.namelist():
            content = source.read(name)
            if name == "profile.ccpr":
                profile = etree.fromstring(content)
                profile.set("update", update)
                content = etree.tostring(profile)
            copy.writestr(name, content)
    path = tmp_path / "copy.ccz"
    path.write_bytes(buffer.getvalue())
    return path


def test_only_archives_hq_built_are_taken(tmp_path):
    archives, left_out = sources.ccz_apps()
    assert archives and not left_out
    assert {app.source["repository"] for app in archives} == {"commcare-core", "commcare-android"}
    built = archives[0].path
    assert sources._hq_built(built)
    elsewhere = _with_profile_update(built, "https://example.org/profile.ccpr", tmp_path)
    assert not sources._hq_built(elsewhere)
