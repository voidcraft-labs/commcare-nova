"""A lane's plan: how many shards run it, and what a pull request's lane leaves to the nightly to end in time.

Contracts (``proof.lane.plan``): a lane with the readers takes the fewest shards over which no shard is expected
past its budget, each with twice its expected work as a deadline, and a group that alone would run past the budget
fails the plan by name. A pull request's lane takes the fewest shards with which it ends within the bound, every
shard charged the latest start of the slots its count uses; where no count holds every group, it defers groups,
documents and packages alike, until it does, keeping the most work any count can hold, and which groups it defers
follows the seed (the head commit), so every group that can run is run on some push. The queues it rewrites hold
every group once: run in a block whose id and estimate follow its groups, read from the store, or deferred with
its estimate. The plausible failures: a plan whose lane runs past its bound, a lane deferred though it fits, the
same groups deferred on every push, a deferral that keeps less than a count could, and a rewritten queue that loses
a group or a block whose id no longer names its groups.
"""

from __future__ import annotations

import json

import pytest

from proof.lane import blocks as lane_blocks
from proof.lane import plan

# Shards start at 100 s (two), 200 s or 300 s (the rest); each spends 100 s beside its blocks and the gate 50 s, so
# a shard of one or two holds 350 s, of three 250 s, of four or more 150 s, within 600 s.
EXECUTION = plan.Execution(shards=8, workers=4, bound=600.0, slots=(100.0, 100.0, 200.0, 300.0), fixed=100.0, gate=50.0)


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


def test_a_lane_that_fits_whole_takes_the_fewest_shards_that_end_in_time_and_defers_nothing():
    lane = _lane(_queue([("proof/core", 20.0)]), _documents(10))
    # 320 box-seconds: one shard holds them (100 + 100 + 320 + 50 = 570 s).
    assert plan.fitted(lane, EXECUTION) == (1, 570.0)
    assert plan.deferral(lane, EXECUTION, "seed") == set()
    # Forty documents (1,200 s) fit only on eight shards of 150 each.
    assert plan.fitted(_lane(_queue(), _documents(40)), EXECUTION) == (8, 600.0)


def test_a_group_runs_on_one_worker_so_its_shard_takes_at_least_its_whole_measure():
    lane = _lane(_queue([("proof/editors", 60.0)]), _queue())
    assert plan.spans(lane, 1, 4) == [240.0]
    assert plan.spans(_lane(_queue([("proof/a", 10.0), ("proof/b", 10.0)]), _queue()), 1, 4) == [40.0]


def test_a_lane_past_its_bound_defers_what_does_not_fit_by_the_seed_and_ends_in_time():
    # Forty-eight documents of 30: eight shards hold forty, so eight are deferred, whichever the seed picks.
    lane = _lane(_queue(), _documents(48))
    deferred = plan.deferral(lane, EXECUTION, "head-1")
    assert len(deferred) == 8
    kept = lane.without(deferred)
    count, end = plan.fitted(kept, EXECUTION)
    assert end <= EXECUTION.bound and count == 8
    # The same commit defers the same groups; another commit, others; over many, every document runs on some.
    assert plan.deferral(lane, EXECUTION, "head-1") == deferred
    seen = [plan.deferral(lane, EXECUTION, f"head-{index}") for index in range(40)]
    assert len({frozenset(found) for found in seen}) > 30
    assert set().union(*seen) == set(lane.groups())
    assert all(any(name not in found for found in seen) for name in lane.groups())


def test_the_count_that_keeps_the_most_work_is_taken_and_a_group_its_shards_cannot_hold_is_deferred():
    # A package of 60 runs 240 s on one worker: only a shard of one to three holds it (at most 750 s of work
    # there), while eight shards hold 1,200 of the documents' 1,440.
    lane = _lane(_queue([("proof/editors", 60.0)]), _documents(48))
    deferred = plan.deferral(lane, EXECUTION, "head")
    assert "proof/editors" in deferred
    kept = lane.without(deferred)
    assert sum(kept.groups().values()) == 1200.0
    assert plan.fitted(kept, EXECUTION)[1] <= EXECUTION.bound


