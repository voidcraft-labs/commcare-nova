"""The Android judge reports a planted difference and only it, and nothing where a device showed the same.

Contract (``proof.checks.android``): proofs 1, 3 and 4 compare what CommCare Android's own code answered of two
archives (``proof.android``'s ``app``, ``installs`` and ``update`` answers) as a worker meets them: each of
Android's profile readers, the home screen, and each walk's screens; one symptom is one difference; what a
reader keys by a name is compared by that name; and what names an install and not what a worker reads is not
compared.

The plausible failures: a reader's changed answer lost, or reported once more for a stored value no reader
reads differently (an equivalence reported as a harm); an app's own id or version read as a difference between
two builds of one app; a walk that takes other screens reported once a step; a menu item, a case or a search
term compared by where it stands, so one added item reports every item after it; a worker's own setting an
update replaced lost, or one the update left reported; an incomplete form that no longer opens lost; two
exports that install as two apps not told from two that install as one. Each test plants one such change in an
answer shaped as the reader writes it and holds the judge to exactly it, beside the unchanged answer it
accepts.
"""

from __future__ import annotations

import copy

from proof.checks import android

READERS = {
    "HiddenPreferences.isSavedFormsEnabled": False,
    "HiddenPreferences.getLoginDuration": 86400,
    "MainConfigurablePreferences.isFuzzySearchEnabled": False,
    "CommCareApp.areMMResourcesValidated": False,
}


def _list(names=("Name",), rows=("ada", "bo")):
    return {
        "EntitySelectActivity.getSortOptionsList": list(names),
        "count": len(rows),
        "header": [{"class": "EntityView", "children": [{"class": "TextView", "text": name} for name in names]}],
        "rows": [{"class": "EntityView", "children": [{"class": "TextView", "text": row}]} for row in rows],
        "sorted": [{"option": name, "rows": sorted(rows)} for name in names],
        "searches": {
            "MainConfigurablePreferences.isFuzzySearchEnabled": False,
            "asInstalled": {"ada": ["ada"], "adx": []},
            "fuzzyOn": {"ada": ["ada"], "adx": ["ada"]},
            "fuzzyOff": {"ada": ["ada"], "adx": []},
        },
        "finishing": True,
    }


def _form(screens=("/data/name[1]",), cases=()):
    return {
        "loaded": True,
        "title": "Register",
        "screens": [{"event": "QUESTION", "index": index, "questions": [], "alert": None} for index in screens],
        "ended": "end",
        "saved": {
            "finishing": True,
            "resultCode": -1,
            "records": [{"status": "unsent", "FormRecord.getDisplayName": "Register"}],
            "cases": [{"id": "case-1", "type": "patient", "name": "ada", "closed": False, "properties": {"age": "7"}}]
            + list(cases),
        },
    }


def _app(**changes):
    answer = {
        "install": "Installed",
        "areMMResourcesValidatedAfterInstall": False,
        "restore": "DOWNLOAD_SUCCESS",
        "home": {"StandardHomeActivityUIController.getHiddenButtons": ["connect", "saved"], "title": "Health"},
        "profile": {
            "app": {"uniqueId": "app-1", "versionNumber": 3, "installedApps": ["app-1"], "displayName": "Health"},
            "readers": dict(READERS),
            "stored": {"cc-show-saved": "no", "cc-login-duration-seconds": None},
            "locale": {"Localization.getCurrentLocale": "en"},
            "settings": {"MainConfigurablePreferences": ["cc-enable-tts"]},
        },
        "walks": {
            "root": {
                "steps": [
                    {
                        "screen": "MenuActivity",
                        "menu": {
                            "id": None,
                            "items": [
                                {"id": "m0", "kind": "menu", "texts": ["Patients"], "image": None, "audio": None},
                                {"id": "m1", "kind": "menu", "texts": ["Visits"], "image": None, "audio": None},
                            ],
                        },
                    }
                ]
            },
            "m0/m0-f0": {
                "steps": [
                    {"screen": "MenuActivity", "chose": "m0"},
                    {"screen": "EntitySelectActivity", "list": _list()},
                    {"screen": "FormEntryActivity", "form": _form()},
                    {"screen": "home", "alert": None},
                ]
            },
        },
    }
    answer.update(changes)
    return answer


