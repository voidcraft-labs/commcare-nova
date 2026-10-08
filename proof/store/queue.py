"""``python3 -m proof.store.queue``: the lane's two queues, each group run, judged or read from the store.

    python3 -m proof.store.queue early [--store DIR]... [--timings FILE] [--arch A] [--image I] [--fresh]
        --out FILE
    python3 -m proof.store.queue main --corpus DIR [--store DIR]... [--timings FILE] [--arch A] [--image I]
        [--audit-seed TEXT] [--audit-units N] [--fresh] [--no-dedupe] [--documents all|sample:N] --out FILE
    python3 -m proof.store.queue android --corpus DIR [--store DIR]... [--timings FILE] [--arch A] [--image I]
        [--android-platform P] [--observed OUTPUT]... [--fresh] --out FILE

The early queue holds the groups whose tests read no corpus
(``proof.lane.blocks.reads_corpus``): the surface block and every other
package with tests. The main queue holds every document of the corpus
(``corpus:<id>``; the corpus's ``native/`` is its products, not a document),
every control the known-defect register names (``control:<id>``), and the
packages in ``proof.lane.blocks.CORPUS_PACKAGES``. A group no test belongs to
(``hq-selfchecks``) is never queued: the lane would find nothing of it.

The Android queue holds each document's Android group (``android:corpus:<id>``)
and that of each control an entry of the Android stage names
(``android_groups``): built with the main queue, from the same corpus (after
any sample is taken, so it lists the same documents), and run by the Android
stage once the main queue's shards have observed the documents
(``proof.android.stage``).

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

A document split by configuration (``corpus:<id>@<configuration>``) is never
queued: the checks give each document one item per check, over every
configuration (``proof.checks.cases.document_params``), so such a group
would collect nothing.

Blocks hold the groups that run. Two documents that share any record part's
inputs (``signatures``) are put in one block, so the second reads what the
first kept in its run's delta (``--no-dedupe`` puts each in its own); the
groups are then packed first-fit, longest first, into blocks of about
``BLOCK_SECONDS`` box-seconds, from ``--timings`` (a judged document counts
``JUDGED_SHARE`` of its estimate), and the blocks are listed longest first.

``--audit-seed`` (the run's id) marks documents fresh, chosen by sha256 of
the seed and each group, until they hold ``--audit-units`` (document,
configuration) units: each runs, observing every part of every configuration
and holding it to the store (``proof.store.runtime``). ``--fresh`` marks
every group fresh and reads nothing from the store (the nightly audit).

A package whose tests read the corpus is keyed by what they read of it
(``PACKAGE_DATA``): the corpus's documents, or only those a test module
names in a constant (read from its source, never imported), with the
corpus's index; and the native products it carries.
``--documents sample:N`` keeps N documents, chosen by sha256 of their ids,
and rewrites the corpus's ``index.json`` to list them alone, so the lane
collects only those, and the rest under ``unsampled``: their files stay, so
a package test that names one still reads it, and the queue names them
(``unsampled``), so the gate holds the register's entries naming one on
their controls alone (``proof.checks.registers.verify_evidence``).

Each queued group names its key (``key``): a document's document key, a
package's or the surface block's outcome key, which ``proof.store.pack``
keeps its outcome under. The same inputs write the same bytes.

Standard library and git only.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from proof.checks import sharding
from proof.lane import blocks as lane_blocks
from proof.store import disk, fingerprints, keys, pack

PROOF_DIR = Path(__file__).resolve().parents[1]
KNOWN_DEFECTS = PROOF_DIR / "known-defects.json"
CONTROLS = PROOF_DIR / "controls"
BLOCK_SECONDS = 12.0
# What share of a document's estimate its group costs judged (its checks' judges over stored records): 24
# documents judged took 32.5 s of the 222.9 s they took observed with every browser run replayed from transcripts
# (every check, four workers, the proof-lane VM).
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

    def __post_init__(self):
        self.observed_estimate = self.estimate


def package_groups(proof_dir: Path = PROOF_DIR) -> list[str]:
    """Every package group with a test module (``proof.checks.sharding.item_group``'s names)."""
    found = set()
    if any(proof_dir.glob("test_*.py")):
        found.add("proof")
    for directory in sorted(path for path in proof_dir.iterdir() if path.is_dir()):
        tests = [
            p for p in directory.rglob("test_*.py") if "__pycache__" not in p.parts and "node_modules" not in p.parts
        ]
        if tests:
            found.add(SURFACE if directory.name == SURFACE else f"proof/{directory.name}")
    return sorted(found)


def control_groups(known_defects: Path = KNOWN_DEFECTS, controls: Path = CONTROLS) -> list[str]:
    """The controls the register names whose directories exist (``proof.checks.cases.control_params``)."""
    try:
        entries = json.loads(known_defects.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    named = {entry.get("control") for entry in entries if isinstance(entry, dict)}
    return sorted(f"control:{name}" for name in named if isinstance(name, str) and (controls / name).is_dir())


def sampled(corpus: Path, count: int) -> list[str]:
    """Keep ``count`` documents, chosen by the sha256 of their ids, rewriting ``index.json`` to list them alone and
    the others under ``unsampled``."""
    path = corpus / "index.json"
    index = json.loads(path.read_text(encoding="utf-8"))
    ranked = sorted(index["documents"], key=lambda entry: hashlib.sha256(f"sample\n{entry['id']}".encode()).hexdigest())
    kept = {entry["id"] for entry in ranked[:count]}
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


def configurations_of(root: Path) -> int:
    """How many configurations a document or control is exported under (each directory of its ``export/``, as
    ``proof.checks.corpus.Document.exports`` reads them), at least one."""
    directory = Path(root) / "export"
    if not directory.is_dir():
        return 1
    return max(1, sum(1 for child in directory.iterdir() if child.is_dir()))


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

    def __init__(self, stores, found, timings, *, fresh=False):
        self.store = pack.merged([] if fresh else stores)
        self.fingerprints = found
        self.estimate = sharding.estimate(timings)
        self.scope = keys.record_scope(found, keys.LANE_ENVIRONMENT)
        self.document_scope = keys.document_scope(found, keys.LANE_ENVIRONMENT)
        self.fresh = fresh

    def package(self, name: str, data: dict) -> Group:
        group = Group(name, self.estimate(name), fresh=self.fresh)
        if any(value is None for value in data.values()):
            return group
        group.key = keys.package_key(self.fingerprints, keys.LANE_ENVIRONMENT, name, data)
        outcome = None if self.fresh else self.store.index["groups"].get(group.key)
        if _passed(outcome) and (name != SURFACE or self._whole(outcome.get("surface"))):
            group.status, group.judgments = "cached", {"outcome": group.key}
        return group

    def document(self, name: str, root: Path, files: str | None = None) -> Group:
        group = Group(name, self.estimate(name), fresh=self.fresh, signatures=signatures(root))
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
        group.status, group.estimate = "judged", round(group.estimate * JUDGED_SHARE, 3)
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


def _atoms(groups: list[Group], dedupe: bool) -> list[list[Group]]:
    """The groups that must share a block: those whose record parts share inputs (with ``dedupe``)."""
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
                tuple(lane_blocks.QueuedGroup(group.name, group.fresh) for group in sorted(members, key=_by_name)),
            )
        )
    return sorted(found, key=lambda block: (-block.estimate, block.id))


