"""What the Connect proofs share: Connect's runtime, and each Connect document's builds, submissions and payloads.

``connect_runtime`` is one ``ConnectRuntime`` for the session (Connect at its
pin, its Postgres and Redis, its migrated database), stopped when the session
ends. ``connect_apps`` publishes each document ``DOCUMENTS`` names into HQ
as Nova's publish leaves it, and keeps everything Connect is ever given of
it:

- what HQ's own archive view answers Connect's download with
  (``views/cli.py::direct_ccz``, the request Connect's sync makes:
  ``opportunity/app_xml.py::get_form_xml_for_app``, ``latest=release``)
  once HQ released the app as its Releases page releases one, and, where the
  document carries the edit that renames its Connect block ids, its answer
  once Nova's publish of that edit is applied over it and released
  (``served_download``);
- a submission of each of its forms from each runtime path, each made by
  Core's own session (``proof.observe.sessions``): on HQ's build, on Nova's
  local archive replaying the same script (its runtime URLs naming the app
  HQ holds, ``proof.hq.operations.with_runtime_app_id``), on HQ's build and
  Nova's local archive of the edit, on HQ's build of the form as HQ's own
  form designer saves it (Vellum, ``proof.editors.vellum``), and, for the
  deliver app, on its control's pre-fix local archive
  (``proof/controls/targeted-connect-deliver-rename/local.ccz``), on the
  lane's day and on the day after;
- for the deliver apps, forms written by hand in a fork of the published app
  (``proof.rules.conftest.Published._write``), each a shape Nova's
  validator refuses or one it admits beside it (``REFUSED_NAMES``,
  ``ACCEPTED_NAMES`` and ``BOTH_IN_ONE_FORM``): HQ's build of the fork,
  HQ's own answer to Connect's download of it once released, and Core's
  submissions on that build;
- HQ's Connect payload for each, as HQ's own receiver and Connect repeater
  made and sent it (``_forwarded_by_hq``): each submission posted to HQ's
  receiver view under the app's id, which every archive Nova compiles names
  in its ``PostURL``, or, for the control's pre-fix archive, which names
  none, with no app named, and the payload read where it reached Connect.

A submission's location is written by CommCare Android alone: HQ's build adds
the meta's location node and the action that fills it (``xform.py::
XForm._add_meta_2``, ``orx:pollsensor``), and only Android runs that action
(``org/commcare/android/javarosa/PollSensorAction.java``). So a submission
"with a fix" here is the form a device's walk saved and sent HQ, with the fix
the device's GPS gave the app (``proof.android.observe``, its ``fix``), on
HQ's release or on Nova's local archive, which holds the node as HQ's build does.

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

from proof.connect.hq import HQ_XMLNS, META_XMLNS  # noqa: F401 - the tests read them here

# Every corpus document a Connect proof reads, by id: Nova's deliver app and learn app that each carry the edit
# renaming their Connect ids, and the deliver app the hand-written forks of finding 60 are made from. A deliver
# app holds its deliver unit in its first form and its task in a form of its own (finding 61).
DOCUMENTS = (
    "targeted-connect-deliver-rename",
    "targeted-connect-learn-rename",
    "connect-deliver-default",
)
DELIVER, LEARN, DELIVER_DEFAULT = DOCUMENTS
CONFIGURATION = "minimum"
# A session's submission of a deliver app's task form, named after the session's own (``by_form``).
TASK_FORM = "#task"
# A document's forms by their place in HQ's app (``"<module>.<form>"``): the first (a learn app's one form, a deliver
# app's deliver form) and a deliver app's task form.
FIRST_FORM_AT, TASK_FORM_AT = "0.0", "0.1"
# The fork of the deliver app whose deliver form also holds the task, the shape Nova's validator refuses
# (``CONNECT_DELIVER_FORM_HOLDS_TASK``), written by hand (``task_moved_into_the_deliver_form``, ``task_removed``).
BOTH_IN_ONE_FORM = "both"
# The submission of the deliver app's form with its deliver unit's ``work_area_id`` and that node's bind taken out.
WITHOUT_WORK_AREA = "without-work-area"
# The submission of the deliver app's control's pre-fix local archive, which names no submission URL.
CONTROL_LOCAL = "control-local"
CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn"
# The day after the lane's own (``proof.core.client.DEFAULT_CLOCK``), for a worker's second visit.
NEXT_DAY_CLOCK = "2026-01-16T10:30:00.000Z"
# Three places a device's GPS puts it (latitude, longitude, altitude, accuracy): one place, a place about four
# metres from it, and a place more than a hundred kilometres away; and the first as the device writes it.
FIX = (12.9716, 77.5946, 920.0, 5.0)
FIX_NEAR = (12.97164, 77.5946, 920.0, 5.0)
FIX_FAR = (13.9716, 77.5946, 920.0, 5.0)
WRITTEN = "12.9716 77.5946 920.0 5.0"


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


@dataclass(frozen=True)
class Download:
    """HQ's own answer to Connect's download of an app's archive: the request as Connect makes it (the path under
    its HQ server's address, and the query), and what HQ's view answered."""

    path: str
    query: dict
    status: int
    body: bytes
    # The released build HQ served.
    build_id: str


@dataclass
class ConnectApp:
    """One Connect document as HQ holds it and as Connect is given it."""

    document: str
    domain: str
    app_id: str
    username: str
    # The profile of Nova's local archive of the document.
    local_profile: bytes
    # HQ's answer to Connect's download of the app as published ("built") and after Nova's publish of its edit
    # ("renamed"), each released (``served_download``).
    downloads: dict = field(default_factory=dict)
    # Each Connect block's id in D and in the edit, by the block's element name.
    renames: dict = field(default_factory=dict)
    # By name: "<path>", "<path>@next" (the day after), each with "+fix", "+near" or "+far" where a fix was
    # written, and for a deliver app the task form's under the same name with ``TASK_FORM`` after it. The paths
    # are "hq" and "local", "renamed" and "renamed-local" where the document carries the edit, and "vellum",
    # "without-work-area" (the form with its deliver unit's ``work_area_id`` and that node's bind taken out),
    # "both" (``BOTH_IN_ONE_FORM``) and "control-local" (the control's pre-fix local archive, posted with no app
    # named) for the deliver app, and each hand-written form's name (``REFUSED_NAMES``, ``ACCEPTED_NAMES``).
    submissions: dict = field(default_factory=dict)
    # The profile of the deliver app's control's pre-fix local archive, which names no submission URL.
    control_local_profile: bytes | None = None


# Where Connect downloads an app's archive from its HQ server, and what it asks first
# (``opportunity/app_xml.py::get_form_xml_for_app``: the latest release, then the latest build, then the app as
# saved, each only where the one before it was not answered).
DOWNLOAD_PATH = "/a/{domain}/apps/api/download_ccz/"
DOWNLOAD_LATEST = "release"


def served_download(app, document, label, *, change=None, edit=False) -> Download:
    """HQ's own answer to the download Connect's sync makes of the app's archive, in a fork of the published
    state: the app released as HQ's Releases page releases one (``proof.formplayer.hq.serve``; after ``change``,
    Nova's publish of the edit, with the edit's worker and cases), then the request Connect makes answered by the
    view HQ's URLconf names, behind HQ's own middleware, with the headers Connect sends (none)."""
    from urllib.parse import urlencode

    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer.client import HqRequest

    path = DOWNLOAD_PATH.format(domain=app.unit.domain)
    query = {"app_id": app.app_id, "latest": DOWNLOAD_LATEST}
    with app.unit.fork():
        if change is not None:
            change()
        with formplayer_hq.serve(app.unit, document, app.app_id, label=f"connect-{label}", edit=edit) as served:
            views = formplayer_hq.HqViews(app.unit, served.username)
            views.begin(f"connect-download-{label}".encode(), None)
            answer = views(HqRequest("GET", path, urlencode(query), (), b""))
            view = views.exchanges[-1].url_name
            assert answer.status == 200 and view == "direct_ccz", (
                f"HQ's own view answered Connect's download of {document.id}'s release ({label}) with"
                f" {answer.status} from {view!r}, where its archive view serves the release: {answer.body[:600]!r}"
            )
            return Download(path, query, answer.status, bytes(answer.body), served.build_id)


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
    """Core's sessions on each build of one published document, and the submissions each made, one for each form
    the document holds (``document.wire_modules``)."""

    def __init__(self, document, app, core_runner, scratch):
        from proof.checks import casedata
        from proof.observe.sessions import hq_restore, local_restore

        self.document, self.app, self.core_runner, self.scratch = document, app, core_runner, Path(scratch)
        database = casedata.case_database(document.document)
        status, self.restore_hq = hq_restore(app.unit, database, app.export.content.lookups, "restore")
        assert self.restore_hq is not None, f"HQ's restore refused {document.id}'s lookup tables: {status}"
        self.restore_plain = local_restore(app.unit, database)
        self.forms = sum(len(module["forms"]) for module in document.wire_modules)
        assert self.forms in (1, 2), (
            f"{document.id} holds {self.forms} forms, where a Connect proof reads an app of one form, or a deliver"
            " app of a deliver form and its task's form"
        )
        self.script = None

    def _session(self, what, path, restore, script, clock):
        """Core's session on the archive at ``path``, replaying ``script`` (none: derived), and its submissions in
        the session's order; on the lane's day, or at ``clock``."""
        from proof.core.client import DEFAULT_CLOCK
        from proof.observe.runs import submission_of
        from proof.observe.sessions import admitted, unmarked_submission

        with admitted(self.core_runner, path) as report:
            assert report.get("admitted") and report.get("app") is not None, (
                f"Core did not admit {what} of {self.document.id}: {report}"
            )
            trace = self.core_runner.session(
                report["app"], restore=restore, script=script, clock=clock or DEFAULT_CLOCK
            )
        made = []
        for run in trace["runs"]:
            if submission_of(run) is None:
                continue
            xml, tokens = unmarked_submission(run)
            # The lane's day's first form keeps the lane's own ids; every other session gets its own.
            session = f"{clock or ''}#{len(made)}"
            made.append(xml if session == "#0" else _in_another_session(xml, tokens, session))
        return trace, made

    def submissions(self, what, path, restore, clock=None):
        """Each submission Core's session makes on the archive at ``path``, one for each form the document holds,
        in the session's order: the session derived on the first call, whose script every later call replays."""
        from proof.checks import proof3

        trace, made = self._session(what, path, restore, self.script, clock)
        if self.script is None:
            self.script = proof3.script_of(trace)
        assert len(made) == self.forms, (
            f"{what} of {self.document.id} submitted {len(made)} forms where the session ran its {self.forms}"
        )
        return made

    def by_form(self, name, submitted):
        """A session's submissions by name: the first form's under ``name``, and a deliver app's task form's under
        ``name`` with ``TASK_FORM`` after it."""
        return dict(zip([name, f"{name}{TASK_FORM}"][: len(submitted)], submitted, strict=True))

    def build(self, files, built, clock=None, *, name=None):
        """HQ's build's submissions of its forms (``by_form``, under ``name``, or ``built`` where none is given), the
        build arranged once under ``built``."""
        from proof.checks import proof3

        directory = self.scratch / built
        if not directory.exists():
            proof3.arrange_build(files, directory)
        submitted = self.submissions(f"HQ's build ({built})", directory, self.restore_hq, clock)
        return self.by_form(name or built, submitted)

    def archive(self, what, name, path, clock=None):
        """A local archive's submissions of its forms (``by_form``), under ``name``."""
        return self.by_form(name, self.submissions(what, path, self.restore_plain, clock))

    def alone(self, what, name, path):
        """The one submission of an archive of one form whose session is its own: derived on it, replaying
        nothing of the document's (the deliver app's control's pre-fix archive, which holds the task in its one
        form)."""
        _, made = self._session(what, path, self.restore_plain, None, None)
        assert len(made) == 1, f"{what} of {self.document.id} submitted {len(made)} forms where its one form was run"
        return {name: made[0]}


