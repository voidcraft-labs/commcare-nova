"""A corpus document's apps as Formplayer installs them, and HQ's answers over the document's case database.

Formplayer installs an app from the archive HQ's download serves
(``/a/<domain>/apps/api/download_ccz/``). For HQ's build of a state that is
the build's files arranged as HQ's archive download arranges them
(``proof.observe.build.arrange``, HQ's own ``iter_index_files``), zipped; for
Nova's local export it is the ``.ccz`` itself. ``published`` publishes a
document into a check's HQ state as Nova's publish leaves it and builds it
(A), as the spelling rules' tests do, and ``answers`` makes the HQ answers a
Formplayer session over it reads: the archives by app id, HQ's restore of the
document's case database, HQ's own reading of each case search and its
results written by HQ's own fixture writer, and HQ's verdict on each
submission.
"""

from __future__ import annotations

import io
import tempfile
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from proof.formplayer.answers import SUBMIT_SUCCESS, HqAnswers, Search, Submission
from proof.formplayer.client import HqAnswer
from proof.observe import casedata
from proof.observe.build import arrange, build_state

# Zip entries carry a date; one fixed date keeps an archive's bytes the same on every run.
ZIP_DATE = (2026, 1, 15, 10, 30, 0)
XML = (("Content-Type", "text/xml; charset=utf-8"),)


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
    """The id Formplayer is given for one build of an app: the app's id and the archive's digest.

    Formplayer keeps each app it installs by the id it was asked for
    (``FormplayerStorageFactory``, one database per project space, worker and
    app id) and never downloads that id again, as each of HQ's builds has an
    id of its own. So two builds of one app must be asked for under two ids,
    or the second session would run the first's install.
    """
    import hashlib

    return f"{app_id}-{hashlib.sha256(archive).hexdigest()[:16]}"


def build_archive(files) -> bytes:
    """HQ's build files as the archive HQ's download serves a runtime."""
    with tempfile.TemporaryDirectory(prefix="proof-formplayer-build-") as directory:
        return zipped(arrange(files, directory))


@dataclass
class Published:
    """A corpus document published into a check's HQ state and built (A)."""

    document: object
    export: object
    unit: object
    app_id: str
    build: object

    @property
    def toggles(self) -> tuple[str, ...]:
        """The flags the configuration turns on, which HQ's session details hand Formplayer."""
        return tuple(sorted(self.export.configuration.flags))


@contextmanager
def published(document, core_runner, configuration="minimum"):
    """``document`` as Nova's first publish leaves it in HQ under ``configuration``, built."""
    from proof.hq import operations
    from proof.hq.check import hq_check
    from proof.hq.seams import build_seams

    export = document.exports[configuration]
    with hq_check(export.configuration.hq(), validate=core_runner.validate_form) as (unit, _):
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


def search_results(unit, database, search: Search) -> HqAnswer:
    """HQ's answer to a case search: its own reading of the request, and every case of the types it names.

    HQ's view reads the request with ``extract_search_request_config`` and
    writes the cases its index finds with ``CaseDBFixture``
    (``case_search/utils.py::get_case_search_results_from_request``). The
    harness holds no case index, so, as the Core runner's sessions do, the
    cases are every case of the requested types; the request reading and the
    fixture writing are HQ's own, and a request HQ's reading refuses is
    answered as HQ's view answers it, with a 400 and HQ's message.
    """
    from casexml.apps.case.fixtures import CaseDBFixture
    from corehq.apps.case_search.exceptions import CaseSearchUserError
    from corehq.apps.case_search.utils import extract_search_request_config

    try:
        config = extract_search_request_config({key: list(values) for key, values in search.params})
    except CaseSearchUserError as error:
        return HqAnswer(400, str(error).encode("utf-8"), (("Content-Type", "text/html; charset=utf-8"),))
    wanted = set(config.case_types)
    cases = [case for case in casedata.hq_cases(database, unit.domain) if case.type in wanted]
    return HqAnswer(200, CaseDBFixture(cases).fixture, XML)


def answers(unit, database, archives, restore, *, toggles=(), previews=()) -> HqAnswers:
    """HQ, as a Formplayer session over the document's case database sees it."""

    def submit(_submission: Submission) -> HqAnswer:
        return HqAnswer(201, SUBMIT_SUCCESS, XML)

    return HqAnswers(
        domain=unit.domain,
        username=database.username,
        archives=archives,
        restore=restore,
        toggles=tuple(toggles),
        previews=tuple(previews),
        search=lambda search: search_results(unit, database, search),
        submit=submit,
    )


def spelled(published: Published, change, *, state="spelled"):
    """HQ's build of the published app with ``change`` made to its stored document, in a fork of the state.

    The document is written the way the spelling rules' tests write a
    spelling (``proof/rules/conftest.py::Published._write``): read, changed
    and saved through HQ's own ``Application`` class, then built under the
    build's seams. The fork puts the state back, so each spelling is built
    over the same published app.
    """
    import copy

    from proof.hq import operations
    from proof.hq.seams import build_seams

    unit = published.unit
    with unit.fork():
        app = operations.held_app(unit, published.app_id)
        held = copy.deepcopy(app.to_json())
        change(held)
        type(app).wrap(held).save()
        with build_seams():
            outcome, _ = build_state(operations.held_app(unit, published.app_id), unit.record, state)
    assert outcome.files is not None, (outcome.errors, outcome.raised)
    return outcome


@dataclass
class Installed:
    """One build of a published document as a Formplayer session reads it: the archive, the restore, HQ's answers."""

    unit: object
    database: object
    app_id: str
    archive: bytes
    restore: bytes
    hq: HqAnswers


def installed(published: Published, files=None, *, app_id=None) -> Installed:
    """``files`` (HQ's build of A by default) with HQ's restore over the document's case database and A's tables."""
    from proof.observe.sessions import hq_restore

    database = casedata.document_case_database(published.document)
    served, restore = hq_restore(published.unit, database, published.export.create.lookups, "restore-a")
    assert restore is not None, served
    archive = build_archive(published.build.files if files is None else files)
    app_id = app_id or build_id(published.app_id, archive)
    hq = answers(published.unit, database, {app_id: archive}, restore, toggles=published.toggles)
    return Installed(published.unit, database, app_id, archive, restore, hq)


def core_sessions(core_runner, files, restore, *, script=None, after_submit=False):
    """Core's sessions over a build, as proof 3 runs them (``proof.observe.sessions.run_sessions``), optionally with
    what Core's session needs after each submission."""
    from proof.observe.sessions import admitted

    with tempfile.TemporaryDirectory(prefix="proof-formplayer-core-") as directory:
        with admitted(core_runner, arrange(files, directory)) as report:
            assert report.get("admitted") and report.get("app") is not None, report
            return core_runner.session(report["app"], restore=restore, script=script, after_submit=after_submit)


def web(runner, session: Installed, **options):
    """The Web Apps client's session with one installed build, as the lane's worker."""
    from proof.formplayer.webapps import WebApps

    return WebApps(
        runner, session.hq, domain=session.unit.domain, username=session.hq.username, app_id=session.app_id, **options
    )


def walked(runner, session: Installed, script=None):
    """Formplayer's sessions over one installed build (``proof.formplayer.walk``), marked."""
    from proof.formplayer.walk import Walk, marked

    trace = Walk(runner, session.hq, domain=session.unit.domain, app_id=session.app_id).run(script)
    return marked(trace, archives=[session.archive], restore=session.restore)