def _by_name(group: Group) -> str:
    return group.name


def queue_value(groups: list[Group], found: dict, *, dedupe: bool = True, unsampled=()) -> dict:
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
        )
    )
    for block in value["blocks"]:
        for queued in block["groups"]:
            if by_name[queued["group"]].key is not None:
                queued["key"] = by_name[queued["group"]].key
            if by_name[queued["group"]].document is not None:
                queued["document"] = by_name[queued["group"]].document
    value["classes"] = {
        status: sorted(group.name for group in groups if group.status == status)
        for status in ("cached", "judged", "observed")
    }
    value["fresh"] = sorted(group.name for group in groups if group.fresh)
    return value


def early(builder: Builder, proof_dir: Path = PROOF_DIR) -> list[Group]:
    return [builder.package(name, {}) for name in package_groups(proof_dir) if not lane_blocks.reads_corpus(name)]


def package_data(name: str, corpus: Path, files: dict[str, str], checkout: Path) -> dict:
    """What the package ``name`` reads of the corpus, as digests (``PACKAGE_DATA``)."""
    found = {}
    for kind, read in PACKAGE_DATA.get(name, CORPUS_DATA).items():
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


def main_groups(builder: Builder, corpus: Path, proof_dir: Path = PROOF_DIR) -> list[Group]:
    corpus = Path(corpus)
    listed = keys.corpus_documents(corpus)
    # The documents a sample left out are not queued, and a package that names one reads it, so its key reads them.
    emitted = [*listed, *lane_blocks.unsampled_documents(corpus)]
    files = {identifier: keys.files_digest(corpus / identifier) for identifier in emitted}
    groups = [builder.document(f"corpus:{identifier}", corpus / identifier, files[identifier]) for identifier in listed]
    for name in control_groups(proof_dir / "known-defects.json", proof_dir / "controls"):
        groups.append(builder.document(name, proof_dir / "controls" / name.partition(":")[2]))
    for name in package_groups(proof_dir):
        if lane_blocks.reads_corpus(name):
            groups.append(builder.package(name, package_data(name, corpus, files, Path(proof_dir).parent)))
    return groups


