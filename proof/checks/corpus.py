"""The corpus on disk, read in the layout ``proof/corpus/emit.ts`` writes.

A corpus directory holds ``index.json`` (``{seed, sample, entropy,
documents: [{id, source, group, ...}]}``, and ``unsampled``, listed the same
way, where a run's sample leaves documents out, ``proof.store.queue.sampled``),
``inputs.json`` (each document's input manifest digest) and ``timings.json``
(what the emission took), and, per document, a directory of the same id:

- ``document.json``: the admitted Nova document D (persistable form) with the
  lookup snapshot and media its publish reads, its source, and its wire
  placement: ``wire.modules`` (the modules Nova emits, in order, each with
  its forms in order, by Nova uuid; ``proof/corpus/footprint.ts::wireLayout``)
  and ``wire.languages`` (each language's tag and the code the app's
  ``langs`` holds for it, in that order; ``footprint.ts::wireLanguages``);
- ``configurations.json``: ``{minimum, maximum, singleFlag: {<symbol>:
  configuration}}``, each ``{flags, namedPrivileges, commcareVersion,
  commtrack, syncCasesOnFormEntry, caseSearchEnabled}``; an export directory
  is named by its configuration (``minimum``, ``maximum`` or the single
  flag's symbol). A configuration grants the privileges a reproduction names
  and those the document's content needs, which HQ derives
  (``proof.checks.configurations.privileges_for``), so ``Configuration.privileges``
  is read where HQ is booted;
- ``verdict.json``: Nova's publish verdict for D;
- ``export/<configuration>/``: the captured requests of D's publish there,
  each a body and a JSON sidecar naming its content type: ``create`` and
  ``republish`` (the next publish of D). A sidecar's ``lookups`` names the
  lookup workbook Nova's push sent before that import, and its ``media`` the
  media upload Nova sent after it (``lib/deployment/service.ts::uploadMediaBytes``),
  each a body with its own sidecar in the same directory;
- ``local.ccz`` and ``local-again.ccz``: two local exports of D;
- ``edit/``: ``batch.json`` (the edit batch and its footprint),
  ``document.json`` (D'), ``verdict.json`` (Nova's verdict for D'),
  ``export/<configuration>/update`` (the publish of D' over D's), and
  ``local.ccz``;
- ``expected.json``: a targeted document's hand-fixed intent values, and
  beside it the files its expectations read (each restore an expectation
  names, ``proof/targeted/restore.ts``); a targeted document carries an
  ``edit/`` only where it writes D′ itself, and its ``document.json`` names
  the work item 12 rows it shows (``source.rows``);
- ``hq-side.json``, where a document carries it: what a person saves in HQ
  over A before Nova's next publish (``proof.observe.hqside``);
- ``inputs.json``: the digest of every file above that a check reads, by the
  part of the document's HQ tree that reads it (``proof/corpus/inputs.ts``).

A control under ``proof/controls/<document id>/`` (the retained inputs of one
document, ``proof.checks.controls``) has the same layout for the files it
retains (the upload bodies, the export bytes, a targeted document's
expectations and restores, the configurations and verdicts, and the edit
batch's footprint), and is read the same way (``load_controls``), but for the
documents themselves: it holds no ``document.json``, whose ``doc`` is Nova's
persistable shape, which a later cutover changes. What the checks derive
from D and D' is written beside the files when the control is retained
(``derived.json``: the wire layout and languages, the intent, the lookup
tags and the case database, ``DERIVED``), so a control reads the same
whatever shape Nova's document later takes.

Nothing here runs HQ or Core; it reads files and refuses a layout it cannot
read, naming the file and what it lacks. The one HQ reach is a
configuration's privileges, which it reads from
``proof.checks.configurations`` only in a process that booted HQ.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

from proof import processes

PROOF_DIR = Path(__file__).resolve().parents[1]
CONTROLS_DIR = PROOF_DIR / "controls"
WORKTREE = PROOF_DIR.parent

CONFIGURATION_KEYS = frozenset(
    {"flags", "namedPrivileges", "commcareVersion", "commtrack", "syncCasesOnFormEntry", "caseSearchEnabled"}
)
BASE_CONFIGURATIONS = ("minimum", "maximum")


class CorpusLayoutError(ValueError):
    """A corpus or control directory is not in the layout the checks read."""


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise CorpusLayoutError(f"The corpus has no {path}, which the checks read.") from error
    except json.JSONDecodeError as error:
        raise CorpusLayoutError(f"{path} is not JSON ({error}).") from error


def hq_booted():
    """Whether this process booted HQ: Django's app registry is ready. Imports nothing."""
    apps = getattr(sys.modules.get("django.apps"), "apps", None)
    return bool(getattr(apps, "ready", False))


