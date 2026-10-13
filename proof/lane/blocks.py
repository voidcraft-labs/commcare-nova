"""The queue a lane runs, and what a block's run leaves in a shard's output.

Standard library only: the gate reads both on the runner's own Python, with
no image (``proof.lane.gate``).

The queue (``version`` 1) is built by the evidence store's queue builder, or,
for a run without one, by the server from its own collection
(``single_block``, or ``block_per_group`` for runs splitting it by bins)::

    {"version": 1,
     "fingerprints": {"observation": ..., "browser": ..., "judge": ..., "image": ..., "postgres": ..., "arch": ...},
     "blocks": [{"id": <block_id of its groups>, "estimate": <box-seconds>,
                 "groups": [{"group": <group>, "fresh": <bool>, "after": [<piece>, ...]}, ...]}, ...],
     "cached": [{"group": <group>, "judgments": {<check>: <judgment key>}}, ...],
     "unsampled": [<document id>, ...],
     "sample": {"seed": <ISO year and week> | null, "documents": [<document id>, ...]},
     "selection": {"documents": [<document id>, ...], "left": [<group>, ...]},
     "readers": false | [<reader>, ...]}

A lane has two queues: the early queue, of groups whose tests need no corpus
(from ``proof-plan``), and the main queue (from ``quality``, once the corpus
is emitted). A group is every item of one corpus document (``corpus:<id>``) or
control (``control:<id>``), one piece of either (``corpus:<id>@<configuration>``,
``control:<id>@<configuration>``: one configuration of it observed, below), of one
package (``proof``, ``proof/<package>``), of one test module a package's
group splits off (``proof/<package>/<module>.py``) or one test of it
(``proof/<package>/<module>.py::<test>``, ``proof.checks.sharding.SPLIT``),
the surface block (``surface``), or the HQ self-checks (``hq-selfchecks``);
``proof.checks.sharding.item_group`` names the group of a collected item. A block's id is the sha256 of its
groups' names, sorted and joined by newlines (``block_id``), so the id names
what the block holds. A cached group is one whose every judgment the store
holds: it runs nowhere, and the gate reads its judgments from the store. A
block's groups may carry their own ``estimate`` (the queue builder writes
it), which the planner reads for the longest group a shard holds
(``proof.lane.plan``) and a shard hands its groups out by, longest first
(``proof.lane.broker``).

Pieces. A document or control heavy enough is observed in pieces
(``proof.store.queue``): each configuration it is exported under is a group
of its own, one item that observes that configuration whole into the run's
evidence store (``proof.checks.pieces``), and the document's own group names
them (``after``) and runs once each has passed, reading every part they kept
and observing nothing, so its checks judge the document whole as they do
unsplit. The pieces run on different workers of the shard that holds their
block, so no one worker carries the whole document. ``parse_queue`` holds a
queue to that shape: a piece is in its document's block, the document's group
follows every piece of it the block holds, a piece follows nothing, and a
group that follows pieces is never fresh (it reads what they observed; they
carry the freshness).

``unsampled``, only in the queue of a run over a sample of the corpus
(``proof.store.queue.sampled``), names the corpus documents the sample
leaves out (``unsampled_documents``): none of them runs, and the gate holds
the register's entries naming one on their controls alone. ``sample``, in
the same queue, names the documents the sample kept and the seed that chose
them, so a verdict says which sample it judged and how to run it again.
``selection``, only in the queue of a run over documents named by hand
(``proof.store.queue``, ``--documents only:<ids>``: a run that shows the lane's
mechanics or one change on a few documents, never a verdict on the corpus),
names those documents and the groups the run leaves out beside the other
documents (``left``: every other control, and the packages that read the
corpus): a shard counts those as accounted for, and the gate holds only the
register's entries naming a selected document, on it and on its control,
saying how many it left. ``readers``, only
in the queue of a run that observes not every reader (``PROOF_READERS``,
``proof.lane.readers``), is false for none or the list of those it observes:
the server refuses a queue built for another set than its own, and the gate
leaves the register's entries only the other readers show to the nightly.

A block's run leaves ``blocks/<id>/`` in the output of the shard that ran it:

- ``block.json``, its manifest: the block, the phase and shard that ran it,
  and for each group the items the worker collected for it, each item's
  outcome, the worker, its seconds, and why it failed when a worker could
  not finish it;
- ``checks/<check>/<kind>-<id>.json``, the evidence its checks wrote
  (``proof.checks.cases.evidence``), which the register is held to;
- ``surface/surface.json``, the surface block's extraction;
- whatever else its groups wrote under ``PROOF_OUT`` (the store's delta,
  editor records, a family's native artifacts).

``serve.json`` at the top of each output records the shard: its fixed costs,
the threads present at each fork, each phase's collection, its claims and
its workers (``proof.lane.serve``).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

from proof.lane import readers as lane_readers

QUEUE_VERSION = 1
MANIFEST_VERSION = 1
BLOCKS = "blocks"
MANIFEST = "block.json"
SERVE = "serve.json"
DOCUMENT_KINDS = ("corpus:", "control:")
# The packages whose tests read the corpus (``proof.checks.cases``,
# ``proof.checks.corpus``) or the native products it carries as ``native/``
# (``proof.native.produce``), each through a test module or a conftest:
# checks' own tests, the editors' corpus sample, HQ's branches and publish
# capture, the lane's nested servers, every native family, the spelling
# rules' own tests (the documents they spell two ways), the Connect proofs
# (the Connect apps they run), the evidence store's guarded observation
# of a document. Like a document's group, each runs in the main phase,
# once the corpus is in place.
CORPUS_PACKAGES = (
    "proof/checks",
    "proof/connect",
    "proof/editors",
    "proof/formplayer",
    "proof/hq",
    "proof/lane",
    "proof/native",
    "proof/rules",
    "proof/store",
    "proof/views",
    "proof/webapps",
)
SINGLE_GROUPS = ("proof", "surface", "hq-selfchecks")
# The outcomes of one item's run (``proof.lane.plugin``) that fail the lane.
FAILING = ("failed", "error")
# A block's output compared where two runs of it differ: its evidence and the surface extraction.
COMPARED = ("checks", "surface/surface.json")


class QueueError(ValueError):
    """A queue file that is not a lane's queue."""


