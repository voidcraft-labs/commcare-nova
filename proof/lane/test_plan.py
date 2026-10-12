"""A lane's plan: how many shards run it, and when it is expected to end.

Contracts (``proof.lane.plan``): a plan chooses a shard count and nothing else, so the queues it reads are left as
they are and every group they hold runs. A lane with the readers takes the fewest shards over which no shard is
expected past its budget, each with twice its expected work as a deadline, and a group that alone would run past
the budget fails the plan by name. A pull request's lane takes the fewest shards whose expected end is within the
tolerance of the soonest any count ends, every shard charged the latest start of the slots its count uses, and
says when it expects to end and each shard's deadline (twice its expected time, never under the floor). The
plausible failures: a plan that drops or rewrites a group to end sooner, a small lane taking every runner for a
second's gain, a large lane held to few shards, a deadline short enough to end a shard that is only doing its work,
and a summary that names another end than the plan's.
"""

from __future__ import annotations

import json

import pytest

from proof.lane import blocks as lane_blocks
from proof.lane import plan

# Shards start at 100 s (two), 200 s or 300 s (the rest); each spends 100 s beside its blocks and the gate 50 s.
EXECUTION = plan.Execution(shards=8, workers=4, slots=(100.0, 100.0, 200.0, 300.0), fixed=100.0, gate=50.0)


def _queue(*blocks: list[tuple[str, float]]) -> dict:
    """A queue's JSON of blocks of (group, box-seconds), each group carrying its estimate as the builder writes it."""
    return {
        "version": 1,
        "fingerprints": {},
        "blocks": [
            {
                "id": lane_blocks.block_id(name for name, _ in block),
                "estimate": round(sum(seconds for _, seconds in block), 3),
                "groups": [{"group": name, "fresh": False, "estimate": seconds} for name, seconds in block],
            }
            for block in blocks
        ],
        "cached": [{"group": "corpus:stored", "judgments": {}}],
        "readers": False,
    }


def _documents(count: int, seconds: float = 30.0) -> dict:
    return _queue(*([(f"corpus:d{index:02}", seconds)] for index in range(count)))


def _lane(early: dict, main: dict) -> plan.Lane:
    return plan.lane_of(early, main, lambda name: 1.0)


def test_a_lane_takes_the_fewest_shards_that_end_within_the_tolerance_of_the_soonest():
    # Nothing to run: every count ends at its start, setup and the gate; one shard ends soonest.
    assert plan.fitted(_lane(_queue(), _queue()), EXECUTION) == (1, 250.0)
    # 320 box-seconds: one shard ends at 570 s, two at 100 + 100 + 170 + 50 = 420 s (the one holding the package
    # runs 170), three, which start later, at 470 s.
    small = _lane(_queue([("proof/core", 20.0)]), _documents(10))
    assert [plan.ends(small, count, EXECUTION) for count in (1, 2, 3)] == [570.0, 420.0, 470.0]
    assert plan.fitted(small, EXECUTION) == (2, 420.0)
    # 1,440 box-seconds: eight shards of 180 end soonest, at 630 s; seven end at 660 s, past the tolerance.
    large = _lane(_queue(), _documents(48))
    assert plan.fitted(large, EXECUTION) == (8, 630.0)
    assert plan.ends(large, 7, EXECUTION) == 660.0
    # A count that ends within the tolerance of the soonest is taken for its fewer runners.
    assert plan.fitted(large, EXECUTION, tolerance=30.0) == (7, 660.0)


def test_a_plan_leaves_out_no_group_however_long_the_lane_then_takes():
    # A package of 300 box-seconds runs 1,200 s on one worker, on any count: the lane is expected to end at
    # 1,450 s, and the plan says so rather than leaving the package out.
    lane = _lane(_queue([("proof/editors", 300.0)]), _documents(48))
    count, end = plan.fitted(lane, EXECUTION)
    assert (count, end) == (2, 1450.0)
    assert set(lane.groups()) == {"proof/editors", *(f"corpus:d{index:02}" for index in range(48))}
    # Its shards' deadline is twice what the longest is expected to take from its start: (100 + 1,200) s.
    assert plan.deadline(lane, count, EXECUTION) == 44
    # A short shard's deadline is the floor: it ends a stuck shard, never one doing its work.
    assert plan.deadline(_lane(_queue(), _documents(4)), 1, EXECUTION) == plan.FIT_DEADLINE_MINUTES[0]