@dataclass(frozen=True)
class Configuration:
    """One project-space configuration a document is published to, by its export directory name."""

    name: str
    flags: tuple[str, ...]
    named_privileges: tuple[str, ...]
    commcare_version: str
    commtrack: bool
    sync_cases_on_form_entry: bool
    case_search_enabled: bool
    # The document directory whose captured publishes the content's privileges are derived from.
    root: Path | None = field(default=None, compare=False)

    @property
    def privileges(self):
        """The privileges the configuration grants: those a reproduction names and those the content needs.

        HQ derives the content's (``proof.checks.configurations.privileges_for``),
        so they are read only in a process that booted HQ.
        """
        if not hq_booted():
            raise CorpusLayoutError(
                f"The privileges of the {self.name!r} configuration of {self.root} are what HQ derives from the apps"
                " Nova sends (proof.checks.configurations.privileges_for) and those it names; this process has not"
                " booted HQ. Read them where HQ runs (the hq fixture), or from the record that observation wrote."
            )
        if self.root is None:
            return self.named_privileges
        from proof.checks.configurations import privileges_for

        return tuple(privileges_for(self.root, self.name))

    @classmethod
    def from_json(cls, name, value, where):
        if not isinstance(value, dict):
            raise CorpusLayoutError(f"{where}: the configuration {name!r} is not an object.")
        unknown = set(value) - CONFIGURATION_KEYS
        missing = CONFIGURATION_KEYS - set(value)
        if unknown or missing:
            raise CorpusLayoutError(
                f"{where}: the configuration {name!r} holds exactly {sorted(CONFIGURATION_KEYS)};"
                f" it has {sorted(unknown)} beyond them and lacks {sorted(missing)}."
            )
        for key in ("flags", "namedPrivileges"):
            if not isinstance(value[key], list) or not all(isinstance(item, str) for item in value[key]):
                raise CorpusLayoutError(f"{where}: {name}.{key} is a list of HQ symbols.")
        for key in ("commtrack", "syncCasesOnFormEntry", "caseSearchEnabled"):
            if not isinstance(value[key], bool):
                raise CorpusLayoutError(f"{where}: {name}.{key} is true or false.")
        if not isinstance(value["commcareVersion"], str):
            raise CorpusLayoutError(f"{where}: {name}.commcareVersion is a version string such as 2.57.0.")
        return cls(
            name=name,
            flags=tuple(sorted(value["flags"])),
            named_privileges=tuple(sorted(value["namedPrivileges"])),
            commcare_version=value["commcareVersion"],
            commtrack=value["commtrack"],
            sync_cases_on_form_entry=value["syncCasesOnFormEntry"],
            case_search_enabled=value["caseSearchEnabled"],
            root=Path(where).parent,
        )

    def hq(self):
        """The configuration as ``proof.hq.configuration.Configuration`` holds it."""
        from proof.hq.configuration import Configuration as HqConfiguration

        return HqConfiguration(
            flags=frozenset(self.flags),
            privileges=frozenset(self.privileges),
            commcare_version=self.commcare_version,
            commtrack=self.commtrack,
            sync_cases_on_form_entry=self.sync_cases_on_form_entry,
            case_search_enabled=self.case_search_enabled,
        )


def _wire_languages(document_json, path):
    """The languages ``document.json`` places on the wire: ``[{tag, code}]``, in the order of the app's ``langs``."""
    wire = document_json.get("wire") if isinstance(document_json, dict) else None
    languages = wire.get("languages") if isinstance(wire, dict) else None
    if not isinstance(languages, list) or not all(
        isinstance(language, dict) and isinstance(language.get("tag"), str) and isinstance(language.get("code"), str)
        for language in languages
    ):
        raise CorpusLayoutError(
            f"{path} holds no wire.languages, each language's tag and the code the app's langs holds for it"
            " (proof/corpus/footprint.ts::wireLanguages)."
        )
    return languages