def android_controls(known_defects: Path = KNOWN_DEFECTS, controls: Path = CONTROLS) -> list[str]:
    """The controls an entry of the Android stage names (an ``android@...`` artifact,
    ``proof.checks.registers.stage_of``) whose directories exist: the stage runs each for the checks naming it."""
    try:
        entries = json.loads(known_defects.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    named = {
        entry.get("control")
        for entry in entries
        if isinstance(entry, dict) and str(entry.get("artifact", "")).startswith("android@")
    }
    return sorted(f"control:{name}" for name in named if isinstance(name, str) and (controls / name).is_dir())


def android_groups(
    builder: Builder, corpus: Path, reader: str, proof_dir: Path = PROOF_DIR, *, observed=None
) -> list[Group]:
    """Each document's Android group (``android:corpus:<id>``, and ``android:control:<id>`` for each control an
    Android entry names): cached where the store holds its outcome, every item passed, and each judge's
    evidence whole, under its key; else run by the Android stage (``proof.android.stage``).

    Its key names the document's key (so every record its archives are read from), the reader
    (``proof.android.records.fingerprint``, on the platform the stage runs on) and the judge's code with both
    registers. ``document`` on a group is its document's key, which the stage finds its records under.
    """
    corpus = Path(corpus)
    documents = {f"corpus:{identifier}": corpus / identifier for identifier in keys.corpus_documents(corpus)}
    for name in android_controls(proof_dir / "known-defects.json", proof_dir / "controls"):
        documents[name] = proof_dir / "controls" / name.partition(":")[2]
    if observed is not None:
        # A run over part of the corpus on one machine: only the documents its outputs hold records of.
        # Each is read under the key that run kept it under, whatever this checkout's own would be.
        held = {
            entry["group"]: key
            for output in observed
            for key, entry in disk.Delta(Path(output) / disk.DELTA).entries("documents").items()
        }
        documents = {name: root for name, root in documents.items() if name in held}
    groups = []
    for name, root in sorted(documents.items()):
        document = (
            held[name]
            if observed is not None
            else keys.document_key(builder.document_scope, name, keys.files_digest(root))
        )
        group = Group(f"{lane_blocks.ANDROID}{name}", builder.estimate(f"{lane_blocks.ANDROID}{name}"), fresh=builder.fresh)
        group.key = keys.hashed("android-group", keys.VERSION, document, reader, builder.fingerprints["judge"])
        group.document = document
        outcome = None if builder.fresh else builder.store.index["groups"].get(group.key)
        if _passed(outcome) and all(
            builder._whole(builder.store.index["judgments"].get(key)) for key in outcome["judgments"].values()
        ):
            group.status, group.judgments = "cached", {**outcome["judgments"], "outcome": group.key}
        groups.append(group)
    return groups


def write_queue(path: Path, value: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent="\t", sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m proof.store.queue", description=__doc__.splitlines()[0])
    parser.add_argument("phase", choices=["early", "main", "android"])
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
    parser.add_argument(
        "--observed",
        action="append",
        type=Path,
        help="a lane run's output (android): queue only the documents it holds records of, for a run on one"
        " machine over part of the corpus",
    )
    parser.add_argument(
        "--android-platform",
        default="linux-amd64",
        help="where the Android stage runs its reader (android), as the reader's fingerprint names it; host for"
        " this machine's",
    )
    parser.add_argument("--out", required=True, type=Path)
    arguments = parser.parse_args(argv)
    started = time.perf_counter()
    try:
        if arguments.phase in ("main", "android") and arguments.corpus is None:
            raise QueueBuildError(
                f"The {arguments.phase} queue holds the corpus's documents: name the corpus with --corpus."
            )
        if arguments.documents != "all":
            kind, _, count = arguments.documents.partition(":")
            if kind != "sample" or not count.isdecimal() or int(count) < 1 or arguments.phase != "main":
                raise QueueBuildError(
                    f"--documents is all or sample:N for the main queue; got {arguments.documents!r}."
                )
            sampled(arguments.corpus, int(count))
        found = fingerprints.compute(arguments.root, arch=arguments.arch, image=arguments.image)
        builder = Builder(arguments.store, found, sharding.load_timings(arguments.timings), fresh=arguments.fresh)
        proof_dir = Path(arguments.root) / "proof"
        unsampled = ()
        if arguments.phase == "early":
            groups = early(builder, proof_dir)
        elif arguments.phase == "android":
            from proof.android import records as android_records

            platform = arguments.android_platform
            if platform == "host":
                platform = android_records.host_platform()
            reader = android_records.fingerprint(platform, root=proof_dir / "android")
            groups = android_groups(builder, arguments.corpus, reader, proof_dir, observed=arguments.observed)
            unsampled = lane_blocks.unsampled_documents(arguments.corpus)
            found = {**found, "android": reader}
        else:
            groups = main_groups(builder, arguments.corpus, proof_dir)
            unsampled = lane_blocks.unsampled_documents(arguments.corpus)
            if arguments.audit_seed and not arguments.fresh:
                audit_sample(groups, arguments.audit_seed, arguments.audit_units)
        dedupe = not arguments.no_dedupe and arguments.phase != "android"
        value = queue_value(groups, found, dedupe=dedupe, unsampled=unsampled)
        write_queue(arguments.out, value)
    except (QueueBuildError, fingerprints.FingerprintError, disk.StoreFormatError, sharding.ShardError) as error:
        print(error, file=sys.stderr)
        return 2
    classes = ", ".join(f"{len(names)} {status}" for status, names in value["classes"].items())
    left_out = f"; {len(value['unsampled'])} documents left out of the sample" if value.get("unsampled") else ""
    print(
        f"The {arguments.phase} queue holds {len(value['blocks'])} blocks; {classes}; {len(value['fresh'])} fresh"
        f"{left_out}; built in {time.perf_counter() - started:.2f} s."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
