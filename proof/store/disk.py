"""The evidence store on disk: a snapshot, and the delta one lane run writes beside its output.

A snapshot is what a GitHub cache entry restores and ``PROOF_STORE`` names::

    index.json                {"version": 1, "parts": {...}, "documents": {...}, "judgments": {...},
                               "transcripts": {...}, "groups": {...}}
    blobs/<2 hex>/<64 hex>    each blob's bytes, named by their sha256

Its index maps each key (``proof.store.keys``) to an entry:

- ``parts``: a part's storage key to ``{"record": <digest>, "blobs": [...]}``,
  its record's blob (``sha256:<hex>`` of its canonical JSON) and every blob
  the record names (``proof.observe.record.Blobs.named_by``);
- ``documents``: a document key to ``{"group", "parts": {"<configuration>/<part>"
  or "local": [<part key hex>, <record digest>]}}``, the digest being of the
  record the judges read for the part (a B-edit recorded as B's reads B's);
- ``judgments``: a judgment key to the digest of the evidence its check wrote;
- ``transcripts``: a transcript key to the transcript's digest;
- ``groups``: a group key (a document's judgment, or a package group's key) to
  its outcome, ``{"group", "items": {<node id>: <outcome>}, "failure",
  "judgments": {<check>: <judgment key>}}``, with ``"surface": <digest>`` for
  the surface block's extraction.

Blobs are kept as their bytes: the standard library reads no zstd before
Python 3.14, and the cache that carries a snapshot compresses it whole.

A delta is ``<output>/store/`` of a lane run, written by every worker of the
run at once (``proof.store.runtime``), so each entry is a file of its own,
created whole and never overwritten (a transcript excepted, which a newer
verified one replaces)::

    fingerprints.json             the fingerprints and environment it was written under
    entries/<kind>/<key>.json     one entry
    blobs/<2 hex>/<64 hex>

Standard library only.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

VERSION = 1
INDEX = "index.json"
BLOBS = "blobs"
ENTRIES = "entries"
FINGERPRINTS = "fingerprints.json"
DELTA = "store"
KINDS = ("parts", "documents", "judgments", "transcripts", "groups")
# A newer transcript replaces an older one under the same key: either is replayed only where HQ answers alike.
REPLACEABLE = frozenset({"transcripts"})
PREFIX = "sha256:"
HEX = re.compile(r"[0-9a-f]{64}")


class StoreFormatError(ValueError):
    """A directory that is not a store in the layout this module reads."""


class EntryConflict(ValueError):
    """Two values for one key: what one observation of a key's inputs found, another did not."""

    def __init__(self, kind, key, held, given):
        super().__init__(
            f"The {kind} entry {key[:16]} is held as {shown(held)}, and this run wrote {shown(given)} under the"
            " same key. A key names every input, so the two observations of it should be byte for byte equal."
        )
        self.kind, self.key, self.held, self.given = kind, key, held, given


class DeltaMixed(StoreFormatError):
    """A worker of a run opened its delta under other fingerprints or another environment than the run's."""


def shown(value) -> str:
    text = json.dumps(value, sort_keys=True)
    return text if len(text) <= 120 else text[:117] + "..."


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest_of(content: bytes) -> str:
    return PREFIX + hashlib.sha256(content).hexdigest()


def _hex(digest: str) -> str:
    hexdigest = digest.removeprefix(PREFIX)
    if HEX.fullmatch(hexdigest) is None:
        raise StoreFormatError(f"{digest!r} is no blob's name; a blob is named sha256:<64 hex digits>.")
    return hexdigest


def blob_path(root: Path, digest: str) -> Path:
    hexdigest = _hex(digest)
    return Path(root, BLOBS, hexdigest[:2], hexdigest)


def blob_names(root: Path) -> set[str]:
    """The name (``sha256:<hex>``) of every blob file under ``root``, read from its directories."""
    found = set()
    try:
        shards = os.scandir(Path(root) / BLOBS)
    except FileNotFoundError:
        return found
    with shards:
        for shard in shards:
            if shard.is_dir():
                with os.scandir(shard.path) as files:
                    found.update(
                        PREFIX + entry.name for entry in files if HEX.fullmatch(entry.name) and entry.is_file()
                    )
    return found


