"""What HQ and Core hold that the intent check judges against the document (``proof.checks.intent``).

The intent check holds HQ's state and Core's runtime to what the Nova document
states. This observation reads the HQ and Core side of that, and nothing of
what the document states: the judge reads the document.

At each state of a unit (A, B and B-edit, ``observe``, called by
``proof.observe.unit`` at the state's mark):

- ``dataDictionary``: the data dictionary rows HQ's saves wrote for the
  project space, ``{case type: [property, ...]}`` (each publish's save runs
  ``data_dictionary/tasks.py::_refresh_data_dictionary_from_app``), read in
  one operation of the unit;
- ``forms``: Core's parse of every form HQ built (``modules-<m>/forms-<f>.xml``),
  the Core runner's ``formShape``: every node of the main instance's template
  with its namespace, value, calculate and constraint, by file name, each a
  blob; a form Core's parser raised on is ``{"refused": <what Core raised>}``
  (``core_raised``);
- ``evaluations`` (a targeted document only): each expectation whose export
  is this state under this configuration, its request run through Core's
  ``evaluate`` over the form HQ built (``evaluation``).

HQ's compile of each CSQL string a search sends is observed with proof 3's
sessions, which send them (``proof.observe.sessions.search_compiles``).

Only what the input makes Core raise is recorded: a failure of the harness
(the runner's JVM exiting, its protocol out of step, a request it refuses, a
deadline, an error of the JVM's own) is raised, so no record holds it.

Over the local archives (``observe_local``, called with the document's
``local`` part): Core's parse of every form of each archive Nova exported
(``archives``: ``{"local.ccz": {"forms": {...}}, ...}``), and each expectation
whose export is ``local`` (a form's in the local archive's bytes; a case
list's in the archive Core admits for it, released after).

What each case the document creates, each property it writes and each field
it validates is, and where HQ keeps each, is the judge's. A record never
names the state it was observed at, so B-edit's stands for B's where their
keys agree; and what this reads beyond its part's own inputs is what
``inputs`` declares: a targeted document's expectations, the file each one's
form is at and the restores they name.
"""

from __future__ import annotations

import base64
import hashlib
import re

from proof.checks.corpus import CorpusLayoutError
from proof.core.client import CoreRunnerError
from proof.observe.build import _placed, admission_placeholders
from proof.observe.record import canonical

# The file a form is built or exported at: ``modules-<m>/forms-<f>.xml``, where HQ and Nova both write it.
FORM_FILE = re.compile(r"modules-(\d+)/forms-(\d+)\.xml")
# A Java object written with ``Object.toString``: its class's name, ``@`` and its identity hash, which differs
# from run to run (Core writes parser nodes so, ``xpath/parser/Parser.java::verifyBaseExpr``'s "Bad node").
IDENTITY_HASH = re.compile(r"\b((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*)@[0-9a-f]{1,8}\b")

EXPECTATION_KEYS = frozenset({"id", "export", "form", "request", "expect", "configuration", "restore"})
REQUEST_KEYS = frozenset(
    {"answers", "constraintChecks", "expressions", "instances", "repeats", "session", "caseList", "locale", "clock"}
)
EXPORTS = ("local", "A", "B")
DEFAULT_CONFIGURATION = "minimum"


def form_file(m, f):
    """The file the form at wire position ``(m, f)`` is built and exported at (``FORM_FILE``)."""
    return f"modules-{m}/forms-{f}.xml"


def form_files(names):
    """The names among ``names`` that are a form's file (``modules-<m>/forms-<f>.xml``), sorted."""
    return sorted(name for name in names if FORM_FILE.fullmatch(name))


# A targeted document's expectations ------------------------------------------------


