"""Every key the evidence store keeps a result under, and what each one names.

A key is the sha256 of the canonical JSON of a list whose first item names
the key's kind, so no two kinds of key can meet. Standard library only.

- ``part_key(kind, parent, inputs)``: one record part (``proof.observe.unit``
  computes its inputs). It names the part's kind, its parent part's key and
  the digests of its inputs, and no fingerprint: a unit's HQ entropy and
  clock are drawn under its parts' keys (``proof.hq.determinism``), so the
  same inputs draw the same values on every image, architecture and version
  of the harness, and two such runs can be compared byte for byte.
- ``storage_key(scope, part key)``: where the store keeps a part, which adds
  what the part's record also depends on (``record_scope``): the observation
  code, the image, the Postgres image, the architecture and the
  observation's environment (``environment``). The browser's code is not in
  it: only proof 4's observation drives the editor driver, inside the ``b``
  and ``b_edit`` parts, and it names the driver's code in those parts' keys
  (``proof.observe.proof4.inputs``), so a ``b`` or ``b_edit`` part misses when
  the driver changes and every other part is kept.
- ``document_key(scope, group, files)``: one corpus document or control as
  the observation reads it: its group, every file of its directory
  (``files_digest``), and the document scope (``document_scope``: the record
  scope and the browser's code). That is everything any of its parts' keys
  reads: a part's corpus inputs are files of the directory, and what an
  observation hook declares is a digest of such a file (the guard refuses a
  hook's read of any other, ``proof.store.guard``) or the browser's code
  (proof 4's). The store maps the document key to the part keys and record
  digests its observation made, so the queue builder learns a document's
  parts without running any of the observation's code, and a change to the
  browser's code alone misses every document key: each document's parts
  that drive the browser are observed again, the rest read from the store.
- ``group_key(document key, judge, records)``: a document's judgment: the
  document, the judge's code (whose fingerprint includes both registers) and
  the digest of every record part, so every check reads at most what it
  names. ``judgment_key(group key, check)`` is one check's evidence in it.
- ``transcript_key(scope, spec digest, first)``: a browser run's starting
  point: the document scope, the run's spec (its clock, randomness, cookies
  and options) and HQ's first answer. A transcript held under it is replayed
  only where HQ answers every later request as recorded
  (``proof.editors.transcripts.replay``), and the scope names the rest of
  what the run reads: the browser's code; the image (Chromium, the static
  files the driver serves, HQ); the architecture; the environment the driver
  is started in; and the observation's code, which starts the driver, hands
  it what HQ does not answer (the JavaScript catalog,
  ``proof.editors.pages._register_catalog``), and records what the page
  asked and showed (``proof.editors.hq.request_headers``,
  ``proof.editors.vellum``, ``proof.editors.pages.page_requests``). The
  guard holds that code to the observation partition, so its fingerprint
  names all of it.
- ``package_key(fingerprints, environment, group, data)``: a package group's
  outcome: every file of the harness, the image, the platform, the
  environment and the digest of the data its tests read
  (``proof.store.queue.package_data``).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from pathlib import Path

VERSION = 1
KEY_BYTES = 32
PART_KINDS = frozenset({"a", "b", "b_aligned", "local"})

# The variables of the lane's environment that change what an observation records and that no file the
# fingerprints cover sets: the HQ speed seams and determinism (proof/hq/speed.py, proof/hq/determinism.py), which
# proof/run.mjs passes through from the machine running it, and HQ's string hashing and zone, which
# proof/compose.yaml sets for the lane. The image sets where its checkouts and tools are (PROOF_HQ, PROOF_CORE, ...),
# so its digest names them. The audit switches that only check (PROOF_VERIFY_MEMOS, PROOF_EDITOR_AUDIT,
# PROOF_BRANCH_DOCUMENTS) record nothing different and are left out.
ENVIRONMENT_VARIABLES = ("PYTHONHASHSEED", "TZ", "PROOF_HQ_SPEED", "PROOF_HQ_DETERMINISM")
# Switches read as on unless set to "0".
SWITCHES = frozenset({"PROOF_HQ_SPEED", "PROOF_HQ_DETERMINISM"})
# The environment proof/compose.yaml gives the harness, which the queue builder's keys assume.
LANE_ENVIRONMENT = {"PYTHONHASHSEED": "0", "TZ": "UTC"}
# What a lane run records of its environment beside its selection (proof.lane.serve's serve.json): what its
# observations record differently under (ENVIRONMENT_VARIABLES), and which documents HQ's branch proof runs over
# (proof/hq/test_branches.py), which changes which items the run collects, in each such document's group and in
# proof/hq's, as its pytest arguments do.
BRANCH_DOCUMENTS = "PROOF_BRANCH_DOCUMENTS"
SELECTION_ENVIRONMENT = (*ENVIRONMENT_VARIABLES, BRANCH_DOCUMENTS)

RECORD_FINGERPRINTS = ("observation", "image", "postgres", "arch")
# What a document's parts and a browser run read beyond the record scope: the browser's code.
DOCUMENT_FINGERPRINTS = (*RECORD_FINGERPRINTS, "browser")
PACKAGE_FINGERPRINTS = ("harness", "image", "postgres", "arch")

# The files of the corpus's native products that hold timings, never read by a check.
NATIVE = "native"
NATIVE_UNREAD = ("logs/", "timings.json")


class KeyInputError(ValueError):
    """A key asked for with inputs it cannot name."""


def canonical(value) -> bytes:
    """``value`` as canonical JSON: sorted keys, no insignificant space, text as itself."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def hashed(*parts) -> str:
    """The sha256 (hex) of the canonical JSON of ``parts``: a key's or a signature's."""
    return hashlib.sha256(canonical([*parts])).hexdigest()


