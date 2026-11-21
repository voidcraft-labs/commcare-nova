"""HQ's own settings page writes, on an app HQ made, each setting the app holds no value for.

Contract (``proof.checks.hq_own_reports``, member
``settings_page_writes_unset_settings``): the app settings page's save adding
each of the fifteen settings Nova seeds, where the app's stored profile holds
no value for it, is what HQ does itself. The page posts every setting it
shows, an unset one at the value it shows for it
(``settings/bootstrap5/commcare_settings.js::serialize``), HQ's save stores
each in the app's profile (``views/settings.py::edit_commcare_settings``,
``edit_commcare_profile``), and HQ's build writes each stored setting whose
value is set into every profile it builds (``ApplicationBase.create_profile``).
The app here holds no Nova byte: HQ's own views make its case menu
(``default_new_app``, ``new_module``), and Vellum saves its follow-up form.
HQ's settings page saves it unchanged in Chromium. Core installs both builds
and reports the force and value of each property.

The plausible failures: a member whose paths are not where proof 4 reports
the settings the save wrote, so the save over B of an app brought in from HQ
stays a difference; and a condition that holds where the app already held a
value, so a save that changed a value the app held would be dropped.
"""

from __future__ import annotations

import json

from lxml import etree

from proof.checks import hq_own_reports
from proof.checks.differences import Difference
from proof.editors import compare, pages, vellum
from proof.editors.conftest import record_timing, save_section, write_evidence
from proof.editors.test_hq_own_registration_alert import _case_menu, _hq
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.observe.build import admit, arrange

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
MEMBER = "settings_page_writes_unset_settings"


def _case_list_app(state, editor_driver):
    """A runnable HQ-made case menu. The follow-up form visits a case, and the list shows its name."""
    app_id, followup = _case_menu(state)
    module = operations.held_app(state, app_id).modules[0]
    # HQ's new case menu also holds an unfinished registration form; the worker visits an existing case.
    _hq(state, "delete_form", app_id, module.unique_id, module.forms[0].unique_id, data=[])
    columns = [{"header": {"en": "Name"}, "model": "case", "field": "name", "format": "plain"}]
    _hq(
        state,
        "edit_module_detail_screens",
        app_id,
        module.unique_id,
        data=[("type", json.dumps("case")), ("short", json.dumps(columns))],
    )
    run = vellum.open_and_save(editor_driver, state, app_id, followup)
    assert run.loaded and run.saved, (run.load_error, run.save_refusal)
    return app_id


def _held(artifact, path, value, added):
    difference = Difference("proof4", "-", artifact, path, path, "added", None, value)
    member = hq_own_reports.held(artifact, path, difference, added)
    return None if member is None else member.id


def test_settings_page_writes_unset_settings(hq, editor_driver, core_runner, tmp_path):
    """On an app HQ's own page made, the settings page's unchanged save stores and builds each of the fifteen
    settings, every one of which the app held no value for, and the member holds each report of it at the
    artifact and path proof 4 reports it at, over the app as it stood before the save."""
    with hq_check(CONFIGURATION) as (state, record):
        app_id = _case_list_app(state, editor_driver)
        before_doc = operations.held_app(state, app_id).to_json()
        before = compare.build(state, app_id, record)
        saved = save_section(editor_driver, state, pages.APP_SETTINGS, app_id)
        after_doc = operations.held_app(state, app_id).to_json()
        after = compare.build(state, app_id, record, version=before.app.version)
    record_timing("page_save:app settings", saved.seconds)
    assert saved.save.url_name == pages.APP_SETTINGS.save
    assert saved.save.status == 200 and not saved.refused, saved.save.response

    stored_before = (before_doc.get("profile") or {}).get("properties") or {}
    stored_after = (after_doc.get("profile") or {}).get("properties") or {}
    built_before = compare.profile_settings(before.files, "profile.ccpr")["properties"]
    built_after = compare.profile_settings(after.files, "profile.ccpr")["properties"]
    write_evidence(
        "hq-own-settings-page",
        {"stored": [stored_before, stored_after], "built": [built_before, built_after], "request": saved.save.body},
    )
    profiles = {
        path: etree.fromstring(after.files[path].encode() if isinstance(after.files[path], str) else after.files[path])
        for path in ("profile.xml", "profile.ccpr", "media_profile.xml", "media_profile.ccpr")
    }
    before_core, after_core = (
        admit(core_runner, arrange(build.files, tmp_path / label))
        for build, label in ((before, "before"), (after, "after"))
    )
    assert before_core["admitted"] and after_core["admitted"], (before_core["problems"], after_core["problems"])
    original = {setter["key"] for setter in before_core["profile"]["properties"]}
    installed = {
        setter["key"]: {k: v for k, v in setter.items() if k != "key"} for setter in after_core["profile"]["properties"]
    }
    posted = json.loads(saved.save.body)["properties"]
    added = hq_own_reports.settings_added(before_doc, before_doc, after_doc)
    assert added == hq_own_reports.UNSEEDED_SETTINGS
    for key, value in hq_own_reports.UNSEEDED_SETTINGS.items():
        assert key not in stored_before and key not in built_before and key not in original, key
        assert str(posted[key]) == stored_after[key] == built_after[key] == value
        path = f"/profile/properties/{key}"
        assert _held("app.json@app settings", path, stored_after[key], added) == MEMBER
        assert _held("trace@app settings", path, installed[key], added) == MEMBER
        for artifact, root in profiles.items():
            (element,) = root.findall(f"property[@key='{key}']")
            assert (
                _held(
                    f"{artifact}@app settings",
                    f"/profile/property[@key={key}]",
                    etree.tostring(element, encoding="unicode", with_tail=False),
                    added,
                )
                == MEMBER
            )
    assert not hq_own_reports.settings_added(before_doc, after_doc, after_doc)
