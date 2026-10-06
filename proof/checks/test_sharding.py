"""Groups hold together what one worker shares, and a run's outputs ran every queued block exactly once.

Contracts (``proof.checks.sharding``): every item of one corpus document is
one group, proof/surface's items are the surface block's, every other item
its package's; a group's items run back to back; the static bins every shard
computes are the same however the blocks are listed; and ``verify`` holds a
run's outputs to its queues. The plausible failures it must catch: a block
no shard ran (unclaimed, or its shard died), a block two shards ran with
different results, a cached group that ran anyway, a group that left items
unrun (a lost worker, a stop), a block run with other groups than queued, a
block no queue holds, shards whose collections differ, and a shard that
collected items no queue accounts for. Each refusal is paired with the run
it accepts. The outputs are written with the server's own writers
(``proof.lane.blocks``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from proof.checks import sharding
from proof.lane import blocks as lane_blocks

PROOF = sharding.PROOF_DIR


@dataclass
class _Param:
    group: str


@dataclass
class _Callspec:
    params: dict = field(default_factory=dict)


@dataclass
class _Item:
    nodeid: str
    path: Path
    callspec: _Callspec | None = None


def _items():
    items = [
        _Item(
            f"checks/test_bar.py::test[{name}]",
            PROOF / "checks/test_bar.py",
            _Callspec({"document": _Param(f"corpus:{name}")}),
        )
        for name in ("a", "b", "c", "d")
    ]
    items += [
        _Item(
            f"checks/test_proof1_identity.py::test[{name}]",
            PROOF / "checks/test_proof1_identity.py",
            _Callspec({"document": _Param(f"corpus:{name}")}),
        )
        for name in ("a", "b", "c", "d")
    ]
    items += [_Item(f"native/test_{n}.py::test", PROOF / f"native/test_{n}.py") for n in range(3)]
    items += [
        _Item("hq/test_boot.py::test", PROOF / "hq/test_boot.py"),
        _Item("surface/test_flags.py::test", PROOF / "surface/test_flags.py"),
        _Item("test_top.py::test", PROOF / "test_top.py"),
    ]
    return items


def test_a_lane_position_is_named_as_one_of_several():
    assert sharding.parse_shard("2/4", "--bin") == (2, 4)
    assert sharding.parse_shard("10/12", "--bin") == (10, 12)
    for value in ("0/4", "5/4", "a/b", "3", "1/0", "+1/4", " 1/4", "1/4 ", "1_0/40", "-1/4"):
        with pytest.raises(sharding.ShardError, match="PROOF_WORKER is"):
            sharding.parse_shard(value, "PROOF_WORKER")


def test_items_are_grouped_by_document_by_package_and_the_surface_block():
    groups = {item.nodeid: sharding.item_group(item) for item in _items()}
    assert groups["checks/test_bar.py::test[a]"] == groups["checks/test_proof1_identity.py::test[a]"] == "corpus:a"
    assert groups["native/test_0.py::test"] == groups["native/test_2.py::test"] == "proof/native"
    assert groups["hq/test_boot.py::test"] == "proof/hq"
    assert groups["surface/test_flags.py::test"] == "surface"
    assert groups["test_top.py::test"] == "proof"
    for group in set(groups.values()):
        assert lane_blocks.group_problem(group) is None, group


def test_each_groups_items_run_together_in_first_appearance_order():
    items = _items()
    shuffled = [items[0], items[8], items[4], items[1], items[9], items[5], *items[2:4], *items[6:8], *items[10:]]
    ordered = sharding.order_by_group(shuffled)
    groups = [sharding.item_group(item) for item in ordered]
    assert groups == sorted(groups, key=groups.index)  # each group contiguous
    assert [item.nodeid for item in ordered][:2] == [items[0].nodeid, items[4].nodeid]  # a's bar, then its proof 1
    assert sorted(item.nodeid for item in ordered) == sorted(item.nodeid for item in items)


def test_each_group_is_collected_from_where_its_tests_are():
    roots = sharding.collection_roots(["corpus:a", "control:x", "surface", "proof/hq", "proof", "hq-selfchecks"])
    assert PROOF / "checks" in roots and PROOF / "surface" in roots and PROOF / "hq" in roots
    top = {path for path in roots if path.parent == PROOF and path.suffix == ".py"}
    assert top == set(PROOF.glob("test_*.py")) and top, "proof's own test modules"
    assert len(roots) == 3 + len(top)  # no test module belongs to the HQ self-checks, so they name nothing
    assert sharding.collection_roots(["corpus:a@minimum"]) == [PROOF / "checks", PROOF / "hq"]


def test_a_document_the_timings_do_not_list_counts_as_their_median_document():
    """A sample's documents change with its size and seed, so most are unmeasured; counting each at the
    default would let a shard of heavy documents pass for a light one."""
    timings = {"corpus:a": 20.0, "corpus:b": 30.0, "corpus:c": 40.0, "proof/native": 100.0}
    seconds = sharding.estimate(timings)
    assert seconds("corpus:b") == 30.0
    assert seconds("corpus:new") == seconds("control:new") == 30.0
    # A document split by configuration counts half its whole measure.
    assert seconds("corpus:c@minimum") == 20.0
    assert seconds("corpus:new@maximum") == 30.0
    assert seconds("proof/new") == sharding.DEFAULT_SECONDS
    assert sharding.estimate({})("corpus:new") == sharding.DEFAULT_SECONDS


def test_the_timings_file_must_hold_groups(tmp_path):
    path = tmp_path / "timings.json"
    assert sharding.load_timings(path) == {}
    path.write_text(json.dumps({"execution": {"shards": 14, "workers": 4}, "groups": {"corpus:a": 2.5}}))
    assert sharding.load_timings(path) == {"corpus:a": 2.5}
    path.write_text(json.dumps({"corpus:a": 2.5}))
    with pytest.raises(sharding.ShardError, match="groups"):
        sharding.load_timings(path)


def _block(*names, estimate=1.0, fresh=()):
    groups = tuple(lane_blocks.QueuedGroup(name, name in fresh) for name in names)
    return lane_blocks.Block(lane_blocks.block_id(names), estimate, groups)


def test_static_bins_are_the_same_however_the_blocks_are_listed_and_balance_by_estimate():
    blocks = [
        _block(f"corpus:d{index}", estimate=estimate) for index, estimate in enumerate([9, 7, 7, 5, 4, 3, 3, 2, 1, 1])
    ]
    bins = sharding.static_bins(blocks, 3)
    assert sharding.static_bins(list(reversed(blocks)), 3) == [
        sorted(members, key=lambda block: list(reversed(blocks)).index(block)) for members in bins
    ]
    assert [block.id for block in bins[0]] == [block.id for block in sorted(bins[0], key=blocks.index)]
    assert sorted(block.id for members in bins for block in members) == sorted(block.id for block in blocks)
    loads = [sum(block.estimate for block in members) for members in bins]
    assert max(loads) - min(loads) <= max(block.estimate for block in blocks)
    heaviest = {block.id for block in blocks[:3]}
    assert all(len(heaviest & {block.id for block in members}) == 1 for members in bins)
    assert sharding.static_bins(blocks, 1) == [blocks]
    with pytest.raises(sharding.ShardError):
        sharding.static_bins(blocks, 0)


def test_shards_that_claim_start_on_their_own_bins_and_each_reaches_every_block():
    """Shards walking one order all ask for the same next block, and every collision costs a claim; each shard
    claims its own bin first, so the shards' first claims never meet, and then every other block."""
    blocks = [
        _block(f"corpus:d{index}", estimate=estimate) for index, estimate in enumerate([9, 7, 7, 5, 4, 3, 3, 2, 1, 1])
    ]
    bins = sharding.static_bins(blocks, 3)
    orders = [sharding.claim_order(blocks, index, 3) for index in (1, 2, 3)]
    for index, order in enumerate(orders):
        assert sorted(block.id for block in order) == sorted(block.id for block in blocks)
        assert order[: len(bins[index])] == bins[index]
    assert orders[0] == [*bins[0], *bins[1], *bins[2]] and orders[2] == [*bins[2], *bins[0], *bins[1]]
    assert sharding.claim_order(blocks, 1, 1) == blocks


