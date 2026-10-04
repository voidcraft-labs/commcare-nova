"""The store a lane worker observes with: the snapshot it reads, and the delta it writes beside its output.

``session_store(document)`` gives the store for one document's observation
(``proof.observe.record.Store``), or ``NULL_STORE``:

- with ``PROOF_STORE=off``: nothing is read, kept or guarded;
- without ``PROOF_FINGERPRINTS`` (``proof.store.fingerprints.current``):
  no key could name the code the records were made with, so nothing is
  stored;
- for a corpus document without an ``inputs.json`` (a test's copy of one):
  the guard could not hold its observation to its keys
  (``proof.store.guard.holds``). A control keeps none, and its observation
  is held to the input files its own files give, as its keys are
  (``proof.store.guard.input_files``), so it is stored as a document is;
- without ``PROOF_OUT``: there is no run output to write the delta beside.

Otherwise the store reads the snapshot ``PROOF_STORE`` names (none when it
is unset: a run that only writes, as the nightly audit's) and writes the
run's delta (``proof.store.disk.Delta``) into ``<output>/store/``, where the
run's output is the directory above ``blocks/`` and ``workers/`` in
``PROOF_OUT``. Every worker of the run writes the one delta, so a part one
group observed is a hit for every later group of the run that names its
key.

A group the queue marks fresh (``PROOF_GROUP_FRESH=1``, the audit sample)
observes every part, records B-edit apart from B even where their keys are
equal (``same_as``), and has each part held to whatever the snapshot or this
run's delta holds under its key (``audit``): a record that differs is
written, with the one held, under ``<output>/audit/`` and fails the group.
Any part kept under a key the run already holds another record under fails
the same way (``put``), so two observations of one key that differ are never
both kept.

The browser transcripts (``transcripts``) are kept the same way, by
``proof.store.keys.transcript_key`` under the document scope (the
observation's and the browser's code, the platform, the environment): a
view's by its run spec and HQ's answer to its navigation, a Vellum run's by
its run spec alone (nothing is answered before Vellum asks, and the replay
verifies the first answer as it does every other), as proof 4's observation
looks them up (``proof.observe.proof4``). A fresh group reads only the
snapshot's, so the audit sample still replays what earlier runs recorded,
and never what its own run did.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from proof.observe.record import NULL_STORE, Blobs, canonical, digest
from proof.store import audit, disk, fingerprints, guard, keys

STORE_ENVIRONMENT = "PROOF_STORE"
FRESH_ENVIRONMENT = "PROOF_GROUP_FRESH"
OFF = "off"
AUDIT = "audit"
# A view's run spec kind (``proof.editors.pages.ViewSpec``); a Vellum run's is ``vellum``.
VIEW = "view"

_snapshots: dict[str, disk.Snapshot] = {}


def output_root(out: Path) -> Path:
    """The lane run's output: ``out`` itself, or the directory above its ``blocks/<id>`` or ``workers/w<n>``."""
    out = Path(out)
    if out.parent.name in ("blocks", "workers"):
        return out.parent.parent
    return out


def snapshot(root: Path | None) -> disk.Snapshot:
    """The snapshot at ``root``, read once per process."""
    if root is None:
        return disk.Snapshot(None)
    held = _snapshots.get(str(root))
    if held is None:
        held = _snapshots[str(root)] = disk.Snapshot(root)
    return held


def session_store(document=None, environ=None):
    """The store a document's observation uses in this process (see the module's docstring), or ``NULL_STORE``."""
    environ = os.environ if environ is None else environ
    named = environ.get(STORE_ENVIRONMENT)
    if named == OFF:
        return NULL_STORE
    found = fingerprints.current(environ)
    if found is None:
        return NULL_STORE
    if document is not None and not guard.holds(document):
        return NULL_STORE
    if not environ.get("PROOF_OUT"):
        return NULL_STORE
    run = output_root(Path(environ["PROOF_OUT"]))
    guard.install()
    return Store(
        snapshot(Path(named) if named else None),
        disk.Delta(run / disk.DELTA),
        found,
        environ,
        fresh=environ.get(FRESH_ENVIRONMENT) == "1",
        audit_directory=run / AUDIT,
    )