def _paths(differences):
    return sorted((difference.artifact, difference.path, difference.kind) for difference in differences)


def _proof3(local, a=None, b=None):
    record = {"local": {"app": local}, "configurations": {"minimum": {"A": {"app": a or _app()}}}}
    if b is not None:
        record["configurations"]["minimum"]["B"] = {"app": b}
    return android.behavior("document", record)


def test_two_devices_that_show_the_same_report_nothing_whatever_names_each_install():
    """An app's own id, its version, the apps a device holds and a stored value no reader reads differently
    name an install or a spelling, never what a worker reads."""
    local = _app()
    local["profile"]["app"].update(uniqueId="another-app", versionNumber=1, installedApps=["another-app"])
    local["profile"]["stored"] = {"cc-show-saved": "no", "cc-login-duration-seconds": "86400"}
    assert _proof3(local) == []
    assert _proof3(local, b=copy.deepcopy(local)) == []


def test_a_readers_changed_answer_is_reported_once_at_that_reader():
    local = _app()
    local["profile"]["readers"]["HiddenPreferences.isSavedFormsEnabled"] = True
    found = _proof3(local)
    assert _paths(found) == [("android@local.ccz", "/profile/readers/HiddenPreferences.isSavedFormsEnabled", "changed")]
    assert (found[0].before, found[0].after) == (False, True)


def test_the_media_checks_reader_is_reported_and_its_two_flags_beside_it_are_not():
    local = _app(areMMResourcesValidatedAfterInstall=True)
    local["profile"]["readers"]["CommCareApp.areMMResourcesValidated"] = True
    local["profile"]["app"]["resourcesValidated"] = True
    assert _paths(_proof3(local)) == [
        ("android@local.ccz", "/profile/readers/CommCareApp.areMMResourcesValidated", "changed")
    ]


def test_a_home_button_is_compared_by_its_name():
    """One more hidden button is that button, not every button listed after it."""
    local = _app(home={"StandardHomeActivityUIController.getHiddenButtons": ["connect", "incomplete", "saved"]})
    local["home"]["title"] = "Health"
    assert _paths(_proof3(local)) == [
        ("android@local.ccz", "/home/StandardHomeActivityUIController.getHiddenButtons/incomplete", "added")
    ]


def test_an_archive_android_does_not_install_is_that_and_nothing_of_its_app():
    assert _paths(_proof3({"install": "UnknownFailure"})) == [("android@local.ccz", "/install", "changed")]


def test_a_menu_item_is_compared_by_its_id_and_the_menus_order_is_one_value():
    local = _app()
    items = local["walks"]["root"]["steps"][0]["menu"]["items"]
    items.insert(0, {"id": "m9", "kind": "menu", "texts": ["Stock"], "image": None, "audio": None})
    assert _paths(_proof3(local)) == [
        ("android@local.ccz", "/walks/*/steps/*/menu/items/*", "added"),
        ("android@local.ccz", "/walks/*/steps/*/menu/order", "changed"),
    ]


def test_a_walk_that_takes_other_screens_is_one_difference():
    local = _app()
    local["walks"]["m0/m0-f0"]["steps"] = [
        {"screen": "MenuActivity", "chose": "m0"},
        {"screen": "home", "alert": {"title": "Session Refresh Required"}},
    ]
    found = _proof3(local)
    parted = "after-MenuActivity:EntitySelectActivity:home!Session Refresh Required"
    assert _paths(found) == [("android@local.ccz", f"/walks/*/screens/{parted}", "changed")]
    assert found[0].after == "MenuActivity | home!Session Refresh Required"
    assert found[0].at == f"/walks/m0~1m0-f0/screens/{parted}"


