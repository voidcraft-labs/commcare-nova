"""What HQ and Core made of one document, read from its records as each check judges it.

The observation (``proof.observe.unit.observe_document``) makes a document's
records once, one unit per configuration, and ``records_for`` keeps them for
the document's checks, which run together (``sharding.order_by_group``):
they are dropped when another document's are asked for. Each check reads the
records through a view:

- ``republish_view(records, name)``: A (Nova's first publish of D applied through
  HQ's import, built with no previous build), B (Nova's next publish of D
  applied over A, built with saved(build(A)) as the previous build), and B
  aligned to A built the same way (``proof.observe.alignment``), with HQ's
  refusals, and each lookup workbook upload and each media upload by the
  state its publish made;
- ``edit_view(records, name)``: the same A, and B-edit (Nova's publish of D′ over
  A), read from B's record where B-edit's inputs are B's;
- ``sensitivity_view(records, name)``: A's plain build and each flipped build;
- ``sessions_record(records, name)``: proof 3's sessions, over B's state (A's
  where HQ refused B), from the ``b_aligned`` record;
- ``local_reports(records)``: Core's admission of each local archive;
- ``soft_assertion_differences(records, check)``: every soft assertion HQ
  noted inside an operation whose check is ``check`` (``operation_check``),
  as that check's difference, so the register classifies it. HQ notes them
  and goes on, as production does (``proof.hq.boot``), so each is evidence.

Nothing here imports HQ: the observation is imported where records are made.
``observe_republish``, ``observe_edit``, ``_create`` and ``_update`` give the
same views (and the publish steps) to the checks whose judges still read
them by those names.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from proof.checks.differences import Difference, pointer_token
from proof.observe.alignment import Alignment
from proof.observe.outcome import BuildOutcome, outcome_from_record


@dataclass
class Refusal:
    """HQ refused one of Nova's uploads: what it was and what HQ answered."""

    state: str
    status: int | None
    response: object


@dataclass
class AppState:
    """One app state HQ holds (A, B or B-edit), with its build and identities."""

    name: str
    app_id: str
    doc: dict
    identities: dict
    build: BuildOutcome


@dataclass
class Republish:
    document: str
    configuration: str
    a: AppState | None = None
    b: AppState | None = None
    b_aligned: BuildOutcome | None = None
    alignment: Alignment | None = None
    refusals: list = field(default_factory=list)
    # HQ's result of each lookup workbook upload, by the state its publish made (before the import).
    lookup_uploads: dict = field(default_factory=dict)
    # What HQ's processing of each media upload reported, by the state its publish made (after the import;
    # ``proof.observe.publish.upload_media``).
    media_uploads: dict = field(default_factory=dict)


@dataclass
class EditPublish:
    document: str
    configuration: str
    a: AppState | None = None
    b: AppState | None = None
    refusals: list = field(default_factory=list)
    lookup_uploads: dict = field(default_factory=dict)
    media_uploads: dict = field(default_factory=dict)


@dataclass
class SensitivityView:
    """A's plain build, what it read, and each flip's build, from one configuration's ``a`` record."""

    configuration: str
    refusals: list = field(default_factory=list)
    plain: BuildOutcome | None = None
    flags_read: list = field(default_factory=list)
    settings_read: list = field(default_factory=list)
    # (sensitivity.Flip, the flipped build's BuildOutcome), in the order they were built.
    flips: list = field(default_factory=list)


# Views ------------------------------------------------------------------------------


def _state(record, name, blobs):
    held = record.get("state") if record else None
    if held is None:
        return None
    doc = blobs.get_json(held["doc"])
    return AppState(name, doc.get("_id"), doc, held["identities"], outcome_from_record(held["build"], blobs, name))


def _publish(record, key, name, refusals, uploads, media_uploads=None):
    published = (record or {}).get(key)
    if published is None:
        return
    if published["refused"] is not None:
        refusals.append(Refusal(name, published["refused"]["status"], published["refused"]["response"]))
    if published["lookups"] is not None:
        uploads[name] = published["lookups"]
    if media_uploads is not None and published.get("media") is not None:
        media_uploads[name] = published["media"]