def _devices(app, document, forms) -> dict:
    """The forms a device's walk saves and sends HQ (``proof.android.observe``), on HQ's release and on Nova's local
    archive (given the input the lane gives Core over it), at each place its GPS puts it, on the lane's day or the
    next: ``hq+fix``, ``hq@next+near``, ``hq@next+far``, ``local+fix``, ``local@next+near``, each with the task
    form's after it (``TASK_FORM``) where the document holds one (``forms``, the number of its forms)."""
    from proof.android import observe as android
    from proof.formplayer import hq as formplayer_hq
    from proof.hq.operations import with_runtime_app_id
    from proof.observe.record import Blobs

    blobs, made = Blobs(), {}
    with formplayer_hq.serve(app.unit, document, app.app_id) as served:
        local = with_runtime_app_id(document.local_ccz.read_bytes(), app.app_id)
        archives = {"hq": (android.release_archive(served), False), "local": (local, True)}
        for name, side, fix, clock in (
            ("hq+fix", "hq", FIX, None),
            ("hq@next+near", "hq", FIX_NEAR, NEXT_DAY_CLOCK),
            ("hq@next+far", "hq", FIX_FAR, NEXT_DAY_CLOCK),
            ("local+fix", "local", FIX, None),
            ("local@next+near", "local", FIX_NEAR, NEXT_DAY_CLOCK),
        ):
            archive, delivered = archives[side]
            sent = []
            android.app(
                served, blobs, label=name, archive=archive, delivered=delivered, fix=list(fix), clock=clock, sent=sent
            )
            assert len(sent) == forms, (
                f"A device on {side} of {document.id} sent {len(sent)} forms where its walks run {forms}"
            )
            made.update(zip([name, f"{name}{TASK_FORM}"][:forms], sent, strict=True))
    return made


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