def write_whole(path: Path, content: bytes, *, replace: bool) -> bool:
    """Write ``content`` to ``path`` through a staged file; False when ``path`` exists and ``replace`` is off."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    # mkstemp makes the file its owner's alone (0600); a lane's container writes the store as its own user and the
    # runner uploads it as another, so every file the store writes is readable by all, as a plain write makes it.
    os.fchmod(handle, 0o644)
    try:
        with os.fdopen(handle, "wb") as staged_file:
            staged_file.write(content)
        if replace:
            os.replace(staged, path)
            return True
        try:
            os.link(staged, path)
        except FileExistsError:
            return False
        return True
    finally:
        if os.path.lexists(staged):
            os.unlink(staged)


def write_blob(root: Path, content: bytes) -> str:
    digest = digest_of(content)
    path = blob_path(root, digest)
    if not path.exists():
        write_whole(path, content, replace=True)
    return digest


def read_blob(root: Path, digest: str) -> bytes | None:
    """The blob's bytes, or None when ``root`` does not hold it whole (absent, or not the bytes its name says)."""
    try:
        content = blob_path(root, digest).read_bytes()
    except FileNotFoundError:
        return None
    return content if digest_of(content) == digest else None


def empty_index() -> dict:
    return {kind: {} for kind in KINDS}


class Snapshot:
    """A snapshot, read: its index in memory, its blobs read when asked for. An absent directory holds nothing."""

    def __init__(self, root: Path | None):
        self.root = None if root is None else Path(root)
        self.index = empty_index()
        # The blobs it holds, listed once when first asked: a restored snapshot is not written to.
        self._names: set[str] | None = None
        if self.root is None or not (self.root / INDEX).is_file():
            return
        try:
            value = json.loads((self.root / INDEX).read_bytes())
        except ValueError as error:
            raise StoreFormatError(f"{self.root / INDEX} is not JSON ({error}).") from error
        if not isinstance(value, dict) or value.get("version") != VERSION:
            raise StoreFormatError(
                f"{self.root / INDEX} is not a version {VERSION} store index; restore a snapshot this checkout's"
                " store wrote, or start from an empty one."
            )
        for kind in KINDS:
            entries = value.get(kind, {})
            if not isinstance(entries, dict):
                raise StoreFormatError(f"{self.root / INDEX}'s {kind} is not an object.")
            self.index[kind] = entries

    def get(self, kind: str, key: str):
        return self.index[kind].get(key)

    def blob(self, digest: str) -> bytes | None:
        return None if self.root is None else read_blob(self.root, digest)

    def has_blob(self, digest: str) -> bool:
        if self._names is None:
            self._names = set() if self.root is None else blob_names(self.root)
        return digest in self._names

    def blob_file(self, digest: str) -> str | None:
        """Where the snapshot keeps the blob, when it holds it as a file."""
        if not self.has_blob(digest):
            return None
        hexdigest = digest.removeprefix(PREFIX)
        return os.path.join(self.root, BLOBS, hexdigest[:2], hexdigest)


