"""``python3 -m proof.store.queue``: the lane's two queues, each group run, judged or read from the store.

    python3 -m proof.store.queue early [--store DIR]... [--timings FILE] [--arch A] [--image I] [--fresh]
        --out FILE
    python3 -m proof.store.queue main --corpus DIR [--store DIR]... [--timings FILE] [--arch A] [--image I]
        [--audit-seed TEXT] [--audit-units N] [--fresh] [--no-dedupe] [--documents all|sample:N|only:ID,...]
        [--sample-seed YYYY-Www] [--split-above SECONDS|none] --out FILE

The early queue holds the groups whose tests read no corpus
(``proof.lane.blocks.reads_corpus``): the surface block and every other
package with tests. The main queue holds every document of the corpus
(``corpus:<id>``; the corpus's ``native/`` is its products, not a document),
every control the known-defect register names (``control:<id>``), and the
packages in ``proof.lane.blocks.CORPUS_PACKAGES``. A group no test belongs to
(``hq-selfchecks``) is never queued: the lane would find nothing of it.

Each group is one of three classes, from the snapshots ``--store`` names
(merged; an absent one holds nothing) and the fingerprints of this checkout
(``proof.store.fingerprints``, on ``--arch``, of ``--image`` or the lock's):

- cached: the store holds the group's outcome under its key, every item of it
  passed, and, for a document, every check's judgment, each read whole (as
  the surface block's extraction is): a blob that is not the bytes its name
  says is a miss here, never a gap in the gate's reading. It runs nowhere;
  ``cached`` lists it with each judgment's key and its outcome's
  (``outcome``), which the gate reads (``proof.store.reader``).
- judged: a document whose record parts the store holds, under the document's
  key (``proof.store.keys.document_key``: its files, the fingerprints of the
  observation's and the browser's code, the platform), but not its
  judgments. It runs, reading every part from the store, so only its checks'
  judges run, and HQ's branch proof of it where that names it
  (``proof/hq/test_branches.py``), which reads nothing from the store.
- observed: everything else, which runs, reading from the store each part it
  holds.

Pieces. A document or control is one group on one worker, and with every
reader the heaviest take one worker hours. One that is observed, is exported
under more than one configuration, and whose whole measure on one worker is
past the split threshold is queued in pieces (``split``,
``proof.lane.blocks``): each configuration a group of its own
(``corpus:<id>@<configuration>``), which observes it whole into the run's
store, and the document's own group after them, which reads what they kept
and judges the document whole. The pieces carry the document's freshness;
the group that follows them is never fresh. All of them share one block, so
one shard runs them, on different workers. The threshold is the profile's
(``proof/timings.json``, ``profiles.<profile>.execution.split``, seconds of
one worker; a profile that names none splits nothing, as the pull request
lane's), or ``--split-above`` (``none`` for no pieces). A judged or cached
document observes nothing and is never split.

A document's whole measure is its own group's with its pieces' where the
timings were measured from a run that split it (``proof.checks.sharding
.documents``): its own group then measured its judging alone. Each queued
group carries the estimate of what it runs as queued: a piece its own
measure, or ``proof.checks.sharding.PIECE_SHARE`` of the whole where no run
measured it; the group after its pieces its judging (measured, or the
profile's judged share of the whole: ``execution.judged`` in the timings,
``JUDGED_SHARE`` where it names none).

Blocks hold the groups that run. Two documents that share any record part's
inputs (``signatures``) are put in one block, so the second reads what the
first kept in its run's delta (``--no-dedupe`` puts each in its own); the
groups are then packed first-fit, longest first, into blocks of about
``BLOCK_SECONDS`` box-seconds, from ``--timings`` (a judged document counts
its profile's judged share of its estimate), and the blocks are listed longest first.

``--audit-seed`` (the run's id) marks documents fresh, chosen by sha256 of
the seed and each group, until they hold ``--audit-units`` (document,
configuration) units: each runs, observing every part of every configuration
and holding it to the store (``proof.store.runtime``). ``--fresh`` marks
every group fresh and reads nothing from the store (the nightly audit).

A package whose tests read the corpus is keyed by what they read of it
(``PACKAGE_DATA``): the corpus's documents, or only those a test module
names in a constant (read from its source, never imported), with the
corpus's index; and the native products it carries.
``--documents sample:N`` keeps N documents, a window of the corpus's
documents ranked by sha256 of their ids, and rewrites the corpus's
``index.json`` to list them alone, so the lane collects only those, and the
rest under ``unsampled``: their files stay, so a package test that names one
still reads it, and the queue names them (``unsampled``), so the gate holds
the register's entries naming one on their controls alone
(``proof.checks.registers.verify_evidence``). ``--sample-seed`` (an ISO year
and week, ``2026-W42``) chooses the window: each week takes the next N of
the ranking, wrapping at its end, so every document is in some week's sample
within as many weeks as the corpus holds samples (fifteen, for 24 of 357),
and the same seed gives the same sample again; without a seed the sample is
the ranking's first N. The queue names the sample and its seed (``sample``),
and the builder writes both into the job's summary where
``$GITHUB_STEP_SUMMARY`` is set.

``--documents only:<id>,<id>`` builds the main queue of a run over documents
named by hand: those documents, and the controls of the register's entries
naming them, and nothing else. It is for showing the lane's mechanics, or one
change, on a few documents (proof-audit.yml's ``mechanics`` dispatch), never a
verdict on the corpus: the queue names the documents and every group it
leaves out beside the other documents (``selection``: each other control,
and the packages that read the corpus), so a shard counts those as accounted
for and the gate asks to see the entries naming a selected document alone,
saying so (``proof.lane.gate``). One of the documents must carry an edit:
proof 5's check is collected over the edited documents, and the lane refuses
to collect a check with none. The corpus's index is rewritten as for a sample.
One of the documents named must carry an edit: proof 5's check runs over the
edited documents, and a lane collects no check with none to run over.

Each queued group names its key (``key``): a document's document key, a
package's or the surface block's outcome key, which ``proof.store.pack``
keeps its outcome under; and its estimate (``estimate``), which the
planner reads for the longest group a shard holds (``proof.lane.plan``). The
queue records the environment those keys name
(``environment``, ``proof.store.keys.environment``), which ``pack`` holds a
run's recorded one to before it keeps a package group's outcome. The same
inputs write the same bytes.

``--lane-env PROOF_READERS=<readers>`` builds the queues of a run that hands
its states to those readers alone (``proof.lane.readers``; ``0`` for none):
every key names that set, no package whose every test starts a reader the
set leaves out is queued (``readers.PACKAGES``), nor a control only those
readers' register entries name (``proof.checks.registers.held_entries``),
and the queue names the set (``readers``).

Standard library and git only.
"""