def _edit_publish(app, document):
    """Nova's publish of the document's edit, applied over the published app."""
    from proof.observe import publish

    def change():
        refusal, _ = publish.update(app.unit, app.app_id, document.edit.exports[CONFIGURATION].update, "update")
        assert refusal is None, f"HQ refused Nova's publish of {document.id}'s edit: {refusal}"

    return change


def _edit_build(app, document):
    """HQ's build of the app once Nova's publish of the document's edit is applied over it."""
    return _build_in_fork(app, "edit", _edit_publish(app, document))


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
    posts it, under the app's id, which every archive Nova compiles names in its ``PostURL``, or, for the
    control's pre-fix local archive (``control-local``), which names none, with no app named; taken by HQ's
    receiver whole and sent by HQ's own Connect repeater, with a token it asked Connect for, to a served Connect
    over a real connection (``proof.connect.hq.forwarding``). The payload is read where it arrived. That Connect
    holds HQ's server and no opportunity, so it authenticates HQ and answers that the form belongs to nothing:
    what Connect makes of a payload is each test's own scenario's to show."""
    from proof.connect import hq as connect_hq
    from proof.formplayer import hq as formplayer_hq

    wanted = [(name, xml, None if name == CONTROL_LOCAL else app.app_id) for name, xml in sorted(made.items())]
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


def _local_archive(scratch, name, path, app_id):
    """Nova's local archive at ``path`` as the deployment's archive names its app, ``app_id``
    (``proof.hq.operations.with_runtime_app_id``), written under ``scratch``."""
    from proof.hq.operations import with_runtime_app_id

    written = Path(scratch) / name
    written.write_bytes(with_runtime_app_id(path.read_bytes(), app_id))
    return written


def _without_work_area(root):
    """A form's root with each deliver unit's ``work_area_id`` and its bind taken out, as no editor writes it."""
    from lxml import etree

    xforms = "{http://www.w3.org/2002/xforms}"
    deliver, work_area = f"{{{CONNECT_XMLNS}}}deliver", f"{{{CONNECT_XMLNS}}}work_area_id"
    paths = set()
    for element in list(root.iter(work_area)):
        parent = element.getparent()
        if parent is None or parent.tag != deliver:
            continue
        # The node's absolute path, as its bind's node set names it: each step up to the form's data root.
        steps = [element]
        while steps[-1].getparent().tag != f"{xforms}instance":
            steps.append(steps[-1].getparent())
        paths.add("".join(f"/{etree.QName(step).localname}" for step in reversed(steps)))
        parent.remove(element)
    binds = [bind for bind in root.iter(f"{xforms}bind") if bind.get("nodeset") in paths]
    assert paths and len(binds) == len(paths), (sorted(paths), len(binds))
    for bind in binds:
        bind.getparent().remove(bind)


# Forms written by hand -------------------------------------------------------------------------------------------

XFORMS = "{http://www.w3.org/2002/xforms}"
VELLUM = "{http://commcarehq.org/xforms/vellum}"


def _data(root):
    """A form's data node: the one child of its main instance, the instance that carries no id."""
    (instance,) = [element for element in root.iter(f"{XFORMS}instance") if element.get("id") is None]
    (data,) = [child for child in instance if isinstance(child.tag, str)]
    return data


