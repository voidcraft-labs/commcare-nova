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
The app here holds no Nova byte: HQ's own view makes it (``default_new_app``),
and HQ's settings page, loaded in Chromium, saves it unchanged as proof 4
saves it (``proof.editors.pages.APP_SETTINGS``).

The plausible failures: a member whose paths are not where proof 4 reports
the settings the save wrote, so the save over B of an app brought in from HQ
stays a difference; and a condition that holds where the app already held a
value, so a save that changed a value the app held would be dropped.
"""

from __future__ import annotations

from types import SimpleNamespace

from proof.checks import hq_own_reports
from proof.editors import compare, pages
from proof.editors.conftest import record_timing, save_section, write_evidence
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
MEMBER = "settings_page_writes_unset_settings"


def _new_app(state):
    """A new app, as HQ's own page makes one (``views/apps.py::default_new_app``); returns its id."""
    from corehq.apps.app_manager.dbaccessors import get_app_ids_in_domain
    from django.urls import resolve, reverse

    from proof.hq import requests as hq_requests

    path = reverse("default_new_app", args=[state.domain])
    match = resolve(path)
    response = match.func(hq_requests.get(state, path), *match.args, **match.kwargs)
    assert response.status_code < 400, (response.status_code, response.content[:600])
    (app_id,) = get_app_ids_in_domain(state.domain)
    return app_id


def _report(path):
    """A report of the save as proof 4 makes one of a setting it added."""
    return SimpleNamespace(path=path, kind="added")


def _held(artifact, path, stored):
    """The member that holds a report of the save over ``stored``, an app HQ's own page made."""
    member = hq_own_reports.held(artifact, path, _report(path), stored, True)
    return None if member is None else member.id


def test_settings_page_writes_unset_settings(hq, editor_driver):
    """On an app HQ's own page made, the settings page's unchanged save stores and builds each of the fifteen
    settings, every one of which the app held no value for, and the member holds each report of it at the
    artifact and path proof 4 reports it at, over the app as it stood before the save."""
    with hq_check(CONFIGURATION) as (state, record):
        app_id = _new_app(state)
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
    for key in hq_own_reports.UNSEEDED_SETTINGS:
        assert key not in stored_before and key not in built_before, key
        assert stored_after.get(key) and built_after.get(key) == str(stored_after[key]), key
        assert _held("app.json@app settings", f"/profile/properties/{key}", before_doc) == MEMBER, key
        assert _held("trace@app settings", f"/profile/properties/{key}", before_doc) == MEMBER, key
        for artifact in ("profile.xml", "profile.ccpr", "media_profile.xml", "media_profile.ccpr"):
            assert _held(f"{artifact}@app settings", f"/profile/property[@key={key}]", before_doc) == MEMBER, key
    # Over the app the save left, which holds a value for each, the member holds nothing: a later save that
    # changed one of them would be reported.
    for key in hq_own_reports.UNSEEDED_SETTINGS:
        assert _held("app.json@app settings", f"/profile/properties/{key}", after_doc) is None, key