def lacking(configuration, verdict_path):
    """What Nova's publish requires that ``configuration`` lacks (decision 19); empty when Nova would publish there.

    Read from the verdict at ``verdict_path`` (``verdict.json`` or
    ``edit/verdict.json``, written from ``proof/corpus/publish.ts``'s
    verdict): ``minimumConfiguration``'s ``flags``, and ``case search`` when
    it needs case search on.
    """
    verdict = _read_json(verdict_path)
    minimum = verdict.get("minimumConfiguration") if isinstance(verdict, dict) else None
    if (
        not isinstance(minimum, dict)
        or not isinstance(minimum.get("flags"), list)
        or not isinstance(minimum.get("caseSearchEnabled"), bool)
    ):
        raise CorpusLayoutError(
            f"{verdict_path} holds no minimumConfiguration with its flags and caseSearchEnabled, so it does not say"
            " whether Nova's publish would send there (decision 19)."
        )
    missing = sorted(set(minimum["flags"]) - set(configuration.flags))
    if minimum["caseSearchEnabled"] and not configuration.case_search_enabled:
        missing.append("case search")
    return missing


def _wire_modules(document_json, path):
    """The wire layout ``document.json`` records: ``[{uuid, forms, synthetic?}]``, in the order Nova emits."""
    wire = document_json.get("wire") if isinstance(document_json, dict) else None
    modules = wire.get("modules") if isinstance(wire, dict) else None
    if not isinstance(modules, list) or not all(
        isinstance(module, dict)
        and isinstance(module.get("uuid"), str)
        and isinstance(module.get("forms"), list)
        and all(isinstance(form, str) for form in module["forms"])
        for module in modules
    ):
        raise CorpusLayoutError(
            f"{path} holds no wire.modules, the modules and forms Nova emits for it in order"
            " (proof/corpus/footprint.ts::wireLayout)."
        )
    return modules


@dataclass(frozen=True)
class Captured:
    """One captured request of Nova's publish: its body, its sidecar, the workbook pushed before it and the media
    upload sent after it."""

    body_path: Path
    meta: dict
    lookups: Captured | None = None
    media: Captured | None = None

    @property
    def content_type(self):
        return self.meta["contentType"]

    def upload(self):
        from proof.hq.operations import Upload

        return Upload(self.body_path.read_bytes(), self.content_type)

    def workbook(self):
        """The lookup workbook a captured lookup upload carries (its ``file-to-upload`` field)."""
        from proof.hq.operations import upload_field

        return upload_field(self.upload(), "file-to-upload")

    @property
    def assumed_source_profile(self):
        """The profile the capture assumed HQ holds for the app an update is sent over."""
        if "assumedSourceProfile" not in self.meta:
            raise CorpusLayoutError(
                f"{self.body_path.with_suffix('.json')} is an update's capture and names no assumedSourceProfile,"
                " the profile it was built over."
            )
        return self.meta["assumedSourceProfile"]


# What an import's sidecar may name beside it: the request each key names, as its message calls it.
_BESIDE = (("lookups", "the lookup workbook"), ("media", "the media upload"))


def _captured(directory: Path, name: str):
    sidecar = directory / f"{name}.json"
    if not sidecar.exists():
        raise CorpusLayoutError(f"{directory} has no {name}.json, the captured {name} request.")
    meta = _read_json(sidecar)
    if not isinstance(meta, dict) or not isinstance(meta.get("contentType"), str):
        raise CorpusLayoutError(f"{sidecar} names no contentType for its body.")
    body = directory / meta.get("body", f"{name}.body")
    if not body.exists():
        raise CorpusLayoutError(f"{sidecar} names the body {body.name}, which {directory} does not hold.")
    beside = {}
    for key, what in _BESIDE:
        if meta.get(key) is None:
            continue
        named = meta[key]
        if not isinstance(named, str) or not named.endswith(".body"):
            raise CorpusLayoutError(f"{sidecar} names {what} {named!r}, which is not a .body file.")
        beside[key] = _captured(directory, named.removesuffix(".body"))
    return Captured(body, meta, **beside)


@dataclass(frozen=True)
class Export:
    """What Nova's publish sends under one configuration."""

    configuration: Configuration
    directory: Path
    create: Captured | None
    republish: Captured | None
    update: Captured | None


# What a control retains of D and D' in place of their ``document.json`` (``proof.checks.controls.derived``): each
# key a check reads, by the document it was derived from.
DERIVED = "derived.json"
DERIVED_KEYS = frozenset({"wire", "intent", "lookupTags", "caseDatabase"})


