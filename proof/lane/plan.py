"""``python3 -m proof.lane.plan``: how many shards run a lane, and, for a pull request, what it leaves to the nightly.

    python3 -m proof.lane.plan size QUEUE... [--timings FILE] [--budget SECONDS]
    python3 -m proof.lane.plan fit --early FILE [--main FILE] --seed TEXT [--timings FILE]

Standard library only: it runs on the runner's own Python before any shard
(``proof-plan``, and ``proof-lane.yml``'s emit job), with no image.

Every shard bins the queues alike (``proof.lane.serve``: the early queue's
blocks with ``proof.checks.sharding.static_bins``, then the main queue's
starting from the early bins' loads), so a count of shards fixes what each
shard runs. A shard is expected to take its bin's box-seconds, or, where it
is longer, the longest group in it run on one of its workers (a group runs on
one worker: its box-seconds times the box's workers), ``spans``.

``size`` is the lanes with the readers (the nightly, the weekly): the fewest
shards over which no shard is expected past ``SHARD_BUDGET_SECONDS``, each
given a deadline of twice its expected work. A group that alone is expected
past the budget fails the plan, naming it.

``fit`` is the pull request lane, whose bound is a guarantee: the workflow
ends within the profile's ``execution.bound`` of its start. It plans to the
bound less ``execution.margin``, held against runner variance (its target).
A lane of N shards is expected to end when its N-th runner frees
(``execution.slots``, measured, sorted; every shard is charged that late
start, since the account's job limit starts them in no fixed order), plus
each shard's fixed cost (``execution.fixed``), its longest span, and the gate
(``execution.gate``). It takes the fewest shards, up to
``execution.shards``, with which the queues end within the target. Where no
count holds them all, it defers groups to the nightly, documents and package
groups alike (``deferral``): for each count it keeps groups in the order of
the sha256 of the seed (the pull request's head commit) and each group's
name while that count still ends within the target, and takes the count
that keeps the most work, so each push defers another subset of the groups a
shard can hold. It rewrites both queues in
place: a deferred group leaves its block (whose id and estimate follow its
remaining groups) for the queue's ``deferred``, which the server accounts
for and the gate reads (``proof.lane.gate``). It prints the plan as JSON:
the shard count, when the lane is expected to end, and what it deferred.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from proof.checks import sharding
from proof.lane import blocks as lane_blocks
from proof.lane import readers as lane_readers

# What one shard of a lane with the readers is expected to run at most: GitHub ends a job at six hours, and a
# shard's setup, its JVMs' first starts and a stretch of slow runners take the rest.
SHARD_BUDGET_SECONDS = 9000.0
# A sized shard's deadline, twice what it is expected to take, within these bounds, in minutes.
DEADLINE_MINUTES = (60, 345)
# The most shards a lane with the readers is sized to.
MOST_SHARDS = 256


class PlanError(ValueError):
    """A lane no plan holds, or a profile that cannot plan one."""


@dataclass
class Lane:
    """The groups of a lane's two queues as the shards bin them: each queue's blocks, of (group, box-seconds)."""

    early: list[list[tuple[str, float]]] = field(default_factory=list)
    main: list[list[tuple[str, float]]] = field(default_factory=list)

    def groups(self) -> dict[str, float]:
        return {name: seconds for queue in (self.early, self.main) for block in queue for name, seconds in block}

    def without(self, deferred: set[str]) -> Lane:
        def kept(queue):
            blocks = [[(name, seconds) for name, seconds in block if name not in deferred] for block in queue]
            return [block for block in blocks if block]

        return Lane(kept(self.early), kept(self.main))


def _group_estimates(block: Mapping, estimate: Callable[[str], float]) -> list[tuple[str, float]]:
    """Each group of a block's JSON with its box-seconds: its own ``estimate`` where the queue builder wrote one,
    else the block's split by the timings' estimates of its groups."""
    names = [queued["group"] for queued in block["groups"]]
    own = [queued.get("estimate") for queued in block["groups"]]
    if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in own):
        return list(zip(names, (float(value) for value in own), strict=True))
    weights = [estimate(name) for name in names]
    total = sum(weights) or 1.0
    return [(name, float(block["estimate"]) * weight / total) for name, weight in zip(names, weights, strict=True)]


def lane_of(early: Mapping | None, main: Mapping | None, estimate: Callable[[str], float]) -> Lane:
    """The lane of two queues' JSON values (either may be absent)."""
    return Lane(
        [_group_estimates(block, estimate) for block in (early or {}).get("blocks", [])],
        [_group_estimates(block, estimate) for block in (main or {}).get("blocks", [])],
    )


