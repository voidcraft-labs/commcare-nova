"""Web Apps' home screen over Nova's exports: the app's tile and its logo, and the Incomplete Forms tile.

Both are read by the client from the app HQ *stores*, never from the build
Formplayer installs: HQ's page hands the client each released build's
document (``cloudcare/utils.py::format_app_doc``: its ``logo_refs``'s
``hq_logo_web_apps`` path as ``imageUri``, its ``multimedia_map`` and its
``profile``), so no build comparison and no session of Core's or
Formplayer's can show either.

- **The logo** (``media-only``). Contract: the logo Nova's publish sends
  with the app (``logo_refs.hq_logo_web_apps.path``, path only) is the image
  on the app's tile: the client resolves the path through the app's media
  map to HQ's own multimedia URL (``app.js``, the ``resourceMap`` reply;
  ``apps/views.js``), and HQ's multimedia view serves the bytes Nova
  uploaded. Plausible failures: a path the media map does not hold (the
  client then draws its own flower and logs that it found no resource), or
  HQ serving nothing at that URL. The accepted counterpart of "no logo" is
  an app without one (``targeted-survey-menu``): the client's own flower,
  and no image asked of HQ.
- **Incomplete Forms** (``targeted-survey-menu``). The client hides the
  tile only when every listed app's stored profile says
  ``cc-show-incomplete`` is ``no`` (``apps/controller.js::listApps``).
  Nova stores no such property, so the tile shows. HQ's App Settings page,
  saved without a change, stores every setting at its page value
  (finding 40), ``cc-show-incomplete: no`` among them, and the tile is gone:
  a save that changes nothing takes a screen away from a worker in Web
  Apps. Plausible failures: a save that never reached the stored app (the
  stored property is checked on both sides), or a client reading the built
  profile instead (the tile would then be the same on both).
"""

from __future__ import annotations

import hashlib
from pathlib import PurePosixPath

from proof.editors import pages
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _kinds(screen):
    return [tile["kind"] for tile in screen["apps"]]


def _content_type(exchange):
    """The content type HQ answered a page request with."""
    return next((value for name, value in exchange.response_headers if name.lower() == "content-type"), "")


def test_web_apps_shows_the_logo_nova_sends_on_the_apps_tile_and_its_own_flower_without_one(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    observed = {}
    for name, document in (("logo", "media-only"), ("none", "targeted-survey-menu")):
        with webapps_hq.project(webapps_documents[document], core_runner) as project:
            with project.released() as release:
                run = Session(project, release, formplayer_runner, editor_driver).run([steps.SCREEN])
                media = [e for e in run.hq if e.path.startswith("/hq/multimedia/file/")]
                observed[name] = {
                    "stored": (release.doc.get("logo_refs") or {}).get("hq_logo_web_apps"),
                    "map": release.doc.get("multimedia_map") or {},
                    "tile": run.screens[0]["apps"][0],
                    "asked": [[e.path, e.status, _content_type(e), e.response] for e in media],
                    "consoleErrors": [entry for entry in run.console_errors if "resource" in entry["error"].lower()],
                }
    logo, none = observed["logo"], observed["none"]
    path = logo["stored"]["path"]
    mapped = logo["map"][path]
    expected = f"/hq/multimedia/file/{mapped['media_type']}/{mapped['multimedia_id']}/{PurePosixPath(path).name}"
    evidence(
        "logo",
        {
            name: {**side, "asked": [[asked[0], asked[1], asked[2], len(asked[3] or b"")] for asked in side["asked"]]}
            for name, side in observed.items()
        },
    )
    # Nova's logo: the tile's image is HQ's own URL for the mapped file, and HQ serves the image at it.
    assert logo["tile"] == {"name": "Media proof", "kind": "default", "icon": expected}
    served = [asked for asked in logo["asked"] if asked[0] == expected]
    assert len(served) == 1 and served[0][1] == 200 and served[0][2].startswith("image/png")
    assert served[0][3].startswith(PNG_SIGNATURE)
    # Nova names a media file by its content's digest, so the bytes HQ serves are the bytes Nova sent.
    assert hashlib.sha256(served[0][3]).hexdigest() == PurePosixPath(path).stem
    # No logo: the client's own flower, and no image asked of HQ.
    assert none["stored"] is None
    assert none["tile"] == {"name": "Household surveys", "kind": "default", "icon": None}
    assert none["asked"] == []


def test_the_app_settings_save_takes_incomplete_forms_off_web_apps_home_screen(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents["targeted-survey-menu"], core_runner) as project:
        observed = {}
        for name, saves in (("nova", ()), ("saved", ((pages.APP_SETTINGS, None),))):
            with project.released(saves=saves, driver=editor_driver, label=name) as release:
                run = Session(project, release, formplayer_runner, editor_driver).run([steps.SCREEN])
                observed[name] = {
                    "stored": ((release.doc.get("profile") or {}).get("properties") or {}).get("cc-show-incomplete"),
                    "tiles": _kinds(run.screens[0]),
                    "pageErrors": run.page_errors,
                }
        evidence("incomplete-forms", observed)
        assert observed["nova"] == {
            "stored": None,
            "tiles": ["default", "incomplete", "sync", "settings"],
            "pageErrors": [],
        }
        assert observed["saved"] == {"stored": "no", "tiles": ["default", "sync", "settings"], "pageErrors": []}
