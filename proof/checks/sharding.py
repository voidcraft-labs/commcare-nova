"""The proof lane's groups, what each costs, and whether a run's blocks ran every item exactly once.

Standard library only (``python -m proof.checks.sharding verify`` runs on the
runner's own Python in the gate, with no image): the pytest plugins that
record a run live in ``proof.lane``.

Groups. Items are grouped so what one group shares (a document's
observations, a package's session services) is built once, by one worker:

- every item of one corpus document or control is one group, the ``group``
  its parameter carries (``corpus:<id>``, ``corpus:<id>@<configuration>``,
  ``control:<id>``): each check's item on it, and HQ's branch proof of it
  (``proof/hq/test_branches.py``);
- ``proof/surface``'s items are the surface block's group, ``surface``;
- every other item belongs to its package under ``proof/`` (``proof/native``,
  ``proof/editors``, ``proof/core``, ``proof/hq``, ``proof/checks``,
  ``proof/lane``, …), and an item of a test module at ``proof/`` itself to
  ``proof``.

The items of each group run back to back (``order_by_group``).
``collection_roots`` names what pytest collects for a set of groups: a
document's checks come from ``proof/checks``, whose check modules parametrize
over the corpus when they are imported. The lane collects the early queue's
groups so; its main phase collects the rest of ``proof/``, which finds a
document's branch items too.

Timings. ``proof/timings.json`` holds each group's measured cost in
box-seconds: the seconds of one worker's wall time the group took, without
what the worker's session shares (its services), divided by the number of
workers that shared the box (``proof.lane.timings``; ``node proof/run.mjs
--timings`` writes them). A document or control it does not list counts the
median of those it lists, since a sample's documents change with its size and
seed; any other group it does not list counts ``DEFAULT_SECONDS``
(``estimate``).

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

PROOF_DIR = Path(__file__).resolve().parents[1]
TIMINGS = PROOF_DIR / "timings.json"
# A group the timings do not list, in box-seconds.
DEFAULT_SECONDS = 8.0
DOCUMENT_KINDS = lane_blocks.DOCUMENT_KINDS
SURFACE = "surface"


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
            roots.add(proof_dir / group[len("proof/") :])
    return sorted(roots)


def load_timings(path: Path = TIMINGS):
    """The box-seconds per group ``proof/timings.json`` holds (its ``groups``); empty when it does not exist."""
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    groups = value.get("groups") if isinstance(value, dict) else None
    if not isinstance(groups, dict) or not all(
        isinstance(seconds, (int, float)) and not isinstance(seconds, bool) for seconds in groups.values()
    ):
        raise ShardError(
            f'{path} holds the lane\'s box-seconds per group under groups ({{"groups": {{<group>: <box-seconds>}}}});'
            " write it with `node proof/run.mjs --timings <output directory>...`."
        )
    return groups


def estimate(timings):
    """Each group's box-seconds: measured where ``timings`` lists it, else the median measured document for a
    document or control, else ``DEFAULT_SECONDS``."""
    documents = sorted(seconds for group, seconds in timings.items() if group.startswith(DOCUMENT_KINDS))
    document = documents[len(documents) // 2] if documents else DEFAULT_SECONDS

    def seconds(group):
        if group in timings:
            return float(timings[group])
        if group.startswith(DOCUMENT_KINDS):
            # A document split by configuration: half its whole measure, since every document is exported under
            # two configurations (its minimum and its maximum).
            whole, _, configuration = group.partition("@")
            if configuration and whole in timings:
                return float(timings[whole]) / 2
            return float(document)
        return DEFAULT_SECONDS

    return seconds


def static_bins(blocks: Sequence, count: int) -> list[list]:
    """The blocks split into ``count`` bins by greedy longest-processing-time balancing over their estimates.

    Heaviest first (ties by id), each to the least loaded bin (ties to the
    lowest); each bin keeps the queue's order. The same blocks give the same
    bins on every shard, whatever order they are listed in.
    """
    if count < 1:
        raise ShardError(f"Blocks are split into at least one bin; asked for {count}.")
    position = {block.id: index for index, block in enumerate(blocks)}
    bins: list[list] = [[] for _ in range(count)]
    loads = [0.0] * count
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


def _shown(names, limit=5):
    names = sorted(names)
    shown = ", ".join(names[:limit])
    return shown + (f" and {len(names) - limit} more" if len(names) > limit else "")


def _verify_run(block, record, where, problems):
    expected = {group.group: group.fresh for group in block.groups}
    ran = {group["group"]: group for group in record["groups"]}
    if set(ran) != set(expected):
        problems.append(
            f"{where} ran block {block.id} with the groups {_shown(ran)}, and the queue's block holds"
            f" {_shown(expected)}."
        )
    for name, group in sorted(ran.items()):
        if name in expected and group["fresh"] != expected[name]:
            problems.append(f"{where} ran {name} with fresh {group['fresh']}, and the queue asks {expected[name]}.")
        if group["failure"]:
            problems.append(f"{where}: {name} did not finish: {group['failure']}")
        collected, ran_items = set(group["collected"]), set(group["outcomes"])
        if not collected:
            problems.append(
                f"{where}: its worker collected no item of {name}, so nothing of it ran; the queue names a group"
                " this lane's tests do not hold."
            )
        if collected - ran_items:
            problems.append(
                f"{where}: {name} left {len(collected - ran_items)} of its {len(collected)} collected items unrun"
                f" ({_shown(collected - ran_items, 3)})."
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
            continue
        for _, directory, record in ran:
            _verify_run(block, record, str(directory), problems)
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
