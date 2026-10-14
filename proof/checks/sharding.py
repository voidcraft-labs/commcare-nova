"""The proof lane's groups, what each costs, and whether a run's blocks ran every item exactly once.

Standard library only (``python -m proof.checks.sharding verify`` runs on the
runner's own Python in the gate, with no image): the pytest plugins that
record a run live in ``proof.lane``.

Groups. Items are grouped so what one group shares (a document's
observations, a package's session services) is built once, by one worker:

- every item of one corpus document or control is one group, the ``group``
  its parameter carries (``corpus:<id>``, ``control:<id>``): each check's
  item on it, and HQ's branch proof of it (``proof/hq/test_branches.py``);
- a piece of a document or control is a group of one item
  (``corpus:<id>@<configuration>``, ``control:<id>@<configuration>``): that
  configuration observed whole into the run's evidence store, for the
  document's own group to judge (``proof.checks.pieces``,
  ``proof.lane.blocks``). Its item is collected only where a queue names
  pieces (``PIECES_MODULE``, which is no ``test_*.py``: the lane's server
  names it a test module for that run, ``PIECES_FILES``), so a lane whose
  queue names none collects none;
- ``proof/surface``'s items are the surface block's group, ``surface``;
- every other item belongs to its package under ``proof/`` (``proof/native``,
  ``proof/editors``, ``proof/core``, ``proof/hq``, ``proof/checks``,
  ``proof/lane``, …), and an item of a test module at ``proof/`` itself to
  ``proof``; but a test module ``SPLIT`` names is a group of its own
  (``proof/<package>/<module>.py``), and each test it names in that module
  one more (``proof/<package>/<module>.py::<test>``): a group runs on one
  worker, so a package whose tests take longer than a pull request's shard
  can hold runs as several groups. A split group reads what its package
  reads, so it is keyed by its package's data (``proof.store.queue``).

The items of each group run back to back (``order_by_group``).
``collection_roots`` names what pytest collects for a set of groups: a
document's checks come from ``proof/checks``, whose check modules parametrize
over the corpus when they are imported. The lane collects the early queue's
groups so; its main phase collects the rest of ``proof/``, which finds a
document's branch items too.

Timings. ``proof/timings.json`` holds each group's measured cost in
box-seconds, for each of the lane's two profiles (``profiles``: ``readers``
and ``no-readers``, ``proof.lane.readers``), since a group costs far more where
its states are served to the readers: the seconds of one worker's wall time the
group took, without what the worker's session shares (its services), divided
by the number of workers that shared a CI box (``proof.lane.timings``; ``node
proof/run.mjs --timings`` writes them). ``load_timings`` reads the run's own
profile. A group it does not list is counted high, at the 90th percentile of
those it lists of its kind (documents and controls, or the rest), so a stale or
partial profile oversizes a lane rather than overrunning its shards
(``estimate``). A document a run observed in pieces is measured as it ran: each
piece under its own name, and the document's own group judging alone; its
whole measure is their sum (``documents``), and a piece no run has measured is
counted at its share of it for the number of pieces the document is observed
in (``piece_share``: ``PIECE_SHARE`` for two).

Blocks. A lane runs the blocks of its queues (``proof.lane.blocks``), each
claimed by one shard. ``static_bins`` splits the blocks across ``n`` shards
by greedy longest-processing-time balancing over their estimates, the
default CI allocation without artifact claims. ``verify`` holds every shard's output to
the queues: every queued block ran exactly once (a block two shards ran
fails, whatever they wrote: a run that reads its records from the evidence
store writes what any other run of it writes, so two alike show only that a
claim did not hold), every group of a block ran every item its worker
collected for it, cached groups ran nowhere, no block ran that no queue
holds, and every shard that collected a phase collected the same items.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from proof.lane import blocks as lane_blocks
from proof.lane import readers as lane_readers

PROOF_DIR = Path(__file__).resolve().parents[1]
TIMINGS = PROOF_DIR / "timings.json"
# A group the timings do not list, in box-seconds.
DEFAULT_SECONDS = 8.0
DOCUMENT_KINDS = lane_blocks.DOCUMENT_KINDS
SURFACE = "surface"
# The module whose items are the pieces a queue names, and the variable that names that queue to it: the lane's
# server sets it and has its main phase collect the module where its main queue names pieces (proof.lane.serve).
PIECES_MODULE = PROOF_DIR / "checks" / "pieces.py"
PIECES_ENVIRONMENT = "PROOF_LANE_PIECES"
# What pytest collects as test modules (proof/pytest.ini's ``python_files``, which test_sharding holds this to), and
# with the pieces' module: pytest's arguments for a collection that takes it in (``-o python_files=...``). Naming
# the module's path beside ``proof/`` does not: pytest drops an argument another one holds, and then the module
# is no test module by its name.
PYTHON_FILES = "test_*.py"
PIECES_FILES = ("-o", f"python_files={PYTHON_FILES} {PIECES_MODULE.name}")
# The one test of that module, which each piece is an item of (proof/checks/test_pieces.py holds the name to it).
PIECE_TEST = "test_a_configuration_is_observed_into_the_runs_store"
# What share of a document's whole measure each of its two configurations' pieces is counted at until a run has
# measured the piece: the heavier configuration took 0.50 to 0.64 of its document in three runs with every reader
# (hosted run 38152876104 and two proof machine slices of 2026-10-12, 225 documents past 1,500 s between them).
# A document under more configurations than two counts each at the same share of its even split.
PIECE_SHARE = 0.65


class ShardError(ValueError):
    """A lane position or timings file that cannot be read."""


def _whole_number(text: str):
    """``text`` as a whole number when it is written in ASCII digits alone (no sign, space or ``_``), else None."""
    return int(text) if text.isascii() and text.isdecimal() else None


def parse_shard(value: str, variable: str):
    """``"i/n"`` as ``(i, n)``, with 1 <= i <= n, each written in digits alone; ``variable`` names it when refused.

    The lane's one reader of a position: ``--bin`` here, and ``PROOF_WORKER``
    in ``proof.hq.database`` (which names a worker's databases) and in the
    server that sets it, so every reader accepts and refuses the same values.
    """
    index, separator, count = value.partition("/")
    index, count = _whole_number(index), _whole_number(count)
    if not separator or index is None or count is None or count < 1 or not 1 <= index <= count:
        raise ShardError(f"{variable} is {value!r}; it names one of several as i/n, with i from 1 to n (such as 2/4).")
    return index, count


# The package test modules that are groups of their own, by their path under proof/, each with the tests of it that
# are groups of their own too (its other tests are the module's group): what one package's tests cost on one
# worker, measured at a CI shard's density (proof/timings.json), would otherwise bound the pull request lane's
# shard that runs it. Each package's group, module and test here stays within about 240 seconds at that density
# (proof/README.md, "Timings and what the lane is expected to take"): proof/editors took 701 seconds whole,
# proof/lane 470, proof/checks 375 and proof/hq 260.
SPLIT: dict[str, tuple[str, ...]] = {
    "checks/test_alignment.py": (),
    "checks/test_judge_purity.py": (),
    "checks/test_proof4_editability.py": (),
    "editors/test_pages.py": (),
    "editors/test_reused_pages.py": (),
    "editors/test_seeding.py": (),
    "editors/test_vellum_warm_equivalence.py": (),
    "editors/test_view_equivalence.py": (
        "test_held_sections_of_corpus_documents_equal_fresh_page_saves",
        "test_what_the_harness_does_at_a_section_is_never_counted_against_the_views_deadline",
    ),
    "hq/test_branches.py": (),
    "lane/test_forkserver.py": (
        "test_a_document_observed_in_pieces_is_judged_from_the_records_of_one_observed_whole",
        "test_no_item_waits_on_a_claim_and_the_session_stays_up_for_the_block_the_claim_brings",
        "test_two_forked_workers_write_the_evidence_one_unforked_session_writes",
    ),
}


def piece_item(group: str) -> str | None:
    """The node id (under ``proof/``) of the item a piece's group holds, as ``proof.checks.pieces`` names it: the
    document's id, ``control-`` before a control's, and the configuration; None for a group that is no piece."""
    piece = lane_blocks.piece_of(group)
    if piece is None:
        return None
    kind, _, identifier = piece[0].partition(":")
    name = f"{'control-' if kind == 'control' else ''}{identifier}@{piece[1]}"
    return f"{PIECES_MODULE.relative_to(PROOF_DIR).as_posix()}::{PIECE_TEST}[{name}]"


def split_groups(module: str) -> tuple[str, ...]:
    """The groups a ``SPLIT`` module's items fall in, beside the module's own: one per test it names."""
    return tuple(f"proof/{module}::{test}" for test in SPLIT.get(module, ()))


def item_group(item, proof_dir: Path = PROOF_DIR) -> str:
    """The group one collected item belongs to."""
    callspec = getattr(item, "callspec", None)
    if callspec is not None:
        for value in callspec.params.values():
            group = getattr(value, "group", None)
            if isinstance(group, str) and group:
                return group
    path = Path(str(item.path))
    try:
        relative = path.relative_to(proof_dir)
    except ValueError:
        return str(path.parent)
    if len(relative.parts) == 1:
        return "proof"
    if relative.parts[0] == SURFACE:
        return SURFACE
    module = relative.as_posix()
    if module in SPLIT:
        test = getattr(item, "originalname", None) or getattr(item, "nodeid", "").rpartition("::")[2].partition("[")[0]
        return f"proof/{module}::{test}" if test in SPLIT[module] else f"proof/{module}"
    return f"proof/{relative.parts[0]}"


def order_by_group(items, proof_dir: Path = PROOF_DIR):
    """The items with each group's items together, groups in the order they first appear.

    Every check of one corpus document then runs back to back, so the
    document's observations (``proof.checks.observations``) are made once and
    released before the next document's.
    """
    first = {}
    for index, item in enumerate(items):
        first.setdefault(item_group(item, proof_dir), index)
    return sorted(items, key=lambda item: first[item_group(item, proof_dir)])


def collection_roots(groups, proof_dir: Path = PROOF_DIR) -> list[Path]:
    """What pytest collects to find every item of ``groups``.

    A document's or control's checks come from the check modules in
    ``proof/checks``; the surface's from ``proof/surface``; a package's from
    its directory; ``proof``'s from the test modules at ``proof/`` itself.
    No test module belongs to ``hq-selfchecks``, so it names nothing, and a
    queue naming it fails the verify, which finds no item of it.
    """
    roots = set()
    for group in groups:
        if group.startswith(DOCUMENT_KINDS):
            roots.add(proof_dir / "checks")
        elif group == SURFACE:
            roots.add(proof_dir / "surface")
        elif group == "proof":
            roots.update(proof_dir.glob("test_*.py"))
        elif group.startswith("proof/"):
            # A package's directory, or the test module a split group is (its tests collected with it).
            roots.add(proof_dir / group[len("proof/") :].partition("::")[0])
    return sorted(roots)


def load_timings(path: Path = TIMINGS, *, readers: bool | None = None):
    """The box-seconds per group ``proof/timings.json`` holds for a profile (its ``profiles.<profile>.groups``): the
    run's own (``proof.lane.readers.served``) unless ``readers`` names one. Empty when the file does not exist or
    holds no measure of that profile."""
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    profiles = value.get("profiles") if isinstance(value, dict) else None
    name = lane_readers.profile(lane_readers.served() if readers is None else readers)
    profile = profiles.get(name, {}) if isinstance(profiles, dict) else None
    groups = profile.get("groups", {}) if isinstance(profile, dict) else None
    if not isinstance(groups, dict) or not all(
        isinstance(seconds, (int, float)) and not isinstance(seconds, bool) for seconds in groups.values()
    ):
        raise ShardError(
            f"{path} holds the lane's box-seconds per group for each profile under profiles"
            f' ({{"profiles": {{"{name}": {{"groups": {{<group>: <box-seconds>}}}}}}}}); write it with'
            " `node proof/run.mjs --timings <output directory>...`."
        )
    return groups


# The share of measured groups an unmeasured one is counted above: a stale or partial profile then oversizes a
# lane rather than overrunning its shards' deadlines.
UNMEASURED_PERCENTILE = 0.9


def _percentile(values, share):
    """The value ``share`` of the sorted ``values`` reach (the 90th percentile at 0.9), or None for none."""
    values = sorted(values)
    return values[min(len(values) - 1, int(share * len(values)))] if values else None


def load_execution(path: Path = TIMINGS, *, readers: bool | None = None) -> dict:
    """How CI runs a profile, as ``proof/timings.json`` says (its ``profiles.<profile>.execution``): the run's own
    profile unless ``readers`` names one; empty where the file or the profile holds none."""
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    profiles = value.get("profiles") if isinstance(value, dict) else None
    name = lane_readers.profile(lane_readers.served() if readers is None else readers)
    profile = profiles.get(name, {}) if isinstance(profiles, dict) else None
    execution = profile.get("execution", {}) if isinstance(profile, dict) else None
    return dict(execution) if isinstance(execution, dict) else {}


def documents(timings) -> dict[str, float]:
    """Each measured document's and control's whole box-seconds, by its group: its own group's measure and each of
    its pieces', which are one observation's cost however a run divided it."""
    whole: dict[str, float] = {}
    for group, seconds in timings.items():
        if group.startswith(DOCUMENT_KINDS):
            name = group.partition("@")[0]
            whole[name] = whole.get(name, 0.0) + float(seconds)
    return whole


def piece_share(configurations: int) -> float:
    """The share of a document's whole measure one unmeasured piece is counted at, for a document under
    ``configurations`` of them (``PIECE_SHARE`` for two), never more than the whole."""
    return min(1.0, PIECE_SHARE * 2 / max(1, configurations))


def estimate(timings):
    """Each group's box-seconds: measured where ``timings`` lists it, else counted high: a document or control at
    the 90th percentile of the measured documents' whole measures (``documents``, ``UNMEASURED_PERCENTILE``), a
    piece no run measured at its share of its document's (``piece_share`` for the ``pieces`` the document is
    observed in, as the queue builder counts one and ``proof.lane.blocks.piece_counts`` reads them from a block;
    two where the caller names none), any other group at the 90th percentile of the measured groups that are not
    documents, each at least ``DEFAULT_SECONDS``."""
    whole = documents(timings)
    document = max(DEFAULT_SECONDS, _percentile(whole.values(), UNMEASURED_PERCENTILE) or 0.0)
    other = max(
        DEFAULT_SECONDS,
        _percentile([float(s) for g, s in timings.items() if not g.startswith(DOCUMENT_KINDS)], UNMEASURED_PERCENTILE)
        or 0.0,
    )

    def seconds(group, pieces: int = 2):
        if group in timings:
            return float(timings[group])
        if group.startswith(DOCUMENT_KINDS):
            name, piece, _ = group.partition("@")
            return piece_share(pieces) * whole.get(name, document) if piece else document
        return other

    return seconds


def static_bins(blocks: Sequence, count: int, loads: Sequence[float] | None = None) -> list[list]:
    """The blocks split into ``count`` bins by greedy longest-processing-time balancing over their estimates.

    Heaviest first (ties by id), each to the least loaded bin (ties to the
    lowest), each bin starting from its share of ``loads`` (what each shard
    already runs: the early queue's bins, for the main queue's); each bin
    keeps the queue's order. The same blocks give the same bins on every
    shard, whatever order they are listed in.
    """
    if count < 1:
        raise ShardError(f"Blocks are split into at least one bin; asked for {count}.")
    position = {block.id: index for index, block in enumerate(blocks)}
    bins: list[list] = [[] for _ in range(count)]
    loads = [float(load) for load in loads] if loads is not None else [0.0] * count
    for block in sorted(blocks, key=lambda block: (-block.estimate, block.id)):
        index = min(range(count), key=lambda bin_index: (loads[bin_index], bin_index))
        bins[index].append(block)
        loads[index] += block.estimate
    return [sorted(members, key=lambda block: position[block.id]) for members in bins]


def claim_order(blocks: Sequence, index: int, count: int) -> list:
    """The order shard ``index`` of ``count`` claims the blocks in: its own static bin's (``static_bins``) first,
    then each other bin's from bin ``index + 1`` on, wrapping. Shards that claim so start apart, each on blocks the
    others reach last, and meet over a block only once its own bin is taken."""
    bins = static_bins(blocks, count)
    return [block for offset in range(count) for block in bins[(index - 1 + offset) % count]]


# Verifying a run --------------------------------------------------------------------


@dataclass
class Verdict:
    """Whether a run's outputs ran every queued block exactly once."""

    problems: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    # Each block's run that counts: the directory of its first run.
    chosen: dict[str, Path] = field(default_factory=dict)
    # Why each group a problem names did not run whole, once: what a rerun of that group would settle.
    groups: dict[str, list[str]] = field(default_factory=dict)


