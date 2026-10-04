"""The records observation writes and judgment reads: canonical JSON, blobs, keys and the store.

A record is a JSON-able dict that holds no timing, no absolute path and no
wall-clock value, so two observations of the same inputs write the same
bytes (``canonical``). Bytes live in ``Blobs``, addressed by the sha256 of
their content, and the record holds the address (``sha256:<hex>``): every
file HQ builds (each its own blob), every app document HQ stores, every
restore, Core trace and HQ processing of a trace. What a record holds
inline is structured data no longer than a kilobyte a value
(``test_record_determinism`` holds a document's records to it).

A unit's record is split into parts, each stored under its own key
(``part_key``): ``a`` (the configuration and A), ``b`` (B over A, what B-edit
observes over A too), ``b_aligned`` (B aligned to A, and proof 3's sessions),
``b_edit`` (B-edit over A, or ``{"same_as": <b's key>}`` when its key is
``b``'s) and ``local`` (Core's admission of each local archive). A key names
exactly the inputs a part reads, and no fingerprint, so a unit draws the same
HQ entropy under it on every image, architecture and version of the harness;
the evidence store keeps a part under its key and the fingerprints of the
code and platform that observed it (``proof.store.keys.storage_key``), so a
part observed once stands for any later observation of the same inputs by the
same code.

``Store`` is where parts are kept between observations, each with the
blobs its record names (``Blobs.named_by``); the evidence store implements
it, and ``NullStore`` (the default) holds nothing, so every part is
observed. ``store.fresh`` asks for every part to be observed even where
the store holds it, and each such part is handed to ``store.audit`` beside
what the store held.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

BLOB_PREFIX = "sha256:"


def canonical(obj) -> bytes:
    """``obj`` as canonical JSON: sorted keys, no insignificant space, text as itself."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(obj) -> str:
    """``sha256:<hex>`` of ``canonical(obj)``."""
    return BLOB_PREFIX + hashlib.sha256(canonical(obj)).hexdigest()


def bytes_digest(content: bytes) -> str:
    """``sha256:<hex>`` of raw bytes."""
    return BLOB_PREFIX + hashlib.sha256(content).hexdigest()


class BlobMissing(KeyError):
    """A record names a blob the blobs it was read with do not hold."""


class Blobs:
    """Bytes by the sha256 of their content, in memory."""

    def __init__(self):
        self._held: dict[str, bytes] = {}

    def put(self, content: bytes) -> str:
        if isinstance(content, str):
            content = content.encode("utf-8")
        if not isinstance(content, (bytes, bytearray)):
            raise TypeError(f"A blob holds bytes; this is {type(content).__name__}.")
        ref = bytes_digest(bytes(content))
        self._held.setdefault(ref, bytes(content))
        return ref

    def get(self, ref: str) -> bytes:
        try:
            return self._held[ref]
        except KeyError:
            raise BlobMissing(
                f"A record names the blob {ref}, and the blobs it was read with do not hold it. Read a record with "
                "the blobs its observation wrote (DocumentRecords.blobs), or the store's for a part it held."
            ) from None

    def __contains__(self, ref) -> bool:
        return ref in self._held

    def refs(self):
        return sorted(self._held)

    def merge(self, other: Blobs) -> Blobs:
        for ref in other.refs():
            self._held.setdefault(ref, other.get(ref))
        return self

    def put_json(self, value) -> str:
        """A JSON value as its canonical bytes' blob."""
        return self.put(canonical(value))

    def get_json(self, ref: str):
        return json.loads(self.get(ref))

    def named_by(self, record) -> Blobs:
        """The blobs ``record`` names, as blobs of their own: each ``sha256:`` string in it that these hold.

        A record names every blob it reads directly (a blob names no other),
        so a part is kept with exactly what reading it needs.
        """
        found = Blobs()
        for value in _strings(record):
            if value.startswith(BLOB_PREFIX) and value in self._held:
                found._held.setdefault(value, self._held[value])
        return found