def test_a_walk_that_stops_at_a_form_is_named_by_the_alert_the_form_holds():
    """Two saves that leave a form a device does not save are two symptoms where the device says two things."""
    unsaved, stopped = _app(), _app()
    for answer, title in ((unsaved, "Error Saving your Form"), (stopped, "Error Occurred")):
        steps = answer["walks"]["m0/m0-f0"]["steps"]
        del steps[3]
        steps[2]["form"]["saved"]["alert"] = {"title": title, "msg": "..."}
    first = _proof3(unsaved)
    assert _paths(first) == [
        (
            "android@local.ccz",
            "/walks/*/screens/after-EntitySelectActivity:FormEntryActivity:FormEntryActivity!Error Saving your Form",
            "changed",
        )
    ]
    assert _paths(_proof3(stopped)) != _paths(first)


def test_a_sort_menu_a_sort_order_and_a_searchs_matches_are_each_one_value():
    local = _app()
    held = local["walks"]["m0/m0-f0"]["steps"][1]["list"]
    held["EntitySelectActivity.getSortOptionsList"] = ["(^) Tags", "Name"]
    held["sorted"] = [{"option": "(^) Tags", "rows": ["bo", "ada"]}, {"option": "Name", "rows": ["ada", "bo"]}]
    held["searches"]["fuzzyOn"]["adx"] = []
    held["searches"]["MainConfigurablePreferences.isFuzzySearchEnabled"] = True
    assert _paths(_proof3(local)) == [
        ("android@local.ccz", "/walks/*/steps/*/list/EntitySelectActivity.getSortOptionsList", "changed"),
        ("android@local.ccz", "/walks/*/steps/*/list/searches/fuzzyOn/*", "changed"),
        ("android@local.ccz", "/walks/*/steps/*/list/sorted/*", "added"),
    ]


def test_a_list_of_another_kind_of_row_is_one_difference():
    local = _app()
    held = local["walks"]["m0/m0-f0"]["steps"][1]["list"]
    held["rows"] = [{"class": "EntityViewTile", "children": [{"class": "Space"}, {"class": "TextView"}]}]
    held["header"] = []
    assert _paths(_proof3(local)) == [("android@local.ccz", "/walks/*/steps/*/list/rowClass", "changed")]


def test_another_order_is_one_difference_its_rows_compare_by_case_and_another_case_opened_ends_the_comparison():
    """A list sorted another way opens another first case: the order and the choice are the two differences,
    a row is compared with the same case's row, and the form past the choice, of another case, is none."""
    baseline, local = _app(), _app()
    held = baseline["walks"]["m0/m0-f0"]["steps"][1]["list"]
    held.update(order=["case-ada", "case-bo"], chose="case-ada", detail={"tabs": [{"title": "Ada"}]})
    held = local["walks"]["m0/m0-f0"]["steps"][1]["list"]
    held["rows"].reverse()
    held.update(order=["case-bo", "case-ada"], chose="case-bo", detail={"tabs": [{"title": "Bo"}]})
    local["walks"]["m0/m0-f0"]["steps"][2]["form"] = _form(screens=("/data/name[1]", "/data/age[1]"))
    local["walks"]["m0/m0-f0"]["steps"].append({"screen": "MenuActivity"})
    found = _proof3(local, a=baseline)
    assert _paths(found) == [
        ("android@local.ccz", "/walks/*/steps/*/list/chose", "changed"),
        ("android@local.ccz", "/walks/*/steps/*/list/order", "changed"),
    ]
    held["rows"][1]["children"][0]["textSize"] = 17
    assert ("android@local.ccz", "/walks/*/steps/*/list/rows/*/children/*/textSize", "added") in _paths(
        _proof3(local, a=baseline)
    )


def test_a_walk_the_app_raised_in_is_compared_by_what_was_raised_and_not_by_its_frames():
    baseline, local = _app(), _app()
    baseline["walks"]["m0/m0-f0"] = {"raised": {"class": "X", "message": "no case", "stack": "X\n at a.B(B.java:1)"}}
    local["walks"]["m0/m0-f0"] = {"raised": {"class": "X", "message": "no case", "stack": "X\n at a.B(B.java:2)"}}
    assert _proof3(local, a=baseline) == []
    local["walks"]["m0/m0-f0"]["raised"]["message"] = "no form"
    assert _paths(_proof3(local, a=baseline)) == [("android@local.ccz", "/walks/*/raised/message", "changed")]