def test_static_bins_give_each_block_to_the_least_loaded_bin_not_the_one_holding_fewest():
    """One heavy block and ten light ones in two bins: by load, the light ones all join the bin without the heavy
    one (10 and 10); by count they would alternate (15 and 5)."""
    heavy = _block("corpus:heavy", estimate=10)
    light = [_block(f"corpus:light{index}", estimate=1) for index in range(10)]
    bins = sharding.static_bins([*light, heavy], 2)
    assert bins == [[heavy], light]


# Outputs, as the server writes them ----------------------------------------------------------------


def _queue(*blocks, cached=()):
    return lane_blocks.Queue(tuple(blocks), tuple(lane_blocks.CachedGroup(name, {"bar": "k"}) for name in cached))


def _collected(group):
    return [f"checks/test_bar.py::test[{group}]", f"checks/test_proof1_identity.py::test[{group}]"]


def _write_run(output, block, *, outcomes=None, failure=None, evidence=None, groups=None, label="shard-1"):
    records = []
    for queued in block.groups:
        collected = _collected(queued.group)
        ran = {node_id: "passed" for node_id in collected} if outcomes is None else outcomes
        records.append(
            lane_blocks.group_record(
                group=queued.group,
                fresh=queued.fresh,
                collected=collected,
                outcomes=ran,
                worker=1,
                seconds=1.5,
                failure=failure,
            )
        )
    if groups is not None:
        records = groups
    directory = lane_blocks.block_dir(output, block.id)
    lane_blocks.write_json(
        directory / lane_blocks.MANIFEST, lane_blocks.manifest(block, phase="main", shard=label, groups=records)
    )
    for name, text in (evidence or {}).items():
        (directory / name).parent.mkdir(parents=True, exist_ok=True)
        (directory / name).write_text(text)
    return directory