@dataclass(frozen=True)
class Edit:
    root: Path
    batch: dict
    exports: dict = field(default_factory=dict)

    @property
    def footprint(self):
        """The Nova entity ids the batch's footprint holds (``proof/corpus/footprint.ts::batchFootprint``)."""
        footprint = self.batch.get("footprint")
        if not isinstance(footprint, list) or not all(isinstance(item, str) for item in footprint):
            raise CorpusLayoutError(f"{self.root / 'batch.json'} holds no footprint, a list of entity ids.")
        return frozenset(footprint)

    @property
    def document_path(self):
        return self.root / "document.json"

    @property
    def local_ccz(self):
        path = self.root / "local.ccz"
        return path if path.exists() else None


@dataclass(frozen=True)
class Document:
    """One corpus document, or one control read as a document."""

    id: str
    source: str
    root: Path
    kind: str = "corpus"  # "corpus" or "control"

    @property
    def group(self):
        """The shard group every item of this document belongs to."""
        return f"{self.kind}:{self.id}"

    def __str__(self):
        return self.id

    @cached_property
    def configurations(self):
        value = _read_json(self.root / "configurations.json")
        where = self.root / "configurations.json"
        if not isinstance(value, dict) or set(value) != {"minimum", "maximum", "singleFlag"}:
            raise CorpusLayoutError(f"{where} holds exactly minimum, maximum and singleFlag.")
        found = {name: Configuration.from_json(name, value[name], where) for name in BASE_CONFIGURATIONS}
        single = value["singleFlag"]
        if not isinstance(single, dict):
            raise CorpusLayoutError(f"{where}: singleFlag maps a flag symbol to a configuration.")
        for symbol, configuration in single.items():
            found[symbol] = Configuration.from_json(symbol, configuration, where)
        return found

    def _configuration(self, name, where, verdict_path):
        configuration = self.configurations.get(name)
        if configuration is None:
            raise CorpusLayoutError(
                f"{where} is an export under the configuration {name!r}, which {self.root / 'configurations.json'}"
                f" does not define (it defines {sorted(self.configurations)})."
            )
        self._publishable(configuration, where, verdict_path)
        return configuration

    def _publishable(self, configuration, where, path):
        """Decision 19: an export exists only under a configuration Nova's publish accepts.

        The verdict beside the export (``verdict.json``, written from
        ``proof/corpus/publish.ts``'s verdict) names what Nova's publish
        requires: ``minimumConfiguration`` with its ``flags`` and
        ``caseSearchEnabled``.
        """
        missing = lacking(configuration, path)
        if missing:
            raise CorpusLayoutError(
                f"{where} is an export under {configuration.name!r}, which lacks what Nova's publish requires"
                f" ({path.name}: {', '.join(missing)}); Nova never publishes there (decision 19), so no check runs"
                " on it."
            )

    @cached_property
    def exports(self):
        """Each configuration D is published under, by name, with its captured requests."""
        directory = self.root / "export"
        if not directory.is_dir():
            return {}
        found = {}
        for child in sorted(p for p in directory.iterdir() if p.is_dir()):
            found[child.name] = Export(
                configuration=self._configuration(child.name, child, self.root / "verdict.json"),
                directory=child,
                create=_captured(child, "create"),
                republish=_captured(child, "republish"),
                update=None,
            )
        return found

    @cached_property
    def edit(self):
        root = self.root / "edit"
        if not root.is_dir():
            return None
        batch = _read_json(root / "batch.json")
        exports = {}
        directory = root / "export"
        if directory.is_dir():
            for child in sorted(p for p in directory.iterdir() if p.is_dir()):
                exports[child.name] = Export(
                    configuration=self._configuration(child.name, child, root / "verdict.json"),
                    directory=child,
                    create=None,
                    republish=None,
                    update=_captured(child, "update"),
                )
        return Edit(root=root, batch=batch, exports=exports)

    @property
    def document_path(self):
        return self.root / ("document.json" if self.kind != "control" else DERIVED)

    def _document_json(self, path, what):
        if self.kind == "control":
            raise CorpusLayoutError(
                f"{self.root} is a control, which retains what the checks derive from {what} ({DERIVED},"
                " Document.derived) and not its document.json, whose shape a later cutover changes; read the"
                " derived value a control holds."
            )
        return _read_json(path)

    @cached_property
    def document(self):
        return self._document_json(self.document_path, "D")

    @cached_property
    def edit_document(self):
        """D', the document after the edit batch (``edit/document.json``)."""
        if self.edit is None:
            raise CorpusLayoutError(f"{self.root} has no edit/, so it carries no D'.")
        return self._document_json(self.edit.document_path, "D'")

    @cached_property
    def _derived(self):
        path = self.root / DERIVED
        value = _read_json(path)
        if not isinstance(value, dict) or not isinstance(value.get("D"), dict):
            raise CorpusLayoutError(f"{path} holds {{D: {{...}}, D'?: {{...}}}}, what the checks derive from each.")
        for name, held in value.items():
            if name not in ("D", "D'") or not isinstance(held, dict) or set(held) != DERIVED_KEYS:
                raise CorpusLayoutError(f"{path}: {name} holds exactly {sorted(DERIVED_KEYS)}.")
        return value

    def derived(self, key, *, edit=False):
        """What a check derives from D (or D', ``edit``) that a control retains (``DERIVED``); None for a corpus
        document, whose checks derive it from its ``document.json``."""
        if self.kind != "control":
            return None
        name = "D'" if edit else "D"
        held = self._derived.get(name)
        if held is None:
            raise CorpusLayoutError(f"{self.root / DERIVED} holds nothing of {name}, which a check reads.")
        return held[key]

    def _wire(self, edit):
        held = self.derived("wire", edit=edit)
        if held is not None:
            return held
        document = self.edit_document if edit else self.document
        return document.get("wire") if isinstance(document, dict) else None

    @property
    def wire_modules(self):
        """D's modules and forms in the order Nova emits them."""
        return _wire_modules({"wire": self._wire(False)}, self.document_path)

    @property
    def edit_wire_modules(self):
        """D''s modules and forms in the order Nova emits them."""
        return _wire_modules({"wire": self._wire(True)}, self.edit.document_path)

    @property
    def wire_languages(self):
        """D's languages in the order of the app's ``langs``, each ``{tag, code}``."""
        return _wire_languages({"wire": self._wire(False)}, self.document_path)

    @property
    def edit_wire_languages(self):
        """D''s languages in the order of the app's ``langs``, each ``{tag, code}``."""
        return _wire_languages({"wire": self._wire(True)}, self.edit.document_path)

    @cached_property
    def inputs(self):
        """The document's input manifest (``inputs.json``; ``proof/corpus/inputs.ts``)."""
        return _read_json(self.root / "inputs.json")

    @cached_property
    def verdict(self):
        return _read_json(self.root / "verdict.json")

    @property
    def local_ccz(self):
        path = self.root / "local.ccz"
        return path if path.exists() else None

    @property
    def local_again_ccz(self):
        path = self.root / "local-again.ccz"
        return path if path.exists() else None

    @cached_property
    def expected(self):
        path = self.root / "expected.json"
        return _read_json(path) if path.exists() else None

    @cached_property
    def hq_side(self):
        """What a person saves in HQ over A before Nova's next publish (``hq-side.json``), or None."""
        path = self.root / "hq-side.json"
        if not path.exists():
            return None
        value = _read_json(path)
        if not isinstance(value, dict):
            raise CorpusLayoutError(f"{path} holds an object naming each save a person makes in HQ over A.")
        return value

    @property
    def targeted(self):
        """A targeted document is one with hand-fixed expected values."""
        return (self.root / "expected.json").exists()


