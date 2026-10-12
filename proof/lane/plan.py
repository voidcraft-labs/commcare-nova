"""``python3 -m proof.lane.plan``: how many shards run a lane, and when it is expected to end.

    python3 -m proof.lane.plan size QUEUE... [--timings FILE] [--budget SECONDS]
    python3 -m proof.lane.plan fit --early FILE [--main FILE] [--shards fit|default|N] [--timings FILE]

Standard library only: it runs on the runner's own Python before any shard
(``proof-plan``, and ``proof-lane.yml``'s emit job), with no image.

A plan decides how many shards run a lane and nothing else: every group the
queues hold runs, whatever the lane then takes. Nothing here leaves a group
out for time.

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

``fit`` is the pull request lane. A lane of N shards is expected to end when
its N-th runner frees (``execution.slots``, measured, sorted; every shard is
charged that late start, since the account's job limit starts them in no
fixed order), plus each shard's fixed cost (``execution.fixed``), its longest
span, and the gate (``execution.gate``). More shards end the work sooner and
start later, so some count ends soonest. The rule: of the counts up to
``execution.shards``, take the fewest whose expected end is within
``FIT_TOLERANCE_SECONDS`` of the soonest, so a small queue does not take
runners it does not need and a large one takes what shortens it.
``--shards`` names a count in place of the rule (``default``:
``execution.shards``), for a controlled comparison. Each shard's deadline is
twice what it is expected to take from its own start, at least
``FIT_DEADLINE_MINUTES``'s floor: it ends a shard that is stuck, and a shard
it ends fails the lane, so it never decides what is verified. It prints the
plan as JSON (the shard count, when the lane is expected to end, each shard's
deadline, the groups and box-seconds it runs) and, where
``$GITHUB_STEP_SUMMARY`` is set, appends the same as a sentence, so a
reviewer sees what the lane is expected to take. The times are modelled
from ``proof/timings.json``'s measures, not promised.
"""

from __future__ import annotations

import argparse
import json
import math
import os
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
# How much later than the soonest count's a pull request lane may be expected to end to take fewer shards.
FIT_TOLERANCE_SECONDS = 15.0
# A pull request shard's deadline, twice what it is expected to take, within these bounds, in minutes.
FIT_DEADLINE_MINUTES = (20, 345)


class PlanError(ValueError):
    """A lane no plan holds, or a profile that cannot plan one."""


@dataclass
class Lane:
    """The groups of a lane's two queues as the shards bin them: each queue's blocks, of (group, box-seconds)."""

    early: list[list[tuple[str, float]]] = field(default_factory=list)
    main: list[list[tuple[str, float]]] = field(default_factory=list)

    def groups(self) -> dict[str, float]:
        return {name: seconds for queue in (self.early, self.main) for block in queue for name, seconds in block}


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
    slots: tuple[float, ...]
    fixed: float
    gate: float

    @classmethod
    def of(cls, value: Mapping) -> Execution:
        try:
            execution = cls(
                int(value["shards"]),
                int(value["workers"]),
                tuple(sorted(float(slot) for slot in value["slots"])),
                float(value["fixed"]),
                float(value["gate"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise PlanError(
                f"proof/timings.json's no-readers execution does not say how the pull request lane runs ({error}):"
                " it names its shards, workers, slots, fixed and gate."
            ) from error
        if execution.shards < 1 or execution.workers < 1 or not execution.slots:
            raise PlanError("proof/timings.json's no-readers execution names no shard, worker or slot.")
        return execution

    def start(self, count: int) -> float:
        """When the last of ``count`` shards is expected to start: the ``count``-th slot, or the last measured."""
        return self.slots[min(count, len(self.slots)) - 1]


def span(lane: Lane, count: int, execution: Execution) -> float:
    """The longest any of ``count`` shards is expected to run its blocks."""
    return max(spans(lane, count, execution.workers), default=0.0)


def ends(lane: Lane, count: int, execution: Execution) -> float:
    """When a lane of ``count`` shards is expected to end, in seconds after the workflow starts."""
    return execution.start(count) + execution.fixed + span(lane, count, execution) + execution.gate


def fitted(lane: Lane, execution: Execution, tolerance: float = FIT_TOLERANCE_SECONDS) -> tuple[int, float]:
    """The fewest shards whose expected end is within ``tolerance`` of the soonest any count ends, and that end."""
    expected = {count: ends(lane, count, execution) for count in range(1, execution.shards + 1)}
    soonest = min(expected.values())
    count = min(count for count, end in expected.items() if end <= soonest + tolerance)
    return count, expected[count]


def deadline(lane: Lane, count: int, execution: Execution) -> int:
    """A shard's deadline in minutes: twice what the longest of ``count`` is expected to take from its start."""
    low, high = FIT_DEADLINE_MINUTES
    expected = execution.fixed + span(lane, count, execution)
    return min(high, max(low, math.ceil(2 * expected / 60)))


def _minutes(seconds: float) -> str:
    whole = round(seconds)
    return f"{whole // 60} min {whole % 60:02d} s"


def described(plan: Mapping) -> str:
    """The plan as the sentence the workflow's summary shows."""
    return (
        f"The proof lane runs {plan['groups']} groups ({plan['seconds']:g} box-seconds) on {plan['shards']}"
        f" shard{'' if plan['shards'] == 1 else 's'} and is expected to end about {_minutes(plan['ends'])} after"
        " the workflow starts, as modelled from proof/timings.json's measures; every group the queues hold runs,"
        f" however long it takes. Each shard's deadline is {plan['deadline']} minutes, which only ends a stuck"
        " shard, failing the lane."
    )


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
    fit = commands.add_parser("fit", help="the pull request lane's shards and when it is expected to end")
    fit.add_argument("--early", type=Path, required=True, help="the early queue")
    fit.add_argument("--main", type=Path, help="the main queue (absent when emission failed)")
    fit.add_argument("--shards", default="fit", help="fit (the rule), default (execution.shards) or a count")
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
        if arguments.shards == "fit":
            count, end = fitted(lane, execution)
        else:
            named = execution.shards if arguments.shards == "default" else arguments.shards
            if not str(named).isdecimal() or int(named) < 1:
                raise PlanError(f"--shards takes fit, default or a whole number of at least one; got {named!r}.")
            count = int(named)
            end = ends(lane, count, execution)
        plan = {
            "shards": count,
            "ends": round(end, 3),
            "deadline": deadline(lane, count, execution),
            "groups": len(lane.groups()),
            "seconds": round(sum(lane.groups().values()), 3),
        }
        print(json.dumps(plan))
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as output:
                output.write(f"## Proof lane plan\n\n{described(plan)}\n")
        return 0
    except (PlanError, lane_blocks.QueueError, lane_readers.ReadersError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