def _write_serve(output, *, digest="d1", unaccounted=()):
    lane_blocks.write_json(
        output / lane_blocks.SERVE,
        {"phases": [{"phase": "main", "collected": {"digest": digest}, "unaccounted": list(unaccounted)}]},
    )


def _outputs(tmp_path, count=2):
    outputs = [tmp_path / f"out-{index}" for index in range(1, count + 1)]
    for output in outputs:
        _write_serve(output)
    return outputs


def test_a_run_that_ran_every_queued_block_once_holds_and_counts_each_blocks_run(tmp_path):
    first, second = _block("corpus:a", "corpus:b"), _block("corpus:c")
    out1, out2 = _outputs(tmp_path)
    ran_first = _write_run(out1, first)
    ran_second = _write_run(out2, second)
    verdict = sharding.verify([("main", _queue(first, second, cached=["corpus:d"]))], [out1, out2])
    assert verdict.problems == [] and verdict.notes == []
    assert verdict.chosen == {first.id: ran_first, second.id: ran_second}


def test_a_block_no_output_holds_fails_the_run(tmp_path):
    first, second = _block("corpus:a"), _block("corpus:b")
    (out1,) = _outputs(tmp_path, 1)
    _write_run(out1, first)
    verdict = sharding.verify([("main", _queue(first, second))], [out1])
    assert [problem for problem in verdict.problems if second.id in problem and "no shard claimed it" in problem]
    assert not [problem for problem in verdict.problems if first.id in problem]


def test_a_block_run_twice_fails_whether_the_runs_wrote_the_same_or_not(tmp_path):
    block = _block("corpus:a")
    out1, out2 = _outputs(tmp_path)
    evidence = {"checks/bar/corpus-a.json": '{"differences": []}\n'}
    _write_run(out1, block, evidence=evidence)
    _write_run(out2, block, evidence=evidence)
    # Runs that read one evidence store's records write alike, so writing alike shows nothing but a broken claim.
    alike = sharding.verify([("main", _queue(block))], [out1, out2])
    assert any("ran 2 times" in problem and "the runs wrote the same" in problem for problem in alike.problems)
    assert alike.chosen[block.id] == lane_blocks.block_dir(out1, block.id)
    single = sharding.verify([("main", _queue(block))], [out1])
    assert single.problems == []

    (lane_blocks.block_dir(out2, block.id) / "checks/bar/corpus-a.json").write_text('{"differences": [1]}\n')
    differing = sharding.verify([("main", _queue(block))], [out1, out2])
    assert any("checks/bar/corpus-a.json" in problem for problem in differing.problems)


def test_a_cached_group_that_ran_fails_the_run(tmp_path):
    block = _block("corpus:a")
    out1, out2 = _outputs(tmp_path)
    _write_run(out1, block)
    stray = _block("corpus:b")
    _write_run(out2, stray)
    verdict = sharding.verify([("main", _queue(block, cached=["corpus:b"]))], [out1, out2])
    assert any("corpus:b" in problem and "read from the store" in problem for problem in verdict.problems)
    assert any(stray.id in problem and "no queue" in problem for problem in verdict.problems)


