"""The gate decides the lane from the shards' outputs alone, on a Python with nothing but its standard library.

Contracts (``proof.lane.gate``): the gate, the lane's planner
(``proof.lane.plan``), a failed night's report (``proof.lane.report``) and
``python -m proof.checks.sharding verify`` import nothing beyond the standard
library and the proof's own standard-library modules, since they run on the
runner's Python with no image; and the gate holds when, and only when, every
block ran exactly once, every item passed, the evidence holds to the
register, and the surface block's extraction is the committed surface byte
for byte, and its verdict names each group a problem is about, with why and
the group's items. A run whose queue names the documents its sample of the corpus left out holds each
entry naming one on its control alone and says so; a run whose queue names
none holds every entry on its document as well. A run without the readers
(its queues built so, ``proof.lane.readers``) leaves the served readers'
entries to the nightly and holds every other exactly as a run with them does,
and says how many it left; a shard of the other profile fails it. The
plausible failures: an
import of pytest, pluggy, lxml or HQ creeping into the verify path (the gate
would die on the runner), a verdict that passes a run with a missing block,
a failed item, an unregistered difference, a stale surface or a cached group
nothing can read, every sampled run failing on the entries it could never
show, a whole run passing without seeing an entry on its document, a run
without the readers failing on the readers' entries or passing over another
entry it never saw, and a shard with the readers counted in a run without
them.

Contract (pieces, ``proof.lane.blocks``): a document observed in pieces is a
block of its pieces and its own group, and the gate holds each of them as it
holds any group: its block ran exactly once, each piece ran its one item and
it passed, and the group after them ran every check. A piece that failed, a
piece that never ran, and a document's group that was not run because its
piece failed are each named in the verdict with why, the document's group by
its piece's name. The plausible failures: a run that passes with a piece
unrun (its document judged over records the store held from another run), a
failed piece named only as its document, so the night's issue reruns the
wrong thing, and a block of pieces two shards both ran passing because they
wrote the same.

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
from proof.lane import gate, plan, report
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


def test_the_verdict_names_each_group_a_problem_is_about_with_why_and_its_items(tmp_path, own_register):
    """What the nightly's issue turns into rerun commands (``proof.lane.report``): a failed item's group with the
    items that failed and every item it holds, a register problem's document or control, a block no shard ran,
    and the surface; a run that holds names none."""
    from proof.checks import registers

    assert _run(*_lane(tmp_path / "holds"))["failing"] == []

    control = next(path.name for path in sorted(registers.CONTROLS.iterdir()) if path.is_dir())
    entry = {"id": "unseen", "defect": 1, "part": "a part", "check": "bar", "artifact": "upload", "path": "/x"}
    own_register.write_text(json.dumps([{**entry, "document": "b", "control": control}]), encoding="utf-8")
    difference = {"check": "bar", "document": "a", "artifact": "upload", "path": "/y", "at": "/y", "kind": "changed"}
    output, queue, committed = _lane(
        tmp_path / "fails",
        outcome="failed",
        surface=b'{"items": {"x": 1}}\n',
        differences=[{**difference, "before": 1, "after": 2}],
    )
    missing = lane_blocks.Block(lane_blocks.block_id(["proof/core"]), 1.0, (lane_blocks.QueuedGroup("proof/core"),))
    value = json.loads(queue.read_text())
    value["blocks"].append(lane_blocks.queue_json(lane_blocks.Queue((missing,)))["blocks"][0])
    queue.write_text(json.dumps(value))
    failing = {entry["group"]: entry for entry in _run(output, queue, committed)["failing"]}
    assert sorted(failing) == ["control:" + control, "corpus:a", "corpus:b", "proof/core", "surface"]
    assert failing["corpus:a"]["failed"] == COLLECTED and failing["corpus:a"]["items"] == COLLECTED
    assert failing["corpus:a"]["why"][0] == "1 of its 1 items failed"
    assert "bar on a" in failing["corpus:a"]["why"][1]
    assert "no shard ran bar on b" in failing["corpus:b"]["why"][0] and failing["corpus:b"]["items"] == []
    assert f"retains its control {control}" in failing["control:" + control]["why"][0]
    assert failing["proof/core"] == {
        "group": "proof/core",
        "why": ["no shard's output holds its block"],
        "failed": [],
        "items": [],
    }
    assert "npm run surface" in failing["surface"]["why"][0]
    assert failing["surface"]["items"] == ["surface/test_flags.py::test"]


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
    assert "sample" not in sampled

    # A queue that names its sample's seed: the verdict and the summary say which sample was judged.
    queue.write_text(json.dumps({**value, "unsampled": ["b", "c"], "sample": {"seed": "2026-W42", "documents": ["a"]}}))
    seeded = _run(output, queue, committed)
    assert seeded["holds"] and seeded["sample"] == {"seed": "2026-W42", "documents": ["a"]}
    assert seeded["sections"]["register"]["notes"][1] == (
        "The sample is the one the seed 2026-W42 chooses; name that seed to run the same sample again. Its 1"
        " documents: a."
    )
    assert "Note: The sample is the one the seed 2026-W42 chooses" in gate._markdown(seeded)


def test_a_run_over_documents_named_by_hand_holds_their_entries_alone_and_says_it_is_no_verdict_on_the_corpus(
    tmp_path, own_register
):
    """The mechanics dispatch (proof-audit.yml) runs a few documents and their controls. Held to the whole
    register it would fail on every entry it could never show; held as a sample it would need every control. It
    holds the entries naming its documents, fully, and its verdict says what it left."""
    from proof.checks import registers

    control, another = [path.name for path in sorted(registers.CONTROLS.iterdir()) if path.is_dir()][:2]
    entry = {"defect": 1, "part": "a part", "check": "bar", "artifact": "upload", "path": "/x"}
    register = [
        {**entry, "id": "selected", "document": "a", "control": control},
        {**entry, "id": "elsewhere", "document": "b", "control": another},
    ]
    own_register.write_text(json.dumps(register), encoding="utf-8")
    shown = {"check": "bar", "artifact": "upload", "path": "/x", "at": "/x", "kind": "changed", "before": 1, "after": 2}
    output, queue, committed = _lane(tmp_path, differences=[{**shown, "document": "a"}])
    [document_dir] = [
        directory for directory, record in lane_blocks.read_manifests(output) if record["phase"] == "main"
    ]
    lane_blocks.write_json(
        document_dir / "checks" / "bar" / f"control-{control}.json",
        {"check": "bar", "document": control, "kind": "control", "differences": [{**shown, "document": control}]},
    )
    # Held to the whole register, the run fails on the entry naming a document it never ran.
    assert not _run(output, queue, committed)["sections"]["register"]["holds"]
    value = json.loads(queue.read_text())
    selection = {"documents": ["a"], "left": [f"control:{another}", "proof/checks"]}
    queue.write_text(json.dumps({**value, "selection": selection}))
    selected = _run(output, queue, committed)
    section = selected["sections"]["register"]
    assert selected["holds"] and section["outsideSelection"] == 1 and selected["selection"] == selection
    assert section["notes"] == [
        "This run checked the documents named by hand (a) and the controls of the register's entries naming them,"
        " so the other 1 of the register's 2 entries were left to the nightly and the weekly, and 2 groups beside"
        " the other documents were not run (every other control, and the packages that read the corpus). It shows"
        " the lane on those documents, and is no verdict on the corpus."
    ]
    assert "Note: This run checked the documents named by hand (a)" in gate._markdown(selected)
    # The entries naming a selected document are held in full: one its control no longer shows fails the run.
    (document_dir / "checks" / "bar" / f"control-{control}.json").unlink()
    unseen = _run(output, queue, committed)["sections"]["register"]
    assert not unseen["holds"] and f"retains its control {control}" in unseen["problems"][0]


def test_the_gate_fails_cached_groups_it_has_no_reader_for(tmp_path):
    output, queue, committed = _lane(tmp_path)
    value = json.loads(queue.read_text())
    value["cached"] = [{"group": "corpus:z", "judgments": {"bar": "k"}}]
    queue.write_text(json.dumps(value))
    result = _run(output, queue, committed)
    register = result["sections"]["register"]
    assert not register["holds"] and register["cached"] == 1
    assert "no store reader" in register["problems"][0] or "no store directory" in register["problems"][0]


def _served_lane(tmp_path, own_register, *, readers):
    """A run that shows a bar entry's difference on its document and control, and no reader's: a register of that
    entry and a Formplayer entry on the same document, and the queue and serve.json of the profile."""
    from proof.checks import registers

    control = next(path.name for path in sorted(registers.CONTROLS.iterdir()) if path.is_dir())
    base = {"defect": 1, "part": "a part", "document": "a", "control": control}
    own_register.write_text(
        json.dumps(
            [
                {**base, "id": "bar-upload", "check": "bar", "artifact": "upload", "path": "/x"},
                {**base, "id": "reader", "check": "proof3", "artifact": "formplayer@B", "path": "/runs/*/screen"},
            ]
        ),
        encoding="utf-8",
    )
    shown = {"check": "bar", "artifact": "upload", "path": "/x", "at": "/x", "kind": "changed", "before": 1, "after": 2}
    output, queue, committed = _lane(tmp_path, differences=[{**shown, "document": "a"}])
    [document_dir] = [
        directory for directory, record in lane_blocks.read_manifests(output) if record["phase"] == "main"
    ]
    lane_blocks.write_json(
        document_dir / "checks" / "bar" / f"control-{control}.json",
        {"check": "bar", "document": control, "kind": "control", "differences": [{**shown, "document": control}]},
    )
    serve = json.loads((output / lane_blocks.SERVE).read_text())
    lane_blocks.write_json(output / lane_blocks.SERVE, {**serve, "readers": readers})
    value = json.loads(queue.read_text())
    queue.write_text(json.dumps({**value, **({} if readers is True else {"readers": readers})}))
    return output, queue, committed


def test_a_run_without_the_readers_leaves_the_readers_entries_to_the_nightly_and_holds_every_other(
    tmp_path, own_register
):
    result = _run(*_served_lane(tmp_path / "without", own_register, readers=False))
    register = result["sections"]["register"]
    assert result["holds"] and register["holds"], register
    assert register["readers"] is False and register["leftToNightly"] == 1
    assert register["notes"][0].startswith(
        "This run handed no state to the readers (PROOF_READERS=0, the pull request lane), so 1 of the register's 2"
        " entries, whose artifacts only the served readers write"
    )
    assert register["notes"][0].endswith("were left to the nightly run with every reader; the other 1 were held.")

    # With the readers the same evidence fails: the Formplayer entry was never seen, on its document or control.
    with_readers = _run(*_served_lane(tmp_path / "with", own_register, readers=True))["sections"]["register"]
    assert not with_readers["holds"] and with_readers["leftToNightly"] == 0
    assert any("reader names proof3 on a, and no shard ran proof3 on a" in p for p in with_readers["problems"])

    # The other entry is held exactly as before: without the readers, an unseen bar entry still fails.
    output, queue, committed = _served_lane(tmp_path / "unseen", own_register, readers=False)
    entries = json.loads(own_register.read_text())
    own_register.write_text(json.dumps([*entries, {**entries[0], "id": "bar-other", "path": "/y"}]))
    unseen = _run(output, queue, committed)["sections"]["register"]
    assert not unseen["holds"] and unseen["leftToNightly"] == 1
    assert any("bar-other" in problem for problem in unseen["problems"])


def test_a_run_of_some_readers_leaves_exactly_the_others_entries_and_says_which(tmp_path, own_register):
    """PROOF_READERS=android: the Formplayer entry is held (its run observed Formplayer), the webapps entry left."""
    output, queue, committed = _served_lane(tmp_path, own_register, readers=["formplayer", "android"])
    entries = json.loads(own_register.read_text())
    reader = entries[1]
    own_register.write_text(json.dumps([entries[0], {**reader, "id": "client", "artifact": "webapps@B"}]))
    register = _run(output, queue, committed)["sections"]["register"]
    assert register["holds"] and register["leftToNightly"] == 1, register
    assert register["readers"] == ["formplayer", "android"]
    assert "observed only formplayer, android (PROOF_READERS=formplayer,android)" in register["notes"][0]
    assert "whose artifacts webapps, connect write" in register["notes"][0]
    # The Formplayer entry is this run's to hold: never seen, it fails here.
    own_register.write_text(json.dumps([entries[0], reader]))
    held = _run(output, queue, committed)["sections"]["register"]
    assert not held["holds"] and held["leftToNightly"] == 0


def test_a_shard_of_the_other_profile_fails_the_run(tmp_path, own_register):
    output, queue, committed = _served_lane(tmp_path, own_register, readers=False)
    serve = json.loads((output / lane_blocks.SERVE).read_text())
    lane_blocks.write_json(output / lane_blocks.SERVE, {**serve, "readers": True})
    register = _run(output, queue, committed)["sections"]["register"]
    assert not register["holds"]
    assert any(
        "ran with every reader" in problem and "built for no reader" in problem for problem in register["problems"]
    )


# Pieces ------------------------------------------------------------------------------------------

PIECES = ("corpus:heavy@maximum", "corpus:heavy@minimum")
PIECE_ITEMS = {name: f"checks/pieces.py::test_observed[{name.partition(':')[2]}]" for name in PIECES}
JUDGED = ["checks/test_bar.py::test[heavy]", "hq/test_branches.py::test[heavy]"]


def _pieces_lane(tmp_path, *, pieces=None, whole=None, shard="s1", output=None):
    """One shard's output over a block of a document in pieces (``pieces``: each piece's record fields, None for
    one that ran and passed; ``whole``: its own group's), and the queue it ran."""
    output = tmp_path / "out" if output is None else output
    groups = (
        *(lane_blocks.QueuedGroup(name, True, (), 50.0) for name in PIECES),
        lane_blocks.QueuedGroup("corpus:heavy", False, PIECES, 2.0),
    )
    block = lane_blocks.Block(lane_blocks.block_id(group.group for group in groups), 102.0, groups)
    records = []
    for index, name in enumerate(PIECES):
        fields = {"outcomes": {PIECE_ITEMS[name]: "passed"}, "worker": index + 1, **((pieces or {}).get(name) or {})}
        records.append(lane_blocks.group_record(group=name, fresh=True, collected=[PIECE_ITEMS[name]], **fields))
    fields = {"outcomes": dict.fromkeys(JUDGED, "passed"), "worker": 3, **(whole or {})}
    records.append(lane_blocks.group_record(group="corpus:heavy", fresh=False, collected=JUDGED, **fields))
    directory = lane_blocks.block_dir(output, block.id)
    lane_blocks.write_json(
        directory / lane_blocks.MANIFEST, lane_blocks.manifest(block, phase="main", shard=shard, groups=records)
    )
    if fields["outcomes"]:
        evidence = {"check": "bar", "document": "heavy", "kind": "corpus", "differences": []}
        lane_blocks.write_json(directory / "checks" / "bar" / "corpus-heavy.json", evidence)
    lane_blocks.write_json(
        output / lane_blocks.SERVE, {"phases": [{"phase": "main", "collected": {"digest": "d"}, "unaccounted": []}]}
    )
    queue = tmp_path / "queue.json"
    lane_blocks.write_json(queue, lane_blocks.queue_json(lane_blocks.Queue((block,))))
    return output, queue, block