def test_a_cells_layout_is_reported_at_the_cell():
    local = _app()
    local["walks"]["m0/m0-f0"]["steps"][1]["list"]["rows"][0]["children"][0]["textSize"] = 17
    assert _paths(_proof3(local)) == [
        ("android@local.ccz", "/walks/*/steps/*/list/rows/*/children/*/textSize", "added")
    ]


def test_a_form_that_takes_another_path_is_one_difference_and_a_case_is_compared_by_its_id():
    local = _app()
    local["walks"]["m0/m0-f0"]["steps"][2]["form"] = _form(screens=("/data/name[1]", "/data/age[1]"))
    assert _paths(_proof3(local)) == [("android@local.ccz", "/walks/*/steps/*/form/path", "changed")]
    made = _app()
    extra = {"id": "@device-case:1", "type": "visit", "name": "v", "closed": False, "properties": {}}
    made["walks"]["m0/m0-f0"]["steps"][2]["form"] = _form(cases=[extra])
    made["walks"]["m0/m0-f0"]["steps"][2]["form"]["saved"]["cases"].reverse()
    assert _paths(_proof3(made)) == [("android@local.ccz", "/walks/*/steps/*/form/saved/cases/*", "added")]
    other = _app()
    held = other["walks"]["m0/m0-f0"]["steps"][2]["form"]["saved"]["cases"][0]
    held.update(closed=True, properties={"age": "8", "note": "x"})
    assert _paths(_proof3(other)) == [("android@local.ccz", "/walks/*/steps/*/form/saved/cases/*", "changed")]


def test_a_search_that_sends_the_query_hq_refuses_stands_on_its_own_and_one_core_stopped_does_not():
    """Finding 48 on a device: the screen sends the suite's placeholder for a value no XPath string holds."""

    def searching(errors, sent):
        app = _app()
        app["walks"]["m0/m0-f0"]["steps"].insert(
            1,
            {
                "screen": "QueryRequestActivity",
                "query": {
                    "opened": True,
                    "withAnswer": {
                        "answer": 'it\'s "x"',
                        "RemoteQuerySessionManager.getErrors": errors,
                        "RemoteQuerySessionManager.getRawQueryParams": {"_xpath_query": sent, "case_type": ["p"]},
                        "afterServerAnswers400": {
                            "errorShown": True,
                            "errorText": "Client-side error",
                            "finishing": False,
                        },
                    },
                },
            },
        )
        return app

    sent = searching({}, ["age > 3", android.UNQUOTABLE])
    found = _proof3(copy.deepcopy(sent), a=sent)
    assert _paths(found) == [("android@A", "/walks/*/steps/*/query/withAnswer/sent-unquotable-search", "error")]
    assert found[0].at == "/walks/m0~1m0-f0/steps/1/query/withAnswer/sent-unquotable-search"
    assert found[0].after == {"sent": ["age > 3", android.UNQUOTABLE], "shown": "Client-side error"}
    stopped = searching({"name": "The value holds both quote marks."}, ["age > 3", android.UNQUOTABLE])
    assert _proof3(copy.deepcopy(stopped), a=stopped) == []
    quoted = searching({}, ["age > 3", 'name = "it\'s"'])
    assert _proof3(copy.deepcopy(quoted), a=quoted) == []


def test_b_is_compared_with_a_as_the_local_archive_is():
    b = _app()
    b["profile"]["locale"]["Localization.getCurrentLocale"] = "default"
    assert _paths(_proof3(_app(), b=b)) == [("android@B", "/profile/locale/Localization.getCurrentLocale", "changed")]


def _update(**changes):
    profile = {
        "app": {"uniqueId": "app-1", "versionNumber": 3},
        "stored": {"cc-enable-tts": "yes", "cc-autoup-freq": "freq-daily", "cc-fuzzy-search-enabled": None},
    }
    after = copy.deepcopy(profile)
    after["app"]["versionNumber"] = 4
    answer = {
        "install": "Installed",
        "staged": "UpdateStaged",
        "updated": "Installed",
        "workerSettings": ["cc-autoup-freq", "cc-enable-tts"],
        "before": profile,
        "after": after,
    }
    answer.update(changes)
    return answer