def test_the_rewritten_queues_hold_every_group_once_with_blocks_named_by_what_they_keep():
    early = _queue([("proof/core", 20.0), ("proof/lane", 15.0)], [("surface", 10.0)])
    main = _queue([("corpus:a", 30.0), ("corpus:b", 30.0)], [("control:c", 5.0)])
    lane = _lane(early, main)
    deferred = {"proof/lane", "corpus:a", "control:c"}
    rewritten_early = plan.rewritten(early, deferred, lane.early)
    rewritten_main = plan.rewritten(main, deferred, lane.main)
    for value in (rewritten_early, rewritten_main):
        lane_blocks.parse_queue(value)
    assert rewritten_early["blocks"][0] == {
        "id": lane_blocks.block_id(["proof/core"]),
        "estimate": 20.0,
        "groups": [{"group": "proof/core", "fresh": False, "estimate": 20.0}],
    }
    assert rewritten_early["deferred"] == [{"group": "proof/lane", "estimate": 15.0}]
    assert [block["groups"][0]["group"] for block in rewritten_main["blocks"]] == ["corpus:b"]
    assert rewritten_main["deferred"] == [
        {"group": "control:c", "estimate": 5.0},
        {"group": "corpus:a", "estimate": 30.0},
    ]
    accounted = (
        lane_blocks.parse_queue(rewritten_early).accounted() | lane_blocks.parse_queue(rewritten_main).accounted()
    )
    assert accounted == set(lane.groups()) | {"corpus:stored"}


def test_a_lane_with_the_readers_is_sized_to_its_budget_and_refuses_a_group_past_it():
    lane = _lane(_queue([("proof/core", 100.0)]), _documents(100, 90.0))
    sized = plan.size(lane, workers=4, budget=3600.0)
    # 9,100 box-seconds within 3,600 a shard: three shards.
    assert sized == {"shards": 3, "deadline": 102, "expected": 3060.0}
    assert plan.size(_lane(_queue(), _queue()), workers=4) == {"shards": 1, "deadline": 60, "expected": 0.0}
    with pytest.raises(plan.PlanError, match="The group corpus:huge is expected to run 4000 s on one worker"):
        plan.size(_lane(_queue(), _queue([("corpus:huge", 1000.0)])), workers=4, budget=3600.0)


def test_the_command_rewrites_both_queues_in_place_and_prints_the_plan(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PROOF_READERS", "0")
    timings = tmp_path / "timings.json"
    execution = {
        "shards": 8,
        "workers": 4,
        "runner": "ubuntu-24.04",
        "bound": 600,
        "slots": [100, 100, 200, 300],
        "fixed": 100,
        "gate": 50,
    }
    timings.write_text(json.dumps({"profiles": {"no-readers": {"execution": execution, "groups": {}}}}))
    early, main = tmp_path / "early.json", tmp_path / "main.json"
    early.write_text(json.dumps(_queue([("proof/core", 20.0)])))
    main.write_text(json.dumps(_documents(48)))
    arguments = ["fit", "--early", str(early), "--main", str(main), "--seed", "head", "--timings", str(timings)]
    assert plan.main(arguments) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["fits"] is True and printed["ends"] <= 600 and len(printed["deferred"]) == 9
    written = lane_blocks.load_queue(main).deferred + lane_blocks.load_queue(early).deferred
    assert sorted(entry.group for entry in written) == printed["deferred"]
    # Without a main queue (a failed emission) the early queue alone is planned.
    main.unlink()
    assert plan.main(["fit", "--early", str(early), "--seed", "head", "--timings", str(timings)]) == 0
    assert json.loads(capsys.readouterr().out)["shards"] == 1
