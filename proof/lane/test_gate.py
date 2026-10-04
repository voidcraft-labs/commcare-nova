"""The gate decides the lane from the shards' outputs alone, on a Python with nothing but its standard library.

Contracts (``proof.lane.gate``): the gate and ``python -m
proof.checks.sharding verify`` import nothing beyond the standard library and
the proof's own standard-library modules, since they run on the runner's
Python with no image; and the gate holds when, and only when, every block ran
exactly once, every item passed, the evidence holds to the register, and the
surface block's extraction is the committed surface byte for byte. A run
whose queue names the documents its sample of the corpus left out holds each
entry naming one on its control alone and says so; a run whose queue names
none holds every entry on its document as well. The plausible failures: an
import of pytest, pluggy, lxml or HQ creeping into the verify path (the gate
would die on the runner), a verdict that passes a run with a missing block,
a failed item, an unregistered difference, a stale surface or a cached group
nothing can read, every sampled run failing on the entries it could never
show, and a whole run passing without seeing an entry on its document.

The standard-library test runs the gate in a child interpreter started with
``-S -I`` (no site-packages, no environment) and a ``sys.path`` of the
worktree and the standard library alone, over outputs written with the
server's own writers.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

import pytest

from proof.lane import blocks as lane_blocks
from proof.lane import gate

WORKTREE = Path(__file__).resolve().parents[2]
COLLECTED = ["checks/test_bar.py::test[a]"]

# Runs in the child: imports the gate and the sharding verify, runs both, and reports what was imported.
CHILD = """
import json, sys, sysconfig
sys.path[:] = [{worktree!r}] + [path for path in sys.path if path.startswith(sysconfig.get_paths()["stdlib"])]
from proof.checks import sharding
from proof.lane import gate
codes = [
    gate.main({gate_args!r}),
    sharding.main({verify_args!r}),
]
standard = sysconfig.get_paths()["stdlib"]
outside = sorted(
    name for name, module in sys.modules.items()
    if getattr(module, "__file__", None)
    and not module.__file__.startswith(standard)
    and not module.__file__.startswith({proof!r})
)
flags = [sys.flags.no_site, sys.flags.isolated]
print(json.dumps({{"codes": codes, "outside": outside, "path": sys.path, "flags": flags}}))
"""


@pytest.fixture(autouse=True)
def own_register(tmp_path, monkeypatch):
    """A synthetic run holds none of the register's documents or controls, so the gate holds it to a register of
    its own, empty (``proof.checks.registers.known_defects_path``); the child interpreter inherits it."""
    register = tmp_path / "known-defects.json"
    register.write_text("[]\n", encoding="utf-8")
    monkeypatch.setenv("PROOF_KNOWN_DEFECTS", str(register))
    return register


def _lane(tmp_path, *, outcome="passed", surface=b'{"items": {}}\n', differences=(), with_surface_block=True):
    """One shard's output with a document block and the surface block, and the queue they ran."""
    output = tmp_path / "out"
    document = lane_blocks.Block(lane_blocks.block_id(["corpus:a"]), 2.0, (lane_blocks.QueuedGroup("corpus:a"),))
    blocks = [document]
    record = lane_blocks.group_record(
        group="corpus:a", fresh=False, collected=COLLECTED, outcomes={COLLECTED[0]: outcome}, worker=1
    )
    directory = lane_blocks.block_dir(output, document.id)
    lane_blocks.write_json(
        directory / lane_blocks.MANIFEST, lane_blocks.manifest(document, phase="main", shard="s1", groups=[record])
    )
    evidence = {"check": "bar", "document": "a", "kind": "corpus", "differences": list(differences)}
    lane_blocks.write_json(directory / "checks" / "bar" / "corpus-a.json", evidence)
    if with_surface_block:
        block = lane_blocks.Block(lane_blocks.block_id(["surface"]), 60.0, (lane_blocks.QueuedGroup("surface"),))
        blocks.append(block)
        nodes = ["surface/test_flags.py::test"]
        surface_record = lane_blocks.group_record(
            group="surface", fresh=False, collected=nodes, outcomes={nodes[0]: "passed"}, worker=2
        )
        surface_dir = lane_blocks.block_dir(output, block.id)
        lane_blocks.write_json(
            surface_dir / lane_blocks.MANIFEST,
            lane_blocks.manifest(block, phase="early", shard="s1", groups=[surface_record]),
        )
        (surface_dir / "surface").mkdir()
        (surface_dir / "surface" / "surface.json").write_bytes(surface)
    lane_blocks.write_json(
        output / lane_blocks.SERVE, {"phases": [{"phase": "main", "collected": {"digest": "d"}, "unaccounted": []}]}
    )
    queue = tmp_path / "queue.json"
    lane_blocks.write_json(queue, lane_blocks.queue_json(lane_blocks.Queue(tuple(blocks))))
    committed = tmp_path / "committed-surface.json"
    committed.write_bytes(b'{"items": {}}\n')
    return output, queue, committed


