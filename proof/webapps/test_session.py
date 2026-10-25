"""The Web Apps session itself: what answers the page, and what a run may claim.

Contracts (``proof.webapps.session``, ``proof.webapps.hq``):

- **What runs is HQ's own page, client and Formplayer.** The navigation is
  answered by HQ's ``FormplayerMain`` view, the script the page loads is the
  bundle built from HQ's ``cloudcare/js/formplayer/main`` entry, the page
  itself asks HQ for nothing it is refused, and the screens come from
  Formplayer's own answers to the client's own requests, each of which
  asked HQ who the worker is. The plausible failure is a page that renders
  from anything but those (a stubbed answer, a script of the harness's own).
- **HQ lists an app by its build's setting, and serves Web Apps to a mobile
  worker only with the privilege.** Nova's update writes the declaration as
  ``cloudcare_enabled`` with no privilege check, so a released build of an
  app that declares Web Apps carries it true and HQ lists that build
  (``cloudcare/utils.py::get_web_apps_available_to_user``) whatever the plan;
  without the privilege HQ's ``FormplayerMain`` answers the release's mobile
  worker with its 402 page (``requires_privilege_for_commcare_user``), and
  with it the page answers. The plausible failure is a configuration that
  grants the privilege for nothing, or a page HQ would serve the worker
  either way.
- **Web Apps lists an app only while it declares Web Apps.** D of
  ``targeted-platform-declaration`` runs on both and its release is on the
  worker's home and in HQ's listing; D′, narrowed to Android only, is
  stored with ``cloudcare_enabled`` false once Nova's update lands, and its
  release is on neither. The plausible failures are an update HQ does not
  keep, and a home that lists an app declared Android only.
- **The page is laid out under HQ's stylesheets, found by HQ's finders.**
  HQ's own precompiler compiles the page's SCSS and HQ's static finders
  serve what they hold; a path none holds, or one that climbs out of the
  static directories, is not served. The plausible failure is a page with
  no stylesheet, whose computed styles are the browser's defaults.
- **Formplayer's own rule admits the page.** Formplayer answers a request
  from an origin other than HQ's with its own refusal, and the session's
  requests, which name HQ as Formplayer knows it, are answered. The
  plausible failure is a session that reaches Formplayer around its
  security chain.
- **A step that finds nothing fails the run by name**, with the page as it
  stood, where the same click on what is there goes through.
- **Each build has an id of its own, and a session runs its own build.**
  Formplayer keeps an install by the id it was asked for, and HQ's seeded
  entropy draws the same id wherever an operation's key is the same. Two
  releases of the same stored app share an id (the same inputs give the
  same bytes); a release of the app with one menu renamed has another, and
  its session shows the renamed menu. The plausible failure is a release
  keyed by something other than its content, whose session would run the
  install of the release before it.
"""

from __future__ import annotations

import pytest

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session, WebAppsRunFailed

TILES = "targeted-custom-tile"
DECLARATION = "targeted-platform-declaration"
BUNDLE = "/static/webpack/cloudcare/js/formplayer/main.js"


