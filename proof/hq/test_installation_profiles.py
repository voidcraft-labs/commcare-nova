"""Selected installation files and the authorized release manager are independent HQ contracts."""

from __future__ import annotations

import copy

import pytest
from lxml import etree

from proof.hq import operations
from proof.hq import redis as hq_redis
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app_with_menu_ids, nova_shaped_upload
from proof.hq.seams import build_seams
from proof.observe import hqside
from proof.observe.build import arrange


def bilingual_app():
    source = hq_test_app_with_menu_ids()
    source["langs"] = ["en", "fra"]
    for path, xml in source["_attachments"].items():
        form = etree.fromstring(xml.encode())
        en = form.xpath("//*[local-name()='translation' and @lang='en']")[0]
        french = copy.deepcopy(en)
        french.attrib.pop("default", None)
        french.set("lang", "fra")
        for value in french.xpath(".//*[local-name()='value' and text()]"):
            value.text = "Visite " + value.text
        en.getparent().append(french)
        source["_attachments"][path] = etree.tostring(form, encoding="unicode")
    for module in source["modules"]:
        module["name"]["fra"] = "Visites"
        for form in module["forms"]:
            form["name"]["fra"] = "Saisie"
    return source


def profile_payload(name, languages, worker=None):
    return {"name": name, "langs": languages, "practice_mobile_worker_id": worker}


@pytest.mark.parametrize("practice_allowed", [True, False])
def test_selected_installation_and_real_practice_restore(hq, core_runner, tmp_path, practice_allowed):
    configuration = Configuration(privileges={"CLOUDCARE", "BUILD_PROFILES"} | (
        {"PRACTICE_MOBILE_WORKERS"} if practice_allowed else set()
    ))
    with hq_check(configuration) as (state, record):
        with hq_redis.shared(None), state.committing():
            worker = operations.practice_worker(state, "installation-guide")
        source = bilingual_app()
        source["build_profiles"] = {
            "visits": profile_payload("Field team", ["fra"], worker),
            "office": profile_payload("Office", ["en", "fra"]),
        }
        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "Team visits")])
        created = operations.held_app(state, app_id)
        assert created.get_practice_user_id("visits") == worker
        with build_seams():
            first = operations.build(created, record)
        assert first.errors == []
        selected = first.profile_files["visits"]
        restore = selected.get("visits/practice_user_restore.xml")
        assert bool(restore) is practice_allowed
        assert "practice_user_restore.xml" not in first.files
        assert not any(name.endswith("practice_user_restore.xml") for name in first.profile_files["office"])
        assert etree.fromstring(selected["visits/profile.ccpr"]).get("buildProfileID") == "visits"
        suite = etree.fromstring(selected["visits/suite.xml"])
        assert suite.xpath("/suite/locale/@language") == ["default", "fra"]
        assert suite.xpath("/suite/user-restore/resource/location[@authority='remote']/text()") == [
            "./practice_user_restore.xml?profile=visits"
        ]
        assert "visits/en/app_strings.txt" not in selected
        assert b"Visites" in selected["visits/default/app_strings.txt"]
        for path, content in selected.items():
            if "/forms-" in path:
                form = etree.fromstring(content)
                assert form.xpath("//*[local-name()='translation']/@lang") == ["fra"]
        # The ordinary API update excludes the whole map. The authorized
        # page preserves the original key on a rename and allocates a new one.
        proposed = {**source, "build_profiles": {}}
        result = operations.apply_upload(state, nova_shaped_upload(proposed, "Team visits", app_id))
        assert result.response["success"] and set(operations.held_app(state, app_id).build_profiles) == {"visits", "office"}
        hqside.build_profiles(state, app_id, [
            {"id": "visits", "name": "Home visits", "langs": ["fra"], "practice_worker_id": worker},
            {"id": "office", "name": "Office", "langs": ["en", "fra"]},
            {"name": "Fly-in team", "langs": ["fra"]},
        ])
        updated = operations.held_app(state, app_id)
        assert updated.build_profiles["visits"].name == "Home visits"
        assert updated.get_practice_user_id("visits") == (worker if practice_allowed else "")
        assert list(updated.build_profiles["office"].langs) == ["en", "fra"]
        (new_key,) = set(updated.build_profiles) - {"visits", "office"}
        assert len(new_key) == 32
        if practice_allowed:
            # Core actually opens the selected language on the real practice restore.
            # No restored row or restore content is retained as a proof artifact.
            files = {path.removeprefix("visits/"): content for path, content in selected.items()}
            arrange(files, tmp_path)
            admitted = core_runner.admit(tmp_path)
            assert admitted["admitted"], admitted["problems"]
            try:
                trace = core_runner.session(admitted["app"], restore=restore)
                assert any(step.get("screen") == "form" for run in trace["runs"] for step in run["trace"])
            finally:
                core_runner.release(admitted["app"])