def _blocks(queue: list[list[tuple[str, float]]]) -> list[lane_blocks.Block]:
    return [
        lane_blocks.Block(
            lane_blocks.block_id(name for name, _ in block),
            round(sum(seconds for _, seconds in block), 3),
            tuple(lane_blocks.QueuedGroup(name) for name, _ in block),
        )
        for block in queue
    ]


def spans(lane: Lane, count: int, workers: int) -> list[float]:
    """What each of ``count`` shards is expected to run, in seconds of its wall time (the module's docstring)."""
    seconds = lane.groups()
    early = sharding.static_bins(_blocks(lane.early), count)
    loads = [sum(block.estimate for block in members) for members in early]
    main = sharding.static_bins(_blocks(lane.main), count, loads)
    found = []
    for shard in range(count):
        held = early[shard] + main[shard]
        load = sum(block.estimate for block in held)
        longest = max((seconds[name] * workers for block in held for name in block.names), default=0.0)
        found.append(max(load, longest))
    return found


def _longest_group(lane: Lane, workers: int) -> tuple[str | None, float]:
    seconds = lane.groups()
    name = max(seconds, key=lambda group: (seconds[group], group), default=None)
    return name, (seconds[name] * workers if name is not None else 0.0)


def size(lane: Lane, *, workers: int, budget: float = SHARD_BUDGET_SECONDS) -> dict:
    """The fewest shards over which no shard is expected past ``budget`` seconds, and each one's deadline."""
    name, longest = _longest_group(lane, workers)
    if longest > budget:
        raise PlanError(
            f"The group {name} is expected to run {longest:.0f} s on one worker of a shard, past the {budget:.0f} s"
            " a shard is given within GitHub's six-hour job limit. Split it (proof.checks.sharding.SPLIT), or"
            " refresh proof/timings.json if its measure is stale."
        )
    for count in range(1, MOST_SHARDS + 1):
        expected = max(spans(lane, count, workers), default=0.0)
        if expected <= budget:
            low, high = DEADLINE_MINUTES
            deadline = min(high, max(low, math.ceil(2 * expected / 60)))
            return {"shards": count, "deadline": deadline, "expected": round(expected, 3)}
    raise PlanError(
        f"No count of shards up to {MOST_SHARDS} keeps every shard's expected work within {budget:.0f} s; the"
        " queues' estimates say why (proof/timings.json)."
    )