def part_key(kind: str, parent: bytes | None, inputs: dict) -> bytes:
    """The 32-byte key of one record part: its kind, its parent part's key and the digests of its inputs."""
    if kind not in PART_KINDS:
        raise KeyInputError(f"A part is of kind {', '.join(sorted(PART_KINDS))}; {kind!r} is none of them.")
    if parent is not None and (not isinstance(parent, bytes) or len(parent) != KEY_BYTES):
        raise KeyInputError(f"A part's parent is the {KEY_BYTES}-byte key of another part; this one is {parent!r}.")
    return hashlib.sha256(canonical(["part", VERSION, kind, parent.hex() if parent else None, inputs])).digest()


def environment(environ: Mapping[str, str]) -> dict:
    """What of ``environ`` changes what an observation records (``ENVIRONMENT_VARIABLES``), switches as on or off."""
    found = {}
    for name in ENVIRONMENT_VARIABLES:
        value = environ.get(name)
        if name in SWITCHES:
            found[name] = "off" if value == "0" else "on"
        else:
            found[name] = value
    return found


def lane_environment(recorded: Mapping[str, str | None]) -> bool:
    """Whether a run's recorded environment (``SELECTION_ENVIRONMENT``) is the one the queue builder keys package
    groups under (``LANE_ENVIRONMENT``), with HQ's branch proof over its own documents or every one."""
    present = {name: value for name, value in recorded.items() if value is not None}
    return environment(present) == environment(LANE_ENVIRONMENT) and lane_branches(recorded)


def lane_branches(recorded: Mapping[str, str | None]) -> bool:
    """Whether a run's recorded environment holds HQ's branch proof over its own documents or every one: the item
    of it in a group is then every item the lane's own run collects there, or more. Under a list of others, a
    document the proof names by default runs without it. A run over every one reads no outcome from the store
    (``proof-lane.yml`` queues it ``--fresh``): one kept by the lane's own run holds no branch item of a document
    the proof does not name."""
    return recorded.get(BRANCH_DOCUMENTS) in (None, "", "all")


def _named(fingerprints: Mapping[str, str], names: Iterable[str]) -> dict:
    missing = [name for name in names if not fingerprints.get(name)]
    if missing:
        raise KeyInputError(f"The fingerprints lack {', '.join(missing)}, which this key names.")
    return {name: fingerprints[name] for name in names}


def record_scope(fingerprints: Mapping[str, str], environ: Mapping[str, str]) -> dict:
    """What a record part depends on beyond its part key: the observation's code, the platform and the
    environment the observation runs in."""
    return {**_named(fingerprints, RECORD_FINGERPRINTS), "environment": environment(environ)}