from __future__ import annotations

import argparse
import ast
import datetime
import hashlib
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from proof.checks import registers, sharding
from proof.lane import blocks as lane_blocks
from proof.lane import readers as lane_readers
from proof.store import disk, fingerprints, keys, pack

PROOF_DIR = Path(__file__).resolve().parents[1]
KNOWN_DEFECTS = PROOF_DIR / "known-defects.json"
CONTROLS = PROOF_DIR / "controls"
BLOCK_SECONDS = 12.0
# What share of a document's estimate its group costs judged (its checks' judges over stored records) where its
# profile names none (``execution.judged`` in the timings): 24 documents judged took 32.5 s of the 222.9 s they
# took observed without the readers, with every browser run replayed from transcripts (every check, four workers,
# the proof-lane VM). With the readers an observation costs far more and its judging little more, so that
# profile names its own.
JUDGED_SHARE = 0.15
# The (document, configuration) units the audit sample observes fresh.
AUDIT_UNITS = 8
SURFACE = "surface"
EVERY = "every"
# What each package whose tests read the corpus reads of it: ``documents`` (every one, ``EVERY``, or those a test
# module names in a module-level constant, ``(module, constant)``, which the module reads through the corpus's
# index), ``native`` (the native products the corpus carries), or both. A package not named reads both, whole.
PACKAGE_DATA = {
    "proof/checks": {"documents": EVERY},
    "proof/connect": {"documents": ("proof/connect/conftest.py", "DOCUMENTS")},
    "proof/editors": {"documents": ("proof/editors/test_view_equivalence.py", "CORPUS_SAMPLE")},
    "proof/formplayer": {"documents": ("proof/formplayer/conftest.py", "DOCUMENTS")},
    "proof/hq": {"documents": ("proof/hq/test_branches.py", "DOCUMENTS"), "native": EVERY},
    "proof/lane": {"documents": EVERY, "native": EVERY},
    "proof/native": {"native": EVERY},
    "proof/rules": {"documents": ("proof/rules/conftest.py", "DOCUMENTS")},
    "proof/store": {"documents": EVERY},
    "proof/views": {"documents": ("proof/views/conftest.py", "DOCUMENTS")},
    "proof/webapps": {"documents": ("proof/webapps/conftest.py", "DOCUMENTS")},
}
CORPUS_DATA = {"documents": EVERY, "native": EVERY}
# The roles of a B or B-edit that its part key does not read (proof.observe.unit.B_UNREAD_ROLES; test_queue holds
# the two alike: this module reads no module of the observation, which needs more than the standard library).
B_UNREAD = frozenset({"verdict", "document"})


class QueueBuildError(ValueError):
    """A corpus, store or checkout the queue cannot be built from."""


