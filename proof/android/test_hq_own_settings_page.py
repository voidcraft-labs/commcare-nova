"""Android's settings after a person first saves the settings page of an app made entirely in HQ.

HQ's settings page posts its displayed defaults for settings its app never stored. Android has its own
defaults for multimedia validation, GPS accuracy and fuzzy search. A new explicit profile property can also
replace a worker's preferences during update. A release of the same unchanged profile at the next version
keeps the worker's choices. These observations require neither a Nova document nor a Nova publish.
"""

import io
import zipfile
from dataclasses import replace

import pytest

from proof.android import observe
from proof.checks import android, hq_own_reports
from proof.editors import pages
from proof.editors.conftest import save_section
from proof.editors.test_hq_own_settings_page import _case_list_app
from proof.formplayer import hq as formplayer
from proof.hq import operations, redis
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.seams import build_seams
from proof.observe import casedata
from proof.observe.proof4 import next_build
from proof.observe.record import Blobs
from proof.webapps import hq as webapps

pytestmark = pytest.mark.reader("android")


def test_android_settings_page_writes_unset_settings(hq, editor_driver, lane_services):
    with hq_check(Configuration()) as (state, _):
        app_id = _case_list_app(state, editor_driver)
        before = operations.held_app(state, app_id)
        properties = (before.to_json().get("profile") or {}).get("properties") or {}
        with (
            redis.shared(None),
            state.committing(),
            state.operation("first-release", b"before-settings-save"),
            build_seams(),
        ):
            first = webapps._archive(formplayer._released(state, before, app_id))
        saved = save_section(editor_driver, state, pages.APP_SETTINGS, app_id)
        assert saved.save.status == 200 and not saved.refused
        written = operations.held_app(state, app_id).to_json()["profile"]["properties"]
        with zipfile.ZipFile(io.BytesIO(first)) as archive:
            unchanged = observe.archive_bytes(next_build([(name, archive.read(name)) for name in archive.namelist()]))
        when = "2025-12-01T08:00:00.000000Z"
        case = casedata.CaseRecord(
            case_id="settings-client",
            case_type=before.modules[0].case_type,
            name="proof text",
            owner_id=casedata.USER_ID,
            opened_on=when,
            modified_on=when,
            external_id=None,
            properties=(),
            indices=(),
        )
        other = replace(case, case_id="other-client", name="Garden")
        database = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (case, other))
        with formplayer.serve(state, None, app_id, database=database, label="after-settings-save") as served:
            blobs = Blobs()

            def update(archive, label):
                record = observe.update(served, blobs, label=label, before=first, after=archive, incomplete=False)
                answer = blobs.get_json(record["answer"])
                assert (answer["staged"], answer["updated"]) == ("UpdateStaged", "Installed"), answer
                return answer

            after = observe.release_archive(served)
            saved_device = update(after, "settings-save")
            unchanged_device = update(unchanged, "unchanged-profile")

            def search(archive, label):
                record = observe.app(
                    served, blobs, label=label, archive=archive, commands=["m0-f0"], searches=["proox"]
                )
                device = blobs.get_json(record["answer"])
                return [
                    step["list"]["searches"]
                    for walk in device["walks"].values()
                    for step in walk["steps"]
                    if "searches" in (step.get("list") or {})
                ]

            initial, saved_lists = search(first, "unset-search"), search(after, "saved-search")
            assert initial and len(initial) == len(saved_lists)
            for old, new in zip(initial, saved_lists, strict=True):
                assert old["fuzzyOff"]["proox"] == new["fuzzyOff"]["proox"] == []
                assert old["fuzzyOn"]["proox"] == new["fuzzyOn"]["proox"] == ["proof text"]
                assert old["asInstalled"] == old["fuzzyOff"] and new["asInstalled"] == new["fuzzyOn"]

    worker = {key: (before, after) for key, before, after in android.settings_replaced(saved_device, unchanged_device)}
    for path, (key, default, before, after) in hq_own_reports.ANDROID_SETTINGS.items():
        assert key not in properties and written[key] == default, key
        if path.startswith("/update/"):
            assert worker[key] == (before, after), path
            assert unchanged_device["before"]["stored"][key] == unchanged_device["after"]["stored"][key] == before, path
            continue
        reader = path.rsplit("/", 1)[1]
        assert saved_device["before"]["readers"][reader] == before, path
        assert saved_device["after"]["readers"][reader] == after, path
        assert unchanged_device["after"]["readers"][reader] == before, path