@dataclass(frozen=True)
class Corpus:
    root: Path
    seed: object
    sample: object
    # The documents the run checks (``proof.checks.cases.document_params``): every one the corpus emitted, or the
    # run's sample of them.
    documents: tuple[Document, ...]
    # The documents the corpus emitted that the run's sample leaves out: no check runs on them, and their files
    # are here for the tests that read the corpus for their own ends. Empty for a corpus run whole.
    unsampled: tuple[Document, ...] = ()

    @property
    def emitted(self):
        """Every document the corpus emitted, those the run checks and those its sample leaves out: what a test
        that is not a document's check reads, so it holds the same over a sample as over the whole corpus."""
        return self.documents + self.unsampled

    def document(self, document_id):
        """The emitted document ``document_id``, whether or not the run's sample holds it."""
        for document in self.emitted:
            if document.id == document_id:
                return document
        raise KeyError(document_id)


def load(root: Path) -> Corpus:
    """The corpus at ``root``, refusing an index that names a document it does not hold."""
    root = Path(root)
    index = _read_json(root / "index.json")
    if not isinstance(index, dict) or not isinstance(index.get("documents"), list):
        raise CorpusLayoutError(f"{root / 'index.json'} holds {{seed, sample, documents: [...]}}.")
    if not isinstance(index.get("unsampled", []), list):
        raise CorpusLayoutError(f"{root / 'index.json'} lists the documents its sample leaves out as a list.")
    seen = set()

    def listed(entries):
        documents = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                raise CorpusLayoutError(f"{root / 'index.json'} lists a document without an id: {entry!r}.")
            document_id = entry["id"]
            if document_id in seen:
                raise CorpusLayoutError(f"{root / 'index.json'} lists {document_id} twice.")
            seen.add(document_id)
            directory = root / document_id
            if not directory.is_dir():
                raise CorpusLayoutError(f"{root / 'index.json'} lists {document_id}, and {directory} does not exist.")
            documents.append(Document(id=document_id, source=str(entry.get("source", "")), root=directory))
        return tuple(documents)

    documents = listed(index["documents"])
    if not documents:
        raise CorpusLayoutError(f"{root / 'index.json'} lists no documents, so no check would run.")
    return Corpus(
        root=root,
        seed=index.get("seed"),
        sample=index.get("sample"),
        documents=documents,
        unsampled=listed(index.get("unsampled", [])),
    )


