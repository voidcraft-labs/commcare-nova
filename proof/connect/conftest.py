"""What the Connect proofs share: Connect's runtime, and each Connect document's builds, submissions and payloads.

``connect_runtime`` is one ``ConnectRuntime`` for the session (Connect at its
pin, its Postgres and Redis, its migrated database), stopped when the session
ends. ``connect_apps`` publishes each document ``DOCUMENTS`` names into HQ
as Nova's publish leaves it, and keeps everything Connect is ever given of
it:

- the archive HQ built of it, which Connect's sync downloads, and, where the
  document carries the edit that renames its Connect block ids, the archive
  HQ builds once Nova's publish of that edit is applied over it;
- a submission of its Connect form from each runtime path, each made by
  Core's own session (``proof.observe.sessions``): on HQ's build, on Nova's
  local archive replaying the same script, on HQ's build and Nova's local
  archive of the edit, and on HQ's build of the form as HQ's own form
  designer saves it (Vellum, ``proof.editors.vellum``), on the lane's day and
  on the day after;
- HQ's Connect payload for each, as HQ's own receiver and Connect repeater
  made and sent it (``_forwarded_by_hq``): each submission posted to HQ's
  receiver view under the app's id or, for the local archive, also with no
  app named, and the payload read where it reached Connect.

A submission's location is the one value no code the lane runs writes: HQ's
build adds the node and the action that fills it (``xform.py::
XForm._add_meta_2``, ``orx:pollsensor``), and only CommCare Android runs that
action (``org/commcare/android/javarosa/PollSensorAction.java``). So a
submission "with a fix" here is Core's submission with a fix written into
the meta's ``location`` node where the form holds one (``with_fix``), and is
the same bytes where it holds none.

``DOCUMENTS`` names every corpus document these tests read, which keys the
package's outcome in the evidence store (``proof.store.queue.PACKAGE_DATA``).
"""

from __future__ import annotations

import io
import json
import os
import tempfile
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from proof.connect.hq import HQ_XMLNS, META_XMLNS, with_fix  # noqa: F401 - the tests read them here

# Every corpus document a Connect proof reads, by id: Nova's deliver app and learn app that each carry the edit
# renaming their Connect ids, and the apps whose blocks are named like Connect's own keys (the deliver app whose
# task is `task`, and a deliver app and a learn app with one form for each other name).
DOCUMENTS = (
    "targeted-connect-deliver-rename",
    "targeted-connect-learn-rename",
    "connect-deliver-default",
    "targeted-connect-deliver-key-names",
    "targeted-connect-learn-key-names",
)
DELIVER, LEARN, TASK_NAMED_TASK, DELIVER_KEY_NAMES, LEARN_KEY_NAMES = DOCUMENTS
CONFIGURATION = "minimum"
CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn"
# The day after the lane's own (``proof.core.client.DEFAULT_CLOCK``), for a worker's second visit.
NEXT_DAY_CLOCK = "2026-01-16T10:30:00.000Z"
# Three fixes as a device writes them (latitude, longitude, altitude, accuracy): one place, a place about four
# metres from it, and a place more than a hundred kilometres away.
FIX = "12.97160 77.59460 920.0 5.0"
FIX_NEAR = "12.97164 77.59460 920.0 5.0"
FIX_FAR = "13.97160 77.59460 920.0 5.0"


@pytest.fixture(scope="session")
def connect_out() -> Path:
    """Where the Connect proofs leave their logs and evidence: ``$PROOF_OUT/connect``."""
    out = os.environ.get("PROOF_OUT")
    if not out:
        pytest.fail(
            "The Connect proofs write their logs and evidence under $PROOF_OUT/connect, and PROOF_OUT is not set."
            " Run them through the proof harness (npm run proof -- proof/connect), which sets it to /out."
        )
    directory = Path(out) / "connect"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


@pytest.fixture(scope="session")
def connect_runtime(connect_out, lane_services):
    """Connect at its pin with its services and its migrated database, for the session: the one a Connect
    document's observation serves its opportunity from (``proof.observe.services.connect``)."""
    from proof.conftest import record_timing
    from proof.observe import services

    runtime = services.connect()
    for name, seconds in runtime.timings.items():
        record_timing(f"connect_{name}", seconds)
    yield runtime
    (connect_out / "timings.json").write_text(json.dumps(runtime.timings, indent="\t", sort_keys=True) + "\n")


@dataclass(frozen=True)
class Submitted:
    """One submission of a form and what HQ's Connect repeater makes of it."""

    xml: bytes
    forwarded: object

    @property
    def payload(self):
        return self.forwarded.payload