def _paths(element):
    """A data node's absolute path, as a bind's node set and a control's ref name it, and the same path as HQ's
    form builder names it (``#form/...``)."""
    from lxml import etree

    steps = [element]
    while steps[-1].getparent().tag != f"{XFORMS}instance":
        steps.append(steps[-1].getparent())
    names = [etree.QName(step).localname for step in reversed(steps)]
    return "/" + "/".join(names), "/".join(["#form", *names[1:]])


def _at_or_below(value, path) -> bool:
    return value == path or value.startswith(f"{path}/")


def _named(element, name):
    """``element`` named ``name`` in its own namespace."""
    from lxml import etree

    namespace = etree.QName(element).namespace
    element.tag = f"{{{namespace}}}{name}" if namespace else name


def block_named(kind, name):
    """A form's one Connect block of the element ``kind`` named ``name`` by hand, as Nova names a block: its wrapper
    node, each ``nodeset`` and ``ref`` at or below it (HQ's form builder's ``vellum:`` ones too), and the block's
    own id."""

    def change(root):
        (block,) = list(_data(root).iter(f"{{{CONNECT_XMLNS}}}{kind}"))
        wrapper = block.getparent()
        before = _paths(wrapper)
        _named(wrapper, name)
        block.set("id", name)
        after = _paths(wrapper)
        for element in root.iter():
            if not isinstance(element.tag, str):
                continue
            for attributes, old, new in (
                (("nodeset", "ref"), before[0], after[0]),
                ((f"{VELLUM}nodeset", f"{VELLUM}ref"), before[1], after[1]),
            ):
                for attribute in attributes:
                    value = element.get(attribute)
                    if value is not None and _at_or_below(value, old):
                        element.set(attribute, new + value[len(old) :])

    return change


