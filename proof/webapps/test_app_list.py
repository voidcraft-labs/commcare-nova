"""Web Apps' home screen over Nova's exports: the app's tile and its logo, and the Incomplete Forms tile.

Both are read by the client from the app HQ *stores*, never from the build
Formplayer installs: HQ's page hands the client each released build's
document (``cloudcare/utils.py::format_app_doc``: its ``logo_refs``'s
``hq_logo_web_apps`` path as ``imageUri``, its ``multimedia_map`` and its
``profile``), so no build comparison and no session of Core's or
Formplayer's can show either.

- **The logo** (``media-only``). Contract: Nova's publish sends no
  ``logo_refs``, so the tile of the app as Nova publishes it shows the
  client's own icon and asks HQ for no image. After HQ's own uploader stores
  ``hq_logo_web_apps`` (``hqmedia/views.py::ProcessLogoFileUploadView``, on
  a plan with the Custom CommCare Logo Uploader), the tile shows HQ's URL
  for the uploaded file, and HQ serves it there; a path-only entry, written
  into the stored app, shows HQ's URL for the file the path maps to. The
  client resolves the entry's path through the app's media map to HQ's own
  multimedia URL (``app.js``, the ``resourceMap`` reply; ``apps/views.js``).
  Plausible failures: a tile that shows a logo nobody uploaded in HQ, a path
  the media map does not hold (the client then draws its own flower and
  logs that it found no resource), or HQ serving nothing at that URL.
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

import base64
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


# The slot Web Apps reads an app's image from (``cloudcare/utils.py::format_app_doc``).
SLOT = "hq_logo_web_apps"
# A 1x1 PNG, the logo a person uploads.
LOGO = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
# Where a person's browser has HQ's page open: HQ's own origin, as the requests here reach it (Django's request
# factory names the host ``testserver``), which HQ's CSRF check holds a form's Referer to.
ORIGIN = "https://testserver/"


def _upload_logo(unit, app_id):
    """HQ's own uploader, posted ``LOGO`` for ``SLOT`` by the project space's admin signed in through HQ's sign-in
    form, as the app's settings page posts it; answered by the view HQ's URLconf names, behind its middleware."""
    from corehq.apps.hqmedia.views import ProcessLogoFileUploadView
    from django.urls import reverse

    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer.client import HqRequest
    from proof.hq import redis as hq_redis

    with hq_redis.shared(None):
        signed_in = formplayer_hq.admin_signed_in(unit, unit.operation, "logo", "webapps")
        boundary = "proof-logo-boundary"
        body = (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="csrfmiddlewaretoken"\r\n\r\n'
                f"{signed_in.csrf}\r\n"
                f'--{boundary}\r\nContent-Disposition: form-data; name="Filedata"; filename="logo.png"\r\n'
                "Content-Type: image/png\r\n\r\n"
            ).encode()
            + LOGO
            + f"\r\n--{boundary}--\r\n".encode()
        )
        headers = (
            ("Content-Type", f"multipart/form-data; boundary={boundary}"),
            ("Cookie", signed_in.cookie),
            ("Referer", ORIGIN),
        )
        path = reverse(ProcessLogoFileUploadView.urlname, args=[unit.domain, app_id, SLOT])
        with unit.committing(), unit.request(hashlib.sha256(b"webapps|upload-logo").digest()):
            with formplayer_hq._language_put_back():
                response = formplayer_hq.respond(
                    formplayer_hq.django_request(HqRequest("POST", path, "", headers, body))
                )
        assert response.status_code == 200, (response.status_code, response.content[:400])


def _path_only(stored):
    """A path-only entry in ``SLOT``, at the path of an image the stored app's media map holds."""
    paths = sorted(path for path, item in stored["multimedia_map"].items() if item["media_type"] == "CommCareImage")
    stored["logo_refs"] = {SLOT: {"path": paths[0]}}


def _tile(project, formplayer_runner, editor_driver, label, change=None):
    """The app's tile on Web Apps' home screen, what the release stores in ``SLOT`` with its media map, and every
    image the client asked HQ for."""
    with project.released(formplayer_runner, label=label, change=change) as release:
        run = Session(release, editor_driver).run([steps.SCREEN])
        media = [e for e in run.hq if e.path.startswith("/hq/multimedia/file/")]
        return {
            "stored": (release.doc.get("logo_refs") or {}).get(SLOT),
            "map": release.doc.get("multimedia_map") or {},
            "tile": run.screens[0]["apps"][0],
            "asked": [[e.path, e.status, _content_type(e), e.response] for e in media],
            "consoleErrors": [entry for entry in run.console_errors if "resource" in entry["error"].lower()],
        }


def _mapped_url(side):
    """HQ's own multimedia URL for the file the stored entry's path maps to."""
    path = side["stored"]["path"]
    mapped = side["map"][path]
    return f"/hq/multimedia/file/{mapped['media_type']}/{mapped['multimedia_id']}/{PurePosixPath(path).name}"


def _served(side, url):
    """The one answer HQ gave the client's request for ``url``: an image, its bytes."""
    served = [asked for asked in side["asked"] if asked[0] == url]
    assert len(served) == 1 and served[0][1] == 200 and served[0][2].startswith("image/png"), side["asked"]
    assert served[0][3].startswith(PNG_SIGNATURE)
    return served[0][3]


def test_web_apps_shows_its_own_flower_without_a_logo_entry_and_hqs_url_for_one(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from corehq import privileges

    from proof.hq.seams import also_granted

    observed = {}
    with webapps_hq.project(webapps_documents["media-only"]) as project:
        observed["published"] = _tile(project, formplayer_runner, editor_driver, "published")
        observed["path-only"] = _tile(project, formplayer_runner, editor_driver, "path-only", change=_path_only)
        # The project space's plan has the Custom CommCare Logo Uploader, which HQ's uploader answers 404 without.
        with also_granted(privileges.COMMCARE_LOGO_UPLOADER), project.unit.fork():
            _upload_logo(project.unit, project.app_id)
            observed["uploaded"] = _tile(project, formplayer_runner, editor_driver, "uploaded")
    evidence(
        "logo",
        {
            name: {**side, "asked": [[asked[0], asked[1], asked[2], len(asked[3] or b"")] for asked in side["asked"]]}
            for name, side in observed.items()
        },
    )
    published, path_only, uploaded = observed["published"], observed["path-only"], observed["uploaded"]
    # As Nova publishes it: no entry, the client's own flower, and no image asked of HQ.
    assert published["stored"] is None
    assert published["tile"] == {"name": "Media proof", "kind": "default", "icon": None}
    assert published["asked"] == []
    # A path-only entry: HQ's own URL for the file the path maps to, served.
    expected = _mapped_url(path_only)
    assert path_only["tile"] == {"name": "Media proof", "kind": "default", "icon": expected}
    # A media file is named by its content's digest, so the bytes HQ serves are the mapped file's.
    assert hashlib.sha256(_served(path_only, expected)).hexdigest() == PurePosixPath(path_only["stored"]["path"]).stem
    # The uploader's record: HQ's own URL for the uploaded file, and HQ serves the bytes the person uploaded.
    assert "m_id" in uploaded["stored"]
    expected = _mapped_url(uploaded)
    assert uploaded["tile"] == {"name": "Media proof", "kind": "default", "icon": expected}
    assert _served(uploaded, expected) == LOGO


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