@dataclass
class ConnectApp:
    """One Connect document as HQ holds it and as Connect is given it."""

    document: str
    domain: str
    app_id: str
    username: str
    # The profile of Nova's local archive of the document.
    local_profile: bytes
    # HQ's archive of the app ("built") and of the app after Nova's publish of its edit ("renamed").
    archives: dict = field(default_factory=dict)
    # Each Connect block's id in D and in the edit, by the block's element name.
    renames: dict = field(default_factory=dict)
    # By name: "<path>", "<path>@next" (the day after), each with "+fix", "+near" or "+far" where a fix was
    # written, and "local-unnamed" (the local archive's submission posted with no app named). The paths are "hq"
    # and "local", "renamed" and "renamed-local" where the document carries the edit, and "vellum" for the
    # deliver app. A document of several forms has "hq#1", "hq#2", one for each form its session submits.
    submissions: dict = field(default_factory=dict)


def zipped(files) -> bytes:
    """HQ's build files as the archive HQ's download serves: each file at the path HQ's download arranges it at
    (``proof.observe.build.arrange``)."""
    from proof.observe.build import arrange

    buffer = io.BytesIO()
    with tempfile.TemporaryDirectory(prefix="proof-connect-archive-") as directory:
        root = Path(arrange(files, Path(directory) / "build"))
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(p for p in root.rglob("*") if p.is_file()):
                archive.write(path, path.relative_to(root).as_posix())
    return buffer.getvalue()


def connect_ids(archive: bytes) -> dict:
    """Each Connect block's id in an archive's forms, by the block's element name."""
    from lxml import etree

    from proof.checks.compare.xml_tree import parse_xml

    found = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as held:
        for name in sorted(held.namelist()):
            if not (name.startswith("modules-") and name.endswith(".xml")):
                continue
            for element in parse_xml(held.read(name)).iter():
                if not isinstance(element.tag, str):
                    continue
                tag = etree.QName(element)
                if tag.namespace == CONNECT_XMLNS and element.get("id"):
                    found[tag.localname] = element.get("id")
    return found


def _in_another_session(submission: bytes, tokens: dict, session: str) -> bytes:
    """A submission as another form entry session makes it: each id the runner generated (its marks' values, which
    every run of the runner numbers from one) replaced by that session's, so no two submissions a device makes
    share an instance id."""
    from proof.observe.runs import GENERATED_NAMESPACE, GENERATED_PREFIX

    text = submission.decode("utf-8")
    for token, value in tokens.items():
        if token.startswith(GENERATED_PREFIX):
            text = text.replace(value, str(uuid.uuid5(GENERATED_NAMESPACE, f"{session}:{token}")))
    return text.encode("utf-8")


class _Paths:
    """Core's sessions on each build of one published document, and the submission each made."""

    def __init__(self, document, app, core_runner, scratch):
        from proof.checks import casedata
        from proof.observe.sessions import hq_restore, local_restore

        self.document, self.app, self.core_runner, self.scratch = document, app, core_runner, Path(scratch)
        database = casedata.case_database(document.document)
        status, self.restore_hq = hq_restore(app.unit, database, app.export.create.lookups, "restore")
        assert self.restore_hq is not None, f"HQ's restore refused {document.id}'s lookup tables: {status}"
        self.restore_plain = local_restore(app.unit, database)
        self.script = None

    def submission(self, what, path, restore, clock=None):
        """The one submission Core's session makes on the archive at ``path`` (``submissions``)."""
        submitted = self.submissions(what, path, restore, clock)
        assert len(submitted) == 1, (
            f"{what} of {self.document.id} submitted {len(submitted)} forms where its one form was run"
        )
        return submitted[0]

    def submissions(self, what, path, restore, clock=None):
        """Each submission Core's session makes on the archive at ``path``, in the session's order: the session
        derived on the first call, whose script every later call replays; on the lane's day, or at ``clock``."""
        from proof.checks import proof3
        from proof.core.client import DEFAULT_CLOCK
        from proof.observe.runs import submission_of
        from proof.observe.sessions import admitted, unmarked_submission

        with admitted(self.core_runner, path) as report:
            assert report.get("admitted") and report.get("app") is not None, (
                f"Core did not admit {what} of {self.document.id}: {report}"
            )
            trace = self.core_runner.session(
                report["app"], restore=restore, script=self.script, clock=clock or DEFAULT_CLOCK
            )
        if self.script is None:
            self.script = proof3.script_of(trace)
        made = []
        for run in trace["runs"]:
            if submission_of(run) is None:
                continue
            xml, tokens = unmarked_submission(run)
            # The lane's day's first form keeps the lane's own ids; every other session gets its own.
            session = f"{clock or ''}#{len(made)}"
            made.append(xml if session == "#0" else _in_another_session(xml, tokens, session))
        return made

    def build(self, files, name, clock=None):
        from proof.checks import proof3

        directory = self.scratch / name
        if not directory.exists():
            proof3.arrange_build(files, directory)
        return self.submission(f"HQ's build ({name})", directory, self.restore_hq, clock)

    def build_forms(self, files, name):
        """HQ's build's submission of each of its forms, where the document holds several."""
        from proof.checks import proof3

        return self.submissions(
            f"HQ's build ({name})", proof3.arrange_build(files, self.scratch / name), self.restore_hq
        )

    def archive(self, what, path, clock=None):
        return self.submission(what, path, self.restore_plain, clock)