@dataclass(frozen=True)
class Execution:
    """The pull request lane's measured execution (``proof/timings.json``'s ``no-readers`` ``execution``)."""

    shards: int
    workers: int
    bound: float
    slots: tuple[float, ...]
    fixed: float
    gate: float
    # Seconds of the bound the plan leaves unplanned, against runner variance.
    margin: float = 0.0

    @classmethod
    def of(cls, value: Mapping) -> Execution:
        try:
            execution = cls(
                int(value["shards"]),
                int(value["workers"]),
                float(value["bound"]),
                tuple(sorted(float(slot) for slot in value["slots"])),
                float(value["fixed"]),
                float(value["gate"]),
                float(value.get("margin", 0.0)),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise PlanError(
                f"proof/timings.json's no-readers execution does not say how the pull request lane runs ({error}):"
                " it names its shards, workers, bound, slots, fixed and gate."
            ) from error
        if execution.shards < 1 or execution.workers < 1 or not execution.slots:
            raise PlanError("proof/timings.json's no-readers execution names no shard, worker or slot.")
        return execution

    def start(self, count: int) -> float:
        """When the last of ``count`` shards is expected to start: the ``count``-th slot, or the last measured."""
        return self.slots[min(count, len(self.slots)) - 1]

    @property
    def target(self) -> float:
        """When the plan has the lane end: the bound less the margin."""
        return self.bound - self.margin

    def capacity(self, count: int) -> float:
        """The seconds each of ``count`` shards may run within the target."""
        return self.target - self.start(count) - self.fixed - self.gate


def ends(lane: Lane, count: int, execution: Execution) -> float:
    return execution.start(count) + execution.fixed + max(spans(lane, count, execution.workers)) + execution.gate


def fitted(lane: Lane, execution: Execution) -> tuple[int, float]:
    """The fewest shards with which the lane ends within the target, and when; else the count that ends soonest."""
    best = None
    for count in range(1, execution.shards + 1):
        end = ends(lane, count, execution)
        if end <= execution.target:
            return count, end
        if best is None or end < best[1]:
            best = (count, end)
    assert best is not None
    return best


class _Kept:
    """The groups kept so far on ``count`` shards, with what decides quickly whether one more still fits."""

    def __init__(self, lane: Lane, execution: Execution, count: int):
        self.lane, self.execution, self.count = lane, execution, count
        self.capacity = execution.capacity(count)
        self.names: set[str] = set()
        self.total = 0.0
        self.longest = 0.0
        self.blocks: dict[tuple[str, int], float] = {}
        self.block_of = {
            name: (queue, index)
            for queue, blocks in (("early", lane.early), ("main", lane.main))
            for index, block in enumerate(blocks)
            for name, _ in block
        }
        self.seconds = lane.groups()

    def fits_with(self, name: str) -> bool:
        workers, capacity, count = self.execution.workers, self.capacity, self.count
        seconds = self.seconds[name]
        total = self.total + seconds
        # Past what any binning holds: a group longer than a shard has, or more than every shard has.
        if seconds * workers > capacity or total / count > capacity:
            return False
        # Within what any greedy binning holds (no bin passes the mean by more than one block).
        block = self.blocks.get(self.block_of[name], 0.0) + seconds
        if total / count + max([block, *self.blocks.values()]) <= capacity:
            return True
        # Between, the shards' own bins decide.
        kept = self.lane.without(set(self.seconds) - self.names - {name})
        return max(spans(kept, count, workers)) <= capacity

    def keep(self, name: str) -> None:
        seconds = self.seconds[name]
        self.names.add(name)
        self.total += seconds
        where = self.block_of[name]
        self.blocks[where] = self.blocks.get(where, 0.0) + seconds


def priority(seed: str, name: str) -> str:
    """The order groups are kept in: the sha256 of the seed and the group's name."""
    return hashlib.sha256(f"{seed}\n{name}".encode()).hexdigest()


def deferral(lane: Lane, execution: Execution, seed: str) -> set[str]:
    """The groups the lane leaves to the nightly to end within the target; none where it ends within it whole.

    For each count of shards, the groups are kept in their order (``priority``) while that count still ends
    within the target; the count that keeps the most work is taken, so how much is deferred follows from the
    lane's measures and only which groups from the seed."""
    if fitted(lane, execution)[1] <= execution.target:
        return set()
    order = sorted(lane.groups(), key=lambda group: priority(seed, group))
    best: tuple[float, int, set[str]] | None = None
    for count in range(1, execution.shards + 1):
        if execution.capacity(count) <= 0:
            continue
        kept, deferred = _Kept(lane, execution, count), set()
        for name in order:
            if kept.fits_with(name):
                kept.keep(name)
            else:
                deferred.add(name)
        if best is None or kept.total > best[0] + 1e-9:
            best = (kept.total, count, deferred)
    if best is None:
        raise PlanError(
            "No count of shards leaves a shard any time within the target (proof/timings.json's no-readers"
            " execution: its slots, fixed, gate and margin pass its bound), so nothing can run."
        )
    return best[2]


def rewritten(value: Mapping, deferred: set[str], lane_blocks_of: list[list[tuple[str, float]]]) -> dict:
    """A queue's JSON without its ``deferred`` groups: each leaves its block, whose id and estimate follow its
    remaining groups, for the queue's ``deferred``, with its estimate."""
    blocks, moved = [], []
    for block, groups in zip(value.get("blocks", []), lane_blocks_of, strict=True):
        seconds = dict(groups)
        kept = [queued for queued in block["groups"] if queued["group"] not in deferred]
        moved += [
            {"group": queued["group"], "estimate": round(seconds[queued["group"]], 3)}
            for queued in block["groups"]
            if queued["group"] in deferred
        ]
        if not kept:
            continue
        if len(kept) < len(block["groups"]):
            names = [queued["group"] for queued in kept]
            block = {
                **block,
                "groups": kept,
                "id": lane_blocks.block_id(names),
                "estimate": round(sum(seconds[name] for name in names), 3),
            }
        blocks.append(block)
    found = {**value, "blocks": sorted(blocks, key=lambda block: (-block["estimate"], block["id"]))}
    if moved:
        found["deferred"] = sorted([*value.get("deferred", []), *moved], key=lambda entry: entry["group"])
    return found


def _read(path: Path | None) -> dict | None:
    if path is None or not Path(path).is_file():
        return None
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    lane_blocks.parse_queue(value, str(path))
    return value


def _profile_execution(timings: Path, readers: bool) -> Mapping:
    value = json.loads(Path(timings).read_text(encoding="utf-8")) if Path(timings).is_file() else {}
    profile = value.get("profiles", {}).get(lane_readers.profile(readers), {})
    return profile.get("execution", {})


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m proof.lane.plan", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    sized = commands.add_parser("size", help="the shards of a lane with the readers")
    sized.add_argument("queues", nargs="+", type=Path, help="the early queue, then the main queue")
    sized.add_argument("--timings", type=Path, default=sharding.TIMINGS)
    sized.add_argument("--budget", type=float, default=SHARD_BUDGET_SECONDS)
    fit = commands.add_parser("fit", help="the pull request lane's shards, deferring what does not fit")
    fit.add_argument("--early", type=Path, required=True, help="the early queue, rewritten in place")
    fit.add_argument("--main", type=Path, help="the main queue, rewritten in place (absent when emission failed)")
    fit.add_argument("--seed", required=True, help="what chooses the deferred groups (the head commit)")
    fit.add_argument("--timings", type=Path, default=sharding.TIMINGS)
    arguments = parser.parse_args(argv)
    try:
        readers = lane_readers.served()
        estimate = sharding.estimate(sharding.load_timings(arguments.timings, readers=readers))
        execution = _profile_execution(arguments.timings, readers)
        if arguments.command == "size":
            values = [_read(path) for path in arguments.queues]
            lane = Lane(
                [block for value in values[:1] for block in lane_of(value, None, estimate).early],
                [block for value in values[1:] for block in lane_of(None, value, estimate).main],
            )
            workers = int(execution.get("workers", 4))
            print(json.dumps(size(lane, workers=workers, budget=arguments.budget)))
            return 0
        early, main_value = _read(arguments.early), _read(arguments.main)
        if early is None:
            raise PlanError(f"The early queue {arguments.early} does not exist, so there is no lane to plan.")
        lane = lane_of(early, main_value, estimate)
        execution = Execution.of(execution)
        deferred = deferral(lane, execution, arguments.seed)
        kept = lane.without(deferred)
        count, end = fitted(kept, execution)
        for path, value, groups in ((arguments.early, early, lane.early), (arguments.main, main_value, lane.main)):
            if value is not None and deferred:
                found = rewritten(value, deferred, groups)
                lane_blocks.parse_queue(found, str(path))
                lane_blocks.write_json(path, found)
        seconds = lane.groups()
        print(
            json.dumps(
                {
                    "shards": count,
                    "ends": round(end, 3),
                    "target": execution.target,
                    "fits": end <= execution.target,
                    "deferred": sorted(deferred),
                    "deferredSeconds": round(sum(seconds[name] for name in deferred), 3),
                }
            )
        )
        return 0
    except (PlanError, lane_blocks.QueueError, lane_readers.ReadersError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