def _proof4(save, base=None):
    record = {
        "configurations": {
            "minimum": {"B": {"app": base or _app()}, "saves": {"B": [{"label": "app settings", **save}]}}
        }
    }
    return android.editability("document", record)


def test_a_save_is_compared_with_the_state_it_was_saved_over_under_its_editors_name():
    saved = _app()
    saved["profile"]["readers"]["MainConfigurablePreferences.isFuzzySearchEnabled"] = True
    found = _proof4({"editor": "app settings", "over": None, "app": saved})
    assert _paths(found) == [
        (
            "android@app settings@B@minimum",
            "/profile/readers/MainConfigurablePreferences.isFuzzySearchEnabled",
            "changed",
        )
    ]
    assert _proof4({"editor": "app settings", "over": None, "app": _app()}) == []


def test_a_second_vellum_save_is_compared_with_the_first():
    first, second = _app(), _app()
    first["walks"]["m0/m0-f0"]["steps"][2]["form"]["title"] = "Registrar"
    second["walks"]["m0/m0-f0"]["steps"][2]["form"]["title"] = "Registrar"
    record = {
        "configurations": {
            "minimum": {
                "B": {"app": _app()},
                "saves": {
                    "B": [
                        {"label": "vellum:m0.f0", "editor": "vellum", "over": None, "app": first},
                        {
                            "label": "vellum again:m0.f0",
                            "editor": "vellum again",
                            "over": "vellum:m0.f0",
                            "app": second,
                        },
                    ]
                },
            }
        }
    }
    assert _paths(android.editability("document", record)) == [
        ("android@vellum@B@minimum", "/walks/*/steps/*/form/title", "changed")
    ]


def test_an_update_reports_each_of_the_workers_own_settings_it_replaced_and_none_it_kept():
    update = _update()
    update["after"]["stored"].update({"cc-enable-tts": "no", "cc-fuzzy-search-enabled": "yes"})
    found = _proof4({"editor": "app settings", "over": None, "app": _app(), "update": update})
    assert _paths(found) == [("android@app settings@B@minimum", "/update/workerSettings/cc-enable-tts", "changed")]
    assert (found[0].before, found[0].after) == ("yes", "no")
    assert _proof4({"editor": "app settings", "over": None, "app": _app(), "update": _update()}) == []


def _installs(*statuses):
    held, steps = [], []
    for index, status in enumerate(statuses):
        if status == "Installed":
            held.append(f"app-{index}")
        steps.append({"install": status, "installedApps": list(held)})
    return {"installs": steps}


def _reopening(*, opens=True):
    saved = {
        "walk": {"steps": [{"screen": "FormEntryActivity", "loaded": True}]},
        "records": [{"status": "incomplete", "AndroidCommCarePlatform.getFormDefId": "held"}],
    }
    reopened = {
        "screen": "FormEntryActivity",
        "form": {"loaded": True, "alert": None},
        "records": [{"status": "incomplete", "AndroidCommCarePlatform.getFormDefId": "held"}],
    }
    if not opens:
        reopened["form"] = {"loaded": False, "alert": {"title": "Error Occurred", "msg": "No XForm definition"}}
        reopened["records"][0]["AndroidCommCarePlatform.getFormDefId"] = "none"
    return {"incompleteForms": {"m0-f0": saved}, "reopened": {"m0-f0": reopened}}


def _proof1(local_installs, local_update, hq_update=None):
    record = {
        "local": {"installs": local_installs, "update": local_update},
        "configurations": {
            "minimum": {"installs": _installs("Installed", "DuplicateApp"), "update": hq_update or _update()}
        },
    }
    return android.identity("document", record)


def test_two_exports_that_install_and_update_as_hqs_builds_do_report_nothing():
    assert _proof1(_installs("Installed", "DuplicateApp"), _update()) == []


def test_an_update_to_another_app_or_a_lower_version_is_reported_where_both_paths_installed_one():
    other = _update()
    other["after"]["app"] = {"uniqueId": "another", "versionNumber": 2}
    assert _paths(_proof1(_installs("Installed", "DuplicateApp"), other)) == [
        ("android@local.ccz", "/updated/sameApp", "changed"),
        ("android@local.ccz", "/updated/versionLower", "changed"),
    ]


