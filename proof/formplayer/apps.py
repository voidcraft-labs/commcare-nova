"""A corpus document published into a check's HQ state, and served to Formplayer by HQ's own views.

``published`` publishes a document as Nova's publish leaves it in HQ (A:
Nova's create, with the lookup workbook and media Nova's push sends beside
it, applied through HQ's own import, ``proof.hq.operations``) and builds it,
as the spelling rules' tests do. ``served`` then serves that app as HQ
serves one to Web Apps (``proof.formplayer.hq.serve``: a worker HQ made, the
worker's cases saved through HQ's receiver, a build HQ released, and every
request Formplayer makes of HQ answered by the view HQ's URLconf names), so
what this package's tests read of Formplayer is what Formplayer makes of
HQ's own answers. A state a person's save leaves is made by HQ's own pages
and views (``saved_page``, ``saved_profile``), never written by hand.

``build_id`` names an archive HQ does not hold (Nova's local export) by its
content, and ``core_sessions`` runs Core's sessions over a build, as proof 3
runs them, for a test that holds Formplayer beside Core.
"""

from __future__ import annotations

import hashlib
import io
import json
import tempfile
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from proof.observe.build import arrange, build_state

# Zip entries carry a date; one fixed date keeps an archive's bytes the same on every run.
ZIP_DATE = (2026, 1, 15, 10, 30, 0)


