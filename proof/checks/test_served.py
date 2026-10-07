"""A document's app served to Formplayer and the Web Apps client: what the lane's own two readers are held to.

Contracts (``proof.observe.served``, ``proof.formplayer.hq``, ``proof.checks.served``):

- **What answers Formplayer is HQ.** Every request Formplayer makes of HQ
  while it walks a served state is answered by the view HQ's URLconf names
  (the session's user, the archive, the restore, a submission), a
  submission is one HQ's receiver processed into its own tables, and a
  session HQ does not hold is refused by HQ, so Formplayer refuses the
  worker. Plausible failures: a request answered from outside HQ, a
  submission answered without being processed, a walk that would pass with
  no worker signed in.
- **A run leaves nothing for the next.** The cases a run's submission made
  are in HQ while the run lasts and gone after it, and the unit is where it
  was once the state is no longer served. Plausible failure: a run that
  reads what an earlier run's submission made.
- **The same inputs give the same bytes.** A state served twice gives one
  Formplayer trace and one record of the client's screens. Plausible
  failures: an id HQ, Formplayer or the browser drew left in a record; a
  request of HQ keyed by something a run does not decide.
- **Each reader shows a planted difference, and only it.** The same state
  with one menu renamed in the stored app gives a Formplayer trace and
  client screens that differ from the baseline's exactly where the menu's
  name is read. Plausible failures: a walk or a screen reading that loses a
  difference, or a comparison that reports one where the states agree.
- **The release is the build.** The archive HQ's download serves of the
  release holds the files of the build the other checks read; a file that
  differs is named.
- **One symptom is one difference** (the comparator, on records alone): a
  list in another order is its order; a response of another kind is its
  kind; a refused submission is its status and nothing that follows from
  it; a generated id's number and a build's version are no difference; the
  client's own home tiles are read by their kind.
"""

from __future__ import annotations

import copy

import pytest

from proof.checks import cases
from proof.checks import served as compare
from proof.observe.record import Blobs, canonical

DOCUMENT = "targeted-survey-menu"
PLANTED = "Planted menu name"


def _document():
    return cases.load_corpus().document(DOCUMENT)


@pytest.fixture(scope="module")
def observed(hq, core_runner, formplayer_runner, editor_driver):
    """A served twice, and once more with one menu renamed in the stored app, each as its record and trace."""
    from corehq.form_processor.models import CommCareCase

    from proof.formplayer import apps
    from proof.observe import served

    document = _document()
    blobs = Blobs()
    found = {"blobs": blobs}

    def rename(stored):
        stored["modules"][0]["name"] = {lang: PLANTED for lang in stored["modules"][0]["name"]}

    with apps.published(document, core_runner) as published:
        unit = published.unit
        before = (unit.key, len(CommCareCase.objects.get_case_ids_in_domain(unit.domain)))
        for name, change in (("first", None), ("again", None), ("planted", rename)):
            with served.serving(
                unit, document, published.app_id, driver=editor_driver, blobs=blobs, label=name, change=change
            ) as held:
                side, trace = held.formplayer()
                found[name] = {
                    "side": side,
                    "trace": trace,
                    "screens": blobs.get_json(held.webapps(trace)),
                    "exchanges": list(held.served.hq.exchanges),
                    "release": held.release_differs(published.build.files),
                    "planted_release": held.release_differs(
                        {**published.build.files, "suite.xml": published.build.files["suite.xml"] + b"<!-- planted -->"}
                    ),
                    "cases_while_served": len(CommCareCase.objects.get_case_ids_in_domain(unit.domain)),
                }
        found["unit"] = (before, (unit.key, len(CommCareCase.objects.get_case_ids_in_domain(unit.domain))))
    return found


def test_hqs_own_views_answer_formplayer_and_its_receiver_processes_each_submission(observed):
    first = observed["first"]
    asked = {(entry.url_name, entry.status) for entry in first["exchanges"]}
    assert asked == {
        ("session_details", 200),
        ("direct_ccz", 200),
        ("ota_restore", 200),
        ("receiver_post_with_app_id", 201),
    }
    assert not [entry for entry in first["exchanges"] if entry.raised or entry.logged]
    runs = first["trace"]["runs"]
    assert runs and all(run["end"] == "submitted" for run in runs)
    # Each submission wrote HQ's state (the form HQ's receiver saved), and none was only answered.
    received = [entry for entry in first["exchanges"] if entry.url_name == "receiver_post_with_app_id"]
    assert len(received) == len(runs) and all(entry.wrote for entry in received)
    assert first["side"]["hq"] == []


