"""A lane's plan: how many shards run it, and when it is expected to end.

Contracts (``proof.lane.plan``): a plan chooses a shard count and nothing else, so the queues it reads are left as
they are and every group they hold runs. A lane with the readers takes the fewest shards over which no shard is
expected past its budget (the profile's, from proof/timings.json), each with twice its expected work as a deadline,
and a group that alone would run past the budget fails the plan by name. A document observed in pieces counts as
its longest piece and the judging after it, the longest run of its work a shard cannot divide. Past as many shards
as run at once the count is rounded up to a multiple of that many, never past the blocks there are to run. A
pull request's lane takes the fewest shards whose expected end is within the tolerance of the soonest any count ends,
every shard charged the latest start of the slots its count uses, and says when it expects to end and each
shard's deadline (twice its expected time, never under the floor). The plausible failures: a plan that drops or
rewrites a group to end sooner, a small lane taking every runner for a second's gain, a large lane held to few
shards, a deadline short enough to end a shard that is only doing its work, a summary that names another end than
the plan's, a lane refused for a document whose pieces each fit (or planned as if its pieces and its judging ran
at once), and a last round of two shards beside rounds of fourteen twice as long as they need be.
"""

from __future__ import annotations

import json
import re

import pytest

from proof.checks import sharding
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
    assert sized == {"shards": 3, "fewest": 3, "deadline": 102, "expected": 3060.0}
    assert plan.size(_lane(_queue(), _queue()), workers=4) == {
        "shards": 1,
        "fewest": 1,
        "deadline": 60,
        "expected": 0.0,
    }
    with pytest.raises(plan.PlanError) as refused:
        plan.size(_lane(_queue(), _queue([("corpus:huge", 1000.0)])), workers=4, budget=3600.0)
    # A document queued whole past the budget is named with what would divide it.
    assert "The group corpus:huge is expected to run 4000 s on one worker of a shard, past the 3600 s" in str(
        refused.value
    )
    assert "is observed in pieces, one configuration a worker" in str(refused.value)
    with pytest.raises(plan.PlanError, match=r"The group proof/editors is expected to run 4000 s .* Split it \("):
        plan.size(_lane(_queue([("proof/editors", 1000.0)]), _queue()), workers=4, budget=3600.0)


def _pieces(name: str, heavier: float, lighter: float, judging: float) -> dict:
    """The queue of one document in pieces, in box-seconds: its two configurations' and its own group after them."""
    value = _queue([(f"{name}@maximum", heavier), (f"{name}@minimum", lighter), (name, judging)])
    value["blocks"][0]["groups"][2]["after"] = [f"{name}@maximum", f"{name}@minimum"]
    return value


def test_a_document_in_pieces_counts_as_its_longest_piece_and_the_judging_after_it():
    # Whole, the document would run 4,040 s on one worker. In pieces its longest run is 600 box-seconds of the
    # heavier configuration and 10 of judging, 2,440 s on a worker, while the lighter piece runs beside it.
    lane = _lane(_queue(), _pieces("corpus:heavy", 600.0, 400.0, 10.0))
    assert lane.after == {"corpus:heavy": ("corpus:heavy@maximum", "corpus:heavy@minimum")}
    assert lane.runs() == {"corpus:heavy@maximum": 600.0, "corpus:heavy@minimum": 400.0, "corpus:heavy": 610.0}
    assert plan.spans(lane, 1, 4) == [2440.0]
    assert plan.size(lane, workers=4, budget=3600.0) == {"shards": 1, "fewest": 1, "deadline": 82, "expected": 2440.0}
    # A configuration that alone outgrows the budget is refused by its piece's name: nothing smaller divides it.
    with pytest.raises(plan.PlanError) as refused:
        plan.size(lane, workers=4, budget=2400.0)
    assert str(refused.value).startswith(
        "The piece corpus:heavy@maximum and the judging of corpus:heavy that follows it are expected to run 2440 s"
        " on one worker of a shard, past the 2400 s a shard is given"
    )
    assert "A configuration is the smallest piece a document is observed in" in str(refused.value)
    # The fit, which a pull request's lane uses, reads the same run of work.
    execution = plan.Execution(shards=2, workers=4, slots=(0.0,), fixed=0.0, gate=0.0)
    assert plan.span(lane, 1, execution) == 2440.0