def _strings(value):
    """Every string in a JSON value, keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _strings(item)


@runtime_checkable
class Store(Protocol):
    """Where parts are kept between observations (the evidence store implements it).

    ``lookup`` returns the record a key names, or None; ``blobs(key)`` the
    blobs a record ``lookup`` returned names (``proof.observe.unit`` merges
    them before it reads the record). ``put`` keeps a record under its key
    with the blobs it names and no others (``Blobs.named_by``).
    """

    # The browser transcripts the proof 4 observation reuses, or None.
    transcripts: object
    # Observe every part even where the store holds it, and audit it against what the store held.
    fresh: bool

    def lookup(self, key: bytes) -> dict | None: ...

    def blobs(self, key: bytes) -> Blobs: ...

    def put(self, key: bytes, record: dict, blobs: Blobs) -> None: ...

    def audit(self, key: bytes, record: dict) -> None: ...


class NullStore:
    """A store that holds nothing: every part is observed, and nothing is kept."""

    transcripts = None
    fresh = False

    def lookup(self, key):
        return None

    def blobs(self, key):
        return Blobs()

    def put(self, key, record, blobs):
        return None

    def audit(self, key, record):
        return None


NULL_STORE = NullStore()


def part_key(kind: str, parent_key: bytes | None, inputs: dict) -> bytes:
    """The 32-byte key of one part: its kind, its parent's key and the digests of its inputs
    (``proof.store.keys.part_key``, the evidence store's derivation)."""
    from proof.store.keys import part_key as store_part_key

    return store_part_key(kind, parent_key, inputs)


# A configuration's record ------------------------------------------------------------


def configuration_record(configuration) -> dict:
    """A ``proof.hq.configuration.Configuration`` as a record holds it."""
    return {
        "flags": sorted(configuration.flags),
        "privileges": sorted(configuration.privileges),
        "commcareVersion": configuration.commcare_version,
        "commtrack": configuration.commtrack,
        "syncCasesOnFormEntry": configuration.sync_cases_on_form_entry,
        "caseSearchEnabled": configuration.case_search_enabled,
        "domain": configuration.domain,
    }


def configuration_of(value: dict):
    """The ``Configuration`` a record holds (``configuration_record``)."""
    from proof.hq.configuration import Configuration

    return Configuration(
        flags=frozenset(value["flags"]),
        privileges=frozenset(value["privileges"]),
        commcare_version=value["commcareVersion"],
        commtrack=value["commtrack"],
        sync_cases_on_form_entry=value["syncCasesOnFormEntry"],
        case_search_enabled=value["caseSearchEnabled"],
        domain=value["domain"],
    )


# A document's records ---------------------------------------------------------------

PARTS = ("a", "b", "b_aligned", "b_edit")


@dataclass
class ConfigurationRecords:
    """One configuration's parts and their keys."""

    name: str
    keys: dict
    a: dict | None = None
    b: dict | None = None
    b_aligned: dict | None = None
    b_edit: dict | None = None

    def part(self, name):
        """A part's record; ``b_edit`` reads ``b``'s where it is the same (``{"same_as": <b's key>}``)."""
        record = getattr(self, name)
        if name == "b_edit" and record is not None and "same_as" in record:
            return self.b
        return record


@dataclass
class DocumentRecords:
    """Every part of one document's tree: each configuration's, the local archives', and the blobs they name."""

    document: str
    kind: str
    configurations: dict = field(default_factory=dict)
    local: dict | None = None
    local_key: bytes | None = None
    blobs: Blobs = field(default_factory=Blobs)
    # Which parts were observed rather than read from the store ("<configuration>/<part>", "local").
    observed: list = field(default_factory=list)
    # What each part and operation took, in seconds (never in a record).
    timings: dict = field(default_factory=dict)

    def digests(self):
        """Each part's record digest, by "<configuration>/<part>" and "local"."""
        found = {}
        for name, held in sorted(self.configurations.items()):
            for part in PARTS:
                record = getattr(held, part)
                if record is not None:
                    found[f"{name}/{part}"] = digest(record)
        if self.local is not None:
            found["local"] = digest(self.local)
        return found

    def save(self, directory) -> Path:
        """The records written into ``directory``: ``records.json`` and each blob as ``blobs/<hex>``."""
        directory = Path(directory)
        (directory / "blobs").mkdir(parents=True, exist_ok=True)
        for ref in self.blobs.refs():
            (directory / "blobs" / ref.removeprefix(BLOB_PREFIX)).write_bytes(self.blobs.get(ref))
        written = {
            "document": self.document,
            "kind": self.kind,
            "configurations": {
                name: {
                    "keys": {part: key.hex() for part, key in held.keys.items()},
                    **{part: getattr(held, part) for part in PARTS},
                }
                for name, held in sorted(self.configurations.items())
            },
            "local": self.local,
            "localKey": None if self.local_key is None else self.local_key.hex(),
        }
        (directory / "records.json").write_bytes(canonical(written))
        return directory

    @classmethod
    def load(cls, directory) -> DocumentRecords:
        """The records ``save`` wrote into ``directory``."""
        directory = Path(directory)
        written = json.loads((directory / "records.json").read_bytes())
        found = cls(written["document"], written["kind"])
        for path in sorted((directory / "blobs").iterdir()):
            found.blobs.put(path.read_bytes())
        for name, held in written["configurations"].items():
            keys = {part: bytes.fromhex(key) for part, key in held["keys"].items()}
            found.configurations[name] = ConfigurationRecords(name, keys, **{part: held[part] for part in PARTS})
        found.local = written["local"]
        found.local_key = None if written["localKey"] is None else bytes.fromhex(written["localKey"])
        return found