def _shown(names, limit=5):
    names = sorted(names)
    shown = ", ".join(names[:limit])
    return shown + (f" and {len(names) - limit} more" if len(names) > limit else "")


def _verify_run(block, record, where, problems, groups):
    expected = {group.group: group.fresh for group in block.groups}
    ran = {group["group"]: group for group in record["groups"]}
    if set(ran) != set(expected):
        problems.append(
            f"{where} ran block {block.id} with the groups {_shown(ran)}, and the queue's block holds"
            f" {_shown(expected)}."
        )
        for name in sorted(set(expected) - set(ran)):
            groups.setdefault(name, []).append("the shard that ran its block did not run it")
    for name, group in sorted(ran.items()):

        def named(problem, why, name=name):
            problems.append(problem)
            groups.setdefault(name, []).append(why)

        if name in expected and group["fresh"] != expected[name]:
            problems.append(f"{where} ran {name} with fresh {group['fresh']}, and the queue asks {expected[name]}.")
        if group["failure"]:
            named(f"{where}: {name} did not finish: {group['failure']}", f"it did not finish: {group['failure']}")
        collected, ran_items = set(group["collected"]), set(group["outcomes"])
        if not collected:
            named(
                f"{where}: its worker collected no item of {name}, so nothing of it ran; the queue names a group"
                " this lane's tests do not hold.",
                "its worker collected no item of it",
            )
        if collected - ran_items:
            named(
                f"{where}: {name} left {len(collected - ran_items)} of its {len(collected)} collected items unrun"
                f" ({_shown(collected - ran_items, 3)}).",
                f"{len(collected - ran_items)} of its {len(collected)} collected items did not run",
            )
        if ran_items - collected:
            problems.append(
                f"{where}: {name} ran items its worker never collected ({_shown(ran_items - collected, 3)})."
            )