def document_scope(fingerprints: Mapping[str, str], environ: Mapping[str, str]) -> dict:
    """What a document's record parts read beyond its own files, and a browser run beyond its spec and HQ's
    answers: the record scope and the browser's code."""
    return {**_named(fingerprints, DOCUMENT_FINGERPRINTS), "environment": environment(environ)}


def storage_key(scope: Mapping, key: bytes) -> str:
    if not isinstance(key, bytes) or len(key) != KEY_BYTES:
        raise KeyInputError(f"A part is stored under its {KEY_BYTES}-byte part key; this one is {key!r}.")
    return hashed("stored-part", VERSION, dict(scope), key.hex())


def document_key(scope: Mapping, group: str, files: str) -> str:
    return hashed("document", VERSION, dict(scope), group, files)


def group_key(document: str, judge: str, records: Mapping[str, str]) -> str:
    """A document's judgment: the document's key, the judge's fingerprint and every record part's digest."""
    return hashed("judged", VERSION, document, judge, dict(sorted(records.items())))


def judgment_key(group: str, check: str) -> str:
    return hashed("judgment", VERSION, group, check)


def transcript_key(scope: Mapping, spec_digest: str, first: str | None) -> str:
    """A browser run's transcript: the document scope (``document_scope``), the run's spec and HQ's first answer."""
    return hashed("transcript", VERSION, dict(scope), spec_digest, first)


def package_key(fingerprints: Mapping[str, str], environ: Mapping[str, str], group: str, data: Mapping) -> str:
    return hashed(
        "package",
        VERSION,
        _named(fingerprints, PACKAGE_FINGERPRINTS),
        environment(environ),
        group,
        dict(sorted(data.items())),
    )


# Digests of what a key names on disk --------------------------------------------------------------------------


def files_digest(root: Path, *, unread: Iterable[str] = ()) -> str:
    """The sha256 of ``<relative path>\\0<sha256 of its bytes>\\n`` for every file under ``root``, by path.

    ``unread`` names relative paths (a directory with a trailing ``/``) left
    out. A missing ``root`` has the digest of no files.
    """
    root = Path(root)
    unread = tuple(unread)
    entries = []
    if root.is_dir():
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            if any(relative == skip or (skip.endswith("/") and relative.startswith(skip)) for skip in unread):
                continue
            entries.append((relative, hashlib.sha256(path.read_bytes()).hexdigest()))
    digest = hashlib.sha256()
    for relative, content in sorted(entries):
        digest.update(f"{relative}\0{content}\n".encode())
    return digest.hexdigest()


def corpus_documents(corpus: Path) -> list[str]:
    """The ids ``index.json`` lists, in its order."""
    index = json.loads((Path(corpus) / "index.json").read_text(encoding="utf-8"))
    return [entry["id"] for entry in index["documents"]]


def index_digest(corpus: Path) -> str | None:
    """The sha256 of the corpus's ``index.json``, which lists its documents; None without one."""
    path = Path(corpus) / "index.json"
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def documents_digest(corpus: Path, documents: Mapping[str, str] | None = None) -> str:
    """The corpus's documents: its index, its input manifest and every document's files (``files_digest``)."""
    corpus = Path(corpus)
    if documents is None:
        documents = {identifier: files_digest(corpus / identifier) for identifier in corpus_documents(corpus)}
    roots = {
        name: hashlib.sha256((corpus / name).read_bytes()).hexdigest() if (corpus / name).is_file() else None
        for name in ("index.json", "inputs.json")
    }
    return hashed("documents", VERSION, roots, dict(sorted(documents.items())))


def native_digest(corpus: Path) -> str | None:
    """The native products the corpus carries (``native/``), their logs and timings left out; None without them.

    It is their bytes: the products' producers mint ids afresh in each
    production, and no renaming of id-shaped tokens can tell a minted id from
    a fixed one whose value changed, so a digest that renamed them would
    stand one production in for another that differs.
    """
    directory = Path(corpus) / NATIVE
    if not directory.is_dir():
        return None
    return files_digest(directory, unread=NATIVE_UNREAD)