@dataclass
class Group:
    name: str
    estimate: float
    key: str | None = None
    fresh: bool = False
    status: str = "observed"
    judgments: dict = field(default_factory=dict)
    signatures: frozenset = frozenset()
    # What the group costs observed (``estimate`` is less for a judged one).
    observed_estimate: float = 0.0
    # The (document, configuration) units it observes: a document's configurations.
    units: int = 0
    # An Android group's document: the key its record parts are kept under.
    document: str | None = None
    # The configurations a document or control is exported under, by name.
    configurations: tuple[str, ...] = ()
    # The pieces this group follows (``split``): it runs after them, reading what they observed.
    after: tuple[str, ...] = ()
    # Whether the group is a piece: one configuration of a document, observed.
    piece: bool = False

    def __post_init__(self):
        self.observed_estimate = self.estimate


def test_functions(path: Path) -> list[str]:
    """The tests a test module defines, read from its source: its module-level ``test_*`` functions and the
    ``test_*`` methods of its ``Test*`` classes, by name."""
    tree = ast.parse(Path(path).read_text(encoding="utf-8"))
    tests = [node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
            tests += [item.name for item in node.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))]
    return [name for name in tests if name.startswith("test_")]


def package_groups(proof_dir: Path = PROOF_DIR) -> list[str]:
    """Every package group with a test module (``proof.checks.sharding.item_group``'s names): a package's own, each
    module of it ``proof.checks.sharding.SPLIT`` names that keeps a test it does not split off, and each test it
    splits off."""
    found = set()
    if any(proof_dir.glob("test_*.py")):
        found.add("proof")
    for directory in sorted(path for path in proof_dir.iterdir() if path.is_dir()):
        tests = [
            p for p in directory.rglob("test_*.py") if "__pycache__" not in p.parts and "node_modules" not in p.parts
        ]
        if not tests:
            continue
        if directory.name == SURFACE:
            found.add(SURFACE)
            continue
        for test in tests:
            module = test.relative_to(proof_dir).as_posix()
            if module not in sharding.SPLIT:
                found.add(f"proof/{directory.name}")
                continue
            defined = set(test_functions(test))
            found.update(group for group in sharding.split_groups(module) if group.rpartition("::")[2] in defined)
            if defined - set(sharding.SPLIT[module]):
                found.add(f"proof/{module}")
    return sorted(found)