def write_snapshot(root: Path, index: dict, blob, *, held=None) -> Path:
    """Write a snapshot of ``index`` into ``root`` (created, its earlier index and blobs replaced) with every
    blob its entries name. A blob a source holds as a file (``held(digest)``, its path) is linked from it (copied
    across file systems), unread: a reader verifies every blob it reads against its name, so a damaged one is a
    miss there. Any other is read through ``blob(digest)``; one no source gives is a ``StoreFormatError``
    (``proof.store.pack`` leaves out every entry naming a blob no source holds before it writes). The snapshot
    holds no blob its index does not name, so the same index and blobs give the same bytes."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    present = blob_names(root)
    reached = reached_blobs(index)
    directories = set()
    for digest in sorted(reached - present):
        hexdigest = _hex(digest)
        directory = os.path.join(root, BLOBS, hexdigest[:2])
        if directory not in directories:
            os.makedirs(directory, exist_ok=True)
            directories.add(directory)
        source = None if held is None else held(digest)
        if source is not None and _linked(source, os.path.join(directory, hexdigest)):
            continue
        content = blob(digest)
        if content is None:
            raise StoreFormatError(f"The store's entries name the blob {digest}, and no source gives it any more.")
        write_blob(root, content)
    for name in sorted(present - reached):
        blob_path(root, name).unlink()
    written = {"version": VERSION, **{kind: dict(sorted(index[kind].items())) for kind in KINDS}}
    write_whole(root / INDEX, canonical(written) + b"\n", replace=True)
    return root


def _linked(source, path: str) -> bool:
    """Put the file ``source`` at ``path`` as a link, or a copy where they are on different file systems; False
    when ``source`` is not there to put."""
    try:
        os.link(source, path)
    except FileExistsError:
        return True
    except FileNotFoundError:
        return False
    except OSError:
        try:
            write_whole(Path(path), Path(source).read_bytes(), replace=False)
        except FileNotFoundError:
            return False
    return True


def entry_blobs(kind: str, value) -> set[str]:
    """The blobs an entry needs: a part's record and the blobs it names, a judgment's evidence, a transcript, the
    surface block's extraction."""
    if kind == "parts":
        return {value["record"], *value["blobs"]}
    if kind in ("judgments", "transcripts"):
        return {value}
    if kind == "groups" and value.get("surface"):
        return {value["surface"]}
    return set()


def reached_blobs(index: dict) -> set[str]:
    return {digest for kind in KINDS for value in index[kind].values() for digest in entry_blobs(kind, value)}


class Delta:
    """One lane run's delta (``<output>/store/``), written by its workers at once and read back by them."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def _entry(self, kind: str, key: str) -> Path:
        if kind not in KINDS:
            raise StoreFormatError(f"A store holds {', '.join(KINDS)} entries; {kind!r} is none of them.")
        return self.root / ENTRIES / kind / f"{key}.json"

    def get(self, kind: str, key: str):
        try:
            return json.loads(self._entry(kind, key).read_bytes())
        except FileNotFoundError:
            return None

    def put(self, kind: str, key: str, value) -> None:
        """Keep ``value`` under ``key``; ``EntryConflict`` when another value is held there (but a transcript's)."""
        path = self._entry(kind, key)
        content = canonical(value)
        if write_whole(path, content, replace=kind in REPLACEABLE):
            return
        held = json.loads(path.read_bytes())
        if canonical(held) != content:
            raise EntryConflict(kind, key, held, value)

    def entries(self, kind: str) -> dict:
        directory = self.root / ENTRIES / kind
        if not directory.is_dir():
            return {}
        return {path.stem: json.loads(path.read_bytes()) for path in sorted(directory.glob("*.json"))}

    def put_blob(self, content: bytes) -> str:
        return write_blob(self.root, content)

    def blob(self, digest: str) -> bytes | None:
        return read_blob(self.root, digest)

    def has_blob(self, digest: str) -> bool:
        return blob_path(self.root, digest).is_file()

    def blob_file(self, digest: str) -> Path | None:
        """Where the delta keeps the blob, when it holds it."""
        return blob_path(self.root, digest) if self.has_blob(digest) else None

    def fingerprints(self) -> dict | None:
        try:
            return json.loads((self.root / FINGERPRINTS).read_bytes())
        except FileNotFoundError:
            return None

    def record_fingerprints(self, value: dict) -> None:
        """Keep what the delta is written under; ``DeltaMixed`` when a worker of the run wrote other ones."""
        path = self.root / FINGERPRINTS
        content = canonical(value)
        if write_whole(path, content, replace=False):
            return
        held = json.loads(path.read_bytes())
        if canonical(held) != content:
            raise DeltaMixed(
                f"The run's evidence-store delta at {self.root} was started under {shown(held)}, and this worker"
                f" observes under {shown(value)}. Every key the delta holds names the code, platform and environment"
                " it was made under, so one run's workers share them: start the run's workers from one lane"
                " environment (PROOF_FINGERPRINTS and the observation's variables), or give each its own output."
            )