def question_named(*names):
    """A form given one hidden value of each of ``names`` after its other data, each with its bind."""
    from lxml import etree

    def change(root):
        data = _data(root)
        binds = [child for child in data.getparent().getparent() if child.tag == f"{XFORMS}bind"]
        for name in names:
            node = etree.SubElement(data, data.tag)
            _named(node, name)
            bind = etree.Element(f"{XFORMS}bind", {"nodeset": _paths(node)[0], "calculate": "'kept'"})
            binds[-1].addnext(bind)
            binds.append(bind)

    return change


def _task_block(root):
    """A form's task: its wrapper node and the binds at or below it."""
    (block,) = list(_data(root).iter(f"{{{CONNECT_XMLNS}}}task"))
    wrapper = block.getparent()
    path, vellum = _paths(wrapper)
    binds = [
        bind
        for bind in root.iter(f"{XFORMS}bind")
        if _at_or_below(bind.get("nodeset") or "", path) or _at_or_below(bind.get(f"{VELLUM}nodeset") or "", vellum)
    ]
    return wrapper, binds


def task_moved_into_the_deliver_form(task_source):
    """The deliver form given the task form's (``task_source``) wrapper, block and binds beside its deliver unit,
    the wrapper in the deliver form's own namespace: the one form holding both, as no Nova form may."""
    import copy

    from lxml import etree

    from proof.checks.compare.xml_tree import parse_xml

    wrapper, binds = _task_block(parse_xml(task_source))

    def change(root):
        data = _data(root)
        moved = copy.deepcopy(wrapper)
        moved.tag = f"{{{etree.QName(data).namespace}}}{etree.QName(moved).localname}"
        (deliver,) = list(data.iter(f"{{{CONNECT_XMLNS}}}deliver"))
        deliver.getparent().addnext(moved)
        held = [child for child in data.getparent().getparent() if child.tag == f"{XFORMS}bind"]
        for bind in binds:
            held[-1].addnext(copy.deepcopy(bind))
            held.append(held[-1].getnext())

    return change


