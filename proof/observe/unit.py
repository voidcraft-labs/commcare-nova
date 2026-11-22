"""One HQ unit per (document, configuration): every observation the checks read, made once, as keyed records.

``observe_document(document, core_runner=..., editor_driver=..., store=...)``
opens one unit (``proof.hq.state.hq_unit``) per configuration the document
is exported under, rooted at the key of its ``a`` part, and runs the tree
below, each HQ step inside ``unit.operation(label, digest of its input)`` so
the unit's state, entropy and clock are a function of the inputs alone:

```
seed → create(D) [shell, lookup upload, content] → media(D) → reads → HQ-side saves → reads → build(A) (no previous)
  → admit (Core) → identities, flag reads → saved(build(A)) → mark@A
  → A's restore for proof 3 (in a fork) → the intent hook at A
  → sensitivity: build(A | each gate HQ read, flipped), each in a fork
  b:         restore@A → republish(D) → media(D) → reads → build(B | saved(build(A))) → admit → identities
             (a republish Nova stopped sends nothing: the record holds the stop, and no B is observed)
                → mark@B → the intent hook at B → proof4.observe_b → restore@B
  b_aligned: (at mark@B) B aligned to A → build(B-aligned | saved(build(A)))
                → proof 3's sessions (local archive and A; B where the raw builds differ)
             (at mark@A where HQ refused B or Nova stopped it: the local archive's and A's sessions alone)
  b_edit:    restore@A → update(D′) → media(D′) → reads → build(B-edit | saved(build(A))) → admit → identities
                → mark@B-edit → the intent hook at B-edit → proof4.observe_b → restore@B-edit
local: Core's admission of local.ccz, local-again.ccz and edit/local.ccz → the intent and manifest local hooks
```

``create`` is Nova's first publish (``proof.observe.publish.create``): the
shell's create and the content that fills it, keyed by the digest of both
imports, or one create for a control retained in the legacy layout. An app
made in CommCare HQ (an ``hq-authored`` document) has no first publish: its
``create`` makes A again from the document's ``authored/`` files with HQ's
own models (``proof.observe.publish.create_authored``), keyed by their
digest, and sends no media, which it attached already; no HQ-side save
follows it.
``reads`` is what Nova's own read of the app asks HQ's API (``_Unit.api_reads``),
made in a fork, so nothing HQ writes as it answers reaches a later step, and
kept as the part's ``apiReads`` by label (``api_read_label``): at A,
``published`` where A is Nova's own publish (a document that is no
migration witness), ``authored`` for an app made in HQ and ``saved`` after
the saves a person makes in HQ whose review Nova runs (``hq-side.json``
stating ``brings-in`` or ``records``); at B and B-edit, ``published``. A state
made again under a stored part makes no reads, which the fork left out of
every later state.
``media`` is the media upload Nova's publish sends after a content import HQ
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
so the same state: A (create, its media, the HQ-side saves where the document
carries them, build, saved build) under a held ``a``, and B (republish, its
media, build) under a held ``b``. A build made again asks HQ for its
identities as the build first observed did and keeps none of the answer
(``_build``), since HQ can write as it answers. With
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
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass

from proof.checks.corpus import BASE_CONFIGURATIONS, DERIVED, EMPTY_LIST_TEXT_ARCHIVE
from proof.lane import progress
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

LOCAL_ROLES = (
    ("local", "local.ccz"),
    ("local-again", "local-again.ccz"),
    ("edit-local", "edit/local.ccz"),
    ("local-empty-list-text", EMPTY_LIST_TEXT_ARCHIVE),
)
# A corpus document's input manifest (``proof/corpus/inputs.ts``), which a control does not keep.
INPUTS = "inputs.json"
# What a person saves in HQ over A before Nova's next publish, where the document carries it (proof.observe.hqside).
HQ_SIDE = "hq-side.json"
# The web user each state's reads of HQ's API are made as (``_Unit.api_reads``), made in the reads' own fork.
API_READER = "proof-reader@example.org"
# The roles of B-edit's inputs its key does not read: its verdict decides only whether the corpus holds its
# publish, and its document is read through the case database it gives (``case_databases``) and what each
# hook declares it reads (``hook_inputs``).
B_UNREAD_ROLES = frozenset({"verdict", "document"})
STATES = ("A", "B", "B-edit")
# The document's local part, which the local hooks observe with (``observe_local``).
LOCAL = "local"
# A served to Formplayer, the Web Apps client, a device and Connect (the baseline of proof 3's comparisons of
# them), where the run hands its states to the readers (``proof.lane.readers``).
SERVED = ("served", "observe", ("A",))
EVERY_HOOK = (
    ("intent", "observe", STATES),
    ("intent", "observe_local", (LOCAL,)),
    ("manifest", "observe_local", (LOCAL,)),
    SERVED,
    ("proof4", "observe_b", ("B", "B-edit")),
)


def hooks(environ=None):
    """Each observation hook the unit calls: its module under ``proof.observe``, the function the unit calls, the
    states it is called at. The served hook only where the run hands its states to the readers
    (``proof.lane.readers.served``, ``PROOF_READERS``): without it no state is served, and so B and proof 4's saves
    are served to nothing (``BContext.serve``)."""
    from proof.lane import readers

    return tuple(hook for hook in EVERY_HOOK if hook != SERVED or readers.served(environ))


HOOKS = hooks()


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


def _two_imports(root, directory):
    """Whether the first publish in ``directory`` is two imports: its create's sidecar is marked ``"layout": 2``
    (``proof.checks.configurations.TWO_IMPORTS``)."""
    from proof.checks.configurations import TWO_IMPORTS

    return json.loads((root / f"{directory}/create.json").read_text(encoding="utf-8")).get("layout") == TWO_IMPORTS


def _first_publish(root, directory, prefix=""):
    """The first publish's files in ``directory``: the create under ``<prefix>create.`` and, in the two-import
    layout, the content import under ``<prefix>content.``, which names the workbook and the media."""
    part = _prefixed(f"{prefix}create.", _request(root, directory, "create"))
    if _two_imports(root, directory):
        part.update(_prefixed(f"{prefix}content.", _request(root, directory, "content")))
    return part


def hq_authored(document) -> bool:
    """Whether A replays HQ's app from ``authored/`` instead of a Nova first publish, including a control
    that retained that app and its inputs."""
    return document.authored is not None if document.kind == "control" else document.hq_authored


# The statements of ``hq-side.json`` under which Nova reviews what a person saved in HQ before it republishes.
REVIEWED = frozenset({"brings-in", "records"})


def api_read_label(document, part, *, saved=False):
    """The label of the reads of HQ's API the unit makes in ``part`` (``a``, or ``b`` for B and B-edit alike) after
    its publish, or None where it makes none.

    At A: ``authored`` for an app made in CommCare HQ, after A is made;
    ``published`` for every other document but a migration witness (whose A
    is no export of Nova's current code), after the first publish and its
    media; and, with ``saved``, after the saves a person makes in HQ,
    ``saved`` where Nova reviews them (``hq-side.json`` stating ``brings-in``
    or ``records``). At B and B-edit, ``published`` for an app made in HQ, a
    migration witness, a document whose republish brings a person's saves in,
    and every document with an edit and no ``hq-side.json``. B and B-edit are
    read alike, because a B-edit keyed as its B is recorded as that B
    (``observe_configuration``'s ``same_as``) and must hold what its own
    observation would. A control makes none: proof 6 judges no control."""
    if document.kind == "control":
        return None
    saves = document.hq_side
    if part == "a":
        if saved:
            return "saved" if saves is not None and saves.get("republish") in REVIEWED else None
        if hq_authored(document):
            return "authored"
        return None if document.migration_witness else "published"
    brings_in = saves is not None and saves.get("republish") == "brings-in"
    edited = document.edit is not None and saves is None
    if hq_authored(document) or document.migration_witness or brings_in or edited:
        return "published"
    return None


def _authored_inputs(document):
    """Part ``a``'s roles for an app made in CommCare HQ, in place of a first publish's requests: the files A is made
    again from (``proof.observe.publish.authored_files``) and the case seed its sessions run over (``seed``)."""
    from proof.observe.publish import AUTHORED, authored_files

    return {**authored_files(document.root), "seed": f"{AUTHORED}/seed.json"}


def input_files(document):
    """Each part's input files, by role, as paths relative to the document's directory, laid out as
    ``proof/corpus/inputs.ts`` lays out ``inputs.json``: ``{"configurations": {<name>: {"a", "b", "b_edit"?}},
    "local"}``. What each part's key reads (``computed_inputs``), and so what the evidence store's guard lets its
    observation read (``proof.store.guard.input_files``). Part ``a`` reads both imports of a first publish in the
    two-import layout, and the privileges read both (``privileges.create.``, ``privileges.content.``). Part ``a``
    of a document made in HQ reads the app, media and seed under ``authored/`` in their place (``authored.app``,
    ``authored.media``, ``authored.media.<name>`` a media file, ``authored.tables``, ``authored.places``,
    ``authored.practice-workers``, ``seed``),
    and its privileges read the app (``privileges.authored.app``) and Nova's republish over it where Nova sent one
    (``privileges.republish.``)."""
    from proof.checks.corpus import republish_stop
    from proof.observe.publish import AUTHORED

    root = document.root
    edited = (root / "edit" / "batch.json").exists()
    authored = hq_authored(document)
    if authored:
        privileges = {"privileges.authored.app": f"{AUTHORED}/app.json"}
        if republish_stop(root / "export/minimum") is None:
            privileges.update(_prefixed("privileges.republish.", _request(root, "export/minimum", "republish")))
    else:
        privileges = _first_publish(root, "export/minimum", "privileges.")
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
        # A migration witness's A is its first publish or the one retained from before its migration
        # (proof/migrations/<id>/), and the overlay keys each import wrote are part of it, as proof/corpus/inputs.ts
        # keys them, so a change to them keys the witness anew. Both files are required: a missing one fails its
        # digest by name rather than keying an incomplete A.
        retained = (
            {f"{body}.ownership": f"export/{name}/{body}.ownership.json" for body in ("create", "content")}
            if document.kind != "control" and document.migration_witness
            else {}
        )
        first = _authored_inputs(document) if authored else _first_publish(root, f"export/{name}")
        part = {
            "a": {**shared, **first, **privileges, **retained},
            "b": (
                {"outcome.json": f"export/{name}/outcome.json"}
                if document.exports[name].republish_stopped is not None
                else _request(root, f"export/{name}", "republish")
            ),
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


def _case_inputs(document):
    """The actual cases B and B-edit will serve, and their digests for the part keys."""
    from proof.observe.casedata import database_digest, document_case_database

    cases = {"b": document_case_database(document)}
    if document.edit is not None:
        cases["b_edit"] = document_case_database(document, edit=True)
    return cases, {part: database_digest(database) for part, database in cases.items()}


def case_databases(document):
    """The case digests used by callers deriving part keys alone."""
    return _case_inputs(document)[1]


def _module(name):
    """The module ``proof.observe.<name>``, or None while that observation does not exist."""
    module_name = f"proof.observe.{name}"
    try:
        return importlib.import_module(module_name)
    except ModuleNotFoundError as error:
        if error.name == module_name:
            return None
        raise


def hook_modules(hooked=None):
    """Each observation hook that exists, of ``hooked`` (``HOOKS`` by default): ``[(name, module, function,
    states)]``."""
    found = []
    for name, function, states in HOOKS if hooked is None else hooked:
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


def hook_inputs(document, hooked=None):
    """What each hook that exists reads beyond its part's own inputs, by state (``local`` too):
    ``{state: {hook: inputs}}``; ``hooked`` is ``hook_modules``'s."""
    found = {state: {} for state in (*STATES, LOCAL)}
    for name, module, _, states in hook_modules(hooked):
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
    under ``b`` with the local archives proof 3's sessions replay on
    (``inputs.json``'s ``local`` role, and its ``local-empty-list-text``
    role where the document carries the archive a configuration holding the
    flag replays on, ``Document.local_ccz_for``) and the local export a
    device installs after it (``local-again``); its cases and B's lookups are
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
        flagged = inputs["local"].get("local-empty-list-text")
        keys["b_aligned"] = part_key(
            "b_aligned",
            keys["b"],
            {
                "localArchive": inputs["local"].get("local"),
                "localAgain": inputs["local"].get("local-again"),
                **({"localEmptyListText": flagged} if flagged is not None else {}),
            },
        )
    return keys


def local_key(inputs, hooks=None):
    """The ``local`` part's key: the local archives, and what each local hook declares it reads (``hooks``:
    ``hook_inputs``)."""
    declared = (hooks or {}).get(LOCAL) or {}
    return part_key("local", None, {"archives": inputs["local"], **({"hooks": declared} if declared else {})})


# Hooks -----------------------------------------------------------------------------


class HookUnit:
    """The unit as a hook sees it: the unit itself, with each operation the hook runs logged in its part's record
    under the hook's name (``OperationLog``), and each of its requests in which HQ noted a soft assertion, with the
    served reader that made it where one did (``proof.observe.served.reading``)."""

    def __init__(self, unit, log, hook):
        self._unit, self._log, self._hook = unit, log, hook

    def operation(self, label, digest):
        return self._log(label, digest, hook=self._hook)

    @contextmanager
    def request(self, digest):
        from proof.observe.served import reader_now

        reader = reader_now()
        with self._unit.request(digest) as scope:
            yield scope
        if scope.soft_assertions:
            entry = {"hook": self._hook, "request": digest.hex(), "softAssertions": _notes(scope.soft_assertions)}
            if reader is not None:
                entry["reader"] = reader
            self._log.requests.append(entry)

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
    # The session's editor driver, in whose Chromium the Web Apps client runs; None where the observation was
    # given none.
    editor_driver: object = None
    # A's restore for proof 3's sessions (None where HQ serves none), and the unit's Connect opportunity holder
    # (``proof.observe.connect.Holder``), which the served hook fills at A for a Connect app.
    restore_a: bytes | None = None
    connect: object = None


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
    archive: dict | None  # device archive materialized on the build copy
    sessions: object  # (case database, the lookup workbook capture or None)
    restore: bytes
    core_runner: object
    editor_driver: object
    blobs: Blobs
    store: object
    # HQ's restore over the document's tables: ``{"served": True}``, or ``{"refused": reason}`` where ``restore``
    # is None (``proof.observe.sessions.hq_restore``).
    restore_outcome: dict
    declared_inputs: dict
    # The build HQ compared this B's forms with when it built it: saved(build(A)).
    previous_build: object = None
    # Whether B and its editor saves run the served readers. When they do, they take the app's platforms
    # from the hook's declared inputs, the same values used to derive the part key.
    serve: bool = False
    # The unit's Connect opportunity holder (``proof.observe.connect.Holder``).
    connect: object = None
    editor_partition: object = None
    replay_b_key: bytes | None = None


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
        # These top-level operations have fixed names. Hook labels may contain reader inputs.
        native = label in ("build", "create", "media", "publish", "save-build")
        activity = progress.activity(f"HQ {label}", count="native") if native else nullcontext()
        with activity, self.unit.operation(label, input_digest) as scope:
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
    # The archive a device installs of it (``proof.observe.build.device_archive``); None where it was not read.
    archive: dict | None = None


def _build(unit, ops, core_runner, app_id, name, previous, *, configuration=None, keep=True):
    """HQ's build of the app the unit holds, Core's admission of it, and its identities, in one operation.

    The build reads the app freshly, with every cache emptied first
    (``proof.observe.sensitivity.build``), and the flags HQ read while it built
    come back with it (by constant, else by slug). With ``configuration``, it is
    A's plain build (``proof.observe.sensitivity.plain_build``) and the
    project-space settings it read come back too; otherwise none do.

    HQ is asked for the build's identities in every build. ``keep`` says
    whether the unit keeps what it reads of the build. With it (a build
    observed for a record) Core admits the build, and the identities and the
    device archive come back. Without it (a build made again under a stored
    part, whose record holds them) HQ is asked all the same and its answer is
    dropped, and Core's admission and the device archive are left out.
    Returns ``(_Built, flags read, settings read)``.

    The build runs in a fork of the unit, so the state the unit holds after it
    is the app as HQ holds it, unbuilt. HQ builds a copy of an app
    (``models/applications.py::Application.make_build``), and the one save a
    build makes is of the app it builds: ``create_all_files`` sets each form's
    and each media item's version (``set_form_versions``, ``set_media_versions``),
    and where the multimedia map holds a path nothing references, the media
    suite's ``multimedia_map_for_build(remove_unused=True)`` prunes it and saves
    (``hqmedia/models.py::ApplicationMediaMixin.remove_unused_mappings``), with
    those versions and ``media_form_errors``. The lane builds the state's app
    itself, so that save would write into A, and the republish would land over
    an A HQ never holds; in production the same save writes the build copy.
    The fork leaves HQ's state as it was, and what the build made comes back
    as data (``_Built``: the files, the app as the build left it, the saved
    build the next build compares with).
    """
    from proof.hq.seams import build_seams
    from proof.observe import sensitivity
    from proof.observe.build import admit_build, device_archive
    from proof.observe.identity import app_identity

    flags = settings = None
    with unit.fork(), ops("build", b""):
        if configuration is not None:
            built, flags, settings = sensitivity.plain_build(unit, unit.record, app_id, configuration)
        else:
            first = len(unit.record.flags)
            built = sensitivity.build(unit, unit.record, app_id, name, previous)
            flags = sorted({read.symbol or read.slug for read in unit.record.flags[first:]})
        found = archive = None
        with build_seams(previous=previous):
            if keep:
                admit_build(core_runner, built.app, built.outcome)
            # HQ's reads for the identities are made whether or not the unit keeps them, so a build recreated
            # under a stored part leaves HQ's state as the build first observed left it: under USERCASE, HQ's
            # case property map creates the project space's user field definition the first time it is asked
            # (app_schemas/case_properties.py::_get_usercase_default_properties).
            read = app_identity(built.app, built.outcome.files, unit.domain)
            if keep:
                found = read
                archive = device_archive(built.outcome, built.app)
        doc = _json(built.app.to_json())
    return _Built(built.outcome, built.hq_build, found, doc, archive), flags, settings


def _aligned_build(unit, ops, app_id, alignment, previous):
    """Build a copy of B with A's identities. The independent release takes the same pre-build document."""
    from proof.hq import operations
    from proof.hq.seams import build_seams
    from proof.observe.build import build_state

    with unit.fork(), ops("build-aligned", b""):
        aligned = aligned_app(operations.held_app(unit, app_id), alignment)
        document = _json(aligned.to_json())
        # Changing an XForm's ID or namespace queues its source on the wrapped app. Its external blob still
        # belongs to B. HQ's release wraps a fresh app in another fork, so pass the actual aligned source.
        changed = {at for at, b, a in (*alignment.form_ids, *alignment.xmlns) if a and b and a != b}
        attachments = {
            f"{form.unique_id}.xml": form.source
            for form in aligned.get_forms()
            if f"form:{form.get_module().id}.{form.id}" in changed
        }
        if attachments:
            document["_attachments"] = {**document.get("_attachments", {}), **attachments}
        with build_seams(previous=previous):
            built, _ = build_state(aligned, unit.record, "B-aligned")
    return built, document


def _state_record(built: _Built, blobs):
    from proof.observe.build import archive_record

    return {
        "build": outcome_record(built.outcome, blobs),
        # What a device installs of this state (HQ's archive download), for the Android reader.
        "archive": archive_record(built.archive, blobs),
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

    def __init__(
        self,
        document,
        export,
        configuration,
        unit,
        core_runner,
        editor_driver,
        store,
        blobs,
        timings,
        cases,
        declared_inputs,
    ):
        self.document, self.export, self.configuration = document, export, configuration
        self.cases, self.declared_inputs = cases, declared_inputs
        self.unit, self.core_runner, self.editor_driver = unit, core_runner, editor_driver
        self.store, self.blobs, self.timings = store, blobs, timings
        self.hooks = hook_modules()
        # An app made in CommCare HQ: A is made again from its authored files, and its tables are A's own.
        self.hq_authored = hq_authored(document)
        self.app_id = None
        self.a_built = None
        self.replay_b_key = None
        self.saved_a = None
        self.mark_a = None
        self.b_built = None
        self.mark_b = None
        # A's restore for proof 3's sessions, and the unit's Connect opportunity (proof.observe.connect).
        self.restore_a = None
        from proof.observe.connect import Holder

        self.connect = Holder()

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
            return publish.upload_media(self.unit, self.app_id, captured.media, counter=captured.media_save_counter)

    def create_a(self, ops, *, full):
        """A, as the ``a`` record's ``create`` (and ``hqSide``, ``apiReads``, ``state``) holds it: Nova's first
        publish and its media, or, for an app made in CommCare HQ, the app made again from its authored files
        (``publish.create_authored``), which attached its media itself; then the saves a person makes in HQ, where
        the document carries them; then A's build. ``full`` is an observation for a record, which also makes the
        reads of HQ's API (``api_reads``); without it, A is made again under a stored part, and no read is made:
        each was made in a fork, so A is the same without it."""
        from proof.observe import publish

        if self.hq_authored:
            with ops("create", publish.first_publish_digest(self.export, self.document.root)):
                self.app_id, refusal, lookups = publish.create_authored(self.unit, self.document)
            record = {"create": _publish_record(refusal, lookups)}
        else:
            with ops("create", publish.first_publish_digest(self.export)):
                self.app_id, refusal, lookups = publish.create(self.unit, self.export)
            media = None if self.app_id is None else self.upload_media(ops, self.export.content)
            record = {"create": _publish_record(refusal, lookups, media)}
        if self.app_id is None:
            return record
        reads = {}
        label = api_read_label(self.document, "a")
        if full and label is not None:
            reads[label] = self.api_reads(ops, label)
        saves = self.document.hq_side
        if saves is not None:
            from proof.observe import hqside

            record["hqSide"] = hqside.save(self.unit, ops, self.app_id, saves, driver=self.editor_driver)
            label = api_read_label(self.document, "a", saved=True)
            if full and label is not None:
                reads[label] = self.api_reads(ops, label)
        if reads:
            record["apiReads"] = reads
        self.a_built, flags, settings = _build(
            self.unit,
            ops,
            self.core_runner,
            self.app_id,
            "A",
            None,
            configuration=self.configuration if full else None,
            keep=full,
        )
        with ops("save-build", b""):
            self.saved_a = self.a_built.hq_build.saved_build() if self.a_built.hq_build is not None else None
        self.mark_a = self.unit.mark()
        if full:
            record["state"] = _state_record(self.a_built, self.blobs)
            record["flagsReadByBuild"] = flags
            record["settingsReadByBuild"] = settings
        return record

    def tables(self, captured=None):
        """What a restore of this unit serves of the lookup tables (``sessions.hq_restore``), at the state the publish
        ``captured`` made (A where it is None): the workbook that publish pushed, uploaded again over the state, which
        already holds it, so every table HQ then holds is served, whoever made A; where it pushed none, for an app
        made in CommCare HQ the tables A was made with (``sessions.AuthoredTables``, which HQ holds without any
        upload), and otherwise the workbook D's first publish pushed."""
        from proof.observe import publish, sessions

        held = None if captured is None else captured.lookups
        if held is not None:
            return held
        if self.hq_authored:
            return sessions.AuthoredTables(self.document.root / publish.AUTHORED / "tables.json")
        return self.export.content.lookups

    def restore_for_sessions(self, ops):
        """A's restore over D's cases for proof 3, with the tables D's first publish uploaded, or those an app made
        in CommCare HQ was made with (``tables``), in a fork at A."""
        from proof.observe import casedata, sessions

        database = casedata.document_case_database(self.document)
        outcome, restore = sessions.hq_restore(self.unit, database, self.tables(), "restore-a", ops)
        self.restore_a = restore
        return {"lookups": outcome, "restore": None if restore is None else self.blobs.put(restore)}

    def api_reads(self, ops, label):
        """What Nova's own read of the app asks HQ's API, as HQ answers it at this state, in a fork of the unit.

        Inside ``seams.also_granted(privileges.API_ACCESS)`` (every resource
        Nova reads an app through asks for it, and no app's content does) and
        ``seams.api_rate_limits`` (which ``operations.api_request`` asks of its
        callers), with HQ's Redis, where a user's save takes its lock, and the
        commit callbacks HQ's saves register run where production's commit runs
        them: the API user is made with its key (``operations.seed_api_user``,
        a member whose role also edits places, which HQ's level resource asks
        for), then the application resource, the source and the version, each
        in the operation ``reads:<label>`` and in the order Nova's read makes
        them (the bracket of the app's read), then the project space list
        whole and filtered by ``SAVE_ONLY_EDITED_FORM_FIELDS`` in the operation
        ``reads:project-spaces``. At ``authored``, what a first reading asks
        beyond the app, as ``proof/matrix/retain.py`` makes those reads of the
        base it retains: the lookup table list and each listed table's rows,
        the levels and the places, in the operation ``reads:project-data``,
        and each mapped file at the address HQ gives its map item
        (``HQMediaMapItem.url``) in the operation ``reads:media``, through
        ``operations.media_file_read``, which keeps the bytes HQ sent. At
        ``saved``, the same reads of each mapped file: proof 6 names each path
        of HQ's app after a person's saves by the asset whose bytes HQ serves
        there (``proof/reader/laneReading.ts::servedFiles``), never by the
        review it holds to them.

        Returns ``{"source", "application", "currentVersion", "projectSpaces":
        {"all", "flagged"}, "projectData"?: {"lookupTables", "fixtureRows":
        {<tag>: ...}, "locationTypes", "locations"}, "media"?: [{"path",
        "mediaType", "multimediaId", "status", "sha256", "length"}]}``, each
        answer a blob of it as ``HqAnswer.retained`` writes it, a file's bytes
        never: at ``authored`` they are the document's own (``authored/media/``),
        and at ``saved`` the hash names the document's asset. The fork
        keeps the API user, its key and whatever HQ writes while it answers
        (with ``USERCASE``, the application resource's case property map makes
        the project space's user field definition the first time it is asked)
        out of every later operation, so a state made again under a stored part
        leaves the reads out."""
        from corehq import privileges, toggles

        from proof.hq import operations
        from proof.hq import redis as hq_redis
        from proof.hq.seams import also_granted, api_rate_limits

        unit, app_id = self.unit, self.app_id
        found = {}

        def kept(answer):
            return self.blobs.put_json(answer.retained())

        with (
            hq_redis.shared(None),
            unit.fork(),
            unit.committing(),
            also_granted(privileges.API_ACCESS),
            api_rate_limits(unit),
        ):
            with ops(f"reads:{label}", b"api-user"):
                credential = operations.seed_api_user(unit, API_READER, edit_locations=True)
            for name, read in (
                ("application", operations.application_read),
                ("source", operations.source_read),
                ("currentVersion", operations.current_version_read),
            ):
                with ops(f"reads:{label}", name.encode()):
                    found[name] = kept(read(unit, app_id, credential))
            with ops("reads:project-spaces", label.encode()):
                found["projectSpaces"] = {
                    "all": kept(operations.project_spaces_read(unit, credential)),
                    "flagged": kept(
                        operations.project_spaces_read(
                            unit, credential, feature_flag=toggles.SAVE_ONLY_EDITED_FORM_FIELDS.slug
                        )
                    ),
                }
            if label == "authored":
                found["projectData"] = self._project_data_reads(ops, credential, kept)
            if label in ("authored", "saved"):
                found["media"] = self._media_reads(ops, credential)
        return found

    def _project_data_reads(self, ops, credential, kept):
        """The project data a first reading reads beyond the app (``api_reads`` at ``authored``)."""
        from proof.hq import operations

        unit = self.unit
        with ops("reads:project-data", b"project-data"):
            listed = operations.lookup_tables_read(unit, credential)
            tables = json.loads(listed.body).get("objects", []) if listed.status == 200 else []
            data = {
                "lookupTables": kept(listed),
                "fixtureRows": {
                    table["tag"]: kept(operations.fixture_rows_read(unit, table["id"], credential)) for table in tables
                },
                "locationTypes": kept(operations.location_types_read(unit, credential)),
                "locations": kept(operations.locations_read(unit, credential)),
                "locationsV1": kept(operations.location_external_ids_read(unit, credential)),
            }
        return data

    def _media_reads(self, ops, credential):
        """Each file HQ's media map names, read at the address HQ gives its map item (``api_reads`` at ``authored``
        and ``saved``): one row a path, with the SHA-256 of the bytes HQ sent."""
        from proof.hq import operations

        unit = self.unit
        media = []
        with ops("reads:media", b"media"):
            app = operations.held_app(unit, self.app_id)
            for path, item in sorted(app.multimedia_map.items()):
                answer = operations.media_file_read(unit, item.url, credential)
                media.append(
                    {
                        "path": path,
                        "mediaType": item.media_type,
                        "multimediaId": item.multimedia_id,
                        "status": answer.status,
                        "sha256": hashlib.sha256(answer.data).hexdigest(),
                        "length": len(answer.data),
                    }
                )
        return media

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
            if any(name == "served" for name, _, _, _ in self.hooks):
                from proof.observe import served

                # A Connect app's opportunity, made again while A is served: every later state is received by it.
                served.reopen(
                    HookUnit(self.unit, self.ops("recreate"), served.HOOK),
                    document=self.document,
                    app_id=self.app_id,
                    a_record=a_record,
                    holder=self.connect,
                    blobs=self.blobs,
                )

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
                self.editor_driver,
                self.restore_a,
                self.connect,
            )
            started = time.perf_counter()
            found[name] = getattr(module, function)(ctx)
            self.unit.restore(mark)
            ops.timings.setdefault("hooks", {})[name] = round(time.perf_counter() - started, 4)
        return found

    def run_proof4(self, ops, name, built, captured, mark, partition=None):
        """``proof4.observe_b`` at B or B-edit, from ``mark`` and leaving the unit there; None without it."""
        for hook, module, function, states in self.hooks:
            if hook == "proof4" and name in states:
                ctx = self.b_context(ops, name, built, captured)
                if partition is not None:
                    from proof.observe.connect import is_connect

                    if is_connect(built.outcome.files) or self.connect.opportunity is not None:
                        raise ValueError("A Connect opportunity must remain in one complete observation.")
                    ctx.editor_partition = partition
                found = getattr(module, function)(ctx)
                self.unit.restore(mark)
                return found
        return None

    def b_context(self, ops, name, built, captured):
        from proof.diagnostics import stages
        from proof.observe import connect, sessions

        lookups = self.tables(captured)
        database = self.cases["b_edit" if name == "B-edit" else "b"]
        outcome, restore = sessions.hq_restore(self.unit, database, lookups, "restore-proof4", ops)
        replayable = (
            name == "B" and self.replay_b_key is not None and stages.wants_receipts(self.document, self.store)
            and self.a_built and self.a_built.outcome.files and built.outcome.files
            and self.connect.opportunity is None
            and not connect.is_connect(self.a_built.outcome.files) and not connect.is_connect(built.outcome.files)
        )
        return BContext(
            replay_b_key=self.replay_b_key if replayable else None,
            document=self.document,
            over=name,
            configuration=self.configuration,
            configuration_name=self.export.configuration.name,
            unit=HookUnit(self.unit, ops, "proof4"),
            app_id=self.app_id,
            build=built.outcome,
            hq_build=built.hq_build,
            archive=built.archive,
            sessions=(database, lookups),
            restore=restore,
            core_runner=self.core_runner,
            editor_driver=self.editor_driver,
            blobs=self.blobs,
            store=self.store,
            restore_outcome=outcome,
            previous_build=self.saved_a,
            declared_inputs=self.declared_inputs[name]["proof4"],
            serve=any(hook == "served" for hook, _, _, _ in self.hooks),
            connect=self.connect,
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

    def observe_b(self, part, captured, name, stopped=None, *, partition=None):
        """B (``captured`` the republish) or B-edit (the update) over A, as the ``b`` or ``b_edit`` record.

        Both take the same steps (publish, the reads of HQ's API where
        ``api_read_label`` names them, build, then the hooks and proof 4 from
        the mark right after the build), so a B-edit with B's inputs is
        observed as B is. The unit is left at that mark (``mark_b``). A
        republish Nova stopped (``stopped``, its failure code) sent nothing, so
        no B is observed: the record holds the stop, as a refused B holds no
        state.
        """
        ops = self.ops(part)
        if captured is None:
            self.b_built = self.mark_b = None
            return ops.recorded({"kind": "b", "stopped": stopped})
        record = {"kind": "b", "publish": self.publish_over_a(ops, captured, name)}
        self.b_built = self.mark_b = None
        if record["publish"]["refused"] is None:
            label = api_read_label(self.document, "b")
            if label is not None:
                record["apiReads"] = {label: self.api_reads(ops, label)}
            built, flags, _ = _build(self.unit, ops, self.core_runner, self.app_id, name, self.saved_a)
            record["state"] = _state_record(built, self.blobs)
            # The flags HQ read while it built this state, apart from those its publish read: the gates the
            # manifest check holds (proof.checks.manifest_usage.flag_reads).
            record["flagsReadByBuild"] = flags
            mark = self.unit.mark()
            record["hooks"] = self.run_hooks(ops, name, built, mark)
            proof4 = self.run_proof4(ops, name, built, captured, mark, partition)
            if proof4 is not None:
                record["proof4"] = proof4
            self.b_built, self.mark_b = built, mark
        return ops.recorded(record)

    def recreate_b(self, b_record, captured):
        """B as the ``b`` record's operations made it (republish, its media, build), for a ``b_aligned`` the store
        lacks."""
        self.b_built = self.mark_b = None
        if captured is None:
            return
        ops = self.ops("recreate")
        refused = self.publish_over_a(ops, captured, "B")["refused"]
        if refused is None and b_record.get("state") is not None:
            built, _, _ = _build(self.unit, ops, self.core_runner, self.app_id, "B", self.saved_a, keep=False)
            held = _built_from(b_record["state"], self.blobs, "B")
            built.outcome, built.doc, built.identities = held.outcome, held.doc, held.identities
            self.b_built, self.mark_b = built, self.unit.mark()

    def observe_b_aligned(self, a_record, b_record=None):
        """B aligned to A, built, and proof 3's sessions, as the ``b_aligned`` record.

        From B's mark. Where HQ refused B there is no B to align, and the
        sessions of the two export paths run all the same (decision 15: the
        local archive against ``build(A)``, always), from A's mark; B's do not.
        B's sessions and walks run where the raw builds of A and of B aligned to
        A differ, and always for an app made in CommCare HQ, whose A is HQ's own
        app and not Nova's export, so two builds alike say nothing of what a
        worker meets on B.
        """
        from proof.observe import builds, sessions

        ops = self.ops("b_aligned")
        record = {"kind": "b_aligned"}
        b_aligned, differs, aligned_doc = None, False, None
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
            b_aligned, aligned_doc = _aligned_build(self.unit, ops, self.app_id, alignment, self.saved_a)
            record["aligned"] = outcome_record(b_aligned, self.blobs)
            differs = (
                builds.raw_builds_differ(self.document.id, self.a_built.outcome, b_aligned, alignment)
                or self.hq_authored
            )
        restore_a = (a_record or {}).get("restoreA")
        if restore_a is not None:
            restore = None if restore_a["restore"] is None else self.blobs.get(restore_a["restore"])
            record["sessions"] = sessions.observe(
                self.unit,
                document=self.document,
                export=self.export,
                app_id=self.app_id,
                a_build=self.a_built.outcome,
                b_aligned=b_aligned,
                b_differs=differs,
                restore_a=(restore_a["lookups"], restore),
                core_runner=self.core_runner,
                blobs=self.blobs,
                operation=ops,
                a_doc=self.a_built.doc,
            )
        if any(name == "served" for name, _, _, _ in self.hooks):
            from proof.observe import served

            def change(stored):
                stored.clear()
                stored.update(aligned_doc)

            found = served.aligned(
                HookUnit(self.unit, ops, served.HOOK),
                document=self.document,
                app_id=self.app_id,
                a_record=a_record,
                a_build=self.a_built.outcome,
                b_aligned=b_aligned,
                differs=differs,
                change=change,
                previous=self.saved_a,
                driver=self.editor_driver,
                blobs=self.blobs,
                connect=self.connect,
                sessions=record.get("sessions"),
                b_record=b_record,
                configuration=self.export.configuration.name,
            )
            if found is not None:
                record["served"] = found
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


class PartsNotHeld(AssertionError):
    """A document read from the store alone (``held_only``) lacks a part an observation of it keeps."""

    def __init__(self, document, parts):
        self.parts = list(parts)
        super().__init__(
            f"{document.group} was read from the evidence store alone, with nothing observed, and the store holds"
            f" no {', '.join(self.parts)} of it. Its own group reads so where each of its configurations was observed"
            " by a piece before it (proof.checks.pieces), which keeps every part in the run's store. Look at the"
            " pieces' outcomes in this block's manifest, and at whether the run keeps a store at all (PROOF_STORE=off"
            " and a run without PROOF_FINGERPRINTS keep none)."
        )


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


@contextmanager
def _connect_closed():
    """Each Connect opportunity holder appended to the block's list is closed as the block ends, however it ends:
    a unit's served Connect does not outlive the unit."""
    holders = []
    try:
        yield holders
    finally:
        for holder in holders:
            holder.close()


def observe_configuration(
    document,
    name,
    keys,
    records,
    *,
    core_runner,
    editor_driver,
    store,
    blobs,
    timings,
    cases,
    hooks,
    same_as=True,
    held_only=False,
    partition=None,
):
    """One configuration's parts, from the store where it holds them and observed in one unit otherwise.

    With ``same_as`` (the default) a ``b_edit`` keyed as ``b`` is recorded as
    the same and not observed; without it, it is observed all the same.
    ``hooks`` is what the observation hooks declare they read
    (``hook_inputs``), which the guard allows each part's hooks. With
    ``held_only`` nothing is observed: a part an observation of the
    configuration keeps and the store does not hold raises ``PartsNotHeld``.
    """
    from proof.hq.state import hq_unit
    from proof.store import guard

    export = document.exports[name]
    with guard.observing(document, name, "configuration", hooks):
        configuration = export.configuration.hq()
    same = same_as and keys.get("b_edit") is not None and keys["b_edit"] == keys["b"]
    if partition is None:
        held = {part: _held(store, key, blobs) for part, key in keys.items()}
        wanted = [part for part in PARTS if part in keys and (store.fresh or held[part] is None)]
    else:
        wanted = ["a", "b", "b_aligned"] if partition.index == 1 else ["b"]
        # A partial B must never borrow the complete B or its blobs. Only the first worker audits A and aligned B.
        held = {
            part: _held(store, key, blobs) if part != "b" and part in wanted else None for part, key in keys.items()
        }
    if same and "b_edit" in wanted:
        wanted.remove("b_edit")
    for part in keys:
        if part not in wanted and held[part] is not None:
            setattr(records, part, held[part])
    if same:
        records.b_edit = {"same_as": keys["b"].hex()}
    if not wanted:
        return []
    if held_only:
        # What an observation of the configuration keeps: its ``a``, and every other part where A holds an app
        # (below: nothing is observed past a create HQ refused).
        a = held.get("a")
        unkept = [part for part in wanted if a is None or a.get("state") is not None]
        if unkept:
            raise PartsNotHeld(document, [f"{name}/{part}" for part in unkept])
        return []
    started = time.perf_counter()
    observed = []
    core_runner = _TimedRunner(core_runner)
    configuration_label = name
    if name not in BASE_CONFIGURATIONS:
        single_flags = sorted(set(document.exports) - set(BASE_CONFIGURATIONS))
        configuration_label = f"single flag {single_flags.index(name) + 1}"

    def settled(part, observe):
        part_started = time.perf_counter()
        with progress.activity(f"{configuration_label}/{part}", count="part"):
            with guard.observing(document, name, part, hooks):
                setattr(records, part, observe())
            timings.setdefault(part, {})["seconds"] = round(time.perf_counter() - part_started, 4)
            if part == "b" and partition is not None:
                fragment, named = partition.fragment(records.b, blobs)
                store.put_fragment(partition.key, fragment, named)
            else:
                _settle(store, keys[part], getattr(records, part), blobs, held[part])
        observed.append(part)

    with (
        guard.observing(document, name, "configuration", hooks),
        hq_unit(configuration, root_key=keys["a"]) as unit,
        _connect_closed() as closing,
    ):
        state = _Unit(
            document,
            export,
            configuration,
            unit,
            core_runner,
            editor_driver,
            store,
            blobs,
            timings,
            cases,
            hooks,
        )
        state.replay_b_key = keys.get("b")
        closing.append(state.connect)
        if "a" in wanted:
            settled("a", state.observe_a)
        else:
            with progress.activity(f"{configuration_label}/recreate A"), guard.observing(document, name, "a", hooks):
                if partition is not None:
                    # A sibling independently observes the full A. B needs its real persisted app and saved
                    # build, exactly what the first step of recreate_a reconstructs under a stored A.
                    from proof.observe.connect import is_connect

                    state.create_a(state.ops("recreate"), full=False)
                    if (
                        state.a_built is None
                        or not state.a_built.outcome.files
                        or is_connect(state.a_built.outcome.files)
                    ):
                        raise ValueError("Editor partitions require a buildable non-Connect A.")
                else:
                    state.recreate_a(records.a)
        if partition is not None and state.app_id is None:
            raise ValueError("Editor partitions require a successful A.")
        if state.app_id is not None:
            if "b" in wanted:
                settled(
                    "b",
                    lambda: state.observe_b("b", export.republish, "B", export.republish_stopped, partition=partition),
                )
            elif "b_aligned" in wanted:
                with (
                    progress.activity(f"{configuration_label}/recreate B"),
                    guard.observing(document, name, "b", hooks),
                ):
                    state.recreate_b(records.b, export.republish)
            if "b_aligned" in wanted:
                settled("b_aligned", lambda: state.observe_b_aligned(records.a, records.b))
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
    """Each local archive the document carries, by its name in the document: ``{name: Path}``
    (``Document.local_archives``: the archive compiled for a project space holding the empty-list text flag
    among them, where the document carries it)."""
    return dict(document.local_archives)


def observe_local(
    document, *, core_runner, store=NULL_STORE, blobs=None, timings=None, hooks=None, held_only=False, force=False
):
    """Core's admission of each local archive the document carries, its reading of each stack step value in
    its suite (``read_stack_values``), and each local hook's record (``observe_local(ctx)``, ``LocalContext``),
    as the ``local`` record, and its key. ``hooks`` is ``hook_inputs(document)``, computed where not given. With
    ``held_only`` nothing is observed: a record the store does not hold raises ``PartsNotHeld``."""
    from proof.core.client import ANDROID_DEFAULT_STRINGS
    from proof.observe.build import admit
    from proof.store import guard

    blobs = Blobs() if blobs is None else blobs
    with guard.observing(document, None, guard.KEYS):
        hooks = hook_inputs(document) if hooks is None else hooks
        key = local_key(document_inputs(document), hooks)
    held = _held(store, key, blobs)
    if held is not None and not (store.fresh or force):
        return held, key, False
    if held_only:
        raise PartsNotHeld(document, [LOCAL])
    started = time.perf_counter()
    reports, readings = {}, {}
    archives = local_archives(document)
    observed, seconds = {}, {}
    with progress.activity("local/Core admission", count="part"):
        with guard.observing(document, None, LOCAL, hooks):
            for name, path in archives.items():
                # A local archive is read by CommCare Android alone (Nova hands one only an app that runs there), which
                # admits it over its own strings (``proof/core/src/nova/proof/core/Admission.java``).
                reports[name] = admit(core_runner, path, runtime_defaults=ANDROID_DEFAULT_STRINGS)
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


def _partition_inputs(document, configuration, store):
    from proof.lane import readers
    from proof.store import guard

    with guard.observing(document, None, guard.KEYS):
        if (
            document.kind != "corpus"
            or document.edit is not None
            or list(document.exports) != [configuration]
            or document.document["doc"].get("connectType") is not None
            or not getattr(store, "seeded", False)
            or readers.named() != readers.EVERY
            or store.environment[readers.VARIABLE] != "all"
        ):
            raise ValueError(
                "Editor partitions require all readers and one seeded, non-Connect configuration without an edit."
            )
        inputs = document_inputs(document)
        cases, databases = _case_inputs(document)
        hooks = hook_inputs(document)
        keys = part_keys(inputs, configuration, databases, hooks)
        keys.pop("b_edit", None)
    return keys, local_key(inputs, hooks), cases, hooks


def observe_partition(document, configuration, index, total, *, core_runner, editor_driver, store):
    """A fresh slice of B's editor saves. Only worker one also produces the whole A, aligned B, and local parts."""
    from proof.observe.editor_slices import Capture

    keys, _, cases, hooks = _partition_inputs(document, configuration, store)
    partition = Capture(keys["b"], index, total)
    found = DocumentRecords(document.id, document.kind)
    records = ConfigurationRecords(configuration, keys)
    timings = found.timings.setdefault(configuration, {})
    made = observe_configuration(
        document,
        configuration,
        keys,
        records,
        core_runner=core_runner,
        editor_driver=editor_driver,
        store=store,
        blobs=found.blobs,
        timings=timings,
        cases=cases,
        hooks=hooks,
        partition=partition,
    )
    found.observed = [
        f"{configuration}/{part}" if part != "b" else f"{configuration}/b~{index}of{total}" for part in made
    ]
    if index == 1:
        found.local, found.local_key, _ = observe_local(
            document,
            core_runner=core_runner,
            store=store,
            blobs=found.blobs,
            timings=found.timings,
            hooks=hooks,
            force=True,
        )
        found.observed.append("local")
    return found


def join_partitions(document, configuration, total, *, store):
    """Seal the ordinary B from the current workers' complete handoff and their independently observed baselines."""
    from proof.observe import editor_slices

    keys, local, _, _ = _partition_inputs(document, configuration, store)
    for part, key in (("a", keys["a"]), ("b_aligned", keys["b_aligned"]), ("local", local)):
        if store.lookup_current(key) is None:
            raise PartsNotHeld(document, [f"{configuration}/{part}"])
    blobs = Blobs()
    fragments = []
    for index in range(1, total + 1):
        key = editor_slices.key_for(keys["b"], index, total)
        fragment = store.lookup_current(key, fragment=True)
        if fragment is None:
            raise PartsNotHeld(document, [f"{configuration}/b~{index}of{total}"])
        named = store.blobs(key)
        if named.refs() != fragment["blobIds"]:
            raise ValueError("The supplied blobs differ from those the native editor partition captured.")
        blobs.merge(named)
        fragments.append(fragment)
    b = editor_slices.merge(keys["b"], fragments)
    _settle(store, keys["b"], b, blobs, store.lookup(keys["b"]))


def observe_document(
    document,
    *,
    core_runner,
    editor_driver=None,
    store=NULL_STORE,
    configurations=None,
    same_as=True,
    held_only=False,
):
    """Every part of one document's tree, each configuration in a unit of its own, and its local archives.

    ``configurations`` names the configurations to observe (every one the
    document is exported under by default); ``same_as`` is
    ``observe_configuration``'s. Each state is also served to the session's
    Formplayer (``proof.observe.services``) and, with ``editor_driver``, shown
    in the Web Apps client (``proof.observe.served``). With ``held_only``
    every part is read from the store and nothing is observed
    (``PartsNotHeld`` where the store lacks one an observation keeps): how a
    document's own group reads what its pieces observed, one configuration
    each (``proof.checks.observations``).
    """
    from proof.store import guard

    # What every key is derived from, which the guard holds to what the document's key names (``guard.KEYS``).
    with guard.observing(document, None, guard.KEYS):
        inputs = document_inputs(document)
        cases, databases = _case_inputs(document)
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
            cases=cases,
            hooks=hooks,
            held_only=held_only,
        )
        found.observed += [f"{name}/{part}" for part in observed]
        found.configurations[name] = held
    found.local, found.local_key, observed = observe_local(
        document,
        core_runner=core_runner,
        store=store,
        blobs=found.blobs,
        timings=found.timings,
        hooks=hooks,
        held_only=held_only,
    )
    if observed:
        found.observed.append("local")
    return found