def test_a_session_hq_does_not_hold_is_refused_by_hq_where_the_workers_own_is_answered(
    hq, core_runner, formplayer_runner
):
    from proof.formplayer import apps
    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer.webapps import FormplayerRefused, WebApps

    document = _document()
    with apps.published(document, core_runner) as published:
        with formplayer_hq.serve(published.unit, document, published.app_id, runner=formplayer_runner) as served:
            with served.run("accepted"):
                web = WebApps(
                    formplayer_runner,
                    served.hq,
                    domain=served.domain,
                    username=served.username,
                    app_id=served.build_id,
                    session_key=served.hq.session_key,
                )
                assert web.navigate([])["type"] == "commands"
            with served.run("refused"):
                web = WebApps(
                    formplayer_runner,
                    served.hq,
                    domain=served.domain,
                    username=served.username,
                    app_id=served.build_id,
                    session_key="a-session-hq-never-made",
                )
                with pytest.raises(FormplayerRefused):
                    web.navigate([])
            refused = served.hq.exchanges[-1]
            assert (refused.url_name, refused.status) == ("session_details", 404)


def test_a_run_leaves_hq_as_it_found_it(observed):
    before, after = observed["unit"]
    assert before == after
    # While a state is served HQ holds the worker's cases, and no run's submission stays beyond its run.
    assert observed["first"]["cases_while_served"] == observed["again"]["cases_while_served"] >= before[1]


@pytest.mark.under_determinism
def test_a_state_served_twice_gives_the_same_bytes(observed):
    first, again = observed["first"], observed["again"]
    assert canonical(first["trace"]) == canonical(again["trace"])
    assert first["side"] == again["side"]
    assert canonical(first["screens"]) == canonical(again["screens"])
    assert (
        compare.formplayer_differences(first["trace"], again["trace"], check="proof3", document="d", artifact="a") == []
    )
    assert (
        compare.webapps_differences(first["screens"], again["screens"], check="proof3", document="d", artifact="a")
        == []
    )


def test_each_reader_shows_a_planted_difference_and_only_it(observed):
    first, planted = observed["first"], observed["planted"]
    for found in (
        compare.formplayer_differences(first["trace"], planted["trace"], check="proof3", document="d", artifact="a"),
        compare.webapps_differences(first["screens"], planted["screens"], check="proof3", document="d", artifact="a"),
    ):
        assert found
        # The rename is a save of the app, which moves its version, and with no earlier build to compare with HQ
        # gives every form the app's version: the one other thing the two releases differ in.
        stray = [
            (d.at, d.kind, d.before, d.after)
            for d in found
            if not (d.kind == "changed" and PLANTED in str(d.after) and PLANTED not in str(d.before))
            and not d.path.endswith("/data/@version")
        ]
        assert not stray, stray
    # The client shows the menu's name where a worker reads it: the app's first screen.
    assert PLANTED in [command["text"] for command in planted["screens"]["runs"][0]["screens"][0]["commands"]]
    assert PLANTED not in str(first["screens"])


def test_the_release_is_the_build_and_a_file_that_differs_is_named(observed):
    assert observed["first"]["release"] is None
    assert observed["first"]["planted_release"] == {"differing": ["suite.xml"]}


# The comparator, on records alone ---------------------------------------------------------------------------


def _trace(*steps, end="menu"):
    return {"derived": True, "generated": 3, "runs": [{"script": [], "end": end, "steps": list(steps)}]}


def _list(*case_ids, **more):
    entities = [{"id": case_id, "data": [case_id.upper()]} for case_id in case_ids]
    return {"request": {"selections": []}, "asked": [], "response": {"type": "entities", "entities": entities, **more}}


def _paths(found):
    return sorted({(d.path, d.kind) for d in found})


def _compared(before, after, **more):
    return compare.formplayer_differences(before, after, check="proof3", document="d", artifact="a", **more)


def test_a_list_in_another_order_is_its_order_and_a_changed_row_is_that_row():
    assert _paths(_compared(_trace(_list("a", "b")), _trace(_list("b", "a")))) == [
        ("/runs/*/steps/*/response/entityOrder/*", "changed")
    ]
    changed = _trace(_list("a", "b"))
    changed["runs"][0]["steps"][0]["response"]["entities"][1]["data"] = ["other"]
    found = _compared(_trace(_list("a", "b")), changed)
    assert [(d.path, d.at) for d in found] == [
        ("/runs/*/steps/*/response/entities/*/data/*", "/runs/0/steps/0/response/entities/b/data/0")
    ]