def test_the_page_is_hqs_own_view_and_bundle_and_its_screens_are_formplayers_answers(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents
):
    with webapps_hq.project(webapps_documents[TILES]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run(
                [{"eval": "() => [...document.scripts].map((script) => script.getAttribute('src'))"}, steps.SCREEN]
                + [*steps.open_app("Visit tiles"), steps.SCREEN]
            )
            build_id, app_id, username = release.build_id, project.app_id, release.username
    navigation = run.hq[0]
    assert navigation.path == session.home and navigation.status == 200
    assert navigation.view.startswith("corehq.apps.cloudcare.views.")
    assert BUNDLE in run.value(0)
    assert run.page_errors == []
    # HQ answered everything the page asked it, and the page was laid out under HQ's own compiled stylesheets.
    assert [e for e in run.hq if e.status >= 400] == []
    assert all(status == 200 for _, status in run.statics)
    compiled = [path for path, _ in run.statics if path.startswith("/static/CACHE/css/")]
    assert any("formplayer-webapp" in path for path in compiled) and any("commcarehq" in path for path in compiled)
    # The app on the home screen is the one HQ released, and its menu is Formplayer's answer for that build.
    assert run.screens[0]["apps"][0]["name"] == "Visit tiles"
    started = run.answered("navigate_menu_start")
    assert len(started) == 1 and started[0].status == 200
    assert started[0].request_json()["app_id"] == build_id
    assert started[0].request_json()["username"] == username
    assert ("POST", "/hq/admin/session_details/") in started[0].asked
    assert [command["displayText"] for command in started[0].json()["commands"]] == [
        command["text"] for command in run.screens[1]["commands"]
    ]
    # The client names the app in its route by the app's own id, and asks Formplayer for the build.
    assert run.screens[1]["route"]["appId"] == app_id != build_id


def _web_apps_page_status(release):
    """The status HQ's own ``FormplayerMain`` view answers the release's mobile worker with, the request built as
    HQ's middleware attaches a signed-in user (``proof.hq.requests``)."""
    from django.urls import resolve

    from proof.hq import requests as hq_requests

    path = f"/a/{release.domain}/cloudcare/apps/v2/"
    match = resolve(path)
    request = hq_requests.get(webapps_hq.Worker(release.domain, release.worker), path)
    return match.func(request, *match.args, **match.kwargs).status_code


def test_hq_lists_an_app_by_its_builds_setting_and_serves_web_apps_to_a_worker_only_with_the_privilege(
    hq, formplayer_runner, webapps_documents
):
    """Finding 64: Nova's update writes ``cloudcare_enabled`` from the declaration, so the released build carries
    it and HQ lists it with or without the privilege; Web Apps itself answers a mobile worker without the privilege
    with HQ's 402 page (``cloudcare/views.py::FormplayerMain.dispatch``). Without the privilege HQ's create stored
    the app with Web Apps off, a state Nova's publish stops at (``hq_plan_lacks_web_apps``), which the test reaches
    on purpose (``webapps_hq.project`` passes ``plan_without_web_apps``)."""
    from corehq.apps.cloudcare.utils import get_web_apps_available_to_user

    offered = {}
    for name, web_apps in (("without Web Apps", False), ("the lane's configuration", True)):
        with webapps_hq.project(webapps_documents[TILES], web_apps=web_apps) as project:
            with project.released(formplayer_runner) as release:
                listed = get_web_apps_available_to_user(project.domain, release.worker)
                offered[name] = (
                    release.doc["cloudcare_enabled"],
                    [app["_id"] == release.build_id for app in listed],
                    _web_apps_page_status(release),
                )
    assert offered == {
        "without Web Apps": (True, [True], 402),
        "the lane's configuration": (True, [True], 200),
    }, offered


def test_web_apps_lists_an_app_while_it_declares_web_apps_and_not_once_it_narrows_to_android(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents
):
    """D declares nothing, so it runs on both: its release stores ``cloudcare_enabled`` true, the worker's home
    shows its tile (kind ``default``, beside the home's own tiles) and HQ lists its build. D′ declares Android
    only: Nova's captured update writes false, which HQ's update keeps, and its release is on neither the home
    nor the listing (``cloudcare/utils.py::get_web_apps_available_to_user``)."""
    from corehq.apps.cloudcare.utils import get_web_apps_available_to_user

    from proof.observe import publish

    document = webapps_documents[DECLARATION]
    seen = {}
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner) as release:
            run = Session(release, editor_driver).run([steps.SCREEN])
            listed = get_web_apps_available_to_user(project.domain, release.worker)
            seen["D"] = (
                release.doc["cloudcare_enabled"],
                [tile["kind"] for tile in run.screens[0]["apps"] if tile["kind"] == "default"],
                [app["_id"] == release.build_id for app in listed],
            )
        with project.unit.fork():
            refusal, _ = publish.update(project.unit, project.app_id, document.edit.exports["minimum"].update, "B-edit")
            assert refusal is None, refusal
            with project.released(formplayer_runner) as release:
                run = Session(release, editor_driver).run([steps.SCREEN])
                listed = get_web_apps_available_to_user(project.domain, release.worker)
                seen["D-edit"] = (
                    release.doc["cloudcare_enabled"],
                    [tile["kind"] for tile in run.screens[0]["apps"] if tile["kind"] == "default"],
                    [app["_id"] == release.build_id for app in listed],
                )
    assert seen == {"D": (True, ["default"], [True]), "D-edit": (False, [], [])}, seen


def test_hqs_finders_serve_the_static_files_they_hold_and_nothing_else(hq):
    from proof.webapps import static

    held = static.serve("/static/nprogress/nprogress.css")
    assert held is not None and held.status == 200 and held.body
    assert dict(held.headers)["Content-Type"] == "text/css"
    assert static.serve("/static/no/such/file.css") is None
    assert static.serve("/static/../settings.py") is None
    assert static.serve("/elsewhere/nprogress/nprogress.css") is None


def test_formplayer_refuses_another_origin_and_answers_the_origin_it_knows_hq_by(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents
):
    with webapps_hq.project(webapps_documents[TILES]) as project:
        with project.released(formplayer_runner) as release:
            body = {"domain": project.domain, "username": release.worker.username, "app_id": release.build_id}
            answers = {}
            with release.run("origin"):
                for name, origin in (
                    ("elsewhere", "http://elsewhere.proof.test"),
                    ("hq", formplayer_runner.ready["hq"]),
                ):
                    exchange = formplayer_runner.http(
                        "/navigate_menu_start",
                        body,
                        headers=[("Origin", origin), ("Cookie", f"sessionid={release.hq.session_key}")],
                        hq=release.hq,
                    )
                    answers[name] = (exchange.response.status, exchange.response.body[:60])
    assert answers["elsewhere"] == (403, b"Invalid CORS request")
    # From HQ's origin the same request passes that rule; with no CSRF token it is Formplayer's next rule that
    # answers, which a browser's own first request (the session's) is what satisfies.
    assert answers["hq"][1] != b"Invalid CORS request"


def test_a_click_on_nothing_fails_the_run_by_name_and_the_same_click_on_what_is_there_goes_through(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents
):
    with webapps_hq.project(webapps_documents[TILES]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            with pytest.raises(WebAppsRunFailed, match="No such app") as refused:
                session.run(steps.open_app("No such app"), deadline=20.0)
            run = session.run([*steps.open_app("Visit tiles"), steps.SCREEN])
    assert "webapps/click" in str(refused.value)
    assert run.screens[0]["title"] == "Visit tiles"


@pytest.mark.under_determinism
def test_each_build_has_an_id_of_its_own_and_its_session_runs_it(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents
):
    def renamed(doc):
        doc["modules"][0]["name"] = {"en": "Renamed visits"}

    with webapps_hq.project(webapps_documents[TILES]) as project:
        shown = {}
        ids = {}
        for name, change in (("first", None), ("again", None), ("renamed", renamed)):
            with project.released(formplayer_runner, change=change) as release:
                run = Session(release, editor_driver).run([*steps.open_app("Visit tiles"), steps.SCREEN])
                ids[name] = release.build_id
                shown[name] = [command["text"] for command in run.screens[0]["commands"]]
    assert ids["first"] == ids["again"] != ids["renamed"]
    assert shown == {"first": ["Visits"], "again": ["Visits"], "renamed": ["Renamed visits"]}
