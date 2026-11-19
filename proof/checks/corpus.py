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
  each a body and a JSON sidecar naming its content type: the first publish
  and ``republish`` (the next publish of D). A sidecar's ``lookups`` names the
  lookup workbook Nova's push sent before that import, and its ``media`` the
  media upload Nova sent after it (``lib/deployment/service.ts::uploadMediaBytes``),
  each a body with its own sidecar in the same directory. The first publish
  is in one of two layouts, which the create's sidecar marks (``_captured``,
  ``Export``): with ``"layout": 2`` it is two imports, ``create`` (the empty
  shell, which names neither workbook nor media) and ``content`` (the update
  that fills it, which names both); without the key it is the legacy layout,
  one ``create`` whose body is state A's whole app, which controls retained
  before the two imports keep. ``Export.content`` is the import whose body is
  state A's app in either layout;
- ``local.ccz`` and ``local-again.ccz``: two local exports of D, compiled for
  a project space without ``USH_EMPTY_CASE_LIST_TEXT``; and, where a
  configuration the document runs under holds that flag,
  ``local-empty-list-text.ccz``, the same export of D compiled for a project
  space that holds it, whose short details carry the empty-list text as
  HQ's build there does. Each configuration's local archive is the one
  compiled for its flags (``Document.local_ccz_for``), and a control retained
  before the archives were compiled per configuration holds ``local.ccz``
  alone, which is then every configuration's;
- ``local-refused.json``, in place of the local archives, where the project
  space's app keeps a custom base URL that sends phones elsewhere than the
  server, for which Nova's download makes no ``.ccz``: the download's refusal
  (``{reason: "workers-sent-elsewhere", host, server}``,
  ``Document.local_refusal``), which the bar holds to A
  (``proof.checks.bar.local_outcome``);
- ``import-file.zip``: the HQ import file for D, as Nova's
  ``/api/compile/json`` builds it (``Document.import_file``);
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
- ``authored/``, on a document made in CommCare HQ (source ``hq-authored:<base>``,
  ``Document.hq_authored``): the app HQ's own pages and models made
  (``app.json``, ``Application.to_json()`` with each form's source under
  ``_attachments``), the case seed made from that app (``seed.json``) and,
  where the base holds them, ``media.json`` with the files it names under
  ``media/``, ``tables.json``, ``places.json`` and ``practice-workers.json``
  (``Document.authored``). Such a
  document has no first publish: each ``export/<configuration>/`` holds the
  republish of D over that app, and nothing in place of ``create`` and
  ``content``. It is exported under one configuration, and its
  ``first-publish.json`` (``{"changes": [{"id", "places"}]}``) lists the
  first-publish register's entries Nova's reading says its first publish
  makes, each with the places it stands at on this app
  (``proof.checks.changes``);
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
tags, the case database and, where retained, case-property types and the
platforms D and D' declare, ``DERIVED``), so a control reads the same
whatever shape Nova's document later takes.

