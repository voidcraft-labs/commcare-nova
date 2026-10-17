"""An app HQ's own pages made with grouped tiles: a form left incomplete for a case with no parent does not reopen.

Contract (``proof.checks.hq_own_reports``, member ``android_grouped_tile_reopen``): home raising on a form left
incomplete under grouped tiles, for a case with no connection of the grouping's name, is what CommCare does itself
with any app HQ builds. HQ's build gives every form that loads a case under grouped tiles the datum
``case_id_parent_ids``, the ids of the case's parents joined by spaces
(``suite_xml/sections/entries.py::EntriesHelper.get_extra_case_id_datums``), which is empty for a case with no
parent; commcare-core writes the session Android keeps for an incomplete form as its steps joined by spaces and
trims it (``session/SessionDescriptorUtil.createSessionDescriptor``), so it ends at that datum's id, and reads it
back by splitting it on spaces and taking a value after every datum's id (``loadSessionFromDescriptor``), which
commcare-android calls to reopen the form (``models/AndroidSessionWrapper.loadFromStateDescription``).

The app holds no Nova byte. HQ's own views make it (``default_new_app``, a case menu by ``new_module``, whose
follow-up form is HQ's own); HQ's Case List save (``views/modules.py::edit_module_detail_screens``) gives the menu
the tiles HQ's Case List page offers under the tile flag (``CASE_LIST_TILE``: the ``person_simple`` template, its
fields mapped to case properties, grouped by the ``parent`` connection, ``app.supports_grouped_case_tiles``); HQ's
form builder, Vellum in HQ's page, opens and saves the follow-up form; HQ releases the app as its Releases page
does (``proof.formplayer.hq.serve``), then again after the form is renamed on HQ's form settings save
(``views/forms.py::edit_form_attr``). The Android reader installs the first release as a worker installs it from a
file, leaves every form incomplete, updates to the second release and reopens each form
(``proof.android.observe.update``).

Built from the commcare-android pin beside the commcare-core pin (``proof/android/build-runtime.sh``), this test is
also the upstream witness: at a commcare-core pin whose reader takes a datum with no value, the session with no
parent reopens, this test fails, and the member leaves the set in that pin's pull request.

The plausible failures: an allowance that holds where HQ's own app reopens the form (a case with a parent), and one
whose condition is not the session this app's device keeps.
"""

from __future__ import annotations

import json

import pytest

from proof.checks import android as judge
from proof.checks import casedata, hq_own_reports
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

pytestmark = pytest.mark.reader("android")

CONFIGURATION = Configuration(privileges={"CLOUDCARE"}, flags={"CASE_LIST_TILE"})
CASE_TYPE = "visit"
PARENT_TYPE = "household"
# HQ's new case menu holds its registration form, then its follow-up form: the follow-up's command.
FOLLOWUP = "m0-f1"
# The tile template HQ's Case List page offers under CASE_LIST_TILE, each of its fields a case property
# (``suite_xml/case_tile_templates/person_simple.json``).
TILE_FIELDS = (("header", "name"), ("top_left", "village"), ("sex", "sex"), ("bottom_left", "age"), ("date", "seen"))


def _hq(state, name, *args, data=None):
    """HQ's view ``name`` answering the request its page sends: a GET, or a POST of ``data`` (name, value) pairs."""
    from django.urls import resolve, reverse

    from proof.hq import requests as hq_requests

    path = reverse(name, args=[state.domain, *args])
    request = hq_requests.get(state, path) if data is None else hq_requests.form_post(state, path, data)
    match = resolve(path)
    response = match.func(request, *match.args, **match.kwargs)
    assert response.status_code < 400, (name, response.status_code, response.content[:600])
    return response


def _tiled_case_menu(state, editor_driver):
    """A new app with one case menu whose case list groups its tiles by parent, as HQ's own pages make it; returns
    (app id, its follow-up form's unique id)."""
    from corehq.apps.app_manager.dbaccessors import get_app_ids_in_domain

    from proof.editors import vellum

    _hq(state, "default_new_app")
    (app_id,) = get_app_ids_in_domain(state.domain)
    _hq(state, "new_module", app_id, data=[("name", "Visits"), ("module_type", "case"), ("case_type", CASE_TYPE)])
    module = operations.held_app(state, app_id).modules[0]
    columns = [
        {"header": {"en": field}, "model": "case", "field": field, "format": "plain", "case_tile_field": tile}
        for tile, field in TILE_FIELDS
    ]
    _hq(
        state,
        "edit_module_detail_screens",
        app_id,
        module.unique_id,
        data=[
            ("type", json.dumps("case")),
            ("short", json.dumps(columns)),
            ("caseTileTemplate", json.dumps("person_simple")),
            ("case_tile_group", json.dumps({"index_identifier": "parent", "header_rows": 2})),
        ],
    )
    module = operations.held_app(state, app_id).modules[0]
    assert module.has_grouped_tiles(), module.case_details.short.to_json()
    followup = module.forms[1]
    assert followup.requires == "case"
    run = vellum.open_and_save(editor_driver, state, app_id, followup.unique_id)
    assert run.loaded and run.saved, (run.load_error, run.save_refusal)
    return app_id, followup.unique_id