def group_problem(name) -> str | None:
    """Why ``name`` is not a group a queue may name, or None when it is one."""
    if not isinstance(name, str) or not name:
        return f"a group is a non-empty name, and {name!r} is not"
    if name in SINGLE_GROUPS:
        return None
    if name.startswith("proof/"):
        package, _, module = name[len("proof/") :].partition("/")
        if not package.isidentifier():
            return f"{name!r} names no package directly under proof/"
        if not module:
            return None
        path, _, test = module.partition("::")
        if (
            path.endswith(".py")
            and path.rpartition("/")[2].startswith("test_")
            and not any(character.isspace() for character in path)
            and (not test and "::" not in module or test.isidentifier())
        ):
            return None
        return f"{name!r} names no test module of a package (proof/<package>/<module>.py) or test of one (::<test>)"
    for kind in DOCUMENT_KINDS:
        if name.startswith(kind):
            rest = name[len(kind) :]
            document, _, configuration = rest.partition("@")
            if not document or any(character.isspace() for character in rest):
                return f"{name!r} names no document"
            if "@" in rest and (not configuration or "@" in configuration):
                return f"{name!r} names no one configuration of its document ({kind}<id>@<configuration>)"
            return None
    return (
        f"{name!r} is none of corpus:<id>, control:<id>, a piece of one (corpus:<id>@<configuration>,"
        " control:<id>@<configuration>), proof, proof/<package>, proof/<package>/<module>.py[::<test>], surface or"
        " hq-selfchecks"
    )


def piece_of(name: str) -> tuple[str, str] | None:
    """The document's or control's group and the configuration a piece names (``corpus:<id>@<configuration>``), or
    None for any other group."""
    if not isinstance(name, str) or not name.startswith(DOCUMENT_KINDS):
        return None
    whole, at, configuration = name.partition("@")
    return (whole, configuration) if at else None