Nothing here runs HQ or Core; it reads files and refuses a layout it cannot
read, naming the file and what it lacks. The one HQ reach is a
configuration's privileges, which it reads from
``proof.checks.configurations`` only in a process that booted HQ.
"""

from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

from proof import processes
from proof.checks.configurations import TWO_IMPORTS
from proof.checks.eligibility import hq_authored, migration_witness

PROOF_DIR = Path(__file__).resolve().parents[1]
CONTROLS_DIR = PROOF_DIR / "controls"
WORKTREE = PROOF_DIR.parent

CONFIGURATION_KEYS = frozenset(
    {"flags", "namedPrivileges", "commcareVersion", "commtrack", "syncCasesOnFormEntry", "caseSearchEnabled"}
)
BASE_CONFIGURATIONS = ("minimum", "maximum")
# The flag a local archive's bytes depend on, and the archive compiled for a project space that holds it
# (proof/corpus/inputs.ts::EMPTY_LIST_TEXT_FLAG, ::EMPTY_LIST_TEXT_ARCHIVE).
EMPTY_LIST_TEXT_FLAG = "USH_EMPTY_CASE_LIST_TEXT"
EMPTY_LIST_TEXT_ARCHIVE = "local-empty-list-text.ccz"
# What a document states in place of a local archive Nova's download refuses for its project space
# (proof/corpus/inputs.ts::LOCAL_REFUSED): ``{reason, host, server}``.
LOCAL_REFUSED = "local-refused.json"
# The one reason a published project space has no local archive (lib/deployment/runtimeTarget.ts::CczUnavailable).
WORKERS_SENT_ELSEWHERE = "workers-sent-elsewhere"
# The platforms an app declares it runs on (``appSettings.runsOnlyOn``, absent for both; proof/CLAUDE.md, "A reader
# reads an app on the platforms it declares").
WEB_APPS = "web-apps"
ANDROID = "android"
PLATFORMS = (WEB_APPS, ANDROID)
BOTH = frozenset(PLATFORMS)


class CorpusLayoutError(ValueError):
    """A corpus or control directory is not in the layout the checks read."""


def _local_refusal(directory: Path):
    """The refusal ``directory`` states in place of its local archive (``LOCAL_REFUSED``), or None where it states
    none. A statement is ``{reason, host, server}``, its reason the download's one (``WORKERS_SENT_ELSEWHERE``);
    anything else is refused by name."""
    path = directory / LOCAL_REFUSED
    if not path.exists():
        return None
    stated = _read_json(path)
    if (
        not isinstance(stated, dict)
        or set(stated) != {"reason", "host", "server"}
        or stated.get("reason") != WORKERS_SENT_ELSEWHERE
        or not all(isinstance(stated[key], str) and stated[key] for key in ("host", "server"))
    ):
        raise CorpusLayoutError(
            f"{path} states a refusal of the local archive as {stated!r}; the entry writer writes"
            f' {{"reason": "{WORKERS_SENT_ELSEWHERE}", "host", "server"}} (proof/corpus/entryWriter.ts).'
        )
    return stated


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
    verdict): ``minimumConfiguration``'s ``flags``, ``case search`` when
    it needs case search on, ``sync cases on form entry off`` when its
    ``syncCasesOnFormEntry`` is ``false`` (Nova's publish requires the
    setting off) and the configuration has it on, and ``CommCare Supply off``
    when its ``commtrackEnabled`` is ``false`` and the configuration has it
    on, and ``<flag> off`` for each flag its ``flagsOff`` names that the
    configuration holds; a verdict without one of those keys requires
    nothing of it.
    """
    return verdict_lacks(_read_json(verdict_path), configuration, verdict_path)