def zipped(directory: Path) -> bytes:
    """A directory's files as one archive, entries in name order, each dated alike."""
    held = io.BytesIO()
    with zipfile.ZipFile(held, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(p for p in Path(directory).rglob("*") if p.is_file()):
            info = zipfile.ZipInfo(path.relative_to(directory).as_posix(), ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    return held.getvalue()


def build_id(app_id: str, archive: bytes) -> str:
    """The id Formplayer is given for an archive HQ does not hold: the app's id and the archive's digest.

    Formplayer keeps each app it installs by the id it was asked for
    (``FormplayerStorageFactory``, one database per project space, worker and
    app id) and never downloads that id again, as each of HQ's builds has an
    id of its own. So two archives of one app must be asked for under two
    ids, or the second session would run the first's install.
    """
    return f"{app_id}-{hashlib.sha256(archive).hexdigest()[:16]}"


@dataclass
class Published:
    """A corpus document published into a check's HQ state and built (A)."""

    document: object
    export: object
    unit: object
    app_id: str
    build: object

    def module_id(self, index: int) -> str:
        """The unique id HQ holds for the app's menu at ``index``, which names its pages."""
        from proof.hq import operations

        return operations.held_app(self.unit, self.app_id).modules[index].unique_id


@contextmanager
def published(document, core_runner, configuration="minimum"):
    """``document`` as Nova's first publish leaves it in HQ under ``configuration``, built."""
    from proof.hq import operations
    from proof.hq.check import hq_check
    from proof.hq.seams import build_seams

    export = document.exports[configuration]
    with hq_check(export.configuration.hq()) as (unit, _):
        # One operation, its digest the document's: what HQ draws while it applies the publish (the app's id,
        # each media file's) is then this document's own and the same on every run.
        with unit.operation("formplayer:publish", document.id.encode()):
            if export.create.lookups is not None:
                uploaded = operations.upload_lookup_workbook(unit, export.create.lookups.workbook(), replace=True)
                assert uploaded.errors == [], uploaded.errors
            result = operations.apply_upload(unit, export.create.upload())
            assert 200 <= result.status < 300 and result.response.get("success"), result.response
            app_id = result.response["app_id"]
            if export.create.media is not None:
                media = operations.apply_media_upload(unit, app_id, export.create.media.upload())
                assert media.status == 200, media.response
        with build_seams():
            outcome, _ = build_state(operations.held_app(unit, app_id), unit.record, "A")
        assert outcome.files is not None, (outcome.errors, outcome.raised)
        yield Published(document, export, unit, app_id, outcome)


class SaveRefused(AssertionError):
    """HQ's page or view did not save what a test asked a person's save of."""


def saved_page(published: Published, driver, page, target=None):
    """HQ's editor page saved without changing a value, as a person saves it (``proof.editors.pages``): HQ's page
    view renders it in ``driver``'s Chromium, the page's own JavaScript makes the save request, and HQ's save
    view applies it to the published app. Call it inside a fork of the unit, which puts the app back."""
    from proof.editors import pages

    unit = published.unit
    saved = pages.fresh_section_save(driver, unit, page, published.app_id, target, unit=unit)
    if saved.save is None or saved.save.status != 200:
        raise SaveRefused(
            f"HQ's {page.name} page did not save: it sent"
            f" {'nothing' if saved.save is None else f'a save HQ answered {saved.save.status}'}"
            f" (its alerts: {saved.alerts}, its dialog: {saved.unsent})."
        )
    return saved


def saved_profile(published: Published, properties: dict):
    """The profile settings ``properties`` saved through HQ's own settings view
    (``views/settings.py::edit_commcare_profile``, the request HQ's App Settings page posts with a person's
    changed values), decorators and all. Call it inside a fork of the unit, which puts the app back."""
    from django.urls import resolve, reverse

    from proof.hq import requests as hq_requests

    unit = published.unit
    path = reverse("edit_commcare_profile", args=[unit.domain, published.app_id])
    body = json.dumps({"properties": properties}).encode("utf-8")
    with unit.operation("formplayer:settings-save", body):
        request = hq_requests.raw_post(unit, path, body, "application/json")
        match = resolve(path)
        response = match.func(request, *match.args, **match.kwargs)
    if response.status_code != 200 or json.loads(response.content).get("status") != "ok":
        raise SaveRefused(
            f"HQ's edit_commcare_profile answered {response.status_code} {response.content[:400]!r} for {properties}."
        )


@contextmanager
def served(published: Published, runner, *, label="A", change=None, database=None):
    """The published app (as it stands where this is entered) served to ``runner`` by HQ's own views
    (``proof.formplayer.hq.serve``): the worker HQ made, their cases saved through HQ's receiver (``database``,
    or the document's case database), and a build HQ released."""
    from proof.formplayer import hq as formplayer_hq

    with formplayer_hq.serve(
        published.unit,
        published.document,
        published.app_id,
        runner=runner,
        label=label,
        change=change,
        database=database,
    ) as held:
        yield held


def web(runner, served, *, app_id=None, **options):
    """The Web Apps client's requests for one run of a served state (inside ``served.run()``): the worker HQ
    signed in, with their data cleared and Formplayer's caches empty, as every run of a walk starts."""
    from proof.formplayer.webapps import WebApps

    client = WebApps(
        runner,
        served.hq,
        domain=served.domain,
        username=served.username,
        app_id=app_id or served.build_id,
        session_key=served.hq.session_key,
        **options,
    )
    client.post("/clear_user_data", {"domain": served.domain, "username": served.username, "restoreAs": None})
    runner.forget_caches()
    return client


def walked(runner, served, script=None, *, app_id=None, archives=()):
    """Formplayer's walk of a served state (``proof.formplayer.walk``), each run a fork of the unit with the worker
    signed in, marked as a served state's record marks it."""
    from proof.formplayer.observe import marked
    from proof.formplayer.walk import Walk

    trace = Walk.of(served, runner=runner, app_id=app_id).run(script)
    return marked(trace, served=served, app_id=app_id, archives=archives, runner=runner)


def core_sessions(core_runner, files, restore, *, script=None, after_submit=False):
    """Core's sessions over a build, as proof 3 runs them (``proof.observe.sessions.run_sessions``), optionally with
    what Core's session needs after each submission."""
    from proof.observe.sessions import admitted

    with tempfile.TemporaryDirectory(prefix="proof-formplayer-core-") as directory:
        with admitted(core_runner, arrange(files, directory)) as report:
            assert report.get("admitted") and report.get("app") is not None, report
            return core_runner.session(report["app"], restore=restore, script=script, after_submit=after_submit)