def load_controls(directory: Path = CONTROLS_DIR):
    """Each retained control under ``proof/controls/``, read as a document of kind ``control``."""
    if not directory.is_dir():
        return ()
    return tuple(
        Document(id=child.name, source="control", root=child, kind="control")
        for child in sorted(directory.iterdir())
        if child.is_dir()
    )


def corpus_root() -> Path:
    """Where the corpus the checks read is: ``PROOF_CORPUS``, or the one emitted into the output directory.

    With ``PROOF_CORPUS`` unset, the corpus is emitted once into
    ``$PROOF_OUT/corpus`` by Nova's corpus CLI (``proof/corpus/emit.ts``),
    with ``PROOF_CORPUS_SAMPLE`` and ``PROOF_CORPUS_SEED`` passed through, and
    reused while its ``index.json`` exists.
    """
    named = os.environ.get("PROOF_CORPUS")
    if named:
        return Path(named)
    out = os.environ.get("PROOF_OUT")
    if not out:
        raise CorpusLayoutError(
            "The checks read the corpus from PROOF_CORPUS, or emit it into $PROOF_OUT/corpus; neither is set."
            " Run them through `npm run proof`, which sets PROOF_OUT."
        )
    root = Path(out) / "corpus"
    if not (root / "index.json").exists():
        emit_corpus(root)
    return root


# The whole corpus takes under a minute on four cores; this bounds a CLI that never finishes.
EMIT_TIMEOUT_SECONDS = 900


def emit_corpus(root: Path):
    """Emit the corpus with Nova's corpus CLI, inside the lane (Linux node_modules at the worktree).

    The entropy preload (``proof/corpus/entropy.mts``) loads first, so every
    export is seeded and the corpus is the one CI emits for the same seed.

    The CLI starts worker processes and Vitest, each with its own children
    (the esbuild service every ``tsx`` starts), so it runs through
    ``proof.processes.run``: whatever it started is stopped and reaped before
    this returns, however it ended. Its output goes to ``<root>.log``.
    """
    root = Path(root)
    command = [
        "node",
        "--conditions=react-server",
        "--import",
        "./proof/corpus/entropy.mts",
        "--import",
        "tsx",
        "proof/corpus/emit.ts",
        "--out",
        str(root),
    ]
    for option, variable in (("--sample", "PROOF_CORPUS_SAMPLE"), ("--seed", "PROOF_CORPUS_SEED")):
        if os.environ.get(variable):
            command += [option, os.environ[variable]]
    root.parent.mkdir(parents=True, exist_ok=True)
    log = root.with_name(f"{root.name}.log")
    try:
        with log.open("wb") as output:
            status = processes.run(
                command, timeout=EMIT_TIMEOUT_SECONDS, cwd=WORKTREE, stdout=output, stderr=subprocess.STDOUT
            )
    except processes.TimedOut as error:
        raise CorpusLayoutError(f"{error} So the checks have no documents. Its output is in {log}.") from error
    if status != 0 or not (root / "index.json").exists():
        tail = log.read_text(encoding="utf-8", errors="replace")[-8000:]
        raise CorpusLayoutError(
            f"Emitting the corpus ({' '.join(command)}) failed with exit status {status}, so the checks have no"
            f" documents. Its output ({log}) ends:\n{tail}"
        )