def verdict_lacks(verdict, configuration, where):
    """``lacking`` over a verdict already read (``where`` names it in a refusal), so every reader of a verdict,
    ``proof.checks.sensitivity.accepts`` among them, reads and refuses it alike."""
    minimum = verdict.get("minimumConfiguration") if isinstance(verdict, dict) else None
    if (
        not isinstance(minimum, dict)
        or not isinstance(minimum.get("flags"), list)
        or not isinstance(minimum.get("caseSearchEnabled"), bool)
    ):
        raise CorpusLayoutError(
            f"{where} holds no minimumConfiguration with its flags and caseSearchEnabled, so it does not say"
            " whether Nova's publish would send there (decision 19)."
        )
    sync = minimum.get("syncCasesOnFormEntry", None)
    if "syncCasesOnFormEntry" in minimum and sync is not False:
        raise CorpusLayoutError(
            f"{where} holds syncCasesOnFormEntry {sync!r}; a verdict requires the setting off (false) or says"
            " nothing of it."
        )
    commtrack = minimum.get("commtrackEnabled", None)
    if "commtrackEnabled" in minimum and commtrack is not False:
        raise CorpusLayoutError(
            f"{where} holds commtrackEnabled {commtrack!r}; a verdict requires CommCare Supply off (false) or says"
            " nothing of it."
        )
    off = minimum.get("flagsOff", [])
    if (
        not isinstance(off, list)
        or not all(isinstance(flag, str) for flag in off)
        or ("flagsOff" in minimum and not off)
    ):
        raise CorpusLayoutError(
            f"{where} holds flagsOff {off!r}; a verdict lists the flags it requires off, or says nothing."
        )
    missing = sorted(set(minimum["flags"]) - set(configuration.flags))
    if minimum["caseSearchEnabled"] and not configuration.case_search_enabled:
        missing.append("case search")
    if sync is False and configuration.sync_cases_on_form_entry:
        missing.append("sync cases on form entry off")
    if commtrack is False and configuration.commtrack:
        missing.append("CommCare Supply off")
    missing.extend(f"{flag} off" for flag in sorted(set(off) & set(configuration.flags)))
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
    def assumed_source(self):
        """The fields of HQ's app source the capture assumed HQ serves for the app an update is sent over, each by
        its path in the source (``build_spec.version``), as ``proof/observe/publish.py::update`` holds them.

        A sidecar of the two-import layout names them as ``assumedSource``; a legacy one names the profile alone as
        ``assumedSourceProfile``, which is that one field.
        """
        if "assumedSource" in self.meta:
            assumed = self.meta["assumedSource"]
            if not isinstance(assumed, dict) or not assumed:
                raise CorpusLayoutError(
                    f"{self.body_path.with_suffix('.json')} names its assumedSource as {assumed!r}, which is not an"
                    " object naming each field of HQ's source by its path."
                )
            return assumed
        if "assumedSourceProfile" in self.meta:
            return {"profile": self.meta["assumedSourceProfile"]}
        raise CorpusLayoutError(
            f"{self.body_path.with_suffix('.json')} is an update's capture and names neither assumedSource nor"
            " assumedSourceProfile, the source it was built over."
        )

    @property
    def save_counter(self):
        """The capture peer's save counter around this import, ``(before, after)``, ``before`` None for a create
        (the sidecar's ``saveCounter``, ``proof/corpus/publish.ts::SaveCounterMove``), or None where the sidecar
        names none: a capture made before the peer's counter was recorded."""
        return self._counter_move("saveCounter")

    @property
    def media_save_counter(self):
        """The capture peer's save counter around the media upload sent after this import, as ``save_counter``
        reads it (the sidecar's ``mediaSaveCounter``), or None where it names none."""
        return self._counter_move("mediaSaveCounter")

    def _counter_move(self, key):
        move = self.meta.get(key)
        if move is None:
            return None
        before = move.get("before") if isinstance(move, dict) else None
        after = move.get("after") if isinstance(move, dict) else None

        def counter(value):
            return isinstance(value, int) and not isinstance(value, bool) and value > 0

        if not (isinstance(move, dict) and set(move) == {"before", "after"} and counter(after)) or not (
            before is None or counter(before)
        ):
            raise CorpusLayoutError(
                f"{self.body_path.with_suffix('.json')} names its {key} as {move!r}; it is"
                ' {"before": <counter> or null, "after": <counter>}, each counter a whole number from 1.'
            )
        return before, after

    @property
    def brought_in(self):
        """What the publish read and took of the changes a person made in HQ before it was sent, or None where it
        was sent with no review of them (``proof/corpus/publish.ts::BringInRecord``, the sidecar's ``broughtIn``):
        ``BroughtIn``."""
        record = self.meta.get("broughtIn")
        if record is None:
            return None
        return BroughtIn.from_json(record, self.body_path.with_suffix(".json"))


# The keys of a bring-in's record (``proof/corpus/publish.ts::BringInRecord``), and the one it holds where the review
# read CommCare HQ's app now: that reading, which the HQ side holds HQ's own answer after the same saves to.
BROUGHT_IN_KEYS = frozenset(
    {"review", "taken", "discarded", "mutations", "identities", "again", "assumedSummary", "document"}
)
BROUGHT_IN_READING = "reading"


