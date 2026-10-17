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
- **Incomplete Forms** (defect 7 and finding 62). The client hides the tile
  only when every listed app's stored profile says ``cc-show-incomplete`` is
  ``no`` (``apps/controller.js::listApps``). Nova stores the app's own
  setting: ``targeted-survey-menu`` shows incomplete forms, so it stores
  ``yes`` and the tile shows; ``media-only`` keeps the new app's default,
  off, so it stores ``no`` and the tile is absent. HQ's App Settings page,
  saved without a change, keeps each stored value, so each tile stays as it
  was. Plausible failures: a setting that never reached the stored app (the
  stored property is checked on every side), a client reading the built
  profile instead, and a save that writes its own value over the app's. The
  pre-fix behaviour stays held on the control's capture: an app as Nova
  published it before step 2, which stores no value
  (``proof/controls/case-operation-query``'s create), shows the tile, and
  the same save stores ``no`` and takes it away.
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
        with webapps_hq.project(webapps_documents[document]) as project:
            with project.released(formplayer_runner) as release:
                run = Session(release, editor_driver).run([steps.SCREEN])
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


def _incomplete_forms(document, formplayer_runner, editor_driver):
    """The stored ``cc-show-incomplete`` and the home screen's tiles of ``document``'s app as Nova published it, and
    after HQ's App Settings page saved it without a change."""
    observed = {}
    with webapps_hq.project(document) as project:
        for name, saves in (("published", ()), ("saved", ((pages.APP_SETTINGS, None),))):
            with project.released(formplayer_runner, saves=saves, driver=editor_driver, label=name) as release:
                run = Session(release, editor_driver).run([steps.SCREEN])
                observed[name] = {
                    "stored": ((release.doc.get("profile") or {}).get("properties") or {}).get("cc-show-incomplete"),
                    "tiles": _kinds(run.screens[0]),
                    "pageErrors": run.page_errors,
                }
    return observed


def test_the_incomplete_forms_tile_follows_the_apps_setting_and_survives_a_settings_save(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, webapps_controls, evidence
):
    shown = ["default", "incomplete", "sync", "settings"]
    hidden = ["default", "sync", "settings"]
    on = _incomplete_forms(webapps_documents["targeted-survey-menu"], formplayer_runner, editor_driver)
    off = _incomplete_forms(webapps_documents["media-only"], formplayer_runner, editor_driver)
    before = _incomplete_forms(webapps_controls["case-operation-query"], formplayer_runner, editor_driver)
    evidence("incomplete-forms", {"on": on, "off": off, "control": before})
    for name in ("published", "saved"):
        assert on[name] == {"stored": "yes", "tiles": shown, "pageErrors": []}, name
        assert off[name]["stored"] == "no" and off[name]["tiles"] == hidden, name
    # The app as Nova published it before step 2 stores no value, so the tile shows, and the save takes it away.
    assert before["published"] == {"stored": None, "tiles": shown, "pageErrors": []}
    assert before["saved"] == {"stored": "no", "tiles": hidden, "pageErrors": []}