def _pieces_verdict(output, queue):
    """The verdict over the pieces' lane, without the surface section, which a lane of one block does not run."""
    outputs = [output] if isinstance(output, Path) else output
    result = gate.gate(outputs, [("main", lane_blocks.load_queue(queue))])
    result["failing"] = [entry for entry in result["failing"] if entry["group"] != gate.SURFACE]
    return result


def test_a_document_in_pieces_holds_where_each_piece_and_its_own_group_ran_once_and_passed(tmp_path):
    output, queue, block = _pieces_lane(tmp_path)
    result = _pieces_verdict(output, queue)
    assert result["sections"]["exactlyOnce"] == {"holds": True, "problems": [], "notes": [], "blocks": 1}
    assert result["sections"]["tests"] == {"holds": True, "problems": [], "notes": [], "items": 4}
    assert result["sections"]["register"]["holds"] and result["failing"] == []
    # Two shards that both ran the block fail it, though they wrote the same: a block runs once.
    other, _, _ = _pieces_lane(tmp_path, shard="s2", output=tmp_path / "other")
    twice = _pieces_verdict([output, other], queue)
    assert not twice["sections"]["exactlyOnce"]["holds"]
    assert f"Block {block.id} ran 2 times" in twice["sections"]["exactlyOnce"]["problems"][0]