def expectations(document):
    """The expectations of a targeted document's ``expected.json``, each one the check can run, else refused.

    ``{"intent": [{"id", "export", "form", "request", "expect",
    "configuration"?, "restore"?}]}``: ``export`` is ``local``, or ``A`` or
    ``B`` for HQ's build under ``configuration`` (``minimum`` unless named),
    ``form`` a form of the document by its Nova uuid, ``request`` what Core's
    ``evaluate`` takes from an expectation (a case list only on the local
    export, the one installed archive here), and ``expect`` each
    ``{pointer, value}`` the result must hold, a JSON Pointer each.
    """
    value = document.expected
    where = document.root / "expected.json"
    entries = value.get("intent") if isinstance(value, dict) else None
    if not isinstance(entries, list) or not entries:
        raise CorpusLayoutError(f'{where} holds {{"intent": [expectation, ...]}}, at least one.')
    ids = set()
    for entry in entries:
        if not isinstance(entry, dict) or not {"id", "export", "form", "request", "expect"} <= set(entry):
            raise CorpusLayoutError(f"{where}: each expectation holds id, export, form, request and expect.")
        if set(entry) - EXPECTATION_KEYS:
            raise CorpusLayoutError(
                f"{where}: {entry['id']} holds {sorted(set(entry) - EXPECTATION_KEYS)}, which"
                f" no expectation reads (it reads {sorted(EXPECTATION_KEYS)})."
            )
        if entry["id"] in ids:
            raise CorpusLayoutError(f"{where}: two expectations share the id {entry['id']!r}.")
        ids.add(entry["id"])
        if entry["export"] not in EXPORTS:
            raise CorpusLayoutError(f"{where}: {entry['id']}'s export is local, A or B, not {entry['export']!r}.")
        unknown = set(entry["request"]) - REQUEST_KEYS
        if unknown:
            raise CorpusLayoutError(
                f"{where}: {entry['id']}'s request holds {sorted(unknown)}, which Core's evaluate"
                f" does not take from an expectation (it takes {sorted(REQUEST_KEYS)})."
            )
        if "caseList" in entry["request"] and entry["export"] != "local":
            raise CorpusLayoutError(
                f"{where}: {entry['id']} opens a case list on {entry['export']}; a case list needs"
                " an installed archive, and only the local export is one here."
            )
        expect = entry["expect"]
        if (
            not isinstance(expect, list)
            or not expect
            or not all(
                isinstance(e, dict) and set(e) == {"pointer", "value"} and str(e["pointer"]).startswith("/")
                for e in expect
            )
        ):
            raise CorpusLayoutError(f"{where}: {entry['id']}'s expect lists {{pointer, value}}, a JSON Pointer each.")
    return entries


def form_position(wire_modules, form_uuid):
    """``(module, form)``, the position the wire layout places a form at, or None where it places it nowhere."""
    for m, module in enumerate(wire_modules):
        if form_uuid in module["forms"]:
            return m, module["forms"].index(form_uuid)
    return None


def _restore_path(document, entry):
    from proof.core.artifacts import TEMPLATE_RESTORE

    return (document.root / entry["restore"]) if entry.get("restore") else TEMPLATE_RESTORE


def _runs_at(document, state, configuration=None):
    """The expectations that run at ``state`` (``local``, ``A`` or ``B``), under ``configuration`` where named."""
    if not document.targeted:
        return []
    return [
        entry
        for entry in expectations(document)
        if entry["export"] == state
        and (configuration is None or entry.get("configuration", DEFAULT_CONFIGURATION) == configuration)
    ]


def inputs(document, state):
    """What this observation reads at ``state`` beyond its part's own inputs: a targeted document's expectations
    run there (their requests, the file each one's form is at, which the document's wire layout places, and each
    restore a document's directory holds), else nothing."""
    entries = _runs_at(document, state)
    if not entries:
        return {}
    requests = [
        {
            **{key: entry.get(key) for key in ("id", "form", "configuration", "request", "restore")},
            "file": _form_file(document.wire_modules, entry),
        }
        for entry in entries
    ]
    files = {}
    for entry in entries:
        if entry.get("restore"):
            path = document.root / entry["restore"]
            files[entry["restore"]] = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    return {"requests": "sha256:" + hashlib.sha256(canonical(requests)).hexdigest(), "files": files}


# What Core raised ------------------------------------------------------------------


def core_raised(error: CoreRunnerError):
    """What Core raised, where the runner reports that the op itself raised an exception: ``{"class",
    "message"}``, Core's message without the identity hashes it can hold (``IDENTITY_HASH``); else None.

    The runner reports what an op throws as kind ``internal`` with the
    throwable's class and its stack trace (``proof/core/src/nova/proof/core/
    Runner.java::handle``, its ``ExecutionException`` branch). Nothing else
    the runner or its client reports carries both: the JVM exiting, the
    protocol out of step, a request the runner refuses (kind ``request``), a
    deadline, the runner interrupted while it waits (a class and no trace).
    Nor is a ``java.lang.Error`` the input's (``OutOfMemoryError``,
    ``StackOverflowError``: the JVM's state), and the JDK names each of its
    errors ``…Error`` (but ``ThreadDeath``, which no op raises). All of these
    are the harness's, and the caller raises them, so a record holds only
    what the input makes Core raise.
    """
    detail = error.detail
    name = str(detail.get("class") or "")
    if error.kind != "internal" or not name or not detail.get("trace") or name.endswith("Error"):
        return None
    return {"class": name, "message": IDENTITY_HASH.sub(r"\1", str(detail.get("message") or ""))}


# Core's parse of a form ------------------------------------------------------------


def form_shape(core_runner, xml: bytes):
    """Core's parse of one form (the runner's ``formShape`` nodes), or ``{"refused": <what Core raised>}`` where
    Core's parser raised on it (``core_raised``); any other failure is raised."""
    try:
        return core_runner.request("formShape", deadline=60.0, formBase64=base64.b64encode(xml).decode("ascii"))[
            "nodes"
        ]
    except CoreRunnerError as error:
        raised = core_raised(error)
        if raised is None:
            raise
        return {"refused": raised}


