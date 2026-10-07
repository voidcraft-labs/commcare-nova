"""A corpus document as a worker finds it in Web Apps: published, built and released where the project has Web Apps.

Web Apps lists an app only where three things hold in HQ, none of which the
lane's other checks need, so this module makes each with HQ's own code:

- **The project space has Web Apps** (the ``CLOUDCARE`` privilege).
  ``models/applications.py::_create_app_from_doc`` sets a new app's
  ``cloudcare_enabled`` from it when Nova's upload lands, and
  ``cloudcare/utils.py::get_web_apps_available_to_user`` lists only an app
  that has it. Every configuration of the lane grants it, since every app
  Nova sends is one a worker opens in Web Apps
  (``proof.checks.configurations``, finding 64); ``without_web_apps`` is
  the same configuration with that one privilege taken away, for the test
  that shows what it decides.
- **The app has a released build.** Web Apps runs the latest released build
  (``cloudcare/utils.py::_get_latest_build_for_web_apps``), never the app a
  person edits. ``Project.released`` makes one the way HQ's Releases page
  does: ``Application.make_build`` and the build's save
  (``views/releases.py::make_app_build``), then HQ's own ``release_build``
  view, decorators and all. HQ's ``save_copy`` view is not called whole:
  beside ``make_app_build`` it marks the acting user as having built an app
  under a Redis lock, which the harness has no Redis for, and nothing of the
  build reads that mark.
- **A worker signed in.** The page is answered for a mobile worker of the
  project space (``WORKER``): HQ's ``FormplayerMain`` asks Elasticsearch
  whom a web user may sign in as and asks nothing of the kind for a mobile
  worker, who is also who uses Web Apps. The worker is the one the lane's
  case database and restore name (``proof.observe.casedata.USER_ID``),
  stored as HQ's ``CommCareUser`` document and Django user the way the
  unit's own web user is (``proof.hq.state``), since HQ's user creation
  saves under a Redis lock.

``Release.archive`` is the build as HQ's archive download serves it to
Formplayer: HQ's own ``hqmedia/views.py::iter_index_files`` over the saved
build's stored files, zipped. The build's id is the one Web Apps hands
Formplayer, so each release installs under its own id.

A release may first change the stored app (``change``), in a fork of the
unit, to release the app a person's save in HQ leaves: the fork puts the
state back when the block ends, so each release is made over the same
published app.
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass, replace

from proof.formplayer import apps
from proof.hq import requests as hq_requests
from proof.observe import casedata

# The privilege a project space's plan grants for Web Apps (corehq/privileges.py).
WEB_APPS_PRIVILEGE = "CLOUDCARE"


class ReleaseRefused(AssertionError):
    """HQ made no released build of the app: what it answered is the message."""


def without_web_apps(configuration):
    """``configuration`` as a project space whose plan has no Web Apps."""
    return replace(configuration, privileges=configuration.privileges - {WEB_APPS_PRIVILEGE})


def worker_username(domain: str) -> str:
    """The lane's worker's full username, as HQ names a mobile worker of ``domain``."""
    from corehq.apps.users.util import format_username

    return format_username(casedata.USERNAME, domain)


def worker_document(domain: str) -> dict:
    """The lane's worker as HQ stores a mobile worker, under the id the lane's restore gives them."""
    from corehq.apps.users.models import CommCareUser, DomainMembership

    user = CommCareUser(
        username=worker_username(domain),
        domain=domain,
        # CouchUser.is_active has no default; None reads as deactivated.
        is_active=True,
        domain_membership=DomainMembership(domain=domain),
        analytics_enabled=False,
    )
    doc = user.to_json()
    doc["_id"] = casedata.USER_ID
    return doc


@dataclass(frozen=True)
class Worker:
    """Who a page request is answered for, as ``proof.hq.requests`` reads a state: the project space and its acting
    user."""

    domain: str
    web_user: object


@dataclass
class Release:
    """One released build of the project's app."""

    build_id: str
    version: int
    archive: bytes
    # The released build's document, as HQ's app list reads it.
    doc: dict


@dataclass
class Project:
    """A corpus document published into a project space that has Web Apps, with its worker."""

    document: object
    export: object
    unit: object
    app_id: str
    worker: object
    database: object
    restore: bytes

    @property
    def domain(self) -> str:
        return self.unit.domain

    @property
    def toggles(self) -> tuple[str, ...]:
        return tuple(sorted(self.export.configuration.flags))

    @property
    def acting(self) -> Worker:
        return Worker(self.unit.domain, self.worker)

    def module_id(self, index: int) -> str:
        """The unique id HQ holds for the app's menu at ``index``, which names its pages."""
        from proof.hq import operations

        return operations.held_app(self.unit, self.app_id).modules[index].unique_id

    @contextmanager
    def released(self, *, saves=(), driver=None, change=None, label="release"):
        """The app released, inside a fork that puts the state back: as it stands, or after a person's saves.

        ``saves`` are HQ editor pages saved without changing a value, in
        order, each ``(page, target)`` (``proof.editors.pages``; the target
        a menu's or form's unique id), in ``driver``'s Chromium: HQ's page
        view renders the page, the page's own JavaScript makes the save
        request, and HQ's save view applies it, as proof 4 saves a page.
        ``change`` rewrites the stored document directly, for a state no
        page makes.
        """
        from proof.editors import pages
        from proof.hq import operations
        from proof.hq.seams import build_seams

        unit = self.unit
        with unit.fork():
            for page, target in saves:
                saved = pages.fresh_section_save(driver, unit, page, self.app_id, target, unit=unit)
                if saved.save is None or saved.save.status != 200:
                    raise ReleaseRefused(
                        f"HQ's {page.name} page did not save: it sent"
                        f" {'nothing' if saved.save is None else f'a save HQ answered {saved.save.status}'}"
                        f" (its alerts: {saved.alerts}, its dialog: {saved.unsent})."
                    )
            # The operation's digest is the stored app's own, so what HQ draws inside it (the build's id
            # among it) belongs to this content and no other: HQ gives each build an id of its own, Formplayer
            # keeps an install by that id, and HQ's seeded entropy would otherwise draw one id for two builds.
            stored = operations.held_app(unit, self.app_id).to_json()
            if change is not None:
                change(stored)
            content = hashlib.sha256(json.dumps(stored, sort_keys=True, default=str).encode()).hexdigest()
            with unit.operation(f"webapps:{label}", f"{self.document.id}|{content}".encode()), build_seams():
                app = operations.held_app(unit, self.app_id)
                if change is not None:
                    held = copy.deepcopy(app.to_json())
                    change(held)
                    type(app).wrap(held).save()
                    app = operations.held_app(unit, self.app_id)
                build = _make_build(unit, app)
                _release(unit, self.app_id, build._id)
                build = operations.held_app(unit, build._id)
                archive = _archive(build)
            yield Release(build_id=build._id, version=build.version, archive=archive, doc=build.to_json())