def package_of(name: str) -> str:
    """The package a group belongs to: ``proof/<package>`` for its own group and every module or test it splits off
    (``proof/<package>/<module>.py[::<test>]``), and the group itself for any other."""
    if name.startswith("proof/"):
        return "proof/" + name[len("proof/") :].partition("/")[0]
    return name


def reads_corpus(name: str) -> bool:
    """Whether the group ``name`` reads the corpus: a document's, a control's, or one of a package in
    ``CORPUS_PACKAGES`` (its own group, or a module or test it splits off)."""
    return name.startswith(DOCUMENT_KINDS) or package_of(name) in CORPUS_PACKAGES


def block_id(groups: Iterable[str]) -> str:
    """The id of the block holding ``groups``: the sha256 of their names, sorted and joined by newlines."""
    return hashlib.sha256("\n".join(sorted(groups)).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class QueuedGroup:
    group: str
    # The store recomputes this group's records rather than reading them (the audit sample).
    fresh: bool = False
    # The pieces of its document this group follows: it runs once each has passed, and reads what they observed.
    after: tuple[str, ...] = ()
    # What the queue's builder expects the group to cost, in box-seconds; None where it wrote none.
    estimate: float | None = None


@dataclass(frozen=True)
class Block:
    id: str
    estimate: float
    groups: tuple[QueuedGroup, ...]

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(queued.group for queued in self.groups)


@dataclass(frozen=True)
class CachedGroup:
    group: str
    judgments: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Sample:
    """The documents a sampled run checks, and the seed that chose them (None for the ranking's first)."""

    documents: tuple[str, ...]
    seed: str | None = None


@dataclass(frozen=True)
class Selection:
    """The documents a run was asked for by name, and the groups it leaves out beside the other documents."""

    documents: tuple[str, ...]
    left: tuple[str, ...] = ()


@dataclass(frozen=True)
class Queue:
    blocks: tuple[Block, ...]
    cached: tuple[CachedGroup, ...] = ()
    fingerprints: Mapping[str, str] = field(default_factory=dict)
    # The corpus documents the run's sample leaves out; none for a run over the whole corpus.
    unsampled: tuple[str, ...] = ()
    # The readers the run hands its served states to (proof.lane.readers).
    readers: frozenset = lane_readers.EVERY
    # The sample a sampled run checks; None for a run over the whole corpus.
    sample: Sample | None = None
    # The documents and what it leaves out, for a run over documents named by hand; None for any other.
    selection: Selection | None = None

    def groups(self) -> set[str]:
        return {name for block in self.blocks for name in block.names}

    def block(self, identifier: str) -> Block | None:
        return next((block for block in self.blocks if block.id == identifier), None)


def parse_queue(value, where: str = "the queue", *, check_names: bool = True) -> Queue:
    """A queue from its JSON value, or ``QueueError`` naming every way it is not one.

    ``check_names`` holds each group to the names a queue may hold; a queue
    the server builds from a collection outside ``proof/`` names its groups
    by their directories instead.
    """
    problems = []
    if not isinstance(value, dict):
        raise QueueError(f"{where} holds {type(value).__name__}, not a queue object ({{version, blocks, cached}}).")
    if value.get("version") != QUEUE_VERSION:
        problems.append(f"its version is {value.get('version')!r}; this lane reads version {QUEUE_VERSION}")
    fingerprints = value.get("fingerprints", {})
    if not isinstance(fingerprints, dict) or not all(isinstance(text, str) for text in fingerprints.values()):
        problems.append("its fingerprints are not an object of strings")
        fingerprints = {}
    # A block's id is its groups' (checked below), so a block listed twice is refused by its groups.
    blocks, seen_groups = [], {}
    raw_blocks = value.get("blocks")
    if not isinstance(raw_blocks, list):
        problems.append("it holds no list of blocks")
        raw_blocks = []
    for index, raw in enumerate(raw_blocks):
        if not isinstance(raw, dict):
            problems.append(f"block {index} is not an object")
            continue
        identifier, estimate, raw_groups = raw.get("id"), raw.get("estimate"), raw.get("groups")
        if not isinstance(raw_groups, list) or not raw_groups:
            problems.append(f"block {index} ({identifier}) holds no groups")
            continue
        groups = []
        for raw_group in raw_groups:
            name = raw_group.get("group") if isinstance(raw_group, dict) else None
            fresh = raw_group.get("fresh", False) if isinstance(raw_group, dict) else None
            after = raw_group.get("after", []) if isinstance(raw_group, dict) else None
            expected = raw_group.get("estimate") if isinstance(raw_group, dict) else None
            problem = group_problem(name) if check_names else (None if isinstance(name, str) and name else "no name")
            if problem is not None:
                problems.append(f"block {index}: {problem}")
                continue
            if not isinstance(fresh, bool):
                problems.append(f"block {index}: {name}'s fresh is {fresh!r}, not true or false")
                continue
            if not isinstance(after, list) or not all(isinstance(piece, str) and piece for piece in after):
                problems.append(f"block {index}: {name}'s after is {after!r}, not a list of the pieces it follows")
                continue
            if name in seen_groups:
                problems.append(f"{name} is in block {seen_groups[name]} and block {index}; a group runs once")
                continue
            if expected is not None and (isinstance(expected, bool) or not isinstance(expected, (int, float))):
                problems.append(f"block {index}: {name}'s estimate is {expected!r}, not a number of box-seconds")
                continue
            seen_groups[name] = index
            groups.append(QueuedGroup(name, fresh, tuple(after), None if expected is None else float(expected)))
        if check_names:
            # A queue a lane is given holds each piece with the group that follows it; the queue a run of one
            # selection writes for itself may hold a piece alone, observed again by hand.
            problems += [f"block {index}: {problem}" for problem in piece_problems(groups)]
        if isinstance(estimate, bool) or not isinstance(estimate, (int, float)) or estimate < 0:
            problems.append(f"block {index}'s estimate is {estimate!r}, not a number of box-seconds")
            estimate = 0.0
        expected = block_id(group.group for group in groups)
        if identifier != expected:
            problems.append(f"block {index}'s id is {identifier!r}, and its groups' id is {expected}")
            continue
        blocks.append(Block(identifier, float(estimate), tuple(groups)))
    cached = []
    raw_cached = value.get("cached", [])
    if not isinstance(raw_cached, list):
        problems.append("its cached groups are not a list")
        raw_cached = []
    for raw in raw_cached:
        name = raw.get("group") if isinstance(raw, dict) else None
        judgments = raw.get("judgments", {}) if isinstance(raw, dict) else None
        problem = group_problem(name) if check_names else None
        if problem is not None:
            problems.append(f"a cached group: {problem}")
            continue
        if name in seen_groups:
            problems.append(f"{name} is both in block {seen_groups[name]} and cached; a group is run or read, not both")
            continue
        if check_names and piece_of(name) is not None:
            problems.append(f"the cached group {name} is a piece; a piece observes, and is never read from the store")
            continue
        if not isinstance(judgments, dict) or not all(isinstance(key, str) for key in judgments.values()):
            problems.append(f"the cached group {name}'s judgments are not an object of judgment keys")
            continue
        seen_groups[name] = "cached"
        cached.append(CachedGroup(name, dict(judgments)))
    unsampled = value.get("unsampled", [])
    if not isinstance(unsampled, list) or not all(isinstance(name, str) and name for name in unsampled):
        problems.append("its unsampled documents are not a list of document ids")
        unsampled = []
    for name in sorted(seen_groups):
        if name.startswith("corpus:") and name[len("corpus:") :].partition("@")[0] in unsampled:
            problems.append(f"{name} is run or read, and the queue names its document as one its sample leaves out")
    try:
        readers = lane_readers.from_record(value.get("readers"))
    except lane_readers.ReadersError as error:
        problems.append(str(error))
        readers = lane_readers.EVERY
    sample = None
    raw_sample = value.get("sample")
    if raw_sample is not None:
        documents = raw_sample.get("documents") if isinstance(raw_sample, dict) else None
        seed = raw_sample.get("seed") if isinstance(raw_sample, dict) else None
        if not isinstance(documents, list) or not all(isinstance(name, str) and name for name in documents):
            problems.append("its sample names no list of document ids")
        elif seed is not None and not isinstance(seed, str):
            problems.append(f"its sample's seed is {seed!r}, not the text that chose it")
        else:
            sample = Sample(tuple(documents), seed)
    selection = None
    raw_selection = value.get("selection")
    if raw_selection is not None:
        documents = raw_selection.get("documents") if isinstance(raw_selection, dict) else None
        left = raw_selection.get("left", []) if isinstance(raw_selection, dict) else None
        if not isinstance(documents, list) or not all(isinstance(name, str) and name for name in documents):
            problems.append("its selection names no list of document ids")
        elif not isinstance(left, list) or not all(isinstance(name, str) and name for name in left):
            problems.append("its selection's left is not a list of the groups it leaves out")
        else:
            both = sorted(set(left) & set(seen_groups))
            if both:
                problems.append(f"{', '.join(both[:5])} is run or read, and the selection names it as left out")
            selection = Selection(tuple(documents), tuple(left))
    if problems:
        raise QueueError(f"{where} is not a lane queue:\n" + "\n".join(f"- {problem}" for problem in problems))
    return Queue(tuple(blocks), tuple(cached), dict(fingerprints), tuple(unsampled), readers, sample, selection)


def piece_problems(groups: Iterable[QueuedGroup]) -> list[str]:
    """Why one block's groups do not hold their pieces as a lane runs them (the module's docstring); none when
    they do."""
    groups = list(groups)
    by_name = {queued.group: queued for queued in groups}
    problems = []
    for queued in groups:
        piece = piece_of(queued.group)
        if piece is not None:
            whole = by_name.get(piece[0])
            if queued.after:
                problems.append(f"the piece {queued.group} follows {', '.join(queued.after)}; a piece follows nothing")
            if whole is None or queued.group not in whole.after:
                problems.append(
                    f"the piece {queued.group} is followed by no group: {piece[0]}, which judges what it observes,"
                    " belongs in this block, naming the piece in its after"
                )
        for name in queued.after:
            if name not in by_name:
                problems.append(f"{queued.group} follows {name}, which is not in its block")
            elif (piece_of(name) or (None,))[0] != queued.group:
                problems.append(
                    f"{queued.group} follows {name}, which is no piece of it ({queued.group}@<configuration>)"
                )
        if len(set(queued.after)) != len(queued.after):
            problems.append(f"{queued.group} names a piece twice in its after")
        if queued.after and queued.fresh:
            problems.append(
                f"{queued.group} follows its pieces and is fresh; it reads what they observed, and they carry the"
                " freshness"
            )
    return problems


def load_queue(path: Path, *, check_names: bool = True) -> Queue:
    path = Path(path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise QueueError(f"The queue {path} could not be read: {error}.") from error
    except ValueError as error:
        raise QueueError(f"The queue {path} is not JSON: {error}.") from error
    return parse_queue(value, str(path), check_names=check_names)


def queue_json(queue: Queue) -> dict:
    return {
        "version": QUEUE_VERSION,
        "fingerprints": dict(queue.fingerprints),
        "blocks": [
            {
                "id": block.id,
                "estimate": block.estimate,
                "groups": [
                    {
                        "group": group.group,
                        "fresh": group.fresh,
                        **({"after": list(group.after)} if group.after else {}),
                        **({} if group.estimate is None else {"estimate": group.estimate}),
                    }
                    for group in block.groups
                ],
            }
            for block in queue.blocks
        ],
        "cached": [{"group": cached.group, "judgments": dict(cached.judgments)} for cached in queue.cached],
        **({"unsampled": list(queue.unsampled)} if queue.unsampled else {}),
        **(
            {"sample": {"seed": queue.sample.seed, "documents": list(queue.sample.documents)}}
            if queue.sample is not None
            else {}
        ),
        **(
            {"selection": {"documents": list(queue.selection.documents), "left": list(queue.selection.left)}}
            if queue.selection is not None
            else {}
        ),
        **({} if queue.readers == lane_readers.EVERY else {"readers": lane_readers.to_record(queue.readers)}),
    }


def unsampled_documents(corpus: Path) -> tuple[str, ...]:
    """The ids of the documents the corpus at ``corpus`` emitted and its run's sample leaves out (its
    ``index.json``'s ``unsampled``, ``proof.store.queue.sampled``); none for a corpus run whole."""
    index = json.loads((Path(corpus) / "index.json").read_text(encoding="utf-8"))
    return tuple(entry["id"] for entry in index.get("unsampled", []))


def write_json(path: Path, value) -> None:
    """``value`` as tab-indented JSON with sorted keys, written whole (to a staged name, then moved)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(f".{path.name}.staged")
    staged.write_text(json.dumps(value, indent="\t", sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    staged.replace(path)


def single_block(estimates: Mapping[str, float]) -> Queue:
    """One block of every group, for a run that claims everything it collects."""
    names = sorted(estimates)
    return Queue(
        (Block(block_id(names), round(sum(estimates.values()), 3), tuple(QueuedGroup(name) for name in names)),)
    )


def block_per_group(estimates: Mapping[str, float]) -> Queue:
    """A block of each group, for runs that split a collection between them by static bins."""
    return Queue(
        tuple(
            Block(block_id([name]), round(float(estimates[name]), 3), (QueuedGroup(name),))
            for name in sorted(estimates)
        )
    )


def collection_digest(groups: Mapping[str, str]) -> str:
    """The sha256 of a collection: every item's node id with its group, in node id order."""
    payload = json.dumps(sorted(groups.items()), separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# A block's run ------------------------------------------------------------------


def block_dir(output: Path, identifier: str) -> Path:
    return Path(output) / BLOCKS / identifier


def group_record(*, group, fresh, collected, outcomes, worker=None, seconds=None, failure=None) -> dict:
    """One group's entry in a block's manifest."""
    return {
        "group": group,
        "fresh": fresh,
        "collected": sorted(collected),
        "outcomes": dict(sorted(outcomes.items())),
        "worker": worker,
        "seconds": seconds,
        "failure": failure,
    }


def manifest(block: Block, *, phase: str, shard: str, groups: list[dict]) -> dict:
    return {
        "version": MANIFEST_VERSION,
        "block": block.id,
        "phase": phase,
        "shard": shard,
        "estimate": block.estimate,
        "groups": sorted(groups, key=lambda record: record["group"]),
    }


def read_manifests(output: Path) -> list[tuple[Path, dict]]:
    """Every block manifest one output holds, with its block's directory."""
    found = []
    for path in sorted((Path(output) / BLOCKS).glob(f"*/{MANIFEST}")):
        found.append((path.parent, json.loads(path.read_text(encoding="utf-8"))))
    return found


def comparable(directory: Path, record: dict) -> dict[str, bytes]:
    """What one run of a block wrote, to name where two runs of it differ: each group's items and outcomes, its
    evidence, its surface.

    Byte for byte, with nothing set aside. A block runs once, so two runs of
    it fail the verify whatever they wrote (``proof.checks.sharding.verify``):
    two runs that read one evidence store's records write alike, so writing
    alike shows nothing. This only says what differed.
    """
    directory = Path(directory)
    view = {
        MANIFEST: json.dumps(
            [
                [group["group"], group["fresh"], group["collected"], group["outcomes"], group["failure"]]
                for group in record["groups"]
            ],
            sort_keys=True,
        ).encode("utf-8")
    }
    for name in COMPARED:
        path = directory / name
        if path.is_file():
            view[name] = path.read_bytes()
        elif path.is_dir():
            for file in sorted(item for item in path.rglob("*") if item.is_file()):
                view[file.relative_to(directory).as_posix()] = file.read_bytes()
    return view


def failing_items(record: dict) -> list[str]:
    return sorted(
        f"{node_id} ({outcome})"
        for group in record["groups"]
        for node_id, outcome in group["outcomes"].items()
        if outcome in FAILING
    )
