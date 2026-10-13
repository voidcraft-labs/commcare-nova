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

    @property
    def originalname(self):
        """The test's own name, as pytest gives a parametrized item's."""
        return self.nodeid.rpartition("::")[2].partition("[")[0]


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


def test_a_split_module_and_each_test_it_names_are_groups_of_their_own_and_read_what_their_package_reads(
    monkeypatch,
):
    """A group runs on one worker, so a package whose tests a shard cannot hold whole runs as several (SPLIT); each
    is still its package's, in the phase and with the data its package's tests read."""
    monkeypatch.setattr(sharding, "SPLIT", {"hq/test_boot.py": ("test_slow",)})
    items = [
        _Item("hq/test_boot.py::test_slow[one]", PROOF / "hq/test_boot.py"),
        _Item("hq/test_boot.py::test_slow[two]", PROOF / "hq/test_boot.py"),
        _Item("hq/test_boot.py::test_fast", PROOF / "hq/test_boot.py"),
        _Item("hq/test_build.py::test", PROOF / "hq/test_build.py"),
    ]
    groups = [sharding.item_group(item) for item in items]
    assert groups == ["proof/hq/test_boot.py::test_slow"] * 2 + ["proof/hq/test_boot.py", "proof/hq"]
    for group in groups:
        assert lane_blocks.group_problem(group) is None, group
        assert lane_blocks.package_of(group) == "proof/hq"
        assert lane_blocks.reads_corpus(group) == lane_blocks.reads_corpus("proof/hq")
    assert sharding.collection_roots(groups) == [PROOF / "hq", PROOF / "hq/test_boot.py"]
    for refused in ("proof/hq/boot.py", "proof/hq/test_boot.py::", "proof/hq/test_boot.py::a b", "proof/h-q"):
        assert lane_blocks.group_problem(refused) is not None, refused


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
    assert sharding.collection_roots(["corpus:a@minimum"]) == [PROOF / "checks"]


def test_a_group_the_timings_do_not_list_counts_high_among_those_of_its_kind():
    """A sample's documents change with its size and seed, and a profile may be stale or partial, so many groups
    are unmeasured; counting each at a typical cost would let a shard of heavy ones pass for a light one and run
    past its deadline, so each counts at the 90th percentile of its kind."""
    timings = {f"corpus:{n}": float(n) for n in range(1, 11)} | {"proof/native": 100.0, "proof/core": 4.0}
    seconds = sharding.estimate(timings)
    assert seconds("corpus:3") == 3.0
    assert seconds("corpus:new") == seconds("control:new") == 10.0
    # A piece no run measured counts high too: at the share the heavier of two configurations takes of its
    # document's whole measure, never an even half.
    assert sharding.PIECE_SHARE > 0.5
    assert seconds("corpus:6@minimum") == pytest.approx(6.0 * sharding.PIECE_SHARE)
    assert seconds("corpus:new@maximum") == pytest.approx(10.0 * sharding.PIECE_SHARE)
    assert seconds("proof/new") == 100.0
    assert sharding.estimate({})("corpus:new") == sharding.estimate({})("proof/new") == sharding.DEFAULT_SECONDS
    assert sharding.piece_share(2) == sharding.PIECE_SHARE and sharding.piece_share(1) == 1.0
    assert sharding.piece_share(4) == sharding.PIECE_SHARE / 2


def test_a_document_measured_in_pieces_is_measured_whole_by_their_sum():
    """A run that observed a document in pieces measured each piece and, under the document's own name, its
    judging alone. Read as the document's whole cost, that name would say a heavy document is light: it would be
    queued whole on one worker, and would pull the measure unmeasured documents are counted at down with it."""
    timings = {f"corpus:{n}": 100.0 for n in range(1, 10)}
    timings |= {"corpus:heavy": 2.0, "corpus:heavy@maximum": 600.0, "corpus:heavy@minimum": 400.0}
    assert sharding.documents(timings)["corpus:heavy"] == 1002.0
    assert sharding.documents(timings)["corpus:1"] == 100.0
    seconds = sharding.estimate(timings)
    # Each group as it ran: the pieces their own, the document's own group its judging.
    assert (seconds("corpus:heavy@maximum"), seconds("corpus:heavy")) == (600.0, 2.0)
    # An unmeasured document counts at the 90th percentile of the documents' whole measures, the heavy one's
    # among them, and no piece's or judging's alone.
    assert seconds("corpus:new") == 1002.0
    assert sharding.documents({"control:c@only": 5.0, "proof/hq": 9.0}) == {"control:c": 5.0}