def _run(output, queue, committed, **extra):
    queues = [("main", lane_blocks.load_queue(queue))]
    return gate.gate([output], queues, committed=committed, **extra)


def test_the_gate_and_the_sharding_verify_import_only_the_standard_library(tmp_path):
    output, queue, committed = _lane(tmp_path)
    summary = tmp_path / "summary.json"
    gate_args = [str(output), "--queue", str(queue), "--surface", str(committed), "--summary", str(summary)]
    program = CHILD.format(
        worktree=str(WORKTREE),
        proof=str(WORKTREE / "proof") + "/",
        gate_args=gate_args,
        verify_args=["verify", "--queue", str(queue), str(output)],
    )
    completed = subprocess.run(
        [sys.executable, "-S", "-I", "-c", program],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr[-4000:]
    report = json.loads(completed.stdout.strip().splitlines()[-1])
    assert report["flags"] == [1, 1]
    standard = sysconfig.get_paths()["stdlib"]
    assert all(path == str(WORKTREE) or path.startswith(standard) for path in report["path"]), report["path"]
    assert report["outside"] == [], f"The gate imported beyond the standard library: {report['outside']}"
    assert report["codes"] == [0, 0], completed.stdout
    assert json.loads(summary.read_text())["holds"] is True


def test_the_gate_holds_a_run_that_ran_everything_once_with_every_item_passing_and_the_surface_unchanged(tmp_path):
    result = _run(*_lane(tmp_path))
    assert result["holds"], result
    assert result["sections"]["surface"]["verdict"] == "equal"
    assert result["sections"]["tests"]["items"] == 2


def test_the_gate_fails_a_failed_item_and_one_whose_setup_or_teardown_failed(tmp_path):
    for outcome in ("failed", "error"):
        result = _run(*_lane(tmp_path / outcome, outcome=outcome))
        assert not result["holds"] and not result["sections"]["tests"]["holds"], outcome
        assert f"{COLLECTED[0]} ({outcome})" in "\n".join(result["sections"]["tests"]["problems"])
        assert result["sections"]["exactlyOnce"]["holds"]
    for outcome in ("skipped", "xfailed"):
        assert _run(*_lane(tmp_path / outcome, outcome=outcome))["sections"]["tests"]["holds"], outcome


def test_the_gate_fails_a_difference_the_register_does_not_hold(tmp_path):
    difference = {
        "check": "bar",
        "document": "a",
        "artifact": "upload",
        "path": "/x",
        "at": "/x",
        "kind": "changed",
        "before": 1,
        "after": 2,
    }
    result = _run(*_lane(tmp_path, differences=[difference]))
    assert not result["sections"]["register"]["holds"]
    assert result["sections"]["tests"]["holds"]


def _surface_block_dir(output):
    [directory] = [directory for directory, record in lane_blocks.read_manifests(output) if record["phase"] == "early"]
    return directory


def test_the_gate_fails_a_surface_that_differs_from_the_committed_one_or_never_ran(tmp_path):
    stale = _run(*_lane(tmp_path / "stale", surface=b'{"items": {"x": 1}}\n'))
    assert stale["sections"]["surface"]["verdict"] == "differs" and not stale["sections"]["surface"]["holds"]
    assert "npm run surface" in stale["sections"]["surface"]["problems"][0]

    output, queue, committed = _lane(tmp_path / "absent", with_surface_block=False)
    absent = _run(output, queue, committed)
    assert absent["sections"]["surface"]["verdict"] == "absent" and absent["sections"]["surface"]["holds"] is False

    # The queue runs the surface block, and no shard's output holds it.
    output, queue, committed = _lane(tmp_path / "unrun")
    shutil.rmtree(_surface_block_dir(output))
    unrun = _run(output, queue, committed)
    assert unrun["sections"]["surface"]["verdict"] == "unrun" and unrun["sections"]["surface"]["holds"] is False

    # The surface block ran and its extraction wrote nothing.
    output, queue, committed = _lane(tmp_path / "missing")
    (_surface_block_dir(output) / "surface" / "surface.json").unlink()
    missing = _run(output, queue, committed)
    assert missing["sections"]["surface"]["verdict"] == "missing" and missing["sections"]["surface"]["holds"] is False
    assert not missing["holds"]


def test_the_gate_fails_a_block_no_shard_ran(tmp_path):
    output, queue, committed = _lane(tmp_path)
    extra = lane_blocks.Block(lane_blocks.block_id(["corpus:b"]), 1.0, (lane_blocks.QueuedGroup("corpus:b"),))
    value = json.loads(queue.read_text())
    value["blocks"].append(lane_blocks.queue_json(lane_blocks.Queue((extra,)))["blocks"][0])
    queue.write_text(json.dumps(value))
    result = _run(output, queue, committed)
    assert not result["sections"]["exactlyOnce"]["holds"]
    assert any(extra.id in problem for problem in result["sections"]["exactlyOnce"]["problems"])


def test_a_sampled_run_holds_the_entries_on_documents_it_left_out_on_their_controls_and_a_whole_run_does_not(
    tmp_path, own_register
):
    from proof.checks import registers

    control = next(path.name for path in sorted(registers.CONTROLS.iterdir()) if path.is_dir())
    entry = {"id": "left-out", "defect": 1, "part": "a part", "check": "bar", "artifact": "upload", "path": "/x"}
    own_register.write_text(json.dumps([{**entry, "document": "b", "control": control}]), encoding="utf-8")
    output, queue, committed = _lane(tmp_path)
    [document_dir] = [
        directory for directory, record in lane_blocks.read_manifests(output) if record["phase"] == "main"
    ]
    shown = {"check": "bar", "document": control, "artifact": "upload", "path": "/x", "at": "/x", "kind": "changed"}
    lane_blocks.write_json(
        document_dir / "checks" / "bar" / f"control-{control}.json",
        {"check": "bar", "document": control, "kind": "control", "differences": [{**shown, "before": 1, "after": 2}]},
    )

    # The whole corpus: the entry was never seen on its document.
    whole = _run(output, queue, committed)["sections"]["register"]
    assert not whole["holds"] and whole["notes"] == [] and whole["unsampled"] == 0
    assert any("no shard ran bar on b" in problem for problem in whole["problems"])

    # A sample that left b out: the entry is held on its control alone, and the verdict says so.
    value = json.loads(queue.read_text())
    queue.write_text(json.dumps({**value, "unsampled": ["b", "c"]}))
    sampled = _run(output, queue, committed)
    register = sampled["sections"]["register"]
    assert sampled["holds"] and register["holds"], register
    assert register["unsampled"] == 2 and register["heldOnControlAlone"] == 1
    assert register["notes"] == [
        "This run checked a sample of the corpus, leaving 2 documents out, so 1 of the register's 1 entries name a"
        " document it did not run and were held on their controls alone; the other 0 were held on their documents"
        " and controls."
    ]
    assert "Note: This run checked a sample of the corpus" in gate._markdown(sampled)


def test_the_gate_fails_cached_groups_it_has_no_reader_for(tmp_path):
    output, queue, committed = _lane(tmp_path)
    value = json.loads(queue.read_text())
    value["cached"] = [{"group": "corpus:z", "judgments": {"bar": "k"}}]
    queue.write_text(json.dumps(value))
    result = _run(output, queue, committed)
    register = result["sections"]["register"]
    assert not register["holds"] and register["cached"] == 1
    assert "no store reader" in register["problems"][0] or "no store directory" in register["problems"][0]
