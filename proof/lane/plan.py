"""``python3 -m proof.lane.plan``: how many shards run a lane, and when it is expected to end.

    python3 -m proof.lane.plan size QUEUE... [--timings FILE] [--budget SECONDS] [--parallel N]
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
one worker: its box-seconds times the box's workers), ``spans``. A group that
follows pieces (a heavy document's own group, which judges what each
configuration's piece observed on a worker of its own, ``proof.lane.blocks``)
starts when its longest piece ends, so it counts with that piece: the longest
run of work a shard cannot divide is a piece and the judging after it.

``size`` is the lanes with the readers (the nightly, the weekly): the fewest
shards over which no shard is expected past the budget, each given a deadline
of twice its expected work. The budget is the profile's
(``proof/timings.json``, ``profiles.<profile>.execution.budget``, set from
the lane's measured seconds), ``SHARD_BUDGET_SECONDS`` where it names none.
A group that alone is expected past the budget fails the plan, naming it: a
configuration is the smallest piece a document is observed in. Past
``PARALLEL_SHARDS`` shards the count is rounded up to a multiple of it (never
past the number of blocks, so no shard starts with nothing to run): that
many run at once (proof-lane.yml's ``max-parallel``), so the lane takes as
many rounds either way, and the same work over a full last round ends
sooner.

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

# What one shard of a sized lane is expected to run at most where its profile names no budget
# (``execution.budget``): GitHub ends a job at six hours, and a shard's setup, its JVMs' first starts and a
# stretch of slow runners take the rest.
SHARD_BUDGET_SECONDS = 9000.0
# How many shards of a sized lane run at once (proof-lane.yml's max-parallel, which test_plan holds this to).
PARALLEL_SHARDS = 14
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
    # The pieces each group that follows any runs after (``proof.lane.blocks.QueuedGroup.after``).
    after: dict[str, tuple[str, ...]] = field(default_factory=dict)

    def groups(self) -> dict[str, float]:
        return {name: seconds for queue in (self.early, self.main) for block in queue for name, seconds in block}

    def runs(self) -> dict[str, float]:
        """Each group's box-seconds from when the first of its work starts to its end: its own, after the longest
        of the pieces it follows."""
        seconds = self.groups()
        return {
            name: own + max((seconds.get(piece, 0.0) for piece in self.after.get(name, ())), default=0.0)
            for name, own in seconds.items()
        }


def _group_estimates(block: Mapping, estimate: Callable[[str], float]) -> list[tuple[str, float]]:
    """Each group of a block's JSON with its box-seconds: its own ``estimate`` where the queue builder wrote one,
    else the block's split by the timings' estimates of its groups."""
    names = [queued["group"] for queued in block["groups"]]
    own = [queued.get("estimate") for queued in block["groups"]]
    if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in own):
        return list(zip(names, (float(value) for value in own), strict=True))
    # A piece no run measured counts by how many pieces its document is observed in, all of them in this block.
    pieces = lane_blocks.piece_counts(names)

    def weight(name):
        piece = lane_blocks.piece_of(name)
        return estimate(name) if piece is None else estimate(name, pieces=pieces[piece[0]])

    weights = [weight(name) for name in names]
    total = sum(weights) or 1.0
    return [(name, float(block["estimate"]) * weight / total) for name, weight in zip(names, weights, strict=True)]


def lane_of(early: Mapping | None, main: Mapping | None, estimate: Callable[[str], float]) -> Lane:
    """The lane of two queues' JSON values (either may be absent)."""
    return Lane(
        [_group_estimates(block, estimate) for block in (early or {}).get("blocks", [])],
        [_group_estimates(block, estimate) for block in (main or {}).get("blocks", [])],
        {
            queued["group"]: tuple(queued["after"])
            for value in (early, main)
            for block in (value or {}).get("blocks", [])
            for queued in block["groups"]
            if queued.get("after")
        },
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
    runs = lane.runs()
    early = sharding.static_bins(_blocks(lane.early), count)
    loads = [sum(block.estimate for block in members) for members in early]
    main = sharding.static_bins(_blocks(lane.main), count, loads)
    found = []
    for shard in range(count):
        held = early[shard] + main[shard]
        load = sum(block.estimate for block in held)
        longest = max((runs[name] * workers for block in held for name in block.names), default=0.0)
        found.append(max(load, longest))
    return found


def _longest_run(lane: Lane, workers: int) -> tuple[str | None, float]:
    runs = lane.runs()
    name = max(runs, key=lambda group: (runs[group], group), default=None)
    return name, (runs[name] * workers if name is not None else 0.0)


def _past_budget(lane: Lane, name: str, longest: float, budget: float) -> str:
    """Why no plan holds the group ``name``, whose work a shard cannot divide runs ``longest`` seconds."""
    given = f"past the {budget:.0f} s a shard is given within GitHub's six-hour job limit"
    stale = "refresh proof/timings.json if its measure is stale"
    pieces = lane.after.get(name, ())
    if pieces:
        seconds = lane.groups()
        piece = max(pieces, key=lambda group: (seconds.get(group, 0.0), group))
        return (
            f"The piece {piece} and the judging of {name} that follows it are expected to run {longest:.0f} s on"
            f" one worker of a shard, {given}. A configuration is the smallest piece a document is observed in"
            ' (proof/README.md, "Documents observed in pieces"), so no split holds this one: raise the profile\'s'
            f" budget where the limit leaves room (proof/timings.json, execution.budget), or {stale}."
        )
    if name.startswith(lane_blocks.DOCUMENT_KINDS):
        return (
            f"The group {name} is expected to run {longest:.0f} s on one worker of a shard, {given}. A document"
            " or control is observed in pieces, one configuration a worker, where its whole measure is past the"
            " profile's split threshold (proof/timings.json, execution.split; python3 -m proof.store.queue"
            " --split-above), and this one was queued whole: it is exported under one configuration, the store"
            f" holds its records, or the threshold is above it. Lower the threshold, or {stale}."
        )
    return (
        f"The group {name} is expected to run {longest:.0f} s on one worker of a shard, {given}. Split it"
        f" (proof.checks.sharding.SPLIT), or {stale}."
    )


def size(lane: Lane, *, workers: int, budget: float = SHARD_BUDGET_SECONDS, parallel: int = PARALLEL_SHARDS) -> dict:
    """The fewest shards over which no shard is expected past ``budget`` seconds, rounded up past ``parallel`` to a
    multiple of it (the module's docstring), and each one's deadline."""
    name, longest = _longest_run(lane, workers)
    if longest > budget:
        raise PlanError(_past_budget(lane, name, longest, budget))
    for fewest in range(1, MOST_SHARDS + 1):
        expected = max(spans(lane, fewest, workers), default=0.0)
        if expected <= budget:
            count = fewest
            blocks = len(lane.early) + len(lane.main)
            filled = min(math.ceil(fewest / parallel) * parallel, max(fewest, blocks)) if parallel > 0 else fewest
            if parallel < fewest < filled <= MOST_SHARDS:
                # The greedy bins of more shards are almost always no heavier; the fewest stand where they are.
                refilled = max(spans(lane, filled, workers), default=0.0)
                if refilled <= budget:
                    count, expected = filled, refilled
            low, high = DEADLINE_MINUTES
            deadline = min(high, max(low, math.ceil(2 * expected / 60)))
            return {"shards": count, "fewest": fewest, "deadline": deadline, "expected": round(expected, 3)}
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


def _budget(execution: Mapping) -> float:
    """The seconds the profile gives a shard (``execution.budget``), ``SHARD_BUDGET_SECONDS`` where it names none."""
    named = execution.get("budget", SHARD_BUDGET_SECONDS)
    if isinstance(named, bool) or not isinstance(named, (int, float)) or named <= 0:
        raise PlanError(
            "proof/timings.json's execution.budget is the seconds a shard of the profile's sized lanes is expected"
            f" to run at most; got {named!r}."
        )
    return float(named)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m proof.lane.plan", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    sized = commands.add_parser("size", help="the shards of a lane with the readers")
    sized.add_argument("queues", nargs="+", type=Path, help="the early queue, then the main queue")
    sized.add_argument("--timings", type=Path, default=sharding.TIMINGS)
    sized.add_argument("--budget", type=float, help="the seconds a shard is expected to run at most (the profile's)")
    sized.add_argument("--parallel", type=int, default=PARALLEL_SHARDS, help="how many shards run at once")
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
            lanes = [lane_of(value, None, estimate) for value in values[:1]]
            lanes += [lane_of(None, value, estimate) for value in values[1:]]
            lane = Lane(
                [block for held in lanes for block in held.early],
                [block for held in lanes for block in held.main],
                {name: pieces for held in lanes for name, pieces in held.after.items()},
            )
            workers = int(execution.get("workers", 4))
            budget = arguments.budget if arguments.budget is not None else _budget(execution)
            print(json.dumps(size(lane, workers=workers, budget=budget, parallel=arguments.parallel)))
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