def test_a_piece_is_one_item_named_by_its_group_alone():
    module = sharding.PIECES_MODULE.relative_to(sharding.PROOF_DIR).as_posix()
    assert sharding.piece_item("corpus:a@maximum") == f"{module}::{sharding.PIECE_TEST}[a@maximum]"
    assert sharding.piece_item("control:a@minimum") == f"{module}::{sharding.PIECE_TEST}[control-a@minimum]"
    assert sharding.piece_item("corpus:a") is None and sharding.piece_item("proof/hq") is None
    # The module is no test module by its name, so only a run that names it collects it, and it holds that test.
    assert not sharding.PIECES_MODULE.name.startswith("test_")
    assert f"def {sharding.PIECE_TEST}(" in sharding.PIECES_MODULE.read_text(encoding="utf-8")
    # A lane whose queue names pieces collects it beside what pytest.ini names a test module, and nothing more.
    configured = [
        line.partition("=")[2].strip()
        for line in (sharding.PROOF_DIR / "pytest.ini").read_text(encoding="utf-8").splitlines()
        if line.startswith("python_files")
    ]
    assert configured == [sharding.PYTHON_FILES]
    assert sharding.PIECES_FILES == ("-o", f"python_files={sharding.PYTHON_FILES} pieces.py")
    named = [path.name for path in sharding.PROOF_DIR.rglob("pieces.py") if "node_modules" not in path.parts]
    assert named == ["pieces.py"], "Another pieces.py under proof/ would be collected with the pieces' module."


def test_the_timings_file_holds_each_profiles_groups_and_a_run_reads_its_own(tmp_path, monkeypatch):
    """A group costs far more where its states are served to the readers, so each profile packs by its own
    measures (proof.lane.readers): a run without the readers reads the no-readers groups, and a profile the file
    does not measure yet is read as unmeasured, never as the other's."""
    path = tmp_path / "timings.json"
    assert sharding.load_timings(path) == {}
    execution = {"shards": 14, "workers": 4}
    profiles = {
        "readers": {"execution": execution, "groups": {"corpus:a": 25.0}},
        "no-readers": {"execution": execution, "groups": {"corpus:a": 2.5}},
    }
    path.write_text(json.dumps({"profiles": profiles}))
    assert sharding.load_timings(path, readers=True) == {"corpus:a": 25.0}
    assert sharding.load_timings(path, readers=False) == {"corpus:a": 2.5}
    monkeypatch.setenv("PROOF_READERS", "0")
    assert sharding.load_timings(path) == {"corpus:a": 2.5}
    monkeypatch.delenv("PROOF_READERS")
    assert sharding.load_timings(path) == {"corpus:a": 25.0}
    path.write_text(json.dumps({"profiles": {"readers": profiles["readers"]}}))
    assert sharding.load_timings(path, readers=False) == {}
    for written in ({"corpus:a": 2.5}, {"groups": {"corpus:a": 2.5}}, {"profiles": {"readers": {"groups": [1]}}}):
        path.write_text(json.dumps(written))
        with pytest.raises(sharding.ShardError, match="profiles"):
            sharding.load_timings(path, readers=True)


def _block(*names, estimate=1.0, fresh=()):
    groups = tuple(lane_blocks.QueuedGroup(name, name in fresh) for name in names)
    return lane_blocks.Block(lane_blocks.block_id(names), estimate, groups)


def test_the_main_queues_bins_start_from_the_early_queues_so_no_shard_holds_both_heaviest_blocks():
    """A shard runs its bin of each queue (proof.lane.serve): binned apart, the heaviest early block and the
    heaviest main block both land on the first shard, which then runs twice what the others do."""
    early = [_block("proof/a", estimate=10.0), _block("proof/b", estimate=1.0)]
    main = [_block("corpus:x", estimate=10.0), _block("corpus:y", estimate=1.0)]
    loads = [sum(block.estimate for block in members) for members in sharding.static_bins(early, 2)]
    assert loads == [10.0, 1.0]
    after = sharding.static_bins(main, 2, loads)
    assert [[block.names for block in members] for members in after] == [[("corpus:y",)], [("corpus:x",)]]
    assert [[block.names for block in members] for members in sharding.static_bins(main, 2)][0] == [("corpus:x",)]


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