def test_a_response_of_another_kind_is_its_kind_alone():
    refused = {
        "request": {"selections": []},
        "asked": [],
        "response": {"status": "error", "exception": "<!DOCTYPE html><html>a page</html>", "url": "http://x:1/y"},
    }
    found = _compared(_trace(_list("a", title="Cases", headers=["Name"])), _trace(refused))
    assert [(d.path, d.before, d.after) for d in found] == [
        ("/runs/*/steps/*/response/type", "entities", "error: <an HTML page>")
    ]


def test_a_refused_submission_is_its_status_and_nothing_that_follows_from_it():
    def form(status, message=None):
        submit = {"status": status, "nextScreen": {"type": "commands"} if status == "success" else None}
        if message:
            submit["notification"] = {"message": message, "error": True}
        sent = [{"path": "/r", "instance": "<data xmlns='x'/>", "files": 0}] if status == "success" else []
        return {"answers": [], "submit": submit, "asked": [["receiver", "201"]] if sent else [], "submissions": sent}

    taken = _trace(form("success"), end="submitted")
    refused = _trace(form("error", "No submission address"), end="submit-refused")
    found = _compared(taken, refused)
    assert [(d.path, d.before, d.after) for d in found] == [
        ("/runs/*/steps/*/submit/status", "success", "error: No submission address")
    ]
    assert _compared(taken, copy.deepcopy(taken)) == []


def test_a_generated_ids_number_and_a_builds_version_are_no_difference_and_a_forms_version_is_the_version_clauses():
    def opened(session, version, app_version):
        instance = f"<data xmlns='http://form' version='{version}'><q>1</q></data>"
        return _trace(
            {
                "request": {"selections": ["0"]},
                "asked": [],
                "response": {
                    "session_id": session,
                    "tree": [],
                    "appVersion": app_version,
                    "instanceXml": {"output": instance},
                },
            }
        )

    before = opened("@generated:uuid:5", "2", "Formplayer Version: 2.64, App Version: 2")
    after = opened("@generated:uuid:3", "4", "Formplayer Version: 2.64, App Version: 4")
    # The form's version differs: a difference, unless the form's content differs between the builds.
    assert _paths(_compared(before, after)) == [
        ("/runs/*/steps/*/response/instanceXml/output/data/@version", "changed")
    ]
    assert _compared(before, after, versions=({"http://form": "2"}, {"http://form": "4"})) == []


def test_the_clients_own_home_tiles_are_read_by_their_kind_and_a_lists_rows_by_their_case():
    def screens(*tiles, rows=("a", "b")):
        home = {"route": "", "alerts": [], "apps": [{"name": name, "kind": kind} for name, kind in tiles]}
        listed = {"rows": [{"id": f"row-{row}", "cells": [{"text": row}]} for row in rows], "tiles": False}
        return {
            "runtime": {"chromium": "1"},
            "build": {"version": 1},
            "home": home,
            "runs": [{"script": [], "screens": [{"list": listed, "version": "v1"}]}],
        }

    full = screens(("App", "default"), ("Incomplete Forms", "incomplete"), ("Sync", "sync"))
    without = screens(("App", "default"), ("Sync", "sync"))
    found = compare.webapps_differences(full, without, check="proof3", document="d", artifact="a")
    assert [(d.path, d.kind) for d in found] == [("/home/tiles/incomplete", "removed")]
    reordered = screens(("App", "default"), ("Incomplete Forms", "incomplete"), ("Sync", "sync"), rows=("b", "a"))
    found = compare.webapps_differences(full, reordered, check="proof3", document="d", artifact="a")
    assert _paths(found) == [("/runs/*/screens/*/list/rowOrder/*", "changed")]


def test_each_request_hq_refused_is_a_difference_by_its_view_its_status_and_what_hq_raised():
    refusals = [
        {"view": "app_aware_remote_search", "method": "POST", "status": 400, "said": "not a date"},
        {"view": "ota_restore", "method": "GET", "status": 500, "raised": "builtins.KeyError", "error": ["KeyError"]},
    ]
    found = compare.refusal_differences(refusals, check="proof3", document="d", artifact="formplayer@A")
    assert [(d.path, d.kind) for d in found] == [
        ("/hq/app_aware_remote_search/400", "error"),
        ("/hq/ota_restore/500/builtins.KeyError", "error"),
    ]
    assert compare.refusal_differences([], check="proof3", document="d", artifact="formplayer@A") == []