def task_removed(root):
    """The task form with its task's wrapper, block and binds taken out, its label left."""
    wrapper, binds = _task_block(root)
    for element in [wrapper, *binds]:
        element.getparent().remove(element)


# Each hand-written form of a document, by name: the form it changes (its place in HQ's app) and the change. The
# refused are the names Connect's receiver looks for at any depth of a submission, each as Nova would name a
# block (finding 60); the accepted are their replacements, the same names in another case or in the other kind
# of app, and hidden values named like the keys, which HQ never forwards.
REFUSED_NAMES = {
    DELIVER_DEFAULT: {
        "deliver-deliver": (FIRST_FORM_AT, block_named("deliver", "deliver")),
        "deliver-work_area_update": (FIRST_FORM_AT, block_named("deliver", "work_area_update")),
        "task-task": (TASK_FORM_AT, block_named("task", "task")),
    },
    LEARN: {
        "module-module": (FIRST_FORM_AT, block_named("module", "module")),
        "assessment-assessment": (FIRST_FORM_AT, block_named("assessment", "assessment")),
    },
}
ACCEPTED_NAMES = {
    DELIVER_DEFAULT: {
        **{
            f"deliver-{name}": (FIRST_FORM_AT, block_named("deliver", name))
            for name in ("q_deliver", "q_work_area_update", "module", "assessment")
        },
        **{f"task-{name}": (TASK_FORM_AT, block_named("task", name)) for name in ("q_task", "Task")},
        "questions": (FIRST_FORM_AT, question_named("deliver", "task", "work_area_update")),
    },
    LEARN: {
        **{
            f"module-{name}": (FIRST_FORM_AT, block_named("module", name))
            for name in ("q_module", "Module", "deliver", "task", "work_area_update")
        },
        "assessment-q_assessment": (FIRST_FORM_AT, block_named("assessment", "q_assessment")),
        "questions": (FIRST_FORM_AT, question_named("module", "assessment")),
    },
}


def _written(app, document, paths, name, sources, *, next_day=False):
    """A fork of the published app with ``sources`` (``{"m.f": change of its parsed root}``) written by hand: HQ's
    own answer to Connect's download of it once released, and Core's submissions on HQ's build of it (and on the
    day after, with ``next_day``)."""
    from proof.rules.conftest import rewritten

    written = {position: rewritten(change) for position, change in sources.items()}

    def change():
        app._write(sources=written)

    download = served_download(app, document, name, change=change)
    built = _build_in_fork(app, name, change)
    made = paths.build(built.files, name)
    if next_day:
        made.update(paths.build(built.files, name, NEXT_DAY_CLOCK, name=f"{name}@next"))
    return download, made