def verify(queues: Sequence[tuple[str, lane_blocks.Queue]], outputs: Sequence[Path]) -> Verdict:
    """Hold every output to the queues (``(phase, queue)`` pairs); see the module's docstring."""
    verdict = Verdict()
    problems = verdict.problems
    queued: dict[str, tuple[str, lane_blocks.Block]] = {}
    group_phase: dict[str, str] = {}
    cached: set[str] = set()
    for phase, queue in queues:
        for block in queue.blocks:
            if block.id in queued:
                problems.append(f"Block {block.id} is in both the {queued[block.id][0]} and the {phase} queue.")
                continue
            queued[block.id] = (phase, block)
            for name in block.names:
                if name in group_phase:
                    problems.append(f"{name} is queued in both the {group_phase[name]} and the {phase} queue.")
                group_phase[name] = phase
        for entry in queue.cached:
            cached.add(entry.group)
    both = sorted(cached & set(group_phase))
    if both:
        problems.append(f"The queues both run and read from the store {_shown(both)}.")

    runs: dict[str, list[tuple[Path, Path, dict]]] = {}
    phases: dict[str, dict[str, list[str]]] = {}
    for output in outputs:
        output = Path(output)
        serve = output / lane_blocks.SERVE
        if not serve.is_file():
            problems.append(
                f"{output} holds no {lane_blocks.SERVE}, so its shard did not finish; its blocks may be missing."
            )
        else:
            record = json.loads(serve.read_text(encoding="utf-8"))
            for phase in record.get("phases", []):
                collection = phase.get("collected")
                if collection:
                    phases.setdefault(phase["phase"], {}).setdefault(collection["digest"], []).append(str(output))
                for name in phase.get("unaccounted", []):
                    problems.append(
                        f"{output} collected items of {name} in its {phase['phase']} phase, and no queue runs it or"
                        " reads it from the store."
                    )
        for directory, record in lane_blocks.read_manifests(output):
            runs.setdefault(record["block"], []).append((output, directory, record))
            ran_cached = sorted(cached & {group["group"] for group in record["groups"]})
            if ran_cached:
                problems.append(f"{directory} ran {_shown(ran_cached)}, which the queues read from the store.")
    for phase, digests in sorted(phases.items()):
        if len(digests) > 1:
            problems.append(
                f"The shards collected different items in the {phase} phase: "
                + "; ".join(f"{_shown(where, 3)} collected {digest[:12]}" for digest, where in sorted(digests.items()))
                + ". A collection must not depend on the shard."
            )

    for identifier in sorted(set(runs) - set(queued)):
        problems.append(
            f"{_shown(str(directory) for _, directory, _ in runs[identifier])} ran block {identifier}, which no queue"
            " holds."
        )
    for identifier, (phase, block) in queued.items():
        ran = runs.get(identifier, [])
        if not ran:
            problems.append(
                f"No shard's output holds block {identifier} of the {phase} queue ({_shown(block.names, 4)}): no"
                " shard claimed it, or the shard that did never finished."
            )
            for name in block.names:
                verdict.groups.setdefault(name, []).append("no shard's output holds its block")
            continue
        for _, directory, record in ran:
            _verify_run(block, record, str(directory), problems, verdict.groups)
        if len(ran) > 1:
            views = [lane_blocks.comparable(directory, record) for _, directory, record in ran]
            differing = sorted(name for name in set().union(*views) if len({view.get(name) for view in views}) > 1)
            where = _shown((str(directory) for _, directory, _ in ran), 4)
            written = (
                f"the runs wrote different {_shown(differing, 4)}"
                if differing
                else "the runs wrote the same, as two runs reading one evidence store's records always can"
            )
            problems.append(
                f"Block {identifier} ran {len(ran)} times ({where}), and a block runs once: {written}. Two shards"
                " claimed it, so the claims did not hold."
            )
        verdict.chosen[identifier] = ran[0][1]
    return verdict


def main(argv):
    parser = argparse.ArgumentParser(
        prog="python -m proof.checks.sharding verify",
        description="Whether the shards' outputs ran every block of the lane's queues exactly once.",
    )
    parser.add_argument("command", choices=["verify"])
    parser.add_argument("--early-queue", type=Path, help="the early queue the shards ran")
    parser.add_argument("--queue", type=Path, help="the main queue the shards ran")
    parser.add_argument("outputs", nargs="+", type=Path, help="every shard's output directory")
    arguments = parser.parse_args(argv)
    queues = [
        (phase, lane_blocks.load_queue(path))
        for phase, path in (("early", arguments.early_queue), ("main", arguments.queue))
        if path is not None
    ]
    if not queues:
        print("Name the queues the shards ran: --early-queue and --queue.", file=sys.stderr)
        return 2
    verdict = verify(queues, arguments.outputs)
    for note in verdict.notes:
        print(note)
    for problem in verdict.problems:
        print(problem, file=sys.stderr)
    return 1 if verdict.problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