@dataclass(frozen=True)
class BroughtIn:
    """What Nova's publish over a person's saves in HQ read and took of them before it was sent: the review
    (``review``, Nova's ``HqChangesReview``), whether the bring-in committed the change or recorded what HQ holds
    (``taken``: ``brought-in`` or ``recorded``), whether it removed changes made in Nova, the batch's length, the
    ids HQ holds for each menu and form the record keeps, the review over the record (``again``), the summary of the
    app the review read, which the capture's peer modeled (``assumed_summary``), the document the app holds after
    it, and the review's reading of CommCare HQ's app now (``reading``: ``{doc, identity}``, the document and one
    identity row a menu and a form of it, or None where the record holds none)."""

    review: dict
    taken: str
    discarded: bool
    mutations: int
    identities: list
    again: dict
    assumed_summary: list
    document: dict
    reading: dict | None = None

    @classmethod
    def from_json(cls, value, where):
        if not isinstance(value, dict) or set(value) - {BROUGHT_IN_READING} != BROUGHT_IN_KEYS:
            raise CorpusLayoutError(
                f"{where} names its broughtIn as {sorted(value) if isinstance(value, dict) else value!r}; a"
                f" bring-in's record holds exactly {sorted(BROUGHT_IN_KEYS)}, and {BROUGHT_IN_READING} where the"
                " review read CommCare HQ's app."
            )
        if value["taken"] not in ("brought-in", "recorded"):
            raise CorpusLayoutError(f"{where} records a bring-in that took {value['taken']!r}.")
        for key in ("review", "again", "document"):
            if not isinstance(value[key], dict) or not isinstance(value[key].get("kind", ""), str):
                raise CorpusLayoutError(f"{where} records the bring-in's {key} as {value[key]!r}.")
        reading = value.get(BROUGHT_IN_READING)
        if reading is not None and (
            not isinstance(reading, dict)
            or not isinstance(reading.get("doc"), dict)
            or not isinstance(reading.get("identity"), list)
            or set(reading) != {"doc", "identity"}
        ):
            raise CorpusLayoutError(
                f"{where} records the review's reading as {reading!r}; it is {{doc, identity}}, the document the"
                " review read of CommCare HQ's app and one identity row a menu and a form of it."
            )
        return cls(
            review=value["review"],
            taken=value["taken"],
            discarded=value["discarded"],
            mutations=value["mutations"],
            identities=value["identities"],
            again=value["again"],
            assumed_summary=value["assumedSummary"],
            document=value["document"],
            reading=reading,
        )

    @property
    def review_kind(self):
        return self.review["kind"]

    @property
    def review_reason(self):
        """The review's reason where it found nothing to bring in (``unchanged``, ``reads-the-same``,
        ``already-here``), else None."""
        return self.review.get("reason")

    @property
    def publish_changes(self):
        """The sentences of what the next publish changes in HQ that the review listed."""
        return list(self.review.get("publishChanges") or [])


# What an import's sidecar may name beside it: the request each key names, as its message calls it.
_BESIDE = (("lookups", "the lookup workbook"), ("media", "the media upload"))


def republish_stop(directory: Path) -> str | None:
    """The failure code of the republish Nova stopped before it sent anything in this export directory, or None:
    ``outcome.json`` records the stop (``{"republish": {"status": "stopped", "code": ...}}``), and the capture then
    writes no republish request."""
    outcome = directory / "outcome.json"
    if not outcome.exists():
        return None
    republish = _read_json(outcome).get("republish")
    if not isinstance(republish, dict) or republish.get("status") != "stopped":
        return None
    code = republish.get("code")
    if not isinstance(code, str):
        raise CorpusLayoutError(f"{outcome} records a stopped republish with no failure code.")
    return code


def _captured(directory: Path, name: str):
    """The captured request ``<name>`` in ``directory``. Its sidecar's layout marker is read here: no key is the
    legacy layout, ``"layout": 2`` the two-import layout, and any other value is refused by name."""
    sidecar = directory / f"{name}.json"
    if not sidecar.exists():
        raise CorpusLayoutError(f"{directory} has no {name}.json, the captured {name} request.")
    meta = _read_json(sidecar)
    if not isinstance(meta, dict) or not isinstance(meta.get("contentType"), str):
        raise CorpusLayoutError(f"{sidecar} names no contentType for its body.")
    if "layout" in meta and meta["layout"] != TWO_IMPORTS:
        raise CorpusLayoutError(
            f'{sidecar} is marked "layout": {json.dumps(meta["layout"])}, which the checks do not read. A sidecar'
            f" is marked {TWO_IMPORTS} (a first publish captured as the shell's create and its content) or carries no"
            " layout (the legacy layout, a first publish that is one create)."
        )
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
    """What Nova's publish sends under one configuration.

    ``create`` is the import a first publish sends first, and ``content`` the import whose body is the app state A
    holds, which names the workbook pushed before it and the media sent after it. In the two-import layout the two
    are the shell's create and the update that fills it; in the legacy layout ``content`` is ``create`` itself. A
    reader of state A's app, workbook or media reads ``content``; the few that must know whether a first publish is
    two imports ask ``two_imports``, the create's marker, never whether the two captures are one object.
    """

    configuration: Configuration
    directory: Path
    create: Captured | None
    republish: Captured | None
    update: Captured | None
    content: Captured | None = None
    # The failure code of a republish Nova stopped before it sent anything (``outcome.json``'s ``stopped``), which
    # then has no captured request: ``republish`` is None.
    republish_stopped: str | None = None

    @property
    def two_imports(self):
        """Whether the first publish is two imports: the create's sidecar is marked ``"layout": 2``."""
        return self.create is not None and self.create.meta.get("layout") == TWO_IMPORTS

    @property
    def brought_in(self):
        """What the republish read and took of a person's saves in HQ before it was sent (``Captured.brought_in``),
        or None: a republish sent with no review of them, or one Nova stopped."""
        return None if self.republish is None else self.republish.brought_in