def control_groups(
    known_defects: Path = KNOWN_DEFECTS, controls: Path = CONTROLS, *, readers=True, documents=None
) -> list[str]:
    """The controls the register's held entries name whose directories exist (``proof.checks.cases.control_params``):
    every entry but those whose artifacts the readers a run leaves out write (``readers``, the set it observes;
    ``proof.checks.registers.held_entries``); with ``documents``, only the entries naming one of those."""
    try:
        entries = json.loads(known_defects.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    held = registers.held_entries([entry for entry in entries if isinstance(entry, dict)], readers=readers)
    named = {entry.get("control") for entry in held if documents is None or entry.get("document") in documents}
    return sorted(f"control:{name}" for name in named if isinstance(name, str) and (controls / name).is_dir())


SAMPLE_SEED = re.compile(r"(\d{4})-W(\d{2})")


def sample_week(seed: str) -> int:
    """The ISO week ``seed`` names (``2026-W42``), counted so that each week is one more than the week before."""
    match = SAMPLE_SEED.fullmatch(seed)
    try:
        if match is None:
            raise ValueError("it is not written as a year and a week")
        monday = datetime.date.fromisocalendar(int(match[1]), int(match[2]), 1)
    except ValueError as error:
        raise QueueBuildError(
            f"--sample-seed names the ISO year and week a sample is chosen for, as 2026-W42; got {seed!r} ({error})."
        ) from error
    # Year 1's first day is a Monday, so the Mondays' ordinals are a week apart from 1.
    return monday.toordinal() // 7


def sampled(corpus: Path, count: int, seed: str | None = None) -> list[str]:
    """Keep ``count`` documents, rewriting ``index.json`` to list them alone and the others under ``unsampled``.

    The documents are ranked by the sha256 of their ids, and the sample is a window of that ranking: its first
    ``count`` without a seed, and with one (``sample_week``) the window that week's turn gives, each week the
    next ``count``, wrapping at the ranking's end so every sample holds ``count`` documents.
    """
    path = corpus / "index.json"
    index = json.loads(path.read_text(encoding="utf-8"))
    ranked = sorted(index["documents"], key=lambda entry: hashlib.sha256(f"sample\n{entry['id']}".encode()).hexdigest())
    size = min(count, len(ranked))
    start = (sample_week(seed) % math.ceil(len(ranked) / size)) * size if seed is not None and size else 0
    kept = {ranked[(start + offset) % len(ranked)]["id"] for offset in range(size)}
    left = [entry for entry in index["documents"] if entry["id"] not in kept]
    index["documents"] = [entry for entry in index["documents"] if entry["id"] in kept]
    index["unsampled"] = [*index.get("unsampled", []), *left]
    path.write_text(json.dumps(index, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
    return sorted(kept)


def selected(corpus: Path, identifiers: list[str]) -> list[str]:
    """Keep the documents ``identifiers`` name, rewriting ``index.json`` to list them alone and the others under
    ``unsampled`` (as ``sampled`` does), so the lane collects only those."""
    path = corpus / "index.json"
    index = json.loads(path.read_text(encoding="utf-8"))
    held = {entry["id"] for entry in index["documents"]}
    unknown = sorted(set(identifiers) - held)
    if unknown or not identifiers:
        raise QueueBuildError(
            "--documents only:<id>,<id> names documents of the corpus by their ids; the corpus at"
            f" {corpus} holds no {', '.join(unknown) or 'document named so'}."
        )
    kept = set(identifiers)
    if not any((corpus / identifier / "edit").is_dir() for identifier in kept):
        raise QueueBuildError(
            f"--documents only:{','.join(identifiers)} names no document that carries an edit (an edit/ directory"
            " beside its export/). Proof 5's check runs over the edited documents, and the lane refuses to collect a"
            " check that has none to run over (proof/pytest.ini, empty_parameter_set_mark), so no shard would start"
            " its documents. Name one edited document among them."
        )
    left = [entry for entry in index["documents"] if entry["id"] not in kept]
    index["documents"] = [entry for entry in index["documents"] if entry["id"] in kept]
    index["unsampled"] = [*index.get("unsampled", []), *left]
    path.write_text(json.dumps(index, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
    return sorted(kept)


def declared_documents(root: Path, module: str, constant: str) -> tuple[str, ...] | None:
    """The document ids the test module ``module`` (under the checkout ``root``) names in its module-level
    ``constant``, a string or a tuple or list of them, read from its source; None where it names none so."""
    try:
        tree = ast.parse((Path(root) / module).read_text(encoding="utf-8"))
    except (OSError, SyntaxError, ValueError):
        return None
    for node in tree.body:
        targets = (
            node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        )
        if any(isinstance(target, ast.Name) and target.id == constant for target in targets) and node.value:
            try:
                value = ast.literal_eval(node.value)
            except ValueError:
                return None
            if isinstance(value, str):
                return (value,)
            if isinstance(value, (tuple, list)) and value and all(isinstance(item, str) for item in value):
                return tuple(value)
            return None
    return None


def configuration_names(root: Path) -> tuple[str, ...]:
    """The configurations a document or control is exported under, by name (each directory of its ``export/``, as
    ``proof.checks.corpus.Document.exports`` reads them)."""
    directory = Path(root) / "export"
    if not directory.is_dir():
        return ()
    return tuple(sorted(child.name for child in directory.iterdir() if child.is_dir()))


def configurations_of(root: Path) -> int:
    """How many configurations a document or control is exported under, at least one."""
    return max(1, len(configuration_names(root)))


def signatures(root: Path) -> frozenset:
    """What identifies each record part's inputs, from the document's ``inputs.json``: two documents sharing one
    read the same inputs for that part."""
    path = root / "inputs.json"
    if not path.is_file():
        return frozenset()
    manifest = json.loads(path.read_text(encoding="utf-8"))

    def roles(entries, unread=frozenset()):
        return {role: entry["digest"] for role, entry in sorted(entries.items()) if role not in unread}

    found = set()
    for name, parts in manifest["configurations"].items():
        a = keys.hashed("signature", "a", name, roles(parts["a"]))
        found.add(a)
        for part in ("b", "b_edit"):
            if part in parts:
                found.add(keys.hashed("signature", "b", a, roles(parts[part], B_UNREAD)))
    if manifest.get("local"):
        found.add(keys.hashed("signature", "local", roles(manifest["local"])))
    return frozenset(found)


def _passed(outcome) -> bool:
    if outcome is None or outcome.get("failure") or not outcome.get("items"):
        return False
    return not any(result in lane_blocks.FAILING for result in outcome["items"].values())


class Builder:
    """What one queue is built from: the store, the fingerprints, the timings."""

    def __init__(
        self,
        stores,
        found,
        timings,
        *,
        fresh=False,
        environ=None,
        split_above=None,
        workers=1,
        judged_share=JUDGED_SHARE,
    ):
        self.store = pack.merged([] if fresh else stores)
        self.fingerprints = found
        self.timings = dict(timings)
        self.estimate = sharding.estimate(timings)
        # Each measured document's whole box-seconds, its pieces' with its own (a run that split it measured both).
        self.wholes = sharding.documents(timings)
        # The documents and controls the timings measured in pieces: their own groups' measures are of judging alone.
        self.measured_in_pieces = {piece[0] for piece in map(lane_blocks.piece_of, timings) if piece is not None}
        # The seconds of one worker past which an observed document is queued in pieces (None: never), and the
        # workers a box holds, which the timings' box-seconds are divided by.
        self.split_above = split_above
        self.workers = max(1, int(workers))
        # What share of a document's whole measure its judging costs, where no run measured that alone.
        self.judged_share = judged_share
        # The environment the lane's shards run in: proof/compose.yaml's, with what a run sets beyond it
        # (proof-lane.yml's lane-env, ``--lane-env``), which the keys their records are kept under name.
        self.environ = {**keys.LANE_ENVIRONMENT, **(environ or {})}
        # The readers the shards hand their states to (PROOF_READERS, proof.lane.readers).
        self.readers = lane_readers.named(self.environ)
        self.scope = keys.record_scope(found, self.environ)
        self.document_scope = keys.document_scope(found, self.environ)
        self.fresh = fresh

    def package(self, name: str, data: dict) -> Group:
        group = Group(name, self.estimate(name), fresh=self.fresh)
        if any(value is None for value in data.values()):
            return group
        group.key = keys.package_key(self.fingerprints, self.environ, name, data)
        outcome = None if self.fresh else self.store.index["groups"].get(group.key)
        if _passed(outcome) and (name != SURFACE or self._whole(outcome.get("surface"))):
            group.status, group.judgments = "cached", {"outcome": group.key}
        return group

    def whole(self, name: str) -> float:
        """A document's or control's whole box-seconds observed: measured (its pieces' with its own), else counted
        as an unmeasured document is."""
        return self.wholes[name] if name in self.wholes else self.estimate(name)

    def judging(self, name: str) -> float:
        """What a document's group costs where every part is read from the store: its own measure where a run
        measured it after its pieces, else the profile's judged share of its whole (``judged_share``)."""
        if name in self.timings and name in self.measured_in_pieces:
            return float(self.timings[name])
        return self.whole(name) * self.judged_share

    def document(self, name: str, root: Path, files: str | None = None) -> Group:
        group = Group(name, self.whole(name), fresh=self.fresh, signatures=signatures(root))
        group.configurations = configuration_names(root)
        group.units = configurations_of(root)
        files = files if files is not None else keys.files_digest(root)
        group.key = keys.document_key(self.document_scope, name, files)
        if self.fresh:
            return group
        index = self.store.index
        entry = index["documents"].get(group.key)
        if entry is None or entry["group"] != name:
            return group
        for key, held in entry["parts"].values():
            stored = index["parts"].get(keys.storage_key(self.scope, bytes.fromhex(key)))
            if stored is None or stored["record"] != held:
                return group
        group.status, group.estimate = "judged", round(self.judging(name), 3)
        records = {part: held for part, (_, held) in entry["parts"].items()}
        judged = keys.group_key(group.key, self.fingerprints["judge"], records)
        outcome = index["groups"].get(judged)
        if not _passed(outcome):
            return group
        if not all(self._whole(index["judgments"].get(key)) for key in outcome["judgments"].values()):
            return group
        group.status, group.judgments = "cached", {**outcome["judgments"], "outcome": judged}
        return group

    def _whole(self, digest: str | None) -> bool:
        """Whether the store gives the blob ``digest`` names as those bytes (``proof.store.disk.read_blob``)."""
        return digest is not None and self.store.blob(digest) is not None


def audit_sample(groups: list[Group], seed: str, units: int) -> None:
    """Mark document groups fresh, chosen by the sha256 of the seed and each group's name, until they hold
    ``units`` (document, configuration) units."""
    documents = [group for group in groups if group.name.startswith(lane_blocks.DOCUMENT_KINDS)]
    ranked = sorted(documents, key=lambda group: hashlib.sha256(f"{seed}\n{group.name}".encode()).hexdigest())
    chosen = 0
    for group in ranked:
        if chosen >= units:
            break
        group.fresh = True
        group.status, group.judgments, group.estimate = "observed", {}, group.observed_estimate
        chosen += max(1, group.units)


def split(groups: list[Group], builder: Builder) -> list[Group]:
    """The groups with each observed document and control past the builder's split threshold queued in pieces: one
    group for each configuration it is exported under, and its own group after them (the module's docstring)."""
    if builder.split_above is None:
        return groups
    found = []
    for group in groups:
        whole = group.observed_estimate
        if (
            group.piece
            or not group.name.startswith(lane_blocks.DOCUMENT_KINDS)
            or group.status != "observed"
            or len(group.configurations) < 2
            or whole * builder.workers <= builder.split_above
        ):
            found.append(group)
            continue
        share = sharding.piece_share(len(group.configurations))
        pieces = []
        for configuration in group.configurations:
            name = f"{group.name}@{configuration}"
            measured = builder.timings.get(name)
            piece = Group(
                name,
                round(float(measured) if measured is not None else whole * share, 3),
                fresh=group.fresh,
                signatures=group.signatures,
                piece=True,
            )
            pieces.append(piece)
        group.after = tuple(piece.name for piece in pieces)
        # It reads what its pieces observed, which carry its freshness.
        group.fresh, group.estimate = False, round(builder.judging(group.name), 3)
        found += [*pieces, group]
    return found


def _atoms(groups: list[Group], dedupe: bool) -> list[list[Group]]:
    """The groups that must share a block: those whose record parts share inputs (with ``dedupe``), and always a
    document's own group with the pieces it follows."""
    parent = {group.name: group.name for group in groups}

    def root(name):
        while parent[name] != name:
            parent[name] = parent[parent[name]]
            name = parent[name]
        return name

    if dedupe:
        owner = {}
        for group in sorted(groups, key=lambda group: group.name):
            for signature in sorted(group.signatures):
                if signature in owner:
                    parent[root(group.name)] = root(owner[signature])
                else:
                    owner[signature] = group.name
    for group in sorted(groups, key=lambda group: group.name):
        for piece in group.after:
            parent[root(piece)] = root(group.name)
    atoms = {}
    for group in sorted(groups, key=lambda group: group.name):
        atoms.setdefault(root(group.name), []).append(group)
    return list(atoms.values())


def blocks(groups: list[Group], *, dedupe: bool = True, capacity: float = BLOCK_SECONDS) -> list[lane_blocks.Block]:
    """The running groups packed first-fit, longest first, into blocks of about ``capacity`` box-seconds."""
    atoms = sorted(_atoms(groups, dedupe), key=lambda atom: (-round(sum(g.estimate for g in atom), 6), atom[0].name))
    bins: list[list[Group]] = []
    loads: list[float] = []
    for atom in atoms:
        weight = sum(group.estimate for group in atom)
        index = next((i for i, load in enumerate(loads) if load + weight <= capacity), None)
        if weight >= capacity or index is None:
            bins.append(list(atom))
            loads.append(weight)
        else:
            bins[index] += atom
            loads[index] += weight
    found = []
    for members in bins:
        names = sorted(group.name for group in members)
        found.append(
            lane_blocks.Block(
                lane_blocks.block_id(names),
                round(sum(group.estimate for group in members), 3),
                tuple(
                    lane_blocks.QueuedGroup(group.name, group.fresh, group.after, round(group.estimate, 3))
                    for group in sorted(members, key=_by_name)
                ),
            )
        )
    return sorted(found, key=lambda block: (-block.estimate, block.id))


def _by_name(group: Group) -> str:
    return group.name


def queue_value(
    groups: list[Group],
    found: dict,
    *,
    dedupe: bool = True,
    unsampled=(),
    readers: bool = True,
    environment=None,
    sample: lane_blocks.Sample | None = None,
    selection: lane_blocks.Selection | None = None,
) -> dict:
    running = [group for group in groups if group.status != "cached"]
    by_name = {group.name: group for group in groups}
    packed = blocks(running, dedupe=dedupe)
    value = lane_blocks.queue_json(
        lane_blocks.Queue(
            tuple(packed),
            tuple(
                lane_blocks.CachedGroup(group.name, dict(sorted(group.judgments.items())))
                for group in sorted(groups, key=_by_name)
                if group.status == "cached"
            ),
            dict(sorted(found.items())),
            tuple(sorted(unsampled)),
            readers,
            sample,
            selection,
        )
    )
    for block in value["blocks"]:
        for queued in block["groups"]:
            # Each group carries its share of its block's estimate (lane_blocks.QueuedGroup.estimate): a group runs
            # on one worker, so the planner reads how long a shard's longest group is (proof.lane.plan).
            if by_name[queued["group"]].key is not None:
                queued["key"] = by_name[queued["group"]].key
            if by_name[queued["group"]].document is not None:
                queued["document"] = by_name[queued["group"]].document
    value["classes"] = {
        status: sorted(group.name for group in groups if group.status == status and not group.piece)
        for status in ("cached", "judged", "observed")
    }
    pieces = sorted(group.name for group in groups if group.piece)
    if pieces:
        # The configurations observed by a group of their own, each for its document's group to judge.
        value["pieces"] = pieces
    value["fresh"] = sorted(group.name for group in groups if group.fresh)
    # The environment every key above names (proof.store.keys.environment), which proof.store.pack holds a run's to.
    value["environment"] = keys.environment(keys.LANE_ENVIRONMENT if environment is None else environment)
    return value


def queued_packages(builder: Builder, proof_dir: Path = PROOF_DIR) -> list[str]:
    """The package groups with a test module, but those of a package whose every test starts a reader the run
    leaves out (``proof.lane.readers.PACKAGES``), of which such a run collects nothing."""
    return [
        name
        for name in package_groups(proof_dir)
        if lane_readers.PACKAGES.get(lane_blocks.package_of(name), frozenset()) <= builder.readers
    ]


def early(builder: Builder, proof_dir: Path = PROOF_DIR) -> list[Group]:
    return [
        builder.package(name, {}) for name in queued_packages(builder, proof_dir) if not lane_blocks.reads_corpus(name)
    ]


def package_data(name: str, corpus: Path, files: dict[str, str], checkout: Path) -> dict:
    """What the package group ``name`` reads of the corpus, as digests (``PACKAGE_DATA``): a module or test a
    package's group splits off reads what its package reads."""
    found = {}
    for kind, read in PACKAGE_DATA.get(lane_blocks.package_of(name), CORPUS_DATA).items():
        if kind == "native":
            found[kind] = keys.native_digest(corpus)
            continue
        named = None if read == EVERY else declared_documents(checkout, *read)
        if named is None:
            found[kind] = keys.documents_digest(corpus, files)
        else:
            sample = {identifier: files.get(identifier) for identifier in named}
            found[kind] = keys.hashed("sample", keys.VERSION, keys.index_digest(corpus), sorted(sample.items()))
    return found


def main_groups(builder: Builder, corpus: Path, proof_dir: Path = PROOF_DIR, *, only=None) -> list[Group]:
    """The main queue's groups over the corpus as its index lists it; with ``only`` (the documents a run names by
    hand, which the index then lists alone), those documents and the controls of the entries naming them."""
    corpus = Path(corpus)
    listed = keys.corpus_documents(corpus)
    # The documents a sample left out are not queued, and a package that names one reads it, so its key reads them.
    emitted = [*listed, *lane_blocks.unsampled_documents(corpus)]
    files = {identifier: keys.files_digest(corpus / identifier) for identifier in emitted}
    groups = [builder.document(f"corpus:{identifier}", corpus / identifier, files[identifier]) for identifier in listed]
    register, controls = proof_dir / "known-defects.json", proof_dir / "controls"
    for name in control_groups(register, controls, readers=builder.readers, documents=only):
        groups.append(builder.document(name, proof_dir / "controls" / name.partition(":")[2]))
    if only is not None:
        return groups
    for name in queued_packages(builder, proof_dir):
        if lane_blocks.reads_corpus(name):
            groups.append(builder.package(name, package_data(name, corpus, files, Path(proof_dir).parent)))
    return groups


def selection_left(builder: Builder, groups: list[Group], proof_dir: Path = PROOF_DIR) -> list[str]:
    """The groups a run over documents named by hand leaves out beside the other documents: each control it does
    not queue, and the packages that read the corpus."""
    queued = {group.name for group in groups}
    every = control_groups(proof_dir / "known-defects.json", proof_dir / "controls", readers=builder.readers)
    every += [name for name in queued_packages(builder, proof_dir) if lane_blocks.reads_corpus(name)]
    return sorted(set(every) - queued)


def split_threshold(named: str | None, execution: dict) -> float | None:
    """The seconds of one worker past which an observed document is queued in pieces: ``--split-above``'s where
    it is given (``none`` for never), else the profile's (``execution.split``), else never."""
    if named is None:
        named = execution.get("split")
        if named is None:
            return None
    if named == "none":
        return None
    try:
        seconds = float(named)
    except (TypeError, ValueError):
        seconds = -1.0
    if isinstance(named, bool) or seconds < 0 or seconds != seconds:
        raise QueueBuildError(
            "The split threshold is the seconds of one worker past which a document is observed in pieces, or"
            f" none (--split-above, or the profile's execution.split in the timings); got {named!r}."
        )
    return seconds


def judged_share(execution: dict) -> float:
    """What share of a document's whole measure its judging costs in the profile (``execution.judged``),
    ``JUDGED_SHARE`` where it names none."""
    named = execution.get("judged", JUDGED_SHARE)
    if isinstance(named, bool) or not isinstance(named, (int, float)) or not 0 < named <= 1:
        raise QueueBuildError(
            "The profile's execution.judged in the timings is the share of a document's whole measure its judging"
            f" costs, above 0 and at most 1; got {named!r}."
        )
    return float(named)


def described_sample(sample: lane_blocks.Sample, corpus_documents: int) -> str:
    """A sample as a run's summary names it: its seed, how to run it again, and its documents."""
    chosen = (
        f"the one the seed `{sample.seed}` chooses (`--sample-seed {sample.seed}` runs the same sample again)"
        if sample.seed is not None
        else "the first of the ranking (no seed was named)"
    )
    return (
        f"This run checks a sample of {len(sample.documents)} of the corpus's {corpus_documents} documents, {chosen}:"
        f" {', '.join(sample.documents)}."
    )


def write_queue(path: Path, value: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent="\t", sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m proof.store.queue", description=__doc__.splitlines()[0])
    parser.add_argument("phase", choices=["early", "main"])
    parser.add_argument("--corpus", type=Path, help="the emitted corpus (main)")
    parser.add_argument("--store", action="append", type=Path, default=[], help="a store snapshot to read")
    parser.add_argument("--timings", type=Path, default=sharding.TIMINGS)
    parser.add_argument("--arch", choices=fingerprints.ARCHES, help="the shards' architecture")
    parser.add_argument("--image", help="the image's digest or id (the lock's by default)")
    parser.add_argument("--root", type=Path, default=fingerprints.WORKTREE, help="the checkout")
    parser.add_argument("--audit-seed", help="what chooses the audit sample (the run's id)")
    parser.add_argument("--audit-units", type=int, default=AUDIT_UNITS)
    parser.add_argument("--fresh", action="store_true", help="every group fresh, nothing read from the store")
    parser.add_argument("--no-dedupe", action="store_true", help="no two documents share a block for their inputs")
    parser.add_argument("--documents", default="all", help="all, or sample:N")
    parser.add_argument("--sample-seed", help="the ISO year and week that chooses a sample's window (2026-W42)")
    parser.add_argument(
        "--split-above",
        metavar="SECONDS",
        help="queue in pieces each observed document and control whose whole measure on one worker is past this"
        " many seconds (the profile's execution.split in --timings by default; none for no pieces)",
    )
    parser.add_argument(
        "--lane-env",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="a variable the lane's shards run with beyond proof/compose.yaml's (proof-lane.yml's lane-env): the"
        " keys their records are kept under name it",
    )
    parser.add_argument("--out", required=True, type=Path)
    arguments = parser.parse_args(argv)
    started = time.perf_counter()
    try:
        if arguments.phase == "main" and arguments.corpus is None:
            raise QueueBuildError(
                f"The {arguments.phase} queue holds the corpus's documents: name the corpus with --corpus."
            )
        sample, only = None, None
        kind, _, count = arguments.documents.partition(":")
        if arguments.sample_seed is not None and kind != "sample":
            raise QueueBuildError("--sample-seed chooses a sample's window, and --documents names no sample.")
        if arguments.documents != "all":
            if kind == "only" and arguments.phase == "main":
                only = selected(arguments.corpus, [name for name in count.split(",") if name])
            elif kind != "sample" or not count.isdecimal() or int(count) < 1 or arguments.phase != "main":
                raise QueueBuildError(
                    f"--documents is all, sample:N or only:<id>,<id> for the main queue; got {arguments.documents!r}."
                )
            else:
                sample = lane_blocks.Sample(
                    tuple(sampled(arguments.corpus, int(count), arguments.sample_seed)), arguments.sample_seed
                )
        environ = {}
        for assignment in arguments.lane_env:
            name, equals, value = assignment.partition("=")
            if not equals or not name:
                raise QueueBuildError(
                    f"--lane-env takes NAME=VALUE, as a lane-env line is written; got {assignment!r}."
                )
            environ[name] = value
        found = fingerprints.compute(arguments.root, arch=arguments.arch, image=arguments.image)
        execution = sharding.load_execution(arguments.timings, readers=lane_readers.served(environ))
        builder = Builder(
            arguments.store,
            found,
            sharding.load_timings(arguments.timings, readers=lane_readers.served(environ)),
            fresh=arguments.fresh,
            environ=environ,
            split_above=split_threshold(arguments.split_above, execution),
            workers=execution.get("workers", 1),
            judged_share=judged_share(execution),
        )
        proof_dir = Path(arguments.root) / "proof"
        unsampled, selection = (), None
        if arguments.phase == "early":
            groups = early(builder, proof_dir)
        else:
            groups = main_groups(builder, arguments.corpus, proof_dir, only=only)
            if only is None:
                unsampled = lane_blocks.unsampled_documents(arguments.corpus)
            else:
                # The other documents are no sample's remainder: nothing of them is held, on a control or anywhere.
                selection = lane_blocks.Selection(tuple(only), tuple(selection_left(builder, groups, proof_dir)))
            if arguments.audit_seed and not arguments.fresh:
                audit_sample(groups, arguments.audit_seed, arguments.audit_units)
            groups = split(groups, builder)
        dedupe = not arguments.no_dedupe
        value = queue_value(
            groups,
            found,
            dedupe=dedupe,
            unsampled=unsampled,
            readers=builder.readers,
            environment=builder.environ,
            sample=sample,
            selection=selection,
        )
        write_queue(arguments.out, value)
    except (QueueBuildError, fingerprints.FingerprintError, disk.StoreFormatError, sharding.ShardError) as error:
        print(error, file=sys.stderr)
        return 2
    classes = ", ".join(f"{len(names)} {status}" for status, names in value["classes"].items())
    if value.get("pieces"):
        split_documents = sorted({name.partition("@")[0] for name in value["pieces"]})
        classes += f" ({len(split_documents)} of them in {len(value['pieces'])} pieces)"
    left_out = f"; {len(value['unsampled'])} documents left out of the sample" if value.get("unsampled") else ""
    profile = "" if builder.readers == lane_readers.EVERY else f" (for {lane_readers.described(builder.readers)})"
    print(
        f"The {arguments.phase} queue{profile} holds {len(value['blocks'])} blocks; {classes}; {len(value['fresh'])}"
        f" fresh{left_out}; built in {time.perf_counter() - started:.2f} s."
    )
    if selection is not None:
        print(
            f"This run checks the documents named by hand ({', '.join(selection.documents)}) and their controls,"
            f" and leaves {len(selection.left)} other groups out: it is no verdict on the corpus."
        )
    if sample is not None:
        said = described_sample(sample, len(sample.documents) + len(value.get("unsampled", ())))
        print(said)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as output:
                output.write(f"## Corpus sample\n\n{said}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