def _make_build(unit, app):
    """HQ's build of the app as its Releases page makes one (``views/releases.py::make_app_build``)."""
    from corehq.apps.app_manager.exceptions import AppValidationError

    try:
        build = app.make_build(comment="", user_id=unit.web_user.get_id)
    except AppValidationError as refused:
        raise ReleaseRefused(f"HQ's make_build refused the app: {refused.errors}") from refused
    build.save(increment_version=False)
    return build


def _release(unit, app_id, build_id):
    """HQ's ``release_build`` view, as the Releases page's star posts to it."""
    from django.urls import resolve, reverse

    path = reverse("release_build", args=[unit.domain, app_id, build_id])
    request = hq_requests.form_post(unit, path, [("is_released", "true"), ("ajax", "true")])
    match = resolve(path)
    response = match.func(request, *match.args, **match.kwargs)
    answered = json.loads(response.content) if response.status_code == 200 else {}
    if not answered.get("is_released"):
        raise ReleaseRefused(
            f"HQ's release_build answered {response.status_code} {response.content[:500]!r} for build {build_id}."
        )


def _archive(build) -> bytes:
    """The saved build as HQ's archive download serves it (``hqmedia/views.py::iter_index_files``), zipped."""
    from corehq.apps.hqmedia.views import iter_index_files

    entries, errors, _ = iter_index_files(build, build_profile_id=None)
    if errors:
        raise ReleaseRefused(f"HQ's archive download refused the released build: {errors}")
    held = io.BytesIO()
    with zipfile.ZipFile(held, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(entries):
            info = zipfile.ZipInfo(name, apps.ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content if isinstance(content, bytes) else content.encode("utf-8"))
    return held.getvalue()


@contextmanager
def project(document, core_runner, configuration="minimum", *, restore=None, web_apps=True):
    """``document`` as Nova's first publish leaves it in a project space that has Web Apps, with its worker.

    The worker's cases are the lane's case database for the document, as
    HQ's own restore writes them over the tables the publish uploaded; or,
    given ``restore``, the bytes of a restore a targeted document fixes by
    hand (its ``restore.xml``), where a test turns on one case's values.
    With ``web_apps`` false the project space is the document's
    configuration without the Web Apps privilege, for the test that shows
    what the privilege decides.
    """
    from corehq.apps.users.models import CommCareUser
    from django.contrib.auth.models import User

    from proof.hq import operations
    from proof.hq.check import hq_check
    from proof.observe.sessions import hq_restore

    export = document.exports[configuration]
    held = export.configuration.hq()
    if WEB_APPS_PRIVILEGE not in held.privileges:
        raise AssertionError(
            f"{document.id}'s configuration {configuration} grants no {WEB_APPS_PRIVILEGE}, which every"
            " configuration of the lane grants (proof/checks/configurations.py::_needs_cloudcare)."
        )
    with hq_check(held if web_apps else without_web_apps(held), validate=core_runner.validate_form) as (unit, _):
        # One operation, its digest the document's: what HQ draws while it applies the publish (the app's id,
        # each media file's) is then this document's own and the same on every run.
        with unit.operation("webapps:publish", document.id.encode()):
            if export.create.lookups is not None:
                uploaded = operations.upload_lookup_workbook(unit, export.create.lookups.workbook(), replace=True)
                assert uploaded.errors == [], uploaded.errors
            result = operations.apply_upload(unit, export.create.upload())
            assert 200 <= result.status < 300 and result.response.get("success"), result.response
            app_id = result.response["app_id"]
            if export.create.media is not None:
                media = operations.apply_media_upload(unit, app_id, export.create.media.upload())
                assert media.status == 200, media.response
        with unit.operation("webapps:worker", b"worker"):
            username = worker_username(unit.domain)
            User.objects.create(username=username, is_active=True)
            worker = CommCareUser.wrap(unit.couch.seed(worker_document(unit.domain)))
        database = casedata.document_case_database(document)
        if restore is None:
            served, restore = hq_restore(unit, database, export.create.lookups, "restore-a")
            assert restore is not None, served
        yield Project(document, export, unit, app_id, worker, database, restore)