def _first_publish(directory: Path):
    """The first publish in ``directory``: ``(create, content)``. A create marked with the two-import layout is
    followed by ``content.json``, refused by name where the directory lacks it; a legacy create is its own content."""
    create = _captured(directory, "create")
    if create.meta.get("layout") != TWO_IMPORTS:
        return create, create
    if not (directory / "content.json").exists():
        raise CorpusLayoutError(
            f'{directory / "create.json"} is marked "layout": {TWO_IMPORTS}, a first publish captured as two imports,'
            f" and {directory} has no content.json, the import that fills the shell."
        )
    return create, _captured(directory, "content")


# What a control retains of D and D' in place of their ``document.json`` (``proof.checks.controls.derived``): each
# key a check reads, by the document it was derived from.
DERIVED = "derived.json"
DERIVED_KEYS = frozenset({"wire", "intent", "lookupTags", "caseDatabase"})
# Controls retained before a check read this metadata keep their original bytes and answer None for it.
OPTIONAL_DERIVED_KEYS = frozenset({"caseTypes", "platforms"})


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

    @property
    def local_refusal(self):
        """The refusal D' states in place of its local archive (``edit/local-refused.json``), or None."""
        return _local_refusal(self.root)


# The directory of a document made in CommCare HQ that holds what HQ made (``Document.authored``).
AUTHORED = "authored"
FIRST_PUBLISH = "first-publish.json"