def test_an_unmeasured_piece_is_counted_by_how_many_pieces_its_document_is_observed_in():
    """A queue whose groups carry no estimates (one written by hand, or by an older builder) is planned from the
    timings, and a piece no run measured is a share of its document there. The queue builder counts that share
    for the configurations the document is exported under; counted at the two-piece share whatever their number,
    a control under four configurations weighs 2.6 times itself, and its block's other groups are planned
    lighter than they are and its pieces past a budget they fit."""
    from proof.checks import sharding

    pieces = [f"control:wide@{name}" for name in ("a", "b", "c", "d")]
    block = {
        "id": lane_blocks.block_id([*pieces, "control:wide", "corpus:beside"]),
        "estimate": 400.0,
        "groups": [
            *({"group": piece, "fresh": False} for piece in pieces),
            {"group": "control:wide", "fresh": False, "after": pieces},
            {"group": "corpus:beside", "fresh": False},
        ],
    }
    queue = {"version": 1, "fingerprints": {}, "blocks": [block], "cached": [], "readers": True}
    # The document measured whole at 200 box-seconds (its own group's judging counted among them), the one beside
    # it at 100: each of four pieces is 0.325 of 200, not 0.65 of it.
    estimate = sharding.estimate({"control:wide": 200.0, "corpus:beside": 100.0})
    lane = plan.lane_of(None, queue, estimate)
    share = sharding.piece_share(4)
    assert share == pytest.approx(0.325)
    total = 4 * share * 200.0 + 200.0 + 100.0
    assert lane.groups()["control:wide@a"] == pytest.approx(400.0 * share * 200.0 / total)
    assert lane.groups()["corpus:beside"] == pytest.approx(400.0 * 100.0 / total)
    # The four pieces together are what the builder would queue for them: 1.3 documents, never 2.6.
    assert sum(lane.groups()[piece] for piece in pieces) == pytest.approx(400.0 * 1.3 * 200.0 / total)


def test_past_as_many_shards_as_run_at_once_the_count_fills_its_last_round():
    # 160 documents of 20 box-seconds within 210 a shard: sixteen shards of 200 s, fourteen at once, so two rounds
    # either way. Twenty-eight fill the second round, and each then runs six documents at most, 120 s.
    lane = _lane(_queue(), _documents(160, 20.0))
    assert plan.size(lane, workers=1, budget=210.0, parallel=14) == {
        "shards": 28,
        "fewest": 16,
        "deadline": 60,
        "expected": 120.0,
    }
    # Within one round nothing is added: the fewest shards take the fewest runners.
    assert plan.size(lane, workers=1, budget=210.0, parallel=16)["shards"] == 16
    assert plan.size(_lane(_queue(), _documents(60, 20.0)), workers=1, budget=210.0, parallel=14)["shards"] == 6
    # A count already a multiple stands, and no shard is added past the blocks there are to run: sixteen
    # documents of 100 s, one a shard, take sixteen shards, and eighteen of them eighteen.
    assert plan.size(_lane(_queue(), _documents(280, 20.0)), workers=1, budget=210.0, parallel=14)["shards"] == 28
    assert plan.size(_lane(_queue(), _documents(16, 100.0)), workers=1, budget=110.0, parallel=14)["shards"] == 16
    assert plan.size(_lane(_queue(), _documents(18, 100.0)), workers=1, budget=110.0, parallel=14)["shards"] == 18


def test_as_many_shards_run_at_once_as_the_lanes_workflow_says():
    workflow = (sharding.PROOF_DIR.parent / ".github" / "workflows" / "proof-lane.yml").read_text(encoding="utf-8")
    assert [int(found) for found in re.findall(r"^\s*max-parallel: (\d+)$", workflow, re.M)] == [plan.PARALLEL_SHARDS]


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
    readers = {"shards": 16, "workers": 4, "runner": "ubuntu-24.04", "budget": 2500, "split": 1250}
    profiles = {
        "no-readers": {"execution": execution, "groups": {}},
        "readers": {"execution": readers, "groups": {}},
    }
    timings.write_text(json.dumps({"profiles": profiles}))
    return timings


def test_a_sized_lane_is_given_its_profiles_budget_from_the_timings(tmp_path, monkeypatch, capsys):
    timings = _timings(tmp_path)
    early, main = tmp_path / "early.json", tmp_path / "main.json"
    early.write_text(json.dumps({**_queue([("proof/core", 20.0)]), "readers": True}))
    main.write_text(json.dumps({**_pieces("corpus:heavy", 600.0, 400.0, 10.0), "readers": True}))
    arguments = ["size", str(early), str(main), "--timings", str(timings)]
    # With every reader the profile gives a shard 2,500 s, which holds the heavier piece and its judging (2,440 s).
    monkeypatch.setenv("PROOF_READERS", "all")
    assert plan.main(arguments) == 0
    assert json.loads(capsys.readouterr().out) == {"shards": 1, "fewest": 1, "deadline": 82, "expected": 2440.0}
    # A budget named by hand stands in its place, and one the piece outgrows refuses the lane by the piece's name.
    assert plan.main([*arguments, "--budget", "2400"]) == 1
    assert "The piece corpus:heavy@maximum and the judging of corpus:heavy" in capsys.readouterr().err
    # A profile that names no budget is given the lane's own: the pull request lane's profile names none.
    monkeypatch.setenv("PROOF_READERS", "0")
    early.write_text(json.dumps(_queue([("proof/core", 20.0)])))
    main.write_text(json.dumps(_pieces("corpus:heavy", 600.0, 400.0, 10.0)))
    assert plan.main(arguments) == 0
    assert json.loads(capsys.readouterr().out)["expected"] == 2440.0
    broken = json.loads(timings.read_text())
    broken["profiles"]["no-readers"]["execution"]["budget"] = "long"
    timings.write_text(json.dumps(broken))
    assert plan.main(arguments) == 1
    assert "execution.budget is the seconds a shard" in capsys.readouterr().err


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
