"""The Android Start button uses the packages and names the HQ settings page saved."""
import io
from zipfile import ZipFile

import pytest
from lxml import etree

from proof.android import observe
from proof.editors.test_hq_own_settings_page import _case_list_app
from proof.formplayer import hq as formplayer
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.observe import casedata, hqside
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")


def test_android_start_lists_the_missing_apps_then_opens_after_install(hq, editor_driver, lane_services):
    packages = ["com.simprints.id", "org.rdtoolkit", "org.commcare.respiratory"]
    names = ["Field identity reader", "CommCare Toolkit", "Breath Counter"]
    with hq_check(Configuration(privileges=frozenset({"APP_DEPENDENCIES"}))) as (state, _):
        app_id = _case_list_app(state, editor_driver)
        hqside.profile_features(state, app_id, {"dependencies": packages})
        language = operations.held_app(state, app_id).langs[0]
        hqside.ui_translations(state, app_id, {language: {f"android.package.name.{packages[0]}": names[0]}})
        assert operations.held_app(state, app_id).profile["features"]["dependencies"] == packages
        database = casedata.CaseDatabase(user_id=casedata.USER_ID, username=casedata.USERNAME, user_data=(), cases=())
        with formplayer.serve(state, None, app_id, database=database, label="required-companion-apps") as served:
            archive = observe.release_archive(served)
            with ZipFile(io.BytesIO(archive)) as contents:
                profile = etree.fromstring(contents.read("profile.ccpr"))
                assert profile.xpath("//*[local-name()='dependencies']/*[local-name()='android_package']/@id") == packages
            blobs = Blobs()

            def start(installed, label):
                record = observe.required_apps(served, blobs, archive, installed, label)
                answer = blobs.get_json(record["answer"])
                assert answer["install"] == "Installed", answer
                return answer

            partial = start([packages[1]], "missing-two-apps")
            assert partial["openedMenu"] is False, partial
            messages = [value for value in partial["dialog"].values() if isinstance(value, str)]
            assert any(f"1. {names[0]}\n2. {names[2]}" in message for message in messages), messages
            assert all(names[1] not in message for message in messages)
            ready = start(packages, "all-required-apps-installed")
            assert ready["openedMenu"] is True and not ready.get("dialog"), ready