def republish_view(records, name) -> Republish:
    """The republish's view of one configuration: A, B and B aligned to A."""
    held = records.configurations[name]
    view = Republish(records.document, name)
    _publish(held.a, "create", "A", view.refusals, view.lookup_uploads, view.media_uploads)
    view.a = _state(held.a, "A", records.blobs)
    _publish(held.b, "publish", "B", view.refusals, view.lookup_uploads, view.media_uploads)
    view.b = _state(held.b, "B", records.blobs)
    aligned = held.b_aligned or {}
    if aligned.get("aligned") is not None:
        view.b_aligned = outcome_from_record(aligned["aligned"], records.blobs, "B-aligned")
        alignment = aligned["alignment"]
        view.alignment = Alignment(
            tuple(tuple(entry) for entry in alignment["moduleIds"]),
            tuple(tuple(entry) for entry in alignment["formIds"]),
            tuple(tuple(entry) for entry in alignment["xmlns"]),
            tuple(alignment["unmatched"]),
        )
    return view


def edit_view(records, name) -> EditPublish:
    """The edit's view of one configuration: A, and D′'s publish over it (B-edit)."""
    held = records.configurations[name]
    b_edit = held.part("b_edit")
    view = EditPublish(records.document, name)
    _publish(held.a, "create", "A", view.refusals, view.lookup_uploads, view.media_uploads)
    view.a = _state(held.a, "A", records.blobs)
    _publish(b_edit, "publish", "B-edit", view.refusals, view.lookup_uploads, view.media_uploads)
    view.b = _state(b_edit, "B-edit", records.blobs)
    return view


def sensitivity_view(records, name) -> SensitivityView:
    """The sensitivity's view of one configuration."""
    from proof.observe.record import configuration_of
    from proof.observe.sensitivity import Flip

    held = records.configurations[name].a
    view = SensitivityView(name)
    _publish(held, "create", "A", view.refusals, {})
    state = (held or {}).get("state")
    if state is None:
        return view
    view.plain = outcome_from_record(state["build"], records.blobs, "A")
    view.flags_read = list(held["flagsReadByBuild"])
    view.settings_read = list(held["settingsReadByBuild"])
    for flip in held.get("flips", []):
        flipped = configuration_of(flip["configuration"])
        view.flips.append((Flip(flip["gate"], flipped, True), outcome_from_record(flip["build"], records.blobs, "A")))
    return view


def sessions_record(records, name):
    """The ``b_aligned`` record's proof 3 observation (``proof.observe.sessions``), or None."""
    held = records.configurations[name].b_aligned
    return (held or {}).get("sessions")


def local_reports(records) -> dict:
    """Core's admission report of each local archive the document carries, by its path in the document."""
    return dict((records.local or {}).get("admissions", {}))


# Soft assertions ---------------------------------------------------------------------

# Which check an operation's notes are held by, by its label: what the bar's
# publishes and builds noted, the sensitivity's flips, proof 2's aligned build
# and proof 3's restores and case processing; anything else is the bar's. An
# operation (or request) an observation hook ran is that hook's
# (``proof.observe.unit.HookUnit``): ``intent`` or ``proof4``. The manifest's
# hook runs with the local part, in no unit, and keeps what HQ noted in its
# own record (``proof.checks.manifest_usage.read_notes``).
OPERATION_CHECKS = {
    "create": "bar",
    "publish": "bar",
    "build": "bar",
    "save-build": "bar",
    "flip": "sensitivity",
    "build-aligned": "proof2",
    "restore-a": "proof3",
    "restore-b": "proof3",
    "restore-local": "proof3",
    "case-processing": "proof3",
    "restore-proof4": "proof4",
}
# Each part's state, as an artifact names it. Under ``same_as`` a B-edit's part is B's record, which holds
# exactly the operations B-edit's own observation runs (``proof.observe.unit._Unit.observe_b``).
STATES = (("a", "A"), ("b", "B"), ("b_aligned", "B"), ("b_edit", "B-edit"))


def operation_check(entry):
    """The check an operation's (or a hook's request's) notes are held by."""
    if "hook" in entry:
        return entry["hook"]
    return OPERATION_CHECKS.get(entry["label"].partition(":")[0], "bar")