def _build_in_fork(app, name, change):
    """HQ's build of the app after ``change`` is made to the published state, in a fork of it."""
    from proof.hq.seams import build_seams
    from proof.observe.build import build_state

    with app.unit.fork():
        change()
        with build_seams(previous=None):
            outcome, _ = build_state(app._app(), app.unit.record, name)
    assert outcome.files is not None and not outcome.raised, (name, outcome.raised)
    return outcome


def _edit_build(app, document):
    """HQ's build of the app once Nova's publish of the document's edit is applied over it."""
    from proof.observe import publish

    def change():
        refusal, _ = publish.update(app.unit, app.app_id, document.edit.exports[CONFIGURATION].update, "update")
        assert refusal is None, f"HQ refused Nova's publish of {document.id}'s edit: {refusal}"

    return _build_in_fork(app, "edit", change)


def _vellum_saved_build(app, editor_driver, form_unique_id):
    """HQ's build of the app after HQ's form designer opens and saves the form."""
    from proof.editors import vellum
    from proof.editors.hq import HQAnswers

    def change():
        # Answered inside the unit, as proof 4's runs are, so the editor audit (PROOF_EDITOR_AUDIT) can rerun the
        # form in a fork of it.
        run = vellum.open_and_save(editor_driver, HQAnswers(app.unit, app.unit), app.app_id, form_unique_id)
        assert run.saved, f"Vellum did not save the form: {run.save_refusal or run.load_error}"

    return _build_in_fork(app, "vellum", change)


def _refuses_to_answer(method, url, headers, body):
    raise AssertionError(
        f"Connect asked HQ for {method} {url} while it was only given forms to receive; it holds no opportunity"
        " here, so nothing of it should read an app."
    )


def _forwarded_by_hq(app, document, made, connect_runtime) -> dict:
    """Each submission of ``made`` (by name) as HQ forwards it: posted to HQ's own receiver view as a device
    posts it, under the app's id (and the local archive's once more with no app named, ``local-unnamed``),
    taken by HQ's receiver whole and sent by HQ's own Connect repeater, with a token it asked Connect for, to a
    served Connect over a real connection (``proof.connect.hq.forwarding``). The payload is read where it
    arrived. That Connect holds HQ's server and no opportunity, so it authenticates HQ and answers that the
    form belongs to nothing: what Connect makes of a payload is each test's own scenario's to show."""
    from proof.connect import hq as connect_hq
    from proof.formplayer import hq as formplayer_hq

    wanted = [(name, xml, app.app_id) for name, xml in sorted(made.items())]
    if "local" in made:
        wanted.append(("local-unnamed", made["local"], None))
    found = {}
    with formplayer_hq.serve(app.unit, document, app.app_id) as served:
        session = connect_runtime.session(_refuses_to_answer)
        try:
            session.step("hq_server", hqUrl="https://www.commcarehq.org", oauthClient=connect_hq.OAUTH_CLIENT)
            with connect_hq.forwarding(app.unit, session.url, app.unit.operation, "package"):
                views = formplayer_hq.HqViews(app.unit, served.username)
                for name, xml, receiver_id in wanted:
                    with served.run(f"forward-{name}"):
                        views.begin(f"forward-{name}".encode(), None)
                        path = connect_hq.receiver_url(app.unit.domain, receiver_id)
                        request = connect_hq.device_request(path, served.username, formplayer_hq.PASSWORD, xml)
                        answer = views(request)
                        assert answer.status == 201, (name, answer.status, answer.body[:300])
                        registered = connect_hq.forwards(app.unit)
                        arrived = [
                            exchange
                            for exchange in session.step("collect")["exchanges"]
                            if exchange["path"] == "/api/receiver/"
                        ]
                    assert len(registered) == len(arrived) == 1, (name, registered, arrived)
                    payload = arrived[0]["payload"]
                    found[name] = Submitted(
                        xml, connect_hq.Forwarded(payload["app_id"], payload["build_id"], True, payload)
                    )
        finally:
            session.close()
    return found