def test_a_failed_piece_and_the_group_it_kept_from_running_are_each_named_with_why(tmp_path):
    failure = (
        f"its piece {PIECES[0]} did not pass ({PIECE_ITEMS[PIECES[0]]}: failed), so it was not run: it judges what"
        " its pieces observed, and never observes the document whole in their place"
    )
    output, queue, _ = _pieces_lane(
        tmp_path,
        pieces={PIECES[0]: {"outcomes": {PIECE_ITEMS[PIECES[0]]: "failed"}}},
        whole={"outcomes": {}, "worker": None, "failure": failure},
    )
    result = _pieces_verdict(output, queue)
    assert not result["sections"]["tests"]["holds"] and not result["sections"]["exactlyOnce"]["holds"]
    failing = {entry["group"]: entry for entry in result["failing"]}
    assert sorted(failing) == ["corpus:heavy", PIECES[0]]
    assert failing[PIECES[0]] == {
        "group": PIECES[0],
        "why": ["1 of its 1 items failed"],
        "failed": [PIECE_ITEMS[PIECES[0]]],
        "items": [PIECE_ITEMS[PIECES[0]]],
    }
    whole = failing["corpus:heavy"]
    assert whole["why"] == [f"it did not finish: {failure}", "2 of its 2 collected items did not run"]
    assert whole["failed"] == [] and whole["items"] == JUDGED


def test_a_piece_that_never_ran_fails_the_run_though_its_document_was_judged(tmp_path):
    """The store may hold the document's records from another run, so its own group could pass with a piece
    unrun; the piece is a queued group, and the gate holds it to its one item."""
    output, queue, _ = _pieces_lane(tmp_path, pieces={PIECES[1]: {"outcomes": {}, "failure": "it never ran"}})
    result = _pieces_verdict(output, queue)
    assert not result["sections"]["exactlyOnce"]["holds"] and result["sections"]["tests"]["holds"]
    [entry] = result["failing"]
    assert entry["group"] == PIECES[1] and entry["failed"] == [] and entry["items"] == [PIECE_ITEMS[PIECES[1]]]
    assert entry["why"] == ["it did not finish: it never ran", "1 of its 1 collected items did not run"]
