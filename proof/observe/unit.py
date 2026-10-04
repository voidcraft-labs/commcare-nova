"""One HQ unit per (document, configuration): every observation the checks read, made once, as keyed records.

``observe_document(document, core_runner=..., editor_driver=..., store=...)``
opens one unit (``proof.hq.state.hq_unit``) per configuration the document
is exported under, rooted at the key of its ``a`` part, and runs the tree
below, each HQ step inside ``unit.operation(label, digest of its input)`` so
the unit's state, entropy and clock are a function of the inputs alone:

```
seed → create(D) [lookup upload, replace] → media(D) → HQ-side saves → build(A) (no previous) → admit (Core)
  → identities, flag reads → saved(build(A)) → mark@A
  → A's restore for proof 3 (in a fork) → the intent hook at A
  → sensitivity: build(A | each gate HQ read, flipped), each in a fork
  b:         restore@A → republish(D) → media(D) → build(B | saved(build(A))) → admit → identities
                → mark@B → the intent hook at B → proof4.observe_b → restore@B
  b_aligned: (at mark@B) B aligned to A → build(B-aligned | saved(build(A)))
                → proof 3's sessions (local archive and A; B where the raw builds differ)
             (at mark@A where HQ refused B: the local archive's and A's sessions alone)
  b_edit:    restore@A → update(D′) → media(D′) → build(B-edit | saved(build(A))) → admit → identities
                → mark@B-edit → the intent hook at B-edit → proof4.observe_b → restore@B-edit
local: Core's admission of local.ccz, local-again.ccz and edit/local.ccz → the intent and manifest local hooks
```

``media`` is the media upload Nova's publish sends after an import HQ
accepted (``proof.observe.publish.upload_media``), where the captured
import names one: an operation of its own, keyed by the upload's request,
as Nova sends it in a request of its own. A publish without media runs no
such operation, so its records are what they were before the media was
replayed. ``HQ-side saves`` are what a person saves in HQ over A before
Nova's next publish, where the document carries them (``hq-side.json``,
``proof.observe.hqside``): each an operation of its own, so A is what HQ
holds when Nova publishes again, and B and B-edit are published over it.

The records (``proof.observe.record``) are split into parts, each under its
own key (``part_keys``): ``a`` (the configuration with its privileges, A's
create and its media upload, build, admission, identities and flag reads,
the sensitivity flips, A's restore, the intent hook at A), ``b`` (the
republish and its media upload, B's build, the intent hook and proof 4 at B:
the same steps B-edit takes, so a ``b_edit`` keyed as ``b`` is
``{"same_as": <b's key>}``, observed once), ``b_aligned`` (B aligned to A
and its build, proof 3's sessions: keyed under ``b`` with the local archive
the sessions replay on), ``b_edit`` (the update and its media upload,
B-edit's build, the intent hook and proof 4 at B-edit) and ``local`` (one
per document: what reads no HQ state, Core's admission of each local archive
and what the local hooks observe). Every part also records each of its
operations, with the key and depth it ran under (its entropy and clock, so a
part observed over a recreated state shows it was the same) and every soft
assertion HQ noted inside it: HQ notes them and
goes on, as production does (``proof.hq.boot``: ``corehq/util/soft_assert/
core.py::SoftAssert._call`` raises only under ``settings.UNIT_TESTING``, or
``settings.DEBUG`` for ``fail_if_debug``, and production has neither).

Before a part is observed the store is asked for it (``store.lookup``): a
part the store holds is not observed again. One it does not hold under
parts it does recreates what it is observed over with the same operations,
so the same state: A (create, its media, build, saved build) under a held
``a``, and B (republish, its media, build) under a held ``b``. With
``store.fresh`` every part is observed and handed to ``store.audit`` beside
what the store held. While a part (or what it is observed over) is
observed, the evidence store's guard (``proof.store.guard.observing``)
refuses any read its key does not name, and while the keys are derived, any
read the document's key does not name.

Records hold no timings: what each part and operation took is kept beside
them (``DocumentRecords.timings``).

The observation hooks other tracks fill are called where they exist:
``proof.observe.intent`` (``observe(ctx)`` at A, B and B-edit,
``HookContext``), ``proof.observe.proof4`` (``observe_b(ctx)`` at B and
B-edit, ``BContext``), and ``proof.observe.intent`` and
``proof.observe.manifest`` with the ``local`` part (``observe_local(ctx)``,
``LocalContext``: what reads no HQ state, such as every export Nova sends,
which is used whether or not HQ accepts it). Each also declares what it
reads beyond its part's own inputs, ``inputs(document, state) -> dict``
(``hook_inputs``, ``state`` one of ``A``, ``B``, ``B-edit`` and ``local``),
which joins that state's part key; returns a JSON-able record that never
names the state it ran at; and leaves the unit at the mark it was given. A
hook imports only the observation partition (``proof.observe.partition``,
held by ``test_judge_purity``), and the check it is named for reports what
HQ noted in its operations and requests
(``observations.soft_assertion_differences``, held by ``test_bar``).
"""

from __future__ import annotations

import hashlib
import importlib
import json
import time
from contextlib import contextmanager
from dataclasses import dataclass