def _connect_app(document, core_runner, editor_driver, connect_runtime):
    from proof.rules.conftest import published

    with published(document, core_runner, CONFIGURATION) as app, tempfile.TemporaryDirectory() as scratch:
        built = app.spell()
        assert built.build.files is not None and not built.build.raised, built.build.raised
        paths = _Paths(document, app, core_runner, scratch)
        archives = {"built": zipped(built.build.files)}
        if document.id in (DELIVER_KEY_NAMES, LEARN_KEY_NAMES):
            forms = paths.build_forms(built.build.files, "built")
            made = {f"hq#{position}": xml for position, xml in enumerate(forms, start=1)}
        else:
            made = {
                "hq": paths.build(built.build.files, "built"),
                "local": paths.archive("Nova's local archive", document.local_ccz),
            }
        renames = {}
        if document.id in (DELIVER, LEARN):
            edited = _edit_build(app, document)
            archives["renamed"] = zipped(edited.files)
            before, after = connect_ids(archives["built"]), connect_ids(archives["renamed"])
            renames = {block: (before[block], after[block]) for block in sorted(before)}
            assert all(old != new for old, new in renames.values()), (
                f"{document.id}'s edit renames its Connect ids, and HQ's builds of it hold {renames}"
            )
            made["hq@next"] = paths.build(built.build.files, "built", NEXT_DAY_CLOCK)
            made["local@next"] = paths.archive("Nova's local archive", document.local_ccz, NEXT_DAY_CLOCK)
            made["renamed"] = paths.build(edited.files, "edit")
            made["renamed@next"] = paths.build(edited.files, "edit", NEXT_DAY_CLOCK)
            made["renamed-local"] = paths.archive("Nova's local archive of the edit", document.edit.local_ccz)
        if document.id == DELIVER:
            (form,) = [form for module in built.stored["doc"]["modules"] for form in module["forms"]]
            made["vellum"] = paths.build(_vellum_saved_build(app, editor_driver, form["unique_id"]).files, "vellum")
            for name in [name for name in made if name.startswith(("hq", "local"))]:
                for suffix, fix in (("fix", FIX), ("near", FIX_NEAR), ("far", FIX_FAR)):
                    made[f"{name}+{suffix}"] = with_fix(made[name], fix)

        submissions = _forwarded_by_hq(app, document, made, connect_runtime)
        return ConnectApp(
            document=document.id,
            domain=app.unit.domain,
            app_id=app.app_id,
            username=next(iter(submissions.values())).payload["metadata"]["username"],
            local_profile=zipfile.ZipFile(document.local_ccz).read("profile.ccpr"),
            archives=archives,
            renames=renames,
            submissions=submissions,
        )


@pytest.fixture(scope="session")
def connect_documents():
    """The corpus documents ``DOCUMENTS`` names, by id, and no other."""
    from proof.checks import corpus

    found = {document.id: document for document in corpus.load(corpus.corpus_root()).emitted}
    missing = sorted(set(DOCUMENTS) - set(found))
    if missing:
        pytest.fail(
            f"The corpus holds no {missing}, which proof/connect/conftest.py::DOCUMENTS names as the Connect apps the"
            " Connect proofs run. Name documents the corpus holds."
        )
    return {document_id: found[document_id] for document_id in DOCUMENTS}


@pytest.fixture(scope="session")
def connect_apps(hq, core_runner, editor_driver, connect_out, connect_documents, connect_runtime):
    """Each document of ``DOCUMENTS`` as HQ holds it and as Connect is given it, by document id; what each was
    given is written under the run's ``connect/<document>/``."""
    found = connect_documents
    apps = {
        document_id: _connect_app(found[document_id], core_runner, editor_driver, connect_runtime)
        for document_id in DOCUMENTS
    }
    for app in apps.values():
        directory = connect_out / app.document
        directory.mkdir(parents=True, exist_ok=True)
        for name, archive in app.archives.items():
            (directory / f"{name}.ccz").write_bytes(archive)
        for name, submitted in app.submissions.items():
            (directory / f"{name}.submission.xml").write_bytes(submitted.xml)
            (directory / f"{name}.payload.json").write_text(
                json.dumps(
                    {
                        "appId": submitted.forwarded.app_id,
                        "buildId": submitted.forwarded.build_id,
                        "forwards": submitted.forwarded.forwards,
                        "payload": submitted.payload,
                    },
                    indent="\t",
                    sort_keys=True,
                    ensure_ascii=False,
                )
                + "\n"
            )
    return apps