def _connect_app(document, core_runner, editor_driver, connect_runtime):
    from proof.checks.corpus import CONTROLS_DIR
    from proof.rules.conftest import published, rewritten

    with published(document, core_runner, CONFIGURATION) as app, tempfile.TemporaryDirectory() as scratch:
        built = app.spell()
        assert built.build.files is not None and not built.build.raised, built.build.raised
        paths = _Paths(document, app, core_runner, scratch)
        local = _local_archive(scratch, "local.ccz", document.local_ccz, app.app_id)
        control_profile = None
        downloads = {"built": served_download(app, document, "built")}
        made = {
            **paths.build(built.build.files, "built", name="hq"),
            **paths.archive("Nova's local archive", "local", local),
        }
        renames = {}
        if document.id in (DELIVER, LEARN):
            edited = _edit_build(app, document)
            downloads["renamed"] = served_download(
                app, document, "renamed", change=_edit_publish(app, document), edit=True
            )
            before, after = connect_ids(downloads["built"].body), connect_ids(downloads["renamed"].body)
            renames = {block: (before[block], after[block]) for block in sorted(before)}
            assert all(old != new for old, new in renames.values()), (
                f"{document.id}'s edit renames its Connect ids, and HQ's builds of it hold {renames}"
            )
            made.update(paths.build(built.build.files, "built", NEXT_DAY_CLOCK, name="hq@next"))
            made.update(paths.archive("Nova's local archive", "local@next", local, NEXT_DAY_CLOCK))
            made.update(paths.build(edited.files, "edit", name="renamed"))
            made.update(paths.build(edited.files, "edit", NEXT_DAY_CLOCK, name="renamed@next"))
            made.update(
                paths.archive(
                    "Nova's local archive of the edit",
                    "renamed-local",
                    _local_archive(scratch, "edit-local.ccz", document.edit.local_ccz, app.app_id),
                )
            )
        for name, (position, change) in {
            **REFUSED_NAMES.get(document.id, {}),
            **ACCEPTED_NAMES.get(document.id, {}),
        }.items():
            downloads[name], written = _written(app, document, paths, name, {position: change})
            made.update(written)
        if document.id == DELIVER:
            (deliver_form, task_form) = [form for module in built.stored["doc"]["modules"] for form in module["forms"]]
            # HQ's form builder opens and saves the app's first form, the deliver form.
            vellum_saved = _vellum_saved_build(app, editor_driver, deliver_form["unique_id"])
            made.update(paths.build(vellum_saved.files, "vellum"))
            without = app.spell(sources={FIRST_FORM_AT: rewritten(_without_work_area)})
            assert without.build.files is not None and not without.build.raised, without.build.raised
            made.update(paths.build(without.build.files, WITHOUT_WORK_AREA))
            downloads[BOTH_IN_ONE_FORM], both = _written(
                app,
                document,
                paths,
                BOTH_IN_ONE_FORM,
                {
                    FIRST_FORM_AT: task_moved_into_the_deliver_form(_held_source(app, task_form)),
                    TASK_FORM_AT: task_removed,
                },
                next_day=True,
            )
            made.update(both)
            made.update(_devices(app, document, paths.forms))
            # The control's pre-fix archive, which names no submission URL, for the refusal it meets. Its one form
            # holds the deliver unit and the task, so its session is its own.
            control = CONTROLS_DIR / DELIVER / "local.ccz"
            made.update(paths.alone("the control's pre-fix local archive", CONTROL_LOCAL, control))
            control_profile = zipfile.ZipFile(control).read("profile.ccpr")

        submissions = _forwarded_by_hq(app, document, made, connect_runtime)
        return ConnectApp(
            document=document.id,
            domain=app.unit.domain,
            app_id=app.app_id,
            username=next(iter(submissions.values())).payload["metadata"]["username"],
            local_profile=zipfile.ZipFile(local).read("profile.ccpr"),
            downloads=downloads,
            renames=renames,
            submissions=submissions,
            control_local_profile=control_profile,
        )


def _held_source(app, form):
    """The source HQ holds of one form of the published app (``form``: the form as the stored app names it)."""
    return app._app().get_form(form["unique_id"]).source


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
        for name, download in app.downloads.items():
            (directory / f"{name}.ccz").write_bytes(download.body)
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