def _stamp(minute):
    return f"2025-12-01T08:{minute:02d}:00.000000Z"


def _case(case_id, case_type, name, minute, indices=()):
    return casedata.CaseRecord(
        case_id=case_id,
        case_type=case_type,
        name=name,
        owner_id=casedata.USER_ID,
        opened_on=_stamp(minute),
        modified_on=_stamp(minute),
        external_id=None,
        properties=(("village", "Hill"), ("sex", "f"), ("age", "7"), ("seen", "2026-01-10"))
        if case_type == CASE_TYPE
        else (),
        indices=tuple(indices),
    )


def _database(*cases):
    return casedata.CaseDatabase(user_id=casedata.USER_ID, username=casedata.USERNAME, user_data=(), cases=cases)


# The worker's one visit, with no household; and with the household it belongs to (a parent before its child).
ALONE = _database(_case("visit-alone", CASE_TYPE, "Ada", 0))
WITH_PARENT = _database(
    _case("household-1", PARENT_TYPE, "Hill house", 0),
    _case("visit-with-parent", CASE_TYPE, "Bo", 1, [("parent", PARENT_TYPE, "household-1", "child")]),
)


@pytest.fixture(scope="module")
def reopened(hq, editor_driver, lane_services):
    """What a device makes of HQ's own app: the first release installed, every form left incomplete, the update to
    the second release, and each form reopened; for the visit with no parent and for the one with a parent."""
    from proof.android import observe as android
    from proof.formplayer import hq as formplayer_hq
    from proof.observe.record import Blobs

    blobs, found = Blobs(), {}
    with hq_check(CONFIGURATION) as (state, _):
        app_id, form_id = _tiled_case_menu(state, editor_driver)
        with formplayer_hq.serve(state, None, app_id, database=ALONE, label="first") as served:
            first = android.release_archive(served)
        # A person renames the follow-up form on HQ's form settings, and HQ releases the app again.
        _hq(state, "edit_form_attr", app_id, form_id, "name", data=[("name", "Visit again")])
        for name, database in (("alone", ALONE), ("with-parent", WITH_PARENT)):
            with formplayer_hq.serve(state, None, app_id, database=database, label=f"second-{name}") as served:
                second = android.release_archive(served)
                answer = android.update(served, blobs, label=name, before=first, after=second, incomplete=True)
            found[name] = blobs.get_json(answer["answer"])
    return found


def test_android_grouped_tile_reopen(reopened):
    """The visit with no parent: Android kept a session that ends at the empty parent ids, and home raises reopening
    it; the member's condition holds on the answer, and proof 1's Android comparison reports nothing of it."""
    update = reopened["alone"]
    assert (update["staged"], update["updated"]) == ("UpdateStaged", "Installed"), update
    form = update["reopened"][FOLLOWUP]
    descriptor = form.get("SessionStateDescriptor.getSessionDescriptor") or ""
    assert descriptor.endswith(f"CASE_ID {hq_own_reports.PARENT_IDS_DATUM}"), descriptor
    assert form["homeRaised"]["class"] == hq_own_reports.OUT_OF_BOUNDS, form["homeRaised"]
    assert hq_own_reports.reopen_ends_at_empty_parent_ids(form)
    session = hq_own_reports.REOPENED_SESSION
    for artifact in ("android@B", "android@local.ccz"):
        reported = [at for path, at, _, _ in judge.not_reopened(update, artifact) if path == session]
        assert reported == [], reported


def test_a_form_left_for_a_visit_with_a_parent_reopens(reopened):
    """The control: the visit with a parent keeps a session whose parent ids hold a value, and home reopens it."""
    update = reopened["with-parent"]
    assert (update["staged"], update["updated"]) == ("UpdateStaged", "Installed"), update
    form = update["reopened"][FOLLOWUP]
    assert "homeRaised" not in form, form["homeRaised"]
    assert form["form"]["loaded"], form
    assert not hq_own_reports.reopen_ends_at_empty_parent_ids(form)
    assert (form.get("SessionStateDescriptor.getSessionDescriptor") or "").endswith(" household-1"), form