def soft_assertion_differences(records, check):
    """Every soft assertion HQ noted inside an operation ``check`` holds, as that check's ``error`` difference.

    The artifact names the operation and the state it ran over
    (``soft_assert:<operation>@<state>``, and ``@<gate>`` after a flip's; a
    hook's request is ``request:<digest>``), and the path HQ's frame
    (``/<file>::<function>``); the note is the value.
    """
    found = []
    for name in sorted(records.configurations):
        held = records.configurations[name]
        for part, state in STATES:
            record = held.part(part) or {}
            entries = [*record.get("operations", []), *record.get("requests", [])]
            for entry in entries:
                if operation_check(entry) != check:
                    continue
                label = entry["label"] if "label" in entry else f"request:{entry['request'][:16]}"
                artifact = f"soft_assert:{label}@{state}"
                if "gate" in entry:
                    artifact = f"{artifact}@{entry['gate']}"
                for note in entry.get("softAssertions", []):
                    path = f"/{pointer_token(note['where'])}"
                    found.append(Difference(check, records.document, artifact, path, path, "error", None, note))
    return found


# Making the records ------------------------------------------------------------------

# The records of one document: the checks of a document run together
# (``sharding.order_by_group``), so a document's records are made once and
# dropped when the next document's are asked for.
_CACHE: dict = {}


def _owned(document):
    owner = (document.kind, document.id)
    if _CACHE.get("owner") != owner:
        _CACHE.clear()
        _CACHE["owner"] = owner


def _write_timings(document, found):
    out = os.environ.get("PROOF_OUT")
    if not out:
        return
    directory = Path(out, "observe")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{document.kind}-{document.id}.json").write_text(
        json.dumps(
            {"document": document.id, "observed": found.observed, "timings": found.timings},
            indent="\t",
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def records_for(document, core_runner, *, editor_driver=None, store=None):
    """The document's records (``proof.observe.record.DocumentRecords``), made once per document.

    Every caller passes the session's editor driver: whichever check of a
    document asks first makes the records every check of it reads, proof 4's
    saves in HQ's editors included (``proof.observe.proof4``). They are made
    through the evidence store the lane runs with
    (``proof.store.runtime.session_store``) unless ``store`` names another,
    which then keeps which parts the document's observation made.
    """
    _owned(document)
    if "records" not in _CACHE:
        from proof.observe.unit import observe_document
        from proof.store import runtime

        store = runtime.session_store(document) if store is None else store
        found = observe_document(
            document,
            core_runner=core_runner,
            editor_driver=editor_driver,
            store=store,
            same_as=runtime.same_as(store),
        )
        runtime.recorded(store, document, found)
        _write_timings(document, found)
        _CACHE["records"] = found
    return _CACHE["records"]


def local_records_for(document, core_runner):
    """The document's records with its ``local`` part at least: the whole records where made, else that part."""
    _owned(document)
    if "records" in _CACHE:
        return _CACHE["records"]
    if "local" not in _CACHE:
        from proof.observe.record import DocumentRecords
        from proof.observe.unit import observe_local
        from proof.store import runtime

        found = DocumentRecords(document.id, document.kind)
        found.local, found.local_key, _ = observe_local(
            document, core_runner=core_runner, store=runtime.session_store(document), blobs=found.blobs
        )
        _CACHE["local"] = found
    return _CACHE["local"]


# The views by the names the checks that predate records read ----------------------------


def observe_republish(document, export, core_runner, *, editor_driver=None) -> Republish:
    return republish_view(records_for(document, core_runner, editor_driver=editor_driver), export.configuration.name)


def observe_edit(document, name, core_runner, *, editor_driver=None) -> EditPublish:
    return edit_view(records_for(document, core_runner, editor_driver=editor_driver), name)


def _create(state, export, observed, name="A"):
    """Nova's first publish of D over ``state`` (``proof.observe.publish.create``), its refusal kept in ``observed``."""
    from proof.observe import publish

    app_id, refusal, lookups = publish.create(state, export)
    if lookups is not None:
        observed.lookup_uploads[name] = lookups
    if refusal is not None:
        observed.refusals.append(Refusal(name, refusal["status"], refusal["response"]))
    return app_id


def _update(state, app_id, captured, observed, name):
    """A captured update over the app (``proof.observe.publish.update``), its refusal kept in ``observed``."""
    from proof.observe import publish

    refusal, lookups = publish.update(state, app_id, captured, name)
    if lookups is not None:
        observed.lookup_uploads[name] = lookups
    if refusal is not None:
        observed.refusals.append(Refusal(name, refusal["status"], refusal["response"]))
        return False
    return True