def test_a_group_runs_on_one_worker_so_its_shard_takes_at_least_its_whole_measure():
    lane = _lane(_queue([("proof/editors", 60.0)]), _queue())
    assert plan.spans(lane, 1, 4) == [240.0]
    assert plan.spans(_lane(_queue([("proof/a", 10.0), ("proof/b", 10.0)]), _queue()), 1, 4) == [40.0]


def test_a_lane_with_the_readers_is_sized_to_its_budget_and_refuses_a_group_past_it():
    lane = _lane(_queue([("proof/core", 100.0)]), _documents(100, 90.0))
    sized = plan.size(lane, workers=4, budget=3600.0)
    # 9,100 box-seconds within 3,600 a shard: three shards.
    assert sized == {"shards": 3, "deadline": 102, "expected": 3060.0}
    assert plan.size(_lane(_queue(), _queue()), workers=4) == {"shards": 1, "deadline": 60, "expected": 0.0}
    with pytest.raises(plan.PlanError, match="The group corpus:huge is expected to run 4000 s on one worker"):
        plan.size(_lane(_queue(), _queue([("corpus:huge", 1000.0)])), workers=4, budget=3600.0)


def _timings(tmp_path):
    timings = tmp_path / "timings.json"
    execution = {
        "shards": 8,
        "workers": 4,
        "runner": "ubuntu-24.04",
        "slots": [100, 100, 200, 300],
        "fixed": 100,
        "gate": 50,
    }
    timings.write_text(json.dumps({"profiles": {"no-readers": {"execution": execution, "groups": {}}}}))
    return timings


def test_the_command_prints_the_plan_leaves_the_queues_as_they_are_and_writes_the_summary(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("PROOF_READERS", "0")
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    timings = _timings(tmp_path)
    early, main = tmp_path / "early.json", tmp_path / "main.json"
    early.write_text(json.dumps(_queue([("proof/core", 20.0)])))
    main.write_text(json.dumps(_documents(48)))
    before = early.read_bytes(), main.read_bytes()
    arguments = ["fit", "--early", str(early), "--main", str(main), "--timings", str(timings)]
    assert plan.main(arguments) == 0
    printed = json.loads(capsys.readouterr().out)
    # 1,460 box-seconds: eight shards end at 650 s (the one holding the package runs 200), seven at 660 s, within
    # the tolerance, so seven are taken.
    assert printed == {"shards": 7, "ends": 660.0, "deadline": 20, "groups": 49, "seconds": 1460.0}
    assert (early.read_bytes(), main.read_bytes()) == before
    assert summary.read_text() == (
        "## Proof lane plan\n\nThe proof lane runs 49 groups (1460 box-seconds) on 7 shards and is expected to end"
        " about 11 min 00 s after the workflow starts, as modelled from proof/timings.json's measures; every group"
        " the queues hold runs, however long it takes. Each shard's deadline is 20 minutes, which only ends a stuck"
        " shard, failing the lane.\n"
    )
    # A named count is planned as named, for a controlled comparison; default is the execution's.
    assert plan.main([*arguments, "--shards", "2"]) == 0
    assert json.loads(capsys.readouterr().out) == {
        "shards": 2,
        "ends": 990.0,
        "deadline": 28,
        "groups": 49,
        "seconds": 1460.0,
    }
    assert plan.main([*arguments, "--shards", "default"]) == 0
    assert json.loads(capsys.readouterr().out)["shards"] == 8
    assert plan.main([*arguments, "--shards", "none"]) == 1
    assert "--shards takes fit, default or a whole number" in capsys.readouterr().err
    # Without a main queue (a failed emission) the early queue alone is planned.
    main.unlink()
    assert plan.main(["fit", "--early", str(early), "--timings", str(timings)]) == 0
    assert json.loads(capsys.readouterr().out)["shards"] == 1