def _shapes(core_runner, files, blobs, cache):
    """Each form file's parse by Core, as a record holds it: a blob of its nodes, or the refusal itself."""
    found = {}
    for name in form_files(files):
        xml = files[name]
        digest = hashlib.sha256(xml).hexdigest()
        if digest not in cache:
            cache[digest] = form_shape(core_runner, xml)
        shape = cache[digest]
        found[name] = blobs.put_json(shape) if isinstance(shape, list) else shape
    return found


# HQ's data dictionary -----------------------------------------------------------------


def data_dictionary_rows(domain):
    """The data dictionary HQ's saves wrote for the project space: case type -> property names."""
    from corehq.apps.data_dictionary.models import CaseProperty, CaseType

    rows = {name: [] for name in CaseType.objects.filter(domain=domain).values_list("name", flat=True)}
    for case_type, name in CaseProperty.objects.filter(case_type__domain=domain).values_list("case_type__name", "name"):
        rows.setdefault(case_type, []).append(name)
    return {case_type: sorted(names) for case_type, names in sorted(rows.items())}


# Core's evaluate, for a targeted document ------------------------------------------------


def evaluation(core_runner, document, entry, blobs, *, form=None, archive=None):
    """One expectation's request run through Core's ``evaluate``: ``{"result": <blob>}``.

    A form's request runs in ``form`` (the form's own bytes); a case list's in
    ``archive``, the local export, which Core admits for it and releases
    after: ``{"refused": <its admission problems>}`` where Core refuses it.
    Where Core's evaluate raises it is ``{"failed": <what Core raised>}``
    (``core_raised``), for the judge to name with the expectation; any other
    failure is raised.
    """
    request = dict(entry["request"])
    request["restoreBase64"] = base64.b64encode(_restore_path(document, entry).read_bytes()).decode("ascii")
    app = None
    try:
        if "caseList" in request:
            report = core_runner.admit(archive)
            app = report.get("app")
            if app is None:
                problems = _placed(report.get("problems"), admission_placeholders(report, archive))
                return {"refused": blobs.put_json(problems)}
        else:
            request["formBase64"] = base64.b64encode(form).decode("ascii")
        result = core_runner.evaluate(deadline=120.0, app=app, **request)
    except CoreRunnerError as error:
        raised = core_raised(error)
        if raised is None:
            raise
        return {"failed": raised}
    finally:
        if app is not None and core_runner.holds(app):
            core_runner.release(app)
    return {"result": blobs.put_json(result)}


def _form_file(wire_modules, entry):
    position = form_position(wire_modules, entry["form"])
    return None if position is None else form_file(*position)


# The hooks the unit calls -----------------------------------------------------------------


def observe(ctx) -> dict:
    """The intent observation at one state: HQ's data dictionary, Core's parse of each form HQ built, and a
    targeted document's expectations run there (``ctx``: ``proof.observe.unit.HookContext``)."""
    with ctx.unit.operation("intent-data-dictionary", b""):
        rows = data_dictionary_rows(ctx.unit.domain)
    record = {"dataDictionary": rows, "forms": {}}
    files = ctx.build.files
    if files is not None:
        record["forms"] = _shapes(ctx.core_runner, files, ctx.blobs, {})
    entries = _runs_at(ctx.document, ctx.state, ctx.configuration_name) if ctx.state in EXPORTS else []
    evaluations = {}
    for entry in entries:
        name = _form_file(ctx.document.wire_modules, entry)
        form = (files or {}).get(name) if name is not None else None
        if form is not None:
            evaluations[entry["id"]] = evaluation(ctx.core_runner, ctx.document, entry, ctx.blobs, form=form)
    if evaluations:
        record["evaluations"] = evaluations
    return record


def observe_local(ctx) -> dict:
    """The intent observation over the local archives: Core's parse of each form of each, and a targeted
    document's expectations on the local export (``ctx``: ``proof.observe.unit.LocalContext``)."""
    import zipfile

    cache = {}
    archives = {}
    entries_of = {}
    for name, path in ctx.archives.items():
        with zipfile.ZipFile(path) as archive:
            entries = {entry: archive.read(entry) for entry in form_files(archive.namelist())}
        entries_of[name] = entries
        archives[name] = {"forms": _shapes(ctx.core_runner, entries, ctx.blobs, cache)}
    record = {"archives": archives}
    evaluations = {}
    local = ctx.archives.get("local.ccz")
    for entry in _runs_at(ctx.document, "local") if local is not None else []:
        if "caseList" in entry["request"]:
            evaluations[entry["id"]] = evaluation(ctx.core_runner, ctx.document, entry, ctx.blobs, archive=local)
            continue
        name = _form_file(ctx.document.wire_modules, entry)
        form = entries_of["local.ccz"].get(name) if name is not None else None
        if form is not None:
            evaluations[entry["id"]] = evaluation(ctx.core_runner, ctx.document, entry, ctx.blobs, form=form)
    if evaluations:
        record["evaluations"] = evaluations
    return record