def test_a_group_must_run_every_item_its_worker_collected(tmp_path):
    block = _block("corpus:a")
    (out1,) = _outputs(tmp_path, 1)
    _write_run(out1, block, outcomes={_collected("corpus:a")[0]: "failed"})
    verdict = sharding.verify([("main", _queue(block))], [out1])
    assert any("left 1 of its 2 collected items unrun" in problem for problem in verdict.problems)

    lost = _block("corpus:b")
    _write_run(out1, lost, outcomes={}, failure="worker w2 exited with status -9 while running it")
    verdict = sharding.verify([("main", _queue(lost))], [out1])
    assert any("did not finish: worker w2 exited" in problem for problem in verdict.problems)

    empty = _block("corpus:c")
    record = lane_blocks.group_record(group="corpus:c", fresh=False, collected=[], outcomes={})
    _write_run(out1, empty, groups=[record])
    verdict = sharding.verify([("main", _queue(empty))], [out1])
    assert any("collected no item of corpus:c" in problem for problem in verdict.problems)


def test_a_group_may_run_only_items_its_worker_collected(tmp_path):
    block = _block("corpus:a")
    (out1,) = _outputs(tmp_path, 1)
    stray = "checks/test_bar.py::test[elsewhere]"
    _write_run(out1, block, outcomes={**dict.fromkeys(_collected("corpus:a"), "passed"), stray: "passed"})
    verdict = sharding.verify([("main", _queue(block))], [out1])
    assert [
        problem
        for problem in verdict.problems
        if "ran items its worker never collected" in problem and stray in problem
    ]


def test_a_block_run_with_other_groups_or_freshness_than_queued_fails_the_run(tmp_path):
    queued = _block("corpus:a", "corpus:b", fresh=("corpus:b",))
    (out1,) = _outputs(tmp_path, 1)
    ran = lane_blocks.Block(queued.id, 1.0, (lane_blocks.QueuedGroup("corpus:a"),))
    _write_run(out1, ran)
    verdict = sharding.verify([("main", _queue(queued))], [out1])
    assert any("the queue's block holds corpus:a, corpus:b" in problem for problem in verdict.problems)

    # Every group ran, and corpus:b read its records from the store where the queue asks them recomputed.
    (out2,) = _outputs(tmp_path / "stale", 1)
    _write_run(out2, _block("corpus:a", "corpus:b"))
    verdict = sharding.verify([("main", _queue(queued))], [out2])
    assert verdict.problems == [
        f"{lane_blocks.block_dir(out2, queued.id)} ran corpus:b with fresh False, and the queue asks True."
    ]
    _write_run(out1, queued)
    assert sharding.verify([("main", _queue(queued))], [out1]).problems == []


def test_shards_must_collect_alike_and_account_for_every_group_they_collect(tmp_path):
    block = _block("corpus:a")
    out1, out2 = _outputs(tmp_path)
    _write_run(out1, block)
    _write_serve(out2, digest="d2", unaccounted=["proof/forgotten"])
    verdict = sharding.verify([("main", _queue(block))], [out1, out2])
    assert any("collected different items in the main phase" in problem for problem in verdict.problems)
    assert any("proof/forgotten" in problem for problem in verdict.problems)

    missing = tmp_path / "out-unfinished"
    missing.mkdir()
    verdict = sharding.verify([("main", _queue(block))], [out1, missing])
    assert any("holds no serve.json" in problem for problem in verdict.problems)


def test_the_queues_may_not_hold_a_group_twice(tmp_path):
    early, main = _block("proof/hq"), _block("proof/hq", "corpus:a")
    verdict = sharding.verify([("early", _queue(early)), ("main", _queue(main))], [])
    assert any("queued in both the early and the main queue" in problem for problem in verdict.problems)


def test_the_command_line_holds_the_outputs_to_the_named_queues(tmp_path, capsys):
    block = _block("corpus:a")
    (out1,) = _outputs(tmp_path, 1)
    _write_run(out1, block)
    queue = tmp_path / "queue.json"
    lane_blocks.write_json(queue, lane_blocks.queue_json(_queue(block)))
    assert sharding.main(["verify", "--queue", str(queue), str(out1)]) == 0
    other = tmp_path / "other.json"
    lane_blocks.write_json(other, lane_blocks.queue_json(_queue(block, _block("corpus:z"))))
    assert sharding.main(["verify", "--queue", str(other), str(out1)]) == 1
    assert "corpus:z" in capsys.readouterr().err
    assert sharding.main(["verify", str(out1)]) == 2