from proof.checks.corpus import DERIVED
from proof.observe.alignment import align_positions, aligned_app
from proof.observe.outcome import BuildOutcome, outcome_from_record, outcome_record
from proof.observe.record import (
    NULL_STORE,
    PARTS,
    Blobs,
    ConfigurationRecords,
    DocumentRecords,
    canonical,
    configuration_record,
    part_key,
)

LOCAL_ROLES = (("local", "local.ccz"), ("local-again", "local-again.ccz"), ("edit-local", "edit/local.ccz"))
# A corpus document's input manifest (``proof/corpus/inputs.ts``), which a control does not keep.
INPUTS = "inputs.json"
# What a person saves in HQ over A before Nova's next publish, where the document carries it (proof.observe.hqside).
HQ_SIDE = "hq-side.json"
# The roles of B-edit's inputs its key does not read: its verdict decides only whether the corpus holds its
# publish, and its document is read through the case database it gives (``case_databases``) and what each
# hook declares it reads (``hook_inputs``).
B_UNREAD_ROLES = frozenset({"verdict", "document"})
STATES = ("A", "B", "B-edit")
# The document's local part, which the local hooks observe with (``observe_local``).
LOCAL = "local"
# Each observation hook: its module under ``proof.observe``, the function the unit calls, the states it is
# called at.
HOOKS = (
    ("intent", "observe", STATES),
    ("intent", "observe_local", (LOCAL,)),
    ("manifest", "observe_local", (LOCAL,)),
    ("proof4", "observe_b", ("B", "B-edit")),
)


class HookContractError(TypeError):
    """An observation hook's module lacks what the unit calls on it."""


# Inputs and keys ----------------------------------------------------------------