def test_two_exports_that_install_as_two_apps_and_do_not_update_are_two_differences():
    other = _update(staged="UpToDate", updated="UnknownFailure")
    found = _proof1(_installs("Installed", "Installed"), other)
    assert _paths(found) == [
        ("android@local.ccz", "/installs/*", "changed"),
        ("android@local.ccz", "/update", "changed"),
    ]
    values = {difference.path: (difference.before, difference.after) for difference in found}
    assert values["/installs/*"] == ("DuplicateApp", "Installed")
    assert values["/update"] == ("Installed", "UpToDate")


def test_an_incomplete_form_that_no_longer_opens_after_an_update_is_reported_on_its_own_path():
    kept = _update(**_reopening())
    lost = _update(**_reopening(opens=False))
    assert _proof1(_installs("Installed", "DuplicateApp"), kept, kept) == []
    found = _proof1(_installs("Installed", "DuplicateApp"), kept, lost)
    assert _paths(found) == [("android@B", "/update/reopened/*", "changed")]
    assert found[0].at == "/update/reopened/m0-f0"
    assert found[0].before == {"opened": True, "held": [["incomplete", "held"]]}
    assert found[0].after["held"] == [["incomplete", "none"]] and found[0].after["alert"] == "Error Occurred"
    assert _paths(_proof1(_installs("Installed", "DuplicateApp"), lost, kept)) == [
        ("android@local.ccz", "/update/reopened/*", "changed")
    ]


def test_a_stored_session_home_cannot_read_is_that_forms_own_symptom():
    """A menu with grouped tiles on a device: the session Android kept ends at a datum with no value, and home
    raises reading it, on HQ's build and the local archive alike."""
    unread = _update(**_reopening())
    unread["reopened"]["m0-f0"] = {
        "records": [{"status": "incomplete", "AndroidCommCarePlatform.getFormDefId": "held"}],
        "SessionStateDescriptor.getSessionDescriptor": "COMMAND_ID m0-f0 CASE_ID case_id c CASE_ID case_id_parent_ids",
        "homeRaised": {"class": "java.lang.ArrayIndexOutOfBoundsException", "message": "Index 7", "stack": "..."},
    }
    found = _proof1(_installs("Installed", "DuplicateApp"), unread, unread)
    assert _paths(found) == [
        ("android@B", "/update/reopened/*/session", "changed"),
        ("android@local.ccz", "/update/reopened/*/session", "changed"),
    ]
    assert found[0].at == "/update/reopened/m0-f0/session"
    assert found[0].before == {"kept": "COMMAND_ID m0-f0 CASE_ID case_id c CASE_ID case_id_parent_ids"}
    assert found[0].after == {"raised": "java.lang.ArrayIndexOutOfBoundsException", "message": "Index 7"}


def test_a_form_the_device_refused_and_yet_applied_is_reported_of_that_archive_alone():
    """Android applies a form's case blocks in one transaction: a refused form that changed the device's cases
    is a difference of its own, on whichever archive shows it, and one that left them as they were is none."""
    kept, half = _app(), _app()
    for answer, as_opened in ((kept, True), (half, False)):
        saved = answer["walks"]["m0/m0-f0"]["steps"][2]["form"]["saved"]
        saved.update(finishing=False, alert={"title": "Error Saving your Form"}, casesAsTheFormOpened=as_opened)
        del answer["walks"]["m0/m0-f0"]["steps"][3]
    assert _proof3(kept, a=kept) == []
    found = _proof3(half, a=kept)
    assert ("android@local.ccz", "/walks/*/steps/*/form/saved/applied-though-refused", "error") in _paths(found)
    refused = next(d for d in found if d.path.endswith("applied-though-refused"))
    assert refused.at == "/walks/m0~1m0-f0/steps/2/form/saved/applied-though-refused"
    assert refused.after["alert"] == "Error Saving your Form"
    save = {"label": "vellum:m0.f0", "editor": "vellum", "over": None, "app": half, "update": None}
    assert ("android@vellum@B@minimum", "/walks/*/steps/*/form/saved/applied-though-refused", "error") in _paths(
        _proof4(save, base=kept)
    )