class Store:
    """``proof.observe.record.Store`` over a snapshot and this run's delta."""

    def __init__(self, held: disk.Snapshot, delta: disk.Delta, found: dict, environ, *, fresh, audit_directory):
        self.snapshot = held
        self.delta = delta
        self.fingerprints = dict(found)
        self.environment = keys.environment(environ)
        self.scope = keys.record_scope(found, environ)
        self.document_scope = keys.document_scope(found, environ)
        self.fresh = bool(fresh)
        # A fresh group records B-edit apart from B, so the audit holds their equality too.
        self.same_as = not self.fresh
        self.audit_directory = Path(audit_directory)
        self.transcripts = Transcripts(self)
        # The last part read whole (``_held``): the observation asks for its record, then for its blobs.
        self._last: tuple[bytes, bytes, Blobs] | None = None
        delta.record_fingerprints({"fingerprints": self.fingerprints, "environment": self.environment})

    # Parts ---------------------------------------------------------------------------------------

    def storage_key(self, key: bytes) -> str:
        return keys.storage_key(self.scope, key)

    def _held_entry(self, stored: str):
        """The entry this run's delta holds under ``stored``, else the snapshot's, with where its blobs are."""
        entry = self.delta.get("parts", stored)
        if entry is not None:
            return entry, self.delta.blob
        entry = self.snapshot.get("parts", stored)
        if entry is not None:
            return entry, self.snapshot.blob
        return None, None

    def _held(self, key: bytes):
        """The record held under ``key`` and its blobs, or (None, None) when nothing whole is held."""
        if self._last is not None and self._last[0] == key:
            return json.loads(self._last[1]), self._last[2]
        entry, read = self._held_entry(self.storage_key(key))
        if entry is None:
            return None, None
        content = read(entry["record"])
        if content is None:
            return None, None
        blobs = Blobs()
        for name in entry["blobs"]:
            blob = read(name)
            if blob is None:
                return None, None
            blobs.put(blob)
        self._last = (key, content, blobs)
        return json.loads(content), blobs

    def lookup(self, key: bytes) -> dict | None:
        record, _ = self._held(key)
        return record

    def blobs(self, key: bytes) -> Blobs:
        _, found = self._held(key)
        return found if found is not None else Blobs()

    def put(self, key: bytes, record: dict, blobs: Blobs) -> None:
        stored = self.storage_key(key)
        content = canonical(record)
        named = blobs.refs()
        for name in named:
            self.delta.put_blob(blobs.get(name))
        self.delta.put_blob(content)
        entry = {"record": digest(record), "blobs": named}
        try:
            self.delta.put("parts", stored, entry)
        except disk.EntryConflict as conflict:
            held, read = self._held_entry(stored)
            held_record = read(held["record"]) if held is not None else None
            raise audit.write_mismatch(
                self.audit_directory, stored, held_record, content, why="this run already kept another record"
            ) from conflict

    def audit(self, key: bytes, record: dict) -> None:
        """Hold a part observed afresh to whatever this run's delta and the snapshot hold under its key."""
        stored = self.storage_key(key)
        content = canonical(record)
        for source, where in ((self.delta, "this run kept another record"), (self.snapshot, "the store holds another")):
            held = source.get("parts", stored)
            if held is not None and held["record"] != disk.digest_of(content):
                raise audit.write_mismatch(
                    self.audit_directory, stored, source.blob(held["record"]), content, why=where
                )

    # Documents -------------------------------------------------------------------------------------

    def document_key(self, document) -> str:
        return keys.document_key(self.document_scope, document.group, keys.files_digest(document.root))

    def recorded(self, document, records) -> None:
        """Keep each part the document's observation made, its key and the digest of the record the judges read
        for it, under the document's key, so the queue builder finds its parts from its files alone.

        A B-edit recorded as B's (``{"same_as": ...}``) is read as B's record
        (``ConfigurationRecords.part``), which its key, B's, holds: so a run
        that observes it apart (a fresh group) keeps the same entry.
        """
        parts = {}
        for name, configuration in sorted(records.configurations.items()):
            for part, key in sorted(configuration.keys.items()):
                record = configuration.part(part)
                if record is not None:
                    parts[f"{name}/{part}"] = [key.hex(), digest(record)]
        if records.local is not None and records.local_key is not None:
            parts["local"] = [records.local_key.hex(), digest(records.local)]
        self.delta.put("documents", self.document_key(document), {"group": document.group, "parts": parts})


def recorded(store, document, records) -> None:
    """Have ``store`` keep the document's parts (``Store.recorded``); nothing for a store that keeps nothing."""
    keep = getattr(store, "recorded", None)
    if keep is not None:
        keep(document, records)


def same_as(store) -> bool:
    """Whether the observation records a B-edit keyed as B as the same (``proof.observe.unit.observe_document``)."""
    return getattr(store, "same_as", True)


class Transcripts:
    """The browser transcripts proof 4's observation replays (``get``) and records (``put``)."""

    def __init__(self, store: Store):
        self._store = store

    @staticmethod
    def first_of(transcript) -> str | None:
        """The first answer a transcript is kept under: a view's navigation answer, none for a Vellum run."""
        return transcript.first if transcript.spec.get("kind") == VIEW else None

    def key(self, spec_digest: str, first: str | None) -> str:
        return keys.transcript_key(self._store.document_scope, spec_digest, first)

    def get(self, spec_digest: str, first: str | None):
        """The transcript held for a run with this spec whose first answer was ``first`` (None for a Vellum run's),
        or None."""
        from proof.editors.transcripts import Transcript, TranscriptInvalid

        key = self.key(spec_digest, first)
        sources = [self._store.snapshot] if self._store.fresh else [self._store.delta, self._store.snapshot]
        for source in sources:
            held = source.get("transcripts", key)
            content = None if held is None else source.blob(held)
            if content is None:
                continue
            try:
                transcript = Transcript.from_json(json.loads(content))
            except (TranscriptInvalid, ValueError):
                continue
            if transcript.spec_digest == spec_digest and self.first_of(transcript) == first:
                return transcript
        return None

    def put(self, transcript) -> None:
        content = transcript.canonical()
        self._store.delta.put_blob(content)
        self._store.delta.put(
            "transcripts", self.key(transcript.spec_digest, self.first_of(transcript)), disk.digest_of(content)
        )
