"""Selected installation files and the authorized release manager are independent HQ contracts."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

import pytest
from lxml import etree

from proof.hq import operations, requests as hq_requests
from proof.hq import redis as hq_redis
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app_with_menu_ids, nova_shaped_upload
from proof.hq.seams import build_seams
from proof.observe import hqside
from proof.observe.build import arrange
from proof.webapps import hq as webapps_hq


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


def offline_download(state, build, profile, targeted=False):
    """The Releases page's DownloadCCZ route, including its genuine archive worker.

    Capture the file at the final delivery boundary instead of distributing it
    through the shared-download service. HQ selects the profile, runs the real
    zip task, writes its files and creates the private restore.
    """
    from django.urls import resolve, reverse

    files = {}
    def take_file(path, filename, compress_zip, download_id):
        try:
            with ZipFile(path) as archive:
                files.update((name, archive.read(name)) for name in archive.namelist())
        finally:
            Path(path).unlink(missing_ok=True)

    path = reverse("download_ccz", args=[state.domain, build._id])
    params = {"profile": profile} if profile is not None else {}
    if targeted:
        params["download_targeted_version"] = "true"
    with hq_requests.held_get(state, path, params) as request:
        match = resolve(path)
        with patch("corehq.apps.hqmedia.tasks._expose_download_link", side_effect=take_file):
            response = match.func(request, *match.args, **match.kwargs)
    assert 200 <= response.status_code < 400
    assert files, "The offline archive task must finish in this eager test environment"
    return files


@pytest.mark.parametrize("practice_allowed", [True, False])
def test_selected_installation_and_real_practice_restore(hq, core_runner, tmp_path, practice_allowed):
    configuration = Configuration(privileges={"CLOUDCARE", "BUILD_PROFILES", "API_ACCESS"} | (
        {"PRACTICE_MOBILE_WORKERS"} if practice_allowed else set()
    ))
    with hq_check(configuration) as (state, record):
        with hq_redis.shared(None), state.committing():
            worker = operations.practice_worker(state, "installation-guide")
            reader = operations.seed_api_user(state, "build-observer@example.com")
        source = bilingual_app()
        source["target_commcare_flavor"] = "commcare_lts"
        source["build_profiles"] = {
            "visits": profile_payload("(Default)", ["fra"], worker),
            "office": profile_payload("Office", ["en", "fra"]),
        }
        shell = {**source, "modules": [], "_attachments": {}}
        if practice_allowed:
            shell["build_profiles"] = {**source["build_profiles"], "visits": profile_payload("(Default)", ["fra"])}
        app_id, _ = operations.publish(state, [nova_shaped_upload(shell, "Team visits")])
        with build_seams(), pytest.raises(webapps_hq.ReleaseRefused, match="no modules"):
            webapps_hq._make_build(state, operations.held_app(state, app_id))
        if practice_allowed:
            assert not operations.held_app(state, app_id).get_practice_user_id("visits")
            hqside.build_profiles(state, app_id, [
                {"id": "visits", "name": "(Default)", "langs": ["fra"], "practice_worker_id": worker},
                {"id": "office", "name": "Office", "langs": ["en", "fra"]},
            ])
            from corehq.apps.app_manager.exceptions import PracticeUserException
            from corehq.apps.users.models import CommCareUser

            # A named *working* suite consults the real account even while
            # the app has no modules. A failed check leaves the shell empty.
            path = f"/a/{state.domain}/apps/download/{app_id}/suite.xml?profile=visits"
            with hq_redis.shared(None), state.committing():
                account = CommCareUser.get(worker)
                shell_revision = operations.held_app(state, app_id)._rev
                account.set_is_active(state.domain, False)
                account.save()
                with pytest.raises(PracticeUserException, match="deactivated"):
                    operations.api_request(state, "GET", path, credential=reader)
                assert operations.held_app(state, app_id)._rev == shell_revision
                assert not operations.held_app(state, app_id).modules
                assert not operations.served_lookup_tables(state)
                account.set_is_active(state.domain, True)
                account.save()
                active = operations.api_request(state, "GET", path, credential=reader)
                assert active.status == 200
                assert etree.fromstring(active.body.encode()).xpath("/suite/user-restore/resource/@id") == ["practice-user-restore"]
        from proof.hq.test_lookup_upload import REPLACEMENT, workbook
        assert not operations.upload_lookup_workbook(state, workbook(REPLACEMENT), replace=True).errors
        content = {key: value for key, value in source.items() if key != "build_profiles"}
        uploaded = operations.apply_upload(state, nova_shaped_upload(content, "Team visits", app_id))
        assert uploaded.response["success"]
        assert operations.held_app(state, app_id).modules
        assert "district" in operations.served_lookup_tables(state)
        created = operations.held_app(state, app_id)
        assert created.get_practice_user_id("visits") == worker
        from corehq.apps.app_manager.tasks import create_build_files_for_all_app_profiles

        # HQ's release schedules profile generation on a background queue.
        # The harness runs Celery eagerly, so hold that job across the API
        # reads and first named download, then run the job HQ scheduled.
        with build_seams():
            build = webapps_hq._make_build(state, created)
        with patch.object(create_build_files_for_all_app_profiles, "delay") as queued:
            webapps_hq._release(state, app_id, build._id)
        queued.assert_called_once_with(state.domain, build._id)

        def snapshot():
            stored = operations.held_app(state, build._id).to_json()
            return stored["_rev"], stored["external_blobs"]
        def detail():
            answer = operations.api_request(
                state, "GET", f"/a/{state.domain}/api/application/v1/{build._id}/?extras=true", credential=reader)
            assert answer.status == 200
            return json.loads(answer.body)
        before = snapshot()
        assert "files/profile.ccpr" in before[1]
        assert not any(path.startswith(("files/visits/", "files/office/")) for path in before[1])
        cold = detail()
        assert cold["id"] == cold["_id"] == build._id
        assert cold["domain"] == state.domain and cold["is_released"]
        assert cold["built_from_app_id"] == cold["copy_of"] == app_id
        assert cold["version"] == build.version
        assert cold["build_profiles"]["visits"]["name"] == "(Default)"
        assert cold["build_profiles"]["visits"]["practice_mobile_worker_id"] == worker
        assert cold["external_blobs"] == before[1]
        assert cold["langs"] == ["en","fra"] and cold["modules"][0]["forms"]
        working_revision = operations.held_app(state, app_id)._rev
        inventory = operations.api_request(
            state, "GET", f"/a/{state.domain}/apps/download/{app_id}/suite.xml", credential=reader)
        assert inventory.status == 200
        suite = etree.fromstring(inventory.body.encode())
        resources = suite.xpath("/suite/xform/resource | /suite/xform-update-info/resource")
        forms = set()
        for resource in resources:
            (local,) = resource.xpath("location[@authority='local']/text()")
            (remote,) = resource.xpath("location[@authority='remote']/text()")
            assert local == remote and local.startswith("./modules-")
            forms.add(local[2:])
        assert forms and len(forms) == len(resources)
        assert operations.held_app(state, app_id)._rev == working_revision
        assert snapshot() == before
        with build_seams(), hq_redis.shared(None), state.committing():
            ordinary = offline_download(state, build, None)
            assert snapshot() == before
            archive = offline_download(state, build, "visits")
            after = snapshot()
            assert after[0] != before[0]
            assert "files/visits/profile.ccpr" in after[1]
            assert not any(path.startswith("files/office/") for path in after[1])
            assert offline_download(state, build, "visits") == archive
            targeted = offline_download(state, build, "visits", targeted=True)
            normal_targeted = offline_download(state, build, None, targeted=True)
            assert snapshot() == after
        for files in [ordinary, archive, targeted, normal_targeted]:
            assert {path for path in files if path.startswith("modules-") and "/forms-" in path} == forms
        for path in forms:
            assert etree.fromstring(archive[path]).xpath("//*[local-name()='translation']/@lang") == ["fra"]
            assert set(etree.fromstring(ordinary[path]).xpath("//*[local-name()='translation']/@lang")) == {"en", "fra"}
        for files, langs in [(ordinary, ["default","en","fra"]), (archive, ["default","fra"])]:
            assert etree.fromstring(files["suite.xml"]).xpath("/suite/locale/@language") == langs
            assert etree.fromstring(files["media_suite.xml"]).tag == "suite"
        assert all(ordinary[name] for name in ["profile.ccpr", "media_suite.xml", *forms])
        assert not etree.fromstring(ordinary["profile.ccpr"]).get("buildProfileID")
        assert etree.fromstring(archive["profile.ccpr"]).get("buildProfileID") == "visits"
        named = detail()
        assert named["external_blobs"] == after[1]
        assert snapshot() == after
        materialized = operations.held_app(state, build._id)
        selected = {path.removeprefix("files/"): materialized.fetch_attachment(path)
                    for path in after[1] if path.startswith("files/visits/")}
        assert archive["profile.ccpr"] == selected["visits/media_profile.ccpr"]
        assert targeted["profile.ccpr"] == selected["visits/media_profile-commcare_lts.ccpr"]
        assert normal_targeted["profile.ccpr"] == materialized.fetch_attachment("files/media_profile-commcare_lts.ccpr")
        assert ordinary["profile.ccpr"] == materialized.fetch_attachment("files/media_profile.ccpr")
        restore = selected.get("visits/practice_user_restore.xml")
        assert bool(restore) is practice_allowed
        assert archive.get("practice_user_restore.xml") == restore
        assert targeted.get("practice_user_restore.xml") == restore
        assert "practice_user_restore.xml" not in ordinary
        assert "practice_user_restore.xml" not in normal_targeted
        assert all(named["external_blobs"]["files/"+path]["content_length"] == len(content)
                   for path, content in selected.items())
        assert "files/practice_user_restore.xml" not in after[1]
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
        with build_seams(), hq_redis.shared(None), state.committing():
            create_build_files_for_all_app_profiles(*queued.call_args.args)
            warmed = snapshot()
            assert warmed[0] != after[0]
            assert "files/office/profile.ccpr" in warmed[1]
            assert {path: warmed[1][path] for path in after[1]} == after[1]
            assert detail()["external_blobs"] == warmed[1]
            assert offline_download(state, build, None) == ordinary
            assert offline_download(state, build, "visits") == archive
            assert snapshot() == warmed
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


def test_native_profile_links_select_their_physical_key(hq):
    from urllib.parse import urlsplit, urlunsplit

    cases = {"north-team": True, "crew=east": True, "literal%": True,
             "a%zz": True, "clinic&west": False, "a+b": False,
             "north#team": False, "encoded%2Fkey": False}
    with hq_check(Configuration(privileges={"API_ACCESS", "BUILD_PROFILES"})) as (state, _):
        source = bilingual_app()
        source["build_profiles"] = {key: profile_payload("Visits", ["fra"]) for key in cases}
        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "Teams")])
        with hq_redis.shared(None), state.committing():
            observer = operations.seed_api_user(state, "link-observer@example.com")
        app = operations.held_app(state, app_id)
        for key, selects in cases.items():
            # The first location is materialized by HQ's actual profile.xml
            # template. Follow its URL as written, without quoting the key.
            raw = app.create_profile(build_profile_id=key)
            xml = etree.fromstring(raw.encode() if isinstance(raw, str) else raw)
            assert xml.get("buildProfileID") == key
            (remote,) = xml.xpath("/profile/suite/resource/location[@authority='remote']/text()")
            location = urlsplit(remote)
            path = urlunsplit(("", "", location.path, location.query, ""))
            with hq_redis.shared(None), state.committing():
                answer = operations.api_request(state, "GET", path, credential=observer)
            assert answer.status == 200
            suite = etree.fromstring(answer.body.encode())
            assert suite.xpath("/suite/locale/@language") == (
                ["default", "fra"] if selects else ["default", "en", "fra"]
            ), (key, path)
            if selects:
                assert suite.xpath("/suite/locale/resource/location[@authority='remote']/text()") == [
                    f"./{lang}/app_strings.txt?profile={key}" for lang in ("default", "fra")
                ]