@dataclass(frozen=True)
class Authored:
    """What a document made in CommCare HQ holds in place of a first publish: the app HQ's own pages and models made,
    and, where the base holds them, its media rows (``media.json``, each ``{path, file, mediaClass, kind, mimeType,
    extension}``, ``file`` under ``authored/``; ``proof/matrix/retain.py`` writes it only for a base that maps media),
    its lookup tables, its places and its practice workers, each the file's path or None."""

    root: Path
    app: Path
    media: Path | None
    tables: Path | None
    places: Path | None
    seed: Path | None
    practice_workers: Path | None = None

    def app_json(self):
        return _read_json(self.app)

    def media_rows(self):
        """The media rows, none where the base maps no media."""
        if self.media is None:
            return []
        rows = _read_json(self.media)
        if not isinstance(rows, list) or not all(
            isinstance(row, dict) and isinstance(row.get("path"), str) and isinstance(row.get("file"), str)
            for row in rows
        ):
            raise CorpusLayoutError(f"{self.media} lists one {{path, file, ...}} a mapped file of the app HQ made.")
        return rows

    def media_file(self, row) -> Path:
        """The retained file of one media row (its ``file``, relative to ``authored/``)."""
        path = self.root / row["file"]
        if not path.is_file():
            raise CorpusLayoutError(f"{self.media} names {row['file']} for {row['path']}, which {self.root} lacks.")
        return path


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

    @property
    def migration_witness(self):
        """Whether the document is a migration witness: a targeted document whose A is the retained export of the app
        from before a migration (``proof/migrations/<id>/``) and whose B is Nova's republish of the migrated document
        over it."""
        return migration_witness(self.source)

    @property
    def hq_authored(self):
        """Whether the document's A is an app CommCare HQ's own pages and models made (source ``hq-authored:<base>``),
        which Nova never sent: it holds ``authored/`` and no first publish."""
        return hq_authored(self.source)

    @cached_property
    def authored(self) -> Authored | None:
        """What stands where a first publish stood on a document made in HQ (``authored/``), or None on any other
        document. Refuses a document made in HQ that lacks ``authored/app.json``."""
        root = self.root / AUTHORED
        if not self.hq_authored:
            return None
        if not (root / "app.json").is_file():
            raise CorpusLayoutError(
                f"{self.root} is a document made in CommCare HQ ({self.source}) and holds no {AUTHORED}/app.json,"
                " which the entry writer copies from proof/hq-apps/<base>/; emit the corpus again."
            )

        def held(name):
            path = root / name
            return path if path.is_file() else None

        return Authored(
            root=root,
            app=root / "app.json",
            media=held("media.json"),
            tables=held("tables.json"),
            places=held("places.json"),
            seed=held("seed.json"),
            practice_workers=held("practice-workers.json"),
        )

    @cached_property
    def case_seed(self):
        """The case seed made from A (``authored/seed.json``, ``proof/matrix/seed.py``), or None: a document made in
        HQ takes its case database from it and never from D."""
        authored = self.authored
        if authored is None:
            return None
        if authored.seed is None:
            raise CorpusLayoutError(
                f"{self.root} is a document made in CommCare HQ and holds no {AUTHORED}/seed.json, the case seed made"
                " from A that its case database is made from."
            )
        return _read_json(authored.seed)

    @cached_property
    def first_publish_places(self) -> tuple[tuple[str, tuple[str, ...]], ...]:
        """The first-publish register's changes Nova's reading says this document's first publish makes, each with
        the places it stands at (``first-publish.json``, ``{"changes": [{"id", "places"}]}``), in the file's order;
        empty for any document not made in HQ, on which no entry is ever read."""
        if not self.hq_authored:
            return ()
        path = self.root / FIRST_PUBLISH
        value = _read_json(path)
        changes = value.get("changes") if isinstance(value, dict) and set(value) == {"changes"} else None
        shape = (
            f'{path} holds {{"changes": [{{"id", "places"}}]}}: each change a first-publish register id once, with'
            " the places it stands at, a list of JSON Pointers (proof/corpus/entryWriter.ts writes it)."
        )
        if not isinstance(changes, list):
            raise CorpusLayoutError(shape)
        found, seen = [], set()
        for change in changes:
            if not isinstance(change, dict) or set(change) != {"id", "places"}:
                raise CorpusLayoutError(shape)
            change_id, places = change["id"], change["places"]
            if not isinstance(change_id, str) or change_id in seen:
                raise CorpusLayoutError(shape)
            if not isinstance(places, list) or not all(isinstance(place, str) for place in places):
                raise CorpusLayoutError(shape)
            seen.add(change_id)
            found.append((change_id, tuple(places)))
        return tuple(found)

    @property
    def first_publish(self) -> tuple[str, ...]:
        """The ids of ``first_publish_places``, in its order; empty for any document not made in HQ."""
        return tuple(change_id for change_id, _ in self.first_publish_places)

    @property
    def hq_authored_facts(self) -> dict | None:
        """What Nova's reading of the base gave beside D (``document.json``'s ``hqAuthored``: the identity rows,
        the media paths, the declaration and the first-publish ids), or None on any other document."""
        if not self.hq_authored:
            return None
        facts = self.document.get("hqAuthored") if isinstance(self.document, dict) else None
        if not isinstance(facts, dict) or not isinstance(facts.get("declaration"), dict):
            raise CorpusLayoutError(
                f"{self.document_path} is a document made in CommCare HQ and holds no hqAuthored with its"
                " declaration, which Nova's reading of the base gave (proof/corpus/hqAuthored.ts)."
            )
        return facts

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
        ``caseSearchEnabled``, ``syncCasesOnFormEntry: false`` where it
        requires sync cases on form entry off, ``commtrackEnabled: false``
        where it requires CommCare Supply off, and ``flagsOff`` naming the
        flags it requires off (``lacking``).
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
        authored = self.authored is not None
        for child in sorted(p for p in directory.iterdir() if p.is_dir()):
            # A document made in HQ has no first publish: its A is the app HQ made (``authored/``).
            create, content = (None, None) if authored else _first_publish(child)
            stopped = republish_stop(child)
            found[child.name] = Export(
                configuration=self._configuration(child.name, child, self.root / "verdict.json"),
                directory=child,
                create=create,
                republish=None if stopped is not None else _captured(child, "republish"),
                update=None,
                content=content,
                republish_stopped=stopped,
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
            if (
                name not in ("D", "D'")
                or not isinstance(held, dict)
                or not DERIVED_KEYS <= set(held) <= DERIVED_KEYS | OPTIONAL_DERIVED_KEYS
            ):
                raise CorpusLayoutError(
                    f"{path}: {name} holds {sorted(DERIVED_KEYS)}, and optionally {sorted(OPTIONAL_DERIVED_KEYS)}."
                )
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
        return held.get(key) if key in OPTIONAL_DERIVED_KEYS else held[key]

    def platforms(self, *, edit=False) -> frozenset[str]:
        """The platforms D (or D', ``edit``) declares: its ``appSettings.runsOnlyOn``, or both where it names
        none; on a control, what its ``derived.json`` retains, or both for a control retained before a document
        declared any, which was published as an app every platform runs."""
        if self.kind == "control":
            held = self.derived("platforms", edit=edit)
            if held is None:
                return BOTH
            if not isinstance(held, list) or not held or not all(item in PLATFORMS for item in held):
                which = "D'" if edit else "D"
                raise CorpusLayoutError(
                    f"{self.root / DERIVED} holds {which}'s platforms as {held!r}; a control retains a non-empty list"
                    ' of "web-apps" and "android".'
                )
            return frozenset(held)
        document = self.edit_document if edit else self.document
        path = self.edit.document_path if edit else self.document_path
        doc = document.get("doc") if isinstance(document, dict) else None
        settings = doc.get("appSettings") if isinstance(doc, dict) else None
        value = settings.get("runsOnlyOn") if isinstance(settings, dict) else None
        if value is None:
            return BOTH
        if value not in PLATFORMS:
            raise CorpusLayoutError(
                f"{path} declares the app's platforms as {value!r}; Nova stores appSettings.runsOnlyOn as"
                ' "web-apps", "android" or nothing, for both.'
            )
        return frozenset({value})

    def case_types(self, *, edit=False):
        """Each effective case property's type from the emitted catalog, by case type and property name, or
        None for a control retained before this metadata. Python infers no type; an unknown one stays None."""
        if self.kind == "control":
            return self.derived("caseTypes", edit=edit)
        document = self.edit_document if edit else self.document
        return {
            case_type["name"]: {prop["name"]: prop.get("data_type") for prop in case_type.get("properties") or []}
            for case_type in document["catalog"]
        }

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

    @property
    def local_refusal(self):
        """The refusal D states in place of its local archive (``local-refused.json``: Nova's download makes no
        ``.ccz`` for a project space whose app keeps a custom base URL elsewhere, ``workers-sent-elsewhere``), or
        None. ``proof.checks.bar.local_outcome`` holds it to A."""
        return _local_refusal(self.root)

    @property
    def local_empty_list_text_ccz(self):
        """D's local archive compiled for a project space that holds ``EMPTY_LIST_TEXT_FLAG``, or None."""
        path = self.root / EMPTY_LIST_TEXT_ARCHIVE
        return path if path.exists() else None

    def local_ccz_for(self, configuration):
        """The local archive of D compiled for the project space the configuration ``configuration`` names: the
        one compiled with ``EMPTY_LIST_TEXT_FLAG`` where the configuration holds it and the document carries that
        archive, ``local.ccz`` otherwise (a control retained before the archives were compiled per configuration
        holds ``local.ccz`` alone)."""
        flagged = self.local_empty_list_text_ccz
        if flagged is not None and EMPTY_LIST_TEXT_FLAG in self.configurations[configuration].flags:
            return flagged
        return self.local_ccz

    @property
    def local_archives(self):
        """Each local archive the document carries, by its name in the document."""
        found = {
            "local.ccz": self.local_ccz,
            "local-again.ccz": self.local_again_ccz,
            EMPTY_LIST_TEXT_ARCHIVE: self.local_empty_list_text_ccz,
            "edit/local.ccz": self.edit.local_ccz if self.edit is not None else None,
        }
        return {name: path for name, path in found.items() if path is not None}

    @property
    def import_file(self):
        """The HQ import file for D (``import-file.zip``), or None where the document holds none (a control)."""
        path = self.root / "import-file.zip"
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

    @cached_property
    def brings_in(self):
        """The document Nova's bring-in of a person's saves in HQ gives, where ``hq-side.json`` states the republish
        brings them in (``republish`` ``brings-in``, with ``bringsIn``), else None. Every export's republish was sent
        as the statement says (``republished_as_stated``)."""
        saves = self.hq_side
        if saves is None or saves.get("republish") != "brings-in":
            return None
        self.republished_as_stated()
        return saves["bringsIn"]

    @cached_property
    def next_publish(self):
        """The changes Nova's next publish makes in HQ that its review of a person's saves lists, by their ids
        (``hq-side.json``'s ``publishChanges``), where the statement is that the republish brings the saves in, else
        none, and none on a control. The capture held the list to the review's own
        (``proof/corpus/publish.ts::bringInOverPeer``), and every export's republish was sent after a review that
        listed as many (``republished_as_stated``)."""
        saves = self.hq_side
        if self.kind == "control" or saves is None or saves.get("republish") != "brings-in":
            return ()
        self.republished_as_stated()
        return tuple(saves["publishChanges"])

    def republished_as_stated(self):
        """Holds every export's republish to what ``hq-side.json`` states of it, as its sidecar records it
        (``Export.brought_in``, the capture's ``broughtIn``): ``proceeds`` was sent with no review of the saves;
        ``records`` was sent after a review that found nothing to bring in, for the stated ``reason`` and with
        as many changes of the next publish as the statement names, which recorded what HQ holds; ``brings-in`` was
        sent after a bring-in that took exactly the ``bringsIn`` document, whose review listed as many changes of
        the next publish as ``publishChanges`` names. The capture refuses any other outcome, so a
        layout that says otherwise is refused here by name (``CorpusLayoutError``); a document with no saves, or one
        whose republish discards or stops, has nothing to hold."""
        saves = self.hq_side
        statement = None if saves is None else saves.get("republish")
        if statement not in ("proceeds", "records", "brings-in"):
            return
        where = self.root / "hq-side.json"
        for name, export in self.exports.items():
            if export.republish is None:
                raise CorpusLayoutError(
                    f"{export.directory} holds no republish of {self.id}, and {where} states that it"
                    f" {statement} ({name})."
                )
            record = export.brought_in
            if statement == "proceeds":
                if record is not None:
                    raise CorpusLayoutError(
                        f"{export.directory} holds a republish of {self.id} sent after a review of the saves ({name}),"
                        f" and {where} states that it goes through with no stop."
                    )
                continue
            if statement == "records":
                stated = saves.get("recorded")
                if (
                    record is None
                    or record.taken != "recorded"
                    or not isinstance(stated, dict)
                    or record.review_kind != "nothing"
                    or record.review_reason != stated.get("reason")
                    or len(record.publish_changes) != len(stated.get("publishChanges") or [])
                ):
                    raise CorpusLayoutError(
                        f"{export.directory} holds a republish of {self.id} that was not sent after the record of a"
                        f" review that found nothing to bring in, as {where} states ({name}, recorded {stated!r})."
                    )
                continue
            stated = saves.get("bringsIn")
            if not isinstance(stated, dict):
                raise CorpusLayoutError(f"{where} states that the republish brings in, and names no bringsIn document.")
            listed = saves.get("publishChanges")
            if not isinstance(listed, list) or not all(isinstance(change, str) and change for change in listed):
                raise CorpusLayoutError(
                    f"{where} states that the republish brings in, and names the changes its review lists for the"
                    f" next publish as {listed!r}, where it is a list of change ids (publishChanges)."
                )
            if record is not None and len(record.publish_changes) != len(listed):
                raise CorpusLayoutError(
                    f"{export.directory} holds a republish of {self.id} sent after a review that listed"
                    f" {record.publish_changes!r} for the next publish, and {where} states {listed!r} ({name})."
                )
            if record is None or record.taken != "brought-in" or record.document != stated:
                raise CorpusLayoutError(
                    f"{export.directory} holds a republish of {self.id} that was not sent after a bring-in of the"
                    f" document {where} states ({name}); the capture records the bring-in beside the republish"
                    " (broughtIn)."
                )

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
    reused while its ``index.json`` exists. Two workers running groups of one
    block share its ``PROOF_OUT``, so the emission holds a lock beside the
    root: the second waits for the first's corpus and reads it.
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
        root.parent.mkdir(parents=True, exist_ok=True)
        with open(root.with_name(f"{root.name}.lock"), "wb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
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