def _file_digest(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def archive_digest(path):
    """The digest of an archive's entries (``proof/corpus/inputs.ts::archiveDigest``)."""
    import zipfile

    with zipfile.ZipFile(path) as archive:
        entries = sorted(
            (info.filename, hashlib.sha256(archive.read(info)).hexdigest())
            for info in archive.infolist()
            if not info.is_dir()
        )
    return "entries-sha256:" + hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def _request(root, directory, name):
    """A captured request's files, by role: its body and sidecar, and the lookup workbook pushed before it and the
    media upload sent after it, each a body with its own sidecar, where its sidecar names one."""
    sidecar = f"{directory}/{name}.json"
    meta = json.loads((root / sidecar).read_text(encoding="utf-8"))
    part = {"request.body": f"{directory}/{name}.body", "request.json": sidecar}
    for role in ("lookups", "media"):
        if meta.get(role) is not None:
            base = meta[role].removesuffix(".body")
            part[f"{role}.body"] = f"{directory}/{base}.body"
            part[f"{role}.json"] = f"{directory}/{base}.json"
    return part


def _prefixed(prefix, part):
    return {f"{prefix}{role}": path for role, path in part.items()}


def input_files(document):
    """Each part's input files, by role, as paths relative to the document's directory, laid out as
    ``proof/corpus/inputs.ts`` lays out ``inputs.json``: ``{"configurations": {<name>: {"a", "b", "b_edit"?}},
    "local"}``. What each part's key reads (``computed_inputs``), and so what the evidence store's guard lets its
    observation read (``proof.store.guard.input_files``)."""
    root = document.root
    edited = (root / "edit" / "batch.json").exists()
    privileges = _prefixed("privileges.create.", _request(root, "export/minimum", "create"))
    if edited and (root / "edit/export/minimum/update.json").exists():
        privileges.update(_prefixed("privileges.update.", _request(root, "edit/export/minimum", "update")))
    # A control retains what the checks derive from D and D' in place of their document.json (Document.derived).
    control = document.kind == "control"
    shared = {
        "configurations": "configurations.json",
        "document": DERIVED if control else "document.json",
        "verdict": "verdict.json",
    }
    if (root / HQ_SIDE).exists():
        shared["hqSide"] = HQ_SIDE
    configurations = {}
    for name in sorted(document.exports):
        part = {
            "a": {**shared, **_prefixed("create.", _request(root, f"export/{name}", "create")), **privileges},
            "b": _request(root, f"export/{name}", "republish"),
        }
        if edited and (root / f"edit/export/{name}/update.json").exists():
            part["b_edit"] = {
                **_request(root, f"edit/export/{name}", "update"),
                "document": DERIVED if control else "edit/document.json",
                "verdict": "edit/verdict.json",
            }
        configurations[name] = part
    local = {role: path for role, path in LOCAL_ROLES if (root / path).exists()}
    return {"configurations": configurations, "local": local}


def computed_inputs(document):
    """The document's input digests, by role, computed from its files (``input_files``) as
    ``proof/corpus/inputs.ts`` computes them: a local archive's over its entries (``archive_digest``), every other
    file's over its bytes."""
    root = document.root
    files = input_files(document)
    return {
        "configurations": {
            name: {
                part: {role: _file_digest(root / path) for role, path in roles.items()} for part, roles in parts.items()
            }
            for name, parts in files["configurations"].items()
        },
        "local": {role: archive_digest(root / path) for role, path in files["local"].items()},
    }


def document_inputs(document):
    """Each part's input digests, by role: a corpus document's ``inputs.json``, or what its files give
    (``computed_inputs``, which gives what ``inputs.json`` holds) for a control, which keeps none
    (``proof.checks.controls``), and for a copy of a document without one."""
    path = document.root / INPUTS
    if document.kind == "control" or not path.exists():
        return computed_inputs(document)
    written = json.loads(path.read_text(encoding="utf-8"))

    def digests(part):
        return {role: entry["digest"] for role, entry in part.items()}

    return {
        "configurations": {
            name: {part: digests(roles) for part, roles in parts.items()}
            for name, parts in written["configurations"].items()
        },
        "local": digests(written.get("local") or {}),
    }


def case_databases(document):
    """The digest of the case database D's sessions run over, and D′'s (``observe.casedata.database_digest``)."""
    from proof.observe.casedata import database_digest, document_case_database

    found = {"b": database_digest(document_case_database(document))}
    if document.edit is not None:
        found["b_edit"] = database_digest(document_case_database(document, edit=True))
    return found


def _module(name):
    """The module ``proof.observe.<name>``, or None while that observation does not exist."""
    module_name = f"proof.observe.{name}"
    try:
        return importlib.import_module(module_name)
    except ModuleNotFoundError as error:
        if error.name == module_name:
            return None
        raise


def hook_modules():
    """Each observation hook that exists: ``[(name, module, function, states)]``."""
    found = []
    for name, function, states in HOOKS:
        module = _module(name)
        if module is None:
            continue
        missing = [attribute for attribute in (function, "inputs") if not callable(getattr(module, attribute, None))]
        if missing:
            raise HookContractError(
                f"proof/observe/{name}.py is an observation hook, and it defines no {' and no '.join(missing)}."
                f" The unit calls {function}(ctx) at {', '.join(states)}, and keys each part by what the hook's"
                " inputs(document, state) returns, the digests of everything it reads beyond that part's own"
                " inputs (proof/observe/unit.py)."
            )
        found.append((name, module, function, states))
    return found


def hook_inputs(document):
    """What each hook that exists reads beyond its part's own inputs, by state (``local`` too):
    ``{state: {hook: inputs}}``."""
    found = {state: {} for state in (*STATES, LOCAL)}
    for name, module, _, states in hook_modules():
        for state in states:
            if state == "B-edit" and document.edit is None:
                continue
            found[state][name] = json.loads(canonical(module.inputs(document, state)))
    return found


def part_keys(inputs, name, databases, hooks=None):
    """The keys of one configuration's ``a``, ``b``, ``b_aligned`` and ``b_edit`` parts.

    ``a`` reads everything A is made from (``inputs.json``'s ``a`` roles:
    the configurations, the document, its verdict, the create, its workbook
    and media upload, the privilege inputs). ``b`` and ``b_edit`` are keyed
    alike: kind ``b``, parent ``a``, the request's digests (its body, its
    sidecar, the workbook and media upload it names) and the case database
    proof 4 replays over (``databases``: ``case_databases``), so a B-edit
    whose update sends B's bytes over B's cases has B's key. Nothing else of
    D′ is read over B-edit but what a hook declares. ``b_aligned`` is keyed
    under ``b`` with the local archive proof 3's sessions replay on
    (``inputs.json``'s ``local`` role); its cases and B's lookups are
    ``b``'s. Each state's part also reads what each hook declares for that
    state (``hooks``: ``hook_inputs``).
    """
    hooks = hooks or {}
    parts = inputs["configurations"][name]
    a = part_key("a", None, {"configuration": name, "inputs": parts["a"], "hooks": hooks.get("A", {})})
    keys = {"a": a}
    for part, state in (("b", "B"), ("b_edit", "B-edit")):
        if part in parts:
            requests = {role: value for role, value in parts[part].items() if role not in B_UNREAD_ROLES}
            keys[part] = part_key(
                "b", a, {"inputs": requests, "caseDatabase": databases[part], "hooks": hooks.get(state, {})}
            )
    if "b" in keys:
        keys["b_aligned"] = part_key("b_aligned", keys["b"], {"localArchive": inputs["local"].get("local")})
    return keys


def local_key(inputs, hooks=None):
    """The ``local`` part's key: the local archives, and what each local hook declares it reads (``hooks``:
    ``hook_inputs``)."""
    declared = (hooks or {}).get(LOCAL) or {}
    return part_key("local", None, {"archives": inputs["local"], **({"hooks": declared} if declared else {})})


# Hooks -----------------------------------------------------------------------------


class HookUnit:
    """The unit as a hook sees it: the unit itself, with each operation the hook runs logged in its part's record
    under the hook's name (``OperationLog``), and each of its requests in which HQ noted a soft assertion."""

    def __init__(self, unit, log, hook):
        self._unit, self._log, self._hook = unit, log, hook

    def operation(self, label, digest):
        return self._log(label, digest, hook=self._hook)

    @contextmanager
    def request(self, digest):
        with self._unit.request(digest) as scope:
            yield scope
        if scope.soft_assertions:
            self._log.requests.append(
                {"hook": self._hook, "request": digest.hex(), "softAssertions": _notes(scope.soft_assertions)}
            )

    def __getattr__(self, name):
        return getattr(self._unit, name)


@dataclass
class HookContext:
    """What an observation hook reads at one state (A, B or B-edit), the unit at that state's mark.

    A hook's record is part of its state's part, under that part's key, so it
    is a function of what that key names: the unit's state, the build, the
    configuration, and of the document only what the hook's own
    ``inputs(document, state)`` declares (``hook_inputs``). It never names the
    state it was observed at, so B-edit's record stands for B's where their
    keys agree. ``unit`` is a ``HookUnit``: each operation the hook runs is
    logged in the part's record with what HQ noted in it.
    """

    document: object
    state: str
    unit: HookUnit
    app_id: str
    build: BuildOutcome
    hq_build: object
    core_runner: object
    blobs: Blobs
    configuration: object  # proof.hq.configuration.Configuration
    configuration_name: str  # the configuration's name in the corpus (its export directory)


@dataclass
class LocalContext:
    """What a local hook reads with the document's ``local`` part: no HQ state, and no unit.

    Its record is part of the ``local`` part, under its key: the local
    archives and what the hook's ``inputs(document, "local")`` declares.
    """

    document: object
    archives: dict  # each local archive the document carries, by its name in the document: {name: Path}
    core_runner: object
    blobs: Blobs


@dataclass
class BContext:
    """What ``proof.observe.proof4.observe_b`` reads at B or B-edit, the unit (a ``HookUnit``) at that state's mark.

    The same rule as ``HookContext``: what it records is a function of its
    part's key, of which ``proof4.inputs(document, over)`` is part.
    """

    document: object
    over: str  # "B" or "B-edit"
    configuration: object
    configuration_name: str
    unit: HookUnit
    app_id: str
    build: BuildOutcome  # B's build, its previous build saved(build(A))
    hq_build: object  # for saved_build()
    sessions: object  # (case database, the lookup workbook capture or None)
    restore: bytes
    core_runner: object
    editor_driver: object
    blobs: Blobs
    store: object
    # HQ's restore over the document's tables: ``{"served": True}``, or ``{"refused": reason}`` where ``restore``
    # is None (``proof.observe.sessions.hq_restore``).
    restore_outcome: dict


# Observation -----------------------------------------------------------------------


def _notes(soft_assertions):
    return [
        {"message": note.message, "value": note.value, "where": note.where, "line": note.line}
        for note in soft_assertions
    ]


class OperationLog:
    """The operations a part ran, each with the key and depth it ran under and what HQ noted in it (and the hooks'
    requests that noted something), and what each took (kept apart, in ``timings``)."""

    def __init__(self, unit, record, timings):
        self.unit, self.log, self.requests, self.timings, self.flags = unit, [], [], timings, []
        self.record = record

    @contextmanager
    def __call__(self, label, input_digest, **about):
        started = time.perf_counter()
        first = len(self.record.flags)
        with self.unit.operation(label, input_digest) as scope:
            yield scope
        reads = self.record.flags[first:]
        # The key and depth the operation ran under: its entropy and its clock (``proof.hq.branch``).
        entry = {"label": label, **about, "key": scope.key.hex()[:16], "depth": scope.depth, "wrote": scope.wrote}
        if scope.soft_assertions:
            entry["softAssertions"] = _notes(scope.soft_assertions)
        self.log.append(entry)
        self.flags.append((label, sorted({read.symbol or read.slug for read in reads})))
        self.timings.setdefault("operations", []).append([label, round(time.perf_counter() - started, 4)])

    def recorded(self, record):
        """``record`` with the operations (and any noting request, in a fixed order) written into it."""
        record["operations"] = self.log
        if self.requests:
            record["requests"] = sorted(self.requests, key=canonical)
        return record


def _json(value):
    return json.loads(json.dumps(value, default=str))


@dataclass
class _Built:
    """One built state: its outcome, HQ's Build, its identities and its stored document."""

    outcome: BuildOutcome
    hq_build: object
    identities: dict | None
    doc: dict


def _build(unit, ops, core_runner, app_id, name, previous, *, configuration=None, identities=True):
    """HQ's build of the app the unit holds, Core's admission of it, and its identities, in one operation.

    The build reads the app freshly, with every cache emptied first
    (``proof.observe.sensitivity.build``), and the flags HQ read while it built
    come back with it (by constant, else by slug). With ``configuration``, it is
    A's plain build (``proof.observe.sensitivity.plain_build``) and the
    project-space settings it read come back too; otherwise none do.
    Returns ``(_Built, flags read, settings read)``.
    """
    from proof.hq.seams import build_seams
    from proof.observe import sensitivity
    from proof.observe.build import admit_build
    from proof.observe.identity import app_identity

    flags = settings = None
    with ops("build", b""):
        if configuration is not None:
            built, flags, settings = sensitivity.plain_build(unit, unit.record, app_id, configuration)
        else:
            first = len(unit.record.flags)
            built = sensitivity.build(unit, unit.record, app_id, name, previous)
            flags = sorted({read.symbol or read.slug for read in unit.record.flags[first:]})
        found = None
        if identities:
            with build_seams(previous=previous):
                admit_build(core_runner, built.app, built.outcome)
                found = app_identity(built.app, built.outcome.files, unit.domain)
        doc = _json(built.app.to_json())
    return _Built(built.outcome, built.hq_build, found, doc), flags, settings


def _state_record(built: _Built, blobs):
    return {
        "build": outcome_record(built.outcome, blobs),
        "identities": built.identities,
        "doc": blobs.put_json(built.doc),
    }


def _built_from(record, blobs, name):
    """A built state as a record holds it, for what is observed over it without observing it again."""
    return _Built(
        outcome_from_record(record["build"], blobs, name), None, record["identities"], blobs.get_json(record["doc"])
    )


def _publish_record(refusal, lookups, media=None):
    """A publish as the record holds it: HQ's refusal of the import, the lookup upload's result, and, where the
    publish sent media, what HQ's processing of it reported (``proof.observe.publish.upload_media``)."""
    record = {"refused": refusal, "lookups": lookups}
    if media is not None:
        record["media"] = media
    return record


def _flags_of(ops, labels):
    return sorted({symbol for label, symbols in ops.flags if label in labels for symbol in symbols})


class _Unit:
    """One configuration's unit and what its parts share."""

    def __init__(self, document, export, configuration, unit, core_runner, editor_driver, store, blobs, timings):
        self.document, self.export, self.configuration = document, export, configuration
        self.unit, self.core_runner, self.editor_driver = unit, core_runner, editor_driver
        self.store, self.blobs, self.timings = store, blobs, timings
        self.hooks = hook_modules()
        self.app_id = None
        self.a_built = None
        self.saved_a = None
        self.mark_a = None
        self.b_built = None
        self.mark_b = None

    def ops(self, part):
        return OperationLog(self.unit, self.unit.record, self.timings.setdefault(part, {}))

    # A -------------------------------------------------------------------

    def upload_media(self, ops, captured):
        """The media upload Nova's publish sent after the import ``captured``, as an operation of its own; None
        where the import names none."""
        from proof.observe import publish

        if captured.media is None:
            return None
        with ops("media", publish.captured_digest(captured.media)):
            return publish.upload_media(self.unit, self.app_id, captured.media)

    def create_a(self, ops, *, full):
        from proof.observe import publish

        with ops("create", publish.captured_digest(self.export.create)):
            self.app_id, refusal, lookups = publish.create(self.unit, self.export)
        media = None if self.app_id is None else self.upload_media(ops, self.export.create)
        record = {"create": _publish_record(refusal, lookups, media)}
        if self.app_id is None:
            return record
        saves = self.document.hq_side
        if saves is not None:
            from proof.observe import hqside

            record["hqSide"] = hqside.save(self.unit, ops, self.app_id, saves)
        self.a_built, flags, settings = _build(
            self.unit,
            ops,
            self.core_runner,
            self.app_id,
            "A",
            None,
            configuration=self.configuration if full else None,
            identities=full,
        )
        with ops("save-build", b""):
            self.saved_a = self.a_built.hq_build.saved_build() if self.a_built.hq_build is not None else None
        self.mark_a = self.unit.mark()
        if full:
            record["state"] = _state_record(self.a_built, self.blobs)
            record["flagsReadByBuild"] = flags
            record["settingsReadByBuild"] = settings
        return record

    def restore_for_sessions(self, ops):
        """A's restore over D's cases for proof 3, with the tables D's create uploaded (in a fork at A)."""
        from proof.observe import casedata, sessions

        database = casedata.document_case_database(self.document)
        outcome, restore = sessions.hq_restore(self.unit, database, self.export.create.lookups, "restore-a", ops)
        return {"lookups": outcome, "restore": None if restore is None else self.blobs.put(restore)}

    def observe_a(self):
        from proof.observe.sensitivity import flip_builds, flip_plan

        ops = self.ops("a")
        record = {"kind": "a", "configuration": configuration_record(self.configuration)}
        record.update(self.create_a(ops, full=True))
        if self.app_id is not None:
            if self.a_built.outcome.files is not None:
                record["restoreA"] = self.restore_for_sessions(ops)
            record["hooks"] = self.run_hooks(ops, "A", self.a_built, self.mark_a)
            plan = flip_plan(self.configuration, record["flagsReadByBuild"], record["settingsReadByBuild"])
            built = flip_builds(
                self.unit,
                self.unit.record,
                self.app_id,
                plan,
                lambda flip: ops("flip", flip.gate.encode(), gate=flip.gate),
            )
            record["flips"] = [
                {
                    "gate": flip.gate,
                    "configuration": configuration_record(flip.configuration),
                    "build": outcome_record(outcome, self.blobs),
                }
                for flip, outcome in built
            ]
        return ops.recorded(record)

    def recreate_a(self, a_record):
        """A as the ``a`` record's operations made it, for a part the store does not hold under one it does."""
        self.create_a(self.ops("recreate"), full=False)
        if self.a_built is not None and a_record.get("state") is not None:
            held = _built_from(a_record["state"], self.blobs, "A")
            self.a_built.outcome, self.a_built.doc = held.outcome, held.doc

    # Hooks ---------------------------------------------------------------------

    def run_hooks(self, ops, state, built, mark):
        """The hooks the unit calls at ``state`` (the intent hook), each from ``mark`` and leaving the unit there."""
        found = {}
        for name, module, function, states in self.hooks:
            if function != "observe" or state not in states:
                continue
            ctx = HookContext(
                self.document,
                state,
                HookUnit(self.unit, ops, name),
                self.app_id,
                built.outcome,
                built.hq_build,
                self.core_runner,
                self.blobs,
                self.configuration,
                self.export.configuration.name,
            )
            started = time.perf_counter()
            found[name] = getattr(module, function)(ctx)
            self.unit.restore(mark)
            ops.timings.setdefault("hooks", {})[name] = round(time.perf_counter() - started, 4)
        return found

    def run_proof4(self, ops, name, built, captured, mark):
        """``proof4.observe_b`` at B or B-edit, from ``mark`` and leaving the unit there; None without it."""
        for hook, module, function, states in self.hooks:
            if hook == "proof4" and name in states:
                found = getattr(module, function)(self.b_context(ops, name, built, captured))
                self.unit.restore(mark)
                return found
        return None

    def b_context(self, ops, name, built, captured):
        from proof.observe import casedata, sessions

        lookups = captured.lookups or self.export.create.lookups
        database = casedata.document_case_database(self.document, edit=name == "B-edit")
        outcome, restore = sessions.hq_restore(self.unit, database, lookups, "restore-proof4", ops)
        return BContext(
            document=self.document,
            over=name,
            configuration=self.configuration,
            configuration_name=self.export.configuration.name,
            unit=HookUnit(self.unit, ops, "proof4"),
            app_id=self.app_id,
            build=built.outcome,
            hq_build=built.hq_build,
            sessions=(database, lookups),
            restore=restore,
            core_runner=self.core_runner,
            editor_driver=self.editor_driver,
            blobs=self.blobs,
            store=self.store,
            restore_outcome=outcome,
        )

    # B and B-edit --------------------------------------------------------------

    def publish_over_a(self, ops, captured, name):
        """``captured`` published over A, then the media it sends after an import HQ accepted, as the record
        holds the publish (``_publish_record``)."""
        from proof.observe import publish

        self.unit.restore(self.mark_a)
        with ops("publish", publish.captured_digest(captured)):
            refusal, lookups = publish.update(self.unit, self.app_id, captured, name)
        media = None if refusal is not None else self.upload_media(ops, captured)
        return _publish_record(refusal, lookups, media)

    def observe_b(self, part, captured, name):
        """B (``captured`` the republish) or B-edit (the update) over A, as the ``b`` or ``b_edit`` record.

        Both take the same steps (publish, build, then the hooks and proof 4
        from the mark right after the build), so a B-edit with B's inputs is
        observed as B is. The unit is left at that mark (``mark_b``).
        """
        ops = self.ops(part)
        record = {"kind": "b", "publish": self.publish_over_a(ops, captured, name)}
        self.b_built = self.mark_b = None
        if record["publish"]["refused"] is None:
            built, flags, _ = _build(self.unit, ops, self.core_runner, self.app_id, name, self.saved_a)
            record["state"] = _state_record(built, self.blobs)
            # The flags HQ read while it built this state, apart from those its publish read: the gates the
            # manifest check holds (proof.checks.manifest_usage.flag_reads).
            record["flagsReadByBuild"] = flags
            mark = self.unit.mark()
            record["hooks"] = self.run_hooks(ops, name, built, mark)
            proof4 = self.run_proof4(ops, name, built, captured, mark)
            if proof4 is not None:
                record["proof4"] = proof4
            self.b_built, self.mark_b = built, mark
        return ops.recorded(record)

    def recreate_b(self, b_record, captured):
        """B as the ``b`` record's operations made it (republish, its media, build), for a ``b_aligned`` the store
        lacks."""
        ops = self.ops("recreate")
        refused = self.publish_over_a(ops, captured, "B")["refused"]
        self.b_built = self.mark_b = None
        if refused is None and b_record.get("state") is not None:
            built, _, _ = _build(self.unit, ops, self.core_runner, self.app_id, "B", self.saved_a, identities=False)
            held = _built_from(b_record["state"], self.blobs, "B")
            built.outcome, built.doc, built.identities = held.outcome, held.doc, held.identities
            self.b_built, self.mark_b = built, self.unit.mark()

    def observe_b_aligned(self, a_record):
        """B aligned to A, built, and proof 3's sessions, as the ``b_aligned`` record.

        From B's mark. Where HQ refused B there is no B to align, and the
        sessions of the two export paths run all the same (decision 15: the
        local archive against ``build(A)``, always), from A's mark; B's do not.
        """
        from proof.hq import operations
        from proof.hq.seams import build_seams
        from proof.observe import builds, sessions
        from proof.observe.build import build_state

        ops = self.ops("b_aligned")
        record = {"kind": "b_aligned"}
        b_aligned, differs = None, False
        if self.b_built is None:
            self.unit.restore(self.mark_a)
        else:
            self.unit.restore(self.mark_b)
            alignment = align_positions(self.a_built.doc, self.b_built.doc)
            record["alignment"] = {
                "moduleIds": [list(entry) for entry in alignment.module_ids],
                "formIds": [list(entry) for entry in alignment.form_ids],
                "xmlns": [list(entry) for entry in alignment.xmlns],
                "unmatched": list(alignment.unmatched),
            }
            with ops("build-aligned", b""):
                aligned = aligned_app(operations.held_app(self.unit, self.app_id), alignment)
                with build_seams(previous=self.saved_a):
                    b_aligned, _ = build_state(aligned, self.unit.record, "B-aligned")
            record["aligned"] = outcome_record(b_aligned, self.blobs)
            differs = builds.raw_builds_differ(self.document.id, self.a_built.outcome, b_aligned, alignment)
        restore_a = (a_record or {}).get("restoreA")
        if restore_a is not None:
            restore = None if restore_a["restore"] is None else self.blobs.get(restore_a["restore"])
            record["sessions"] = sessions.observe(
                self.unit,
                document=self.document,
                export=self.export,
                a_build=self.a_built.outcome,
                b_aligned=b_aligned,
                b_differs=differs,
                restore_a=(restore_a["lookups"], restore),
                core_runner=self.core_runner,
                blobs=self.blobs,
                operation=ops,
            )
        record["flagsReadByBuild"] = _flags_of(ops, {"build-aligned"})
        return ops.recorded(record)


class _TimedRunner:
    """The Core runner, with the seconds its requests take kept apart (``seconds``), so HQ's own time is known."""

    def __init__(self, runner):
        self._runner = runner
        self.seconds = 0.0

    def _timed(self, call, *args, **kwargs):
        started = time.perf_counter()
        try:
            return call(*args, **kwargs)
        finally:
            self.seconds += time.perf_counter() - started

    def admit(self, *args, **kwargs):
        return self._timed(self._runner.admit, *args, **kwargs)

    def session(self, *args, **kwargs):
        return self._timed(self._runner.session, *args, **kwargs)

    def release(self, *args, **kwargs):
        return self._timed(self._runner.release, *args, **kwargs)

    def evaluate(self, *args, **kwargs):
        return self._timed(self._runner.evaluate, *args, **kwargs)

    def validate_form(self, *args, **kwargs):
        return self._timed(self._runner.validate_form, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._runner, name)


def _held(store, key, blobs):
    """The record the store holds under ``key`` (its blobs merged into ``blobs``), or None."""
    held = store.lookup(key)
    if held is not None:
        blobs.merge(store.blobs(key))
    return held


def _settle(store, key, record, blobs, held):
    """A part observed: audited against what the store held, and kept with the blobs it names, no others."""
    if held is not None:
        store.audit(key, record)
    store.put(key, record, blobs.named_by(record))


def observe_configuration(
    document, name, keys, records, *, core_runner, editor_driver, store, blobs, timings, same_as=True, hooks=None
):
    """One configuration's parts, from the store where it holds them and observed in one unit otherwise.

    With ``same_as`` (the default) a ``b_edit`` keyed as ``b`` is recorded as
    the same and not observed; without it, it is observed all the same.
    ``hooks`` is what the observation hooks declare they read
    (``hook_inputs``), which the guard allows each part's hooks.
    """
    from proof.hq.state import hq_unit
    from proof.store import guard

    export = document.exports[name]
    with guard.observing(document, name, "configuration", hooks):
        configuration = export.configuration.hq()
    held = {part: _held(store, key, blobs) for part, key in keys.items()}
    same = same_as and keys.get("b_edit") is not None and keys["b_edit"] == keys["b"]
    wanted = [part for part in PARTS if part in keys and (store.fresh or held[part] is None)]
    if same and "b_edit" in wanted:
        wanted.remove("b_edit")
    for part in keys:
        if part not in wanted and held[part] is not None:
            setattr(records, part, held[part])
    if same:
        records.b_edit = {"same_as": keys["b"].hex()}
    if not wanted:
        return []
    started = time.perf_counter()
    observed = []
    core_runner = _TimedRunner(core_runner)

    def settled(part, observe):
        part_started = time.perf_counter()
        with guard.observing(document, name, part, hooks):
            setattr(records, part, observe())
        timings.setdefault(part, {})["seconds"] = round(time.perf_counter() - part_started, 4)
        _settle(store, keys[part], getattr(records, part), blobs, held[part])
        observed.append(part)

    with (
        guard.observing(document, name, "configuration", hooks),
        hq_unit(configuration, root_key=keys["a"], validate=core_runner.validate_form) as unit,
    ):
        state = _Unit(document, export, configuration, unit, core_runner, editor_driver, store, blobs, timings)
        if "a" in wanted:
            settled("a", state.observe_a)
        else:
            with guard.observing(document, name, "a", hooks):
                state.recreate_a(records.a)
        if state.app_id is not None:
            if "b" in wanted:
                settled("b", lambda: state.observe_b("b", export.republish, "B"))
            elif "b_aligned" in wanted:
                with guard.observing(document, name, "b", hooks):
                    state.recreate_b(records.b, export.republish)
            if "b_aligned" in wanted:
                settled("b_aligned", lambda: state.observe_b_aligned(records.a))
            if "b_edit" in wanted:
                update = document.edit.exports[name].update
                settled("b_edit", lambda: state.observe_b("b_edit", update, "B-edit"))
    timings["seconds"] = round(time.perf_counter() - started, 4)
    timings["coreSeconds"] = round(core_runner.seconds, 4)
    return observed


# What Core's string reading of an expression writes for a part it cannot know (a path, a function's result).
HOLE = "⁇"


# The stack steps whose ``value`` attribute Core reads as an expression (commcare-core
# ``xml/StackFrameStepParser.java::parse`` sends each to ``parseValue``). A ``query`` step's value is a URL
# (``parseQuery`` reads it with ``new URL``), never an expression, and a ``jump`` step has none.
EXPRESSION_STEPS = frozenset({"datum", "rewind", "mark", "command", "instance-datum"})


def stack_values(path):
    """Every stack step ``value`` in an archive's suite that Core reads as XPath.

    Core reads a step's ``value`` attribute as an expression
    (``StackFrameStepParser.java::parseValue``) for each step of a ``create``,
    ``push`` or ``clear`` frame (``StackOpParser``) but a ``query`` step,
    whose value is a URL (``EXPRESSION_STEPS``).
    """
    import zipfile

    from proof.checks.compare.xml_tree import parse_xml, qname

    with zipfile.ZipFile(path) as archive:
        if "suite.xml" not in archive.namelist():
            return []
        root = parse_xml(archive.read("suite.xml"))
    found = set()
    for stack in root.iter("stack"):
        for frame in stack:
            if not isinstance(frame.tag, str) or qname(frame.tag)[1] not in ("create", "push", "clear"):
                continue
            for step in frame:
                if not isinstance(step.tag, str) or qname(step.tag)[1] not in EXPRESSION_STEPS:
                    continue
                if step.get("value") is not None:
                    found.add(step.get("value"))
    return sorted(found)


def read_stack_values(core_runner, path):
    """Core's reading of each stack step value in the archive's suite: the strings it can be, by its text."""
    values = stack_values(path)
    if not values:
        return {}
    results = core_runner.request("xpathStrings", deadline=60.0, expressions=values, hole=HOLE)["results"]
    return dict(zip(values, results, strict=True))


def local_archives(document):
    """Each local archive the document carries, by its name in the document: ``{name: Path}``."""
    found = {}
    for name, path in (
        ("local.ccz", document.local_ccz),
        ("local-again.ccz", document.local_again_ccz),
        ("edit/local.ccz", document.edit.local_ccz if document.edit else None),
    ):
        if path is not None:
            found[name] = path
    return found


def observe_local(document, *, core_runner, store=NULL_STORE, blobs=None, timings=None, hooks=None):
    """Core's admission of each local archive the document carries, its reading of each stack step value in
    its suite (``read_stack_values``), and each local hook's record (``observe_local(ctx)``, ``LocalContext``),
    as the ``local`` record, and its key. ``hooks`` is ``hook_inputs(document)``, computed where not given."""
    from proof.observe.build import admit
    from proof.store import guard

    blobs = Blobs() if blobs is None else blobs
    with guard.observing(document, None, guard.KEYS):
        hooks = hook_inputs(document) if hooks is None else hooks
        key = local_key(document_inputs(document), hooks)
    held = _held(store, key, blobs)
    if held is not None and not store.fresh:
        return held, key, False
    started = time.perf_counter()
    reports, readings = {}, {}
    archives = local_archives(document)
    observed, seconds = {}, {}
    with guard.observing(document, None, LOCAL, hooks):
        for name, path in archives.items():
            reports[name] = admit(core_runner, path)
            readings[name] = read_stack_values(core_runner, path)
        for name, module, function, states in hook_modules():
            if LOCAL not in states:
                continue
            hook_started = time.perf_counter()
            observed[name] = getattr(module, function)(LocalContext(document, archives, core_runner, blobs))
            seconds[name] = round(time.perf_counter() - hook_started, 4)
    record = {"kind": "local", "admissions": reports, "stackValues": readings, "hole": HOLE}
    if observed:
        record["hooks"] = observed
    _settle(store, key, record, blobs, held)
    if timings is not None:
        timings["local"] = round(time.perf_counter() - started, 4)
        if seconds:
            timings["localHooks"] = seconds
    return record, key, True


def observe_document(document, *, core_runner, editor_driver=None, store=NULL_STORE, configurations=None, same_as=True):
    """Every part of one document's tree, each configuration in a unit of its own, and its local archives.

    ``configurations`` names the configurations to observe (every one the
    document is exported under by default); ``same_as`` is
    ``observe_configuration``'s.
    """
    from proof.store import guard

    # What every key is derived from, which the guard holds to what the document's key names (``guard.KEYS``).
    with guard.observing(document, None, guard.KEYS):
        inputs = document_inputs(document)
        databases = case_databases(document)
        hooks = hook_inputs(document)
    found = DocumentRecords(document.id, document.kind)
    for name in sorted(document.exports):
        if configurations is not None and name not in configurations:
            continue
        keys = part_keys(inputs, name, databases, hooks)
        if document.edit is None or name not in document.edit.exports:
            keys.pop("b_edit", None)
        held = ConfigurationRecords(name, keys)
        timings = found.timings.setdefault(name, {})
        observed = observe_configuration(
            document,
            name,
            keys,
            held,
            core_runner=core_runner,
            editor_driver=editor_driver,
            store=store,
            blobs=found.blobs,
            timings=timings,
            same_as=same_as,
            hooks=hooks,
        )
        found.observed += [f"{name}/{part}" for part in observed]
        found.configurations[name] = held
    found.local, found.local_key, observed = observe_local(
        document, core_runner=core_runner, store=store, blobs=found.blobs, timings=found.timings, hooks=hooks
    )
    if observed:
        found.observed.append("local")
    return found
