"""Workers forked from one booted server observe what a session of their own observes, and fail apart.

Contracts (``proof.lane.serve``):

- Two workers forked from the server, over two corpus documents, write the
  evidence one unforked pytest session writes over the same documents, and
  their items end the same way. The plausible failure: state the server
  built before the fork (the warmed caches, the frozen heap, the template it
  restored, the Core classes it compiled) or that one worker leaves behind
  reaching another worker's observations.
- No thread runs in the server when it forks: ``serve.json`` records
  Python's threads and the process's OS threads at the fork itself
  (``/proc/self/task``, read in a before-fork hook that runs after
  ddtrace's, which stops ddtrace's native writer threads); a lock held by
  another thread at the fork would stay held in the worker.
- A worker that dies while running a group is joined with everything it
  started, its group fails with the reason, and the other groups still run
  to the end on the workers left and on the one that takes its slot. The
  plausible failures: the server waiting forever for the dead worker,
  failing every group, re-running the group that died, or leaving the
  worker's children running.
- A worker that stops the run (``-x``) on its group's last item has already
  been handed the next group; that group is written as not run, and the
  run's exit is the failed item's, never a worker's death. The plausible
  failure: the worker telling the server it started the next group, which
  the server then fails as lost with an infrastructure problem.
- An early queue holding a group that reads the corpus (a document's, a
  control's, or a package in ``proof.lane.blocks.CORPUS_PACKAGES``) is
  refused at the start, before HQ boots, naming the groups; in the main
  queue the same groups run. The plausible failure: the group started in the
  early phase, before the corpus is in place, and each of its tests failing
  on its own.
- No item waits on a claim: while a claim the shard needs is still running,
  a worker runs its group's last item at once, the group ends and its block's
  manifest is written, and the worker's session services stay up for the
  block the claim brings. The plausible failures: the last item held back
  until the claim ends (a claim's latency on every group's and block's
  completion, and a deadlock when the claim waits on that block), and the
  session torn down and its services started again for the next group.

HQ mints its ids (``uuid.uuid4().hex``, 32 hexadecimal digits:
``corehq/apps/app_manager/util.py::update_form_unique_ids``, and the app's
id) afresh in every run the checks make outside a keyed HQ operation, and
sensitivity's evidence records how long its steps took (``TIMED``). So the
comparison sets those named timing fields aside, and names each 32-digit id
that only one run wrote by its first appearance across all of that run's
files; every other byte, a 40-digit digest or a UUID included, is compared
as written, and ids that relate differently between the files fail too.

Each test runs the server as a process of its own, under lane positions
from ``NESTED_BASE`` on, so its databases are none of the lane's own, and
writes its output to a file; past its deadline the run is interrupted, so
the server stops the workers it forked (each leads a process group of its
own, beyond a stop of the server's group), then everything left in its
group is killed (``_run_to_end``).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from pathlib import Path

from proof import processes
from proof.checks import cases, sharding
from proof.lane import blocks as lane_blocks

PROOF = sharding.PROOF_DIR
WORKTREE = PROOF.parent
INI = PROOF / "pytest.ini"
# Lane positions no lane runs: the nested server's databases are proof_hq_w701_ and on.
NESTED_BASE = 700
DEADLINE_SECONDS = 1200
# How long an interrupted run has to stop what it started before its group is killed.
GRACE_SECONDS = 120
# What the nested runs must not inherit from the session running this test: they are runs of their own.
INHERITED = ("PROOF_OUT", "PROOF_GROUP", "PROOF_BLOCK", "PROOF_GROUP_FRESH", "PROOF_CORE_CLASSES", "PROOF_WORKER")
# An id HQ mints: uuid.uuid4().hex.
HQ_ID = re.compile(r"\b[0-9a-f]{32}\b")
# The fields each check's evidence records timings in, by path ("*": every element of a list).
TIMED = {
    "sensitivity": (
        ("observed", "*", "seconds"),
        ("observed", "*", "setupSeconds"),
        ("observed", "*", "plainSeconds"),
        ("observed", "*", "flips", "*", "seconds"),
    ),
}


def _environment(**extra):
    environment = {name: value for name, value in os.environ.items() if name not in INHERITED}
    # A nested run observes what it reads: it reads no record from the evidence store this session runs with.
    return {**environment, "PROOF_STORE": "off", **extra}


@dataclass(frozen=True)
class Finished:
    returncode: int
    output: str

    def tail(self) -> str:
        return self.output[-9000:]


def _failure_section(output: str, name: str) -> str:
    """The section pytest wrote for the failed item ``name`` (from its ``___ name ___`` heading to the next), or a
    note that the output holds none."""
    # A forked worker's lines come prefixed with its name (``[w1] ``).
    lines = [line.split("] ", 1)[1] if line.startswith("[w") and "] " in line else line for line in output.splitlines()]
    starts = [index for index, line in enumerate(lines) if line.startswith("_") and line.strip("_ ").endswith(name)]
    if not starts:
        return f"(no failure section for {name} in this output)"
    first = starts[0]
    end = next((index for index in range(first + 1, len(lines)) if lines[index].startswith("___")), len(lines))
    return "\n".join(lines[first:end])[:6000]


def _run_to_end(command, log: Path, **extra) -> Finished:
    """``command`` run from the worktree to its end, its output (standard output and error) kept in ``log``.

    Past ``DEADLINE_SECONDS`` it is sent SIGINT, on which the server stops its
    workers and reaps what they started, and pytest tears its session's
    services down; ``GRACE_SECONDS`` later everything left in its group is
    killed and reaped.
    """
    with (
        log.open("wb") as output,
        processes.ProcessGroup(
            [str(part) for part in command],
            cwd=WORKTREE,
            env=_environment(**extra),
            stdout=output,
            stderr=subprocess.STDOUT,
        ) as group,
    ):
        finished = group.wait(DEADLINE_SECONDS)
        if not finished:
            os.kill(group.group, signal.SIGINT)
            group.wait(GRACE_SECONDS)
    text = log.read_text(encoding="utf-8", errors="replace")
    assert finished, f"`{shlex.join(str(part) for part in command)}` ran past {DEADLINE_SECONDS} s:\n{text[-9000:]}"
    return Finished(group.returncode, text)


def _serve(out, pytest_args=(), *, workers=2, options=(), **extra) -> Finished:
    command = [sys.executable, "-m", "proof.lane.serve", "--out", out, "--workers", workers]
    command += ["--worker-base", NESTED_BASE, *options]
    if pytest_args:
        command += ["--", *pytest_args]
    return _run_to_end(command, Path(f"{out}.log"), **extra)


def _alive(pid: int) -> bool:
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except OSError:
        return False
    return state != "Z"


def _miniature(root: Path, files: dict) -> list[str]:
    """Writes a miniature test tree under ``root``; pytest's arguments for collecting it."""
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)
    return ["-c", str(root / "pytest.ini"), "--rootdir", str(root), str(root)]


def _alone_at_fork(fork: dict) -> bool:
    """Whether the server's own thread was the only one, in Python and in the OS, when it forked."""
    return fork["threads"] == ["MainThread"] and len(fork["osThreadsAtFork"] or ()) == 1


def _finished_groups(finished: Finished) -> list[str]:
    """The groups the server said a worker finished, each by its directory's name."""
    lines = [line for line in finished.output.splitlines() if line.startswith("[lane]") and " finished " in line]
    return sorted(line.split(" finished ")[1].split(":")[0].rsplit("/", 1)[-1] for line in lines)


# A worker that dies --------------------------------------------------------------------

MINIATURE = {
    "pytest.ini": "[pytest]\naddopts = -p no:cacheprovider\n",
    "dies/test_dies.py": """
import os
import signal
import subprocess
from pathlib import Path


def test_the_worker_dies_with_a_child_running():
    # In a session of its own, as the editor driver's node is: no stop of the worker's process group reaches it.
    child = subprocess.Popen(["sleep", "1000"], start_new_session=True)
    Path(os.environ["MINIATURE_OUT"], "child.pid").write_text(str(child.pid))
    os.kill(os.getpid(), signal.SIGKILL)
""",
    "first/test_first.py": "def test_one():\n    pass\n\n\ndef test_two():\n    pass\n",
    "second/test_second.py": "def test_one():\n    pass\n",
    "third/test_third.py": "def test_one():\n    pass\n",
}


def test_a_worker_that_dies_is_joined_its_group_fails_and_the_other_groups_still_run(tmp_path):
    out = tmp_path / "out"
    finished = _serve(out, _miniature(tmp_path / "miniature", MINIATURE), MINIATURE_OUT=str(tmp_path))
    assert finished.returncode == 3, finished.tail()

    child = int((tmp_path / "child.pid").read_text())
    assert not _alive(child), "The dead worker's child is still running: the server did not join what it started."
    record = json.loads((out / lane_blocks.SERVE).read_text())
    [(_, manifest)] = lane_blocks.read_manifests(out)
    groups = {Path(group["group"]).name: group for group in manifest["groups"]}
    assert set(groups) == {"dies", "first", "second", "third"}
    died = groups["dies"]
    assert died["outcomes"] == {}
    assert "exited with status -9 while running it" in died["failure"]
    for name in ("first", "second", "third"):
        assert groups[name]["failure"] is None
        assert set(groups[name]["outcomes"].values()) == {"passed"}
        assert set(groups[name]["outcomes"]) == set(groups[name]["collected"])
    assert any("exited with status -9" in problem for problem in record["problems"])
    statuses = [worker["status"] for worker in record["workersRun"]]
    assert statuses.count(-9) == 1 and all(status == 0 for status in statuses if status != -9)
    assert all(_alone_at_fork(fork) for fork in record["forks"]), record["forks"]
    # The other groups ran once each: the dead worker's group was not run again elsewhere.
    assert _finished_groups(finished) == ["first", "second", "third"]


STOPS = {
    "pytest.ini": "[pytest]\naddopts = -p no:cacheprovider\n",
    "a/test_a.py": "def test_passes():\n    pass\n\n\ndef test_fails_last():\n    assert False\n",
    "b/test_b.py": "def test_never_runs():\n    pass\n",
}


def test_a_worker_that_stops_the_run_on_its_groups_last_item_leaves_the_next_group_unrun(tmp_path):
    out = tmp_path / "out"
    # Groups go out longest first, ties by name: a, whose last item fails, then b, handed before it runs.
    finished = _serve(out, [*_miniature(tmp_path / "miniature", STOPS), "-x"], workers=1)
    assert finished.returncode == 1, finished.tail()
    record = json.loads((out / lane_blocks.SERVE).read_text())
    assert record["problems"] == []
    assert [worker["status"] for worker in record["workersRun"]] == [1]
    [(_, manifest)] = lane_blocks.read_manifests(out)
    groups = {Path(group["group"]).name: group for group in manifest["groups"]}
    assert sorted(groups["a"]["outcomes"].values()) == ["failed", "passed"] and groups["a"]["failure"] is None
    assert groups["b"]["outcomes"] == {}
    assert groups["b"]["failure"].startswith("not run: a worker stopped the run")
    assert _finished_groups(finished) == ["a"]


SERVICE = {
    "pytest.ini": "[pytest]\naddopts = -p no:cacheprovider\n",
    "conftest.py": """
import os
from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def service():
    \"\"\"A session's service, as the Core runner and the editor driver are: each start and stop is written down.\"\"\"
    log = Path(os.environ["MINIATURE_OUT"], f"service-{os.getpid()}.log")
    with log.open("a") as events:
        events.write("start\\n")
    yield
    with log.open("a") as events:
        events.write("stop\\n")
""",
    **{
        f"{name}/test_{name}.py": "def test_one(service):\n    pass\n\n\ndef test_two(service):\n    pass\n"
        for name in ("first", "second", "third")
    },
}


def test_a_workers_session_services_stay_up_from_its_first_group_to_its_last(tmp_path):
    """pytest stops a fixture when the next item does not need it; the worker names the next group's first item."""
    finished = _serve(
        tmp_path / "out", _miniature(tmp_path / "miniature", SERVICE), workers=1, MINIATURE_OUT=str(tmp_path)
    )
    assert finished.returncode == 0, finished.tail()
    [log] = tmp_path.glob("service-*.log")
    assert log.read_text().split() == ["start", "stop"]
    [(_, manifest)] = lane_blocks.read_manifests(tmp_path / "out")
    assert sum(len(group["outcomes"]) for group in manifest["groups"]) == 6


def test_two_runs_split_one_collection_by_bins_and_together_run_it_once(tmp_path):
    """With --bin and no queue, each collected group is a block, and N runs take N disjoint bins of them."""
    selection = _miniature(tmp_path / "miniature", SERVICE)
    outputs = []
    for index in (1, 2):
        out = tmp_path / f"out-{index}"
        finished = _serve(out, selection, workers=1, options=["--bin", f"{index}/2"], MINIATURE_OUT=str(tmp_path))
        assert finished.returncode == 0, finished.tail()
        outputs.append(out)
    queues = [(out / "queue.json").read_bytes() for out in outputs]
    assert queues[0] == queues[1]
    queue = lane_blocks.parse_queue(json.loads(queues[0]), check_names=False)
    assert len(queue.blocks) == 3
    ran = [{manifest["block"] for _, manifest in lane_blocks.read_manifests(out)} for out in outputs]
    assert ran[0] and ran[1] and not ran[0] & ran[1]
    verdict = sharding.verify([("main", queue)], outputs)
    assert verdict.problems == [] and set(verdict.chosen) == {block.id for block in queue.blocks}


# Forked against unforked -------------------------------------------------------------------------


def _drop(value, path):
    """Removes the field ``path`` names from ``value``, in place."""
    head, *rest = path
    if head == "*":
        for member in value if isinstance(value, list) else []:
            _drop(member, rest)
    elif isinstance(value, dict) and head in value:
        if rest:
            _drop(value[head], rest)
        else:
            del value[head]


def _evidence(directories) -> dict[str, dict]:
    """Every evidence record the directories hold, by its path under the block, as JSON."""
    found = {}
    for directory in directories:
        for path in sorted(Path(directory, "checks").glob("*/*.json")):
            relative = path.relative_to(directory).as_posix()
            assert relative not in found, f"Two blocks wrote {relative}."
            found[relative] = path.read_text(encoding="utf-8")
    return found


def _canonical(evidence: dict[str, str], minted: set[str]) -> dict[str, str]:
    """One run's evidence with its timing fields set aside and each id in ``minted`` named by its first appearance
    across the run's files (in path order)."""
    names: dict[str, str] = {}

    def name(match):
        token = match.group(0)
        return names.setdefault(token, f"<minted {len(names) + 1}>") if token in minted else token

    canonical = {}
    for path in sorted(evidence):
        record = json.loads(evidence[path])
        for timed in TIMED.get(record.get("check"), ()):
            _drop(record, timed)
        canonical[path] = HQ_ID.sub(name, json.dumps(record, indent="\t", ensure_ascii=False))
    return canonical


def _own_corpus(corpus):
    """The environment of a nested run over a corpus of its own: that corpus, and the empty register beside it
    (``_two_documents``), since the corpus holds none of the register's other documents or controls."""
    return {"PROOF_CORPUS": str(corpus), "PROOF_KNOWN_DEFECTS": str(corpus.parent / "known-defects.json")}


def _two_documents(tmp_path):
    """The two cheapest edited documents of the lane's corpus that emit a form (``proof/checks``' collection
    parametrizes over a document with one, ``test_alignment``), as a corpus of their own, with an empty register
    beside it (``_own_corpus``)."""
    corpus = cases.load_corpus()
    estimate = sharding.estimate(sharding.load_timings())
    edited = [
        document
        for document in corpus.emitted
        if (document.root / "edit").is_dir() and any(module["forms"] for module in document.wire_modules)
    ]
    chosen = sorted(edited, key=lambda document: (estimate(document.group), document.id))[:2]
    assert len(chosen) == 2, "The corpus holds fewer than two edited documents."
    index = json.loads((corpus.root / "index.json").read_text())
    # Every document the corpus emitted, whether or not the run's sample holds it (proof.store.queue.sampled).
    listed = [*index["documents"], *index.pop("unsampled", [])]
    index["documents"] = [entry for entry in listed if entry["id"] in {d.id for d in chosen}]
    root = tmp_path / "corpus"
    root.mkdir()
    for document in chosen:
        shutil.copytree(document.root, root / document.id)
    (root / "index.json").write_text(json.dumps(index, indent="\t"))
    (tmp_path / "known-defects.json").write_text("[]\n")
    return root, [document.id for document in chosen]


def test_two_forked_workers_write_the_evidence_one_unforked_session_writes(tmp_path):
    corpus, documents = _two_documents(tmp_path)
    selection = ["-c", str(INI), "--rootdir", str(PROOF), str(PROOF / "checks"), "-k", " or ".join(documents)]

    plain_out = tmp_path / "plain"
    plain_out.mkdir()
    plain = _run_to_end(
        [sys.executable, "-m", "pytest", *selection, "-q", f"--junit-xml={tmp_path / 'plain.xml'}"],
        tmp_path / "plain.log",
        PROOF_OUT=str(plain_out),
        **_own_corpus(corpus),
        PROOF_WORKER=f"{NESTED_BASE + 3}/{NESTED_BASE + 3}",
    )
    assert plain.returncode in (0, 1), plain.tail()

    forked_out = tmp_path / "forked"
    forked = _serve(forked_out, selection, **_own_corpus(corpus))
    assert forked.returncode in (0, 1), forked.tail()

    record = json.loads((forked_out / lane_blocks.SERVE).read_text())
    assert len(record["forks"]) == 2
    assert all(_alone_at_fork(fork) for fork in record["forks"]), record["forks"]
    assert {worker["status"] for worker in record["workersRun"]} <= {0, 1}

    manifests = lane_blocks.read_manifests(forked_out)
    # Each item by its module and its name, as the block manifests and pytest's JUnit report both name it.
    forked_outcomes = {
        (Path(node_id.split("::")[0]).stem, node_id.split("::", 1)[1]): outcome
        for _, manifest in manifests
        for group in manifest["groups"]
        for node_id, outcome in group["outcomes"].items()
    }
    workers = {group["worker"] for _, manifest in manifests for group in manifest["groups"]}
    assert len(workers) == 2, "Both documents ran on one worker, so the fork was not shared."
    plain_outcomes = {}
    for case in ElementTree.parse(tmp_path / "plain.xml").iter("testcase"):
        kinds = {child.tag for child in case}
        outcome = next((kind for kind in ("failure", "error", "skipped") if kind in kinds), "passed")
        plain_outcomes[case.get("classname").rsplit(".", 1)[-1], case.get("name")] = {"failure": "failed"}.get(
            outcome, outcome
        )
    # Where the two disagree, the side whose item failed says why, in that item's own section of its output.
    assert plain_outcomes == forked_outcomes and forked_outcomes, "\n".join(
        [f"{plain_outcomes} != {forked_outcomes}"]
        + [
            _failure_section(side.output, name)
            for (module, name), outcome in sorted(plain_outcomes.items())
            if forked_outcomes.get((module, name)) != outcome
            for side in (plain, forked)
        ]
    )

    # Both runs observed every document themselves, so the evidence below is two observations', not one store's.
    for out in (plain_out, forked_out):
        observed = {path.name: json.loads(path.read_text())["observed"] for path in out.rglob("observe/*.json")}
        assert sorted(observed) == sorted(f"corpus-{document}.json" for document in documents), out
        assert all(observed.values()), observed

    plain_evidence = _evidence([plain_out])
    forked_evidence = _evidence([directory for directory, _ in manifests])
    assert set(plain_evidence) == set(forked_evidence) and plain_evidence
    # An id only one run wrote is that run's own; one both runs wrote is compared as written.
    plain_ids = set(HQ_ID.findall("".join(plain_evidence.values())))
    forked_ids = set(HQ_ID.findall("".join(forked_evidence.values())))
    plain_canonical = _canonical(plain_evidence, plain_ids - forked_ids)
    forked_canonical = _canonical(forked_evidence, forked_ids - plain_ids)
    differing = [name for name in sorted(plain_evidence) if plain_canonical[name] != forked_canonical[name]]
    assert differing == [], f"The forked workers' evidence differs from the unforked session's in {differing}."


# A CI shard: claims over two queues -------------------------------------------------------------------


def _queue_file(path, *groups_per_block):
    blocks = tuple(
        lane_blocks.Block(lane_blocks.block_id(names), 1.0, tuple(lane_blocks.QueuedGroup(name) for name in names))
        for names in groups_per_block
    )
    lane_blocks.write_json(path, lane_blocks.queue_json(lane_blocks.Queue(blocks)))
    return blocks


# Claims a block by making its directory, which only one process can (exit 1 when another already has).
CLAIM = 'mkdir "$CLAIMS/{block}" 2>/dev/null || exit 1'


def test_a_shard_claims_blocks_of_both_queues_skips_the_taken_and_runs_the_main_queue_once_it_arrives(tmp_path):
    # The main phase collects every test under proof/, each check once per document: two documents keep that
    # collection small, and no block here reads a document. The main block that runs is the harness's own
    # package (proof/test_processes.py), whose few tests cost what the claims around them do.
    corpus, _ = _two_documents(tmp_path)
    claims = tmp_path / "claims"
    claims.mkdir()
    early_queue, main_source = tmp_path / "early.json", tmp_path / "main-source.json"
    corpus_package, core = _queue_file(early_queue, ["proof/corpus"], ["proof/core"])
    harness, editors = _queue_file(main_source, ["proof"], ["proof/editors"])
    # Another shard already holds one block of each queue.
    (claims / core.id).mkdir()
    (claims / editors.id).mkdir()
    out, arrives = tmp_path / "out", tmp_path / "arrives" / "main.json"
    arrives.parent.mkdir()
    finished = _serve(
        out,
        options=[
            "--label",
            "shard-7",
            "--early-queue",
            early_queue,
            "--queue",
            arrives,
            "--claim",
            CLAIM,
            "--wait-for",
            f'cp "{main_source}" "$PROOF_LANE_QUEUE"',
            "--command-env",
            "CLAIMS",
        ],
        CLAIMS=str(claims),
        **_own_corpus(corpus),
    )
    assert finished.returncode == 0, finished.tail()

    record = json.loads((out / lane_blocks.SERVE).read_text())
    outcomes = {claim["block"]: claim["outcome"] for claim in record["claims"]}
    assert outcomes == {corpus_package.id: "claimed", core.id: "taken", harness.id: "claimed", editors.id: "taken"}
    ran = {manifest["block"]: manifest for _, manifest in lane_blocks.read_manifests(out)}
    assert set(ran) == {corpus_package.id, harness.id}
    assert ran[corpus_package.id]["phase"] == "early" and ran[harness.id]["phase"] == "main"
    assert all(group["failure"] is None for manifest in ran.values() for group in manifest["groups"])
    phases = {phase["phase"]: phase for phase in record["phases"]}
    # The main phase collects every test the early phase did not: what no queue accounts for is recorded.
    assert "proof/corpus" not in phases["main"]["collected"]["groups"]
    assert "proof" in phases["main"]["collected"]["groups"]
    assert "proof/hq" in phases["main"]["unaccounted"]
    # The wait is time spent on another job, kept apart from the shard's fixed costs.
    assert "queue" in record["waits"] and "queue" not in record["fixed"]

    # Alone, this shard's output leaves the taken blocks to a shard that never ran: the verify says so.
    verdict = sharding.verify(
        [("early", lane_blocks.load_queue(early_queue)), ("main", lane_blocks.load_queue(arrives))], [out]
    )
    missing = [problem for problem in verdict.problems if "no shard claimed it" in problem]
    assert len(missing) == 2 and any(core.id in problem for problem in missing)
    assert set(verdict.chosen) == {corpus_package.id, harness.id}


# One cheap item using the Core runner in each of two packages (pytest's -k, through PYTEST_ADDOPTS, which the
# server's collection and every worker's session read alike).
CORE_RUNNER_ITEMS = "test_a_missing_archive_entry_is_named or test_a_build_reads_the_same_filter_errors_from_either"
# Claims the first block at once, and the second only once the first block's manifest is written.
SLOW_CLAIM = """#!/bin/sh
if [ "$1" = "{first}" ]; then exit 0; fi
attempt=0
while [ $attempt -lt 1200 ]; do
    if [ -f "{manifest}" ]; then echo "The first block's manifest was written while this claim ran."; exit 0; fi
    sleep 0.1
    attempt=$((attempt + 1))
done
echo "The first block's manifest was never written while this claim ran."
exit 2
"""


def test_an_early_queue_holding_a_group_that_reads_the_corpus_is_refused_before_hq_boots(tmp_path):
    # The same groups run in the main phase, once the corpus is in place: the test below runs proof/hq there.
    early_queue = tmp_path / "early.json"
    _queue_file(early_queue, ["proof/corpus"], ["proof/native", "proof/core"], ["control:empty"])
    out = tmp_path / "out"
    finished = _serve(
        out,
        options=["--early-queue", early_queue, "--claim", "static"],
        PROOF_CORPUS=str(cases.load_corpus().root),
    )
    assert finished.returncode == 2, finished.tail()
    record = json.loads((out / lane_blocks.SERVE).read_text())
    assert record["problems"] == [
        f"The early queue {early_queue} holds control:empty, proof/native: their checks read the corpus (its"
        " documents, or the native products it carries), which the early phase runs without. Queue them in the main"
        " queue."
    ]
    # Refused before anything was booted, restored or compiled.
    assert record["fixed"] == {} and "Booted HQ" not in finished.output


def test_no_item_waits_on_a_claim_and_the_session_stays_up_for_the_block_the_claim_brings(tmp_path):
    # As above: the main phase's collection over two documents, which neither block reads.
    corpus, _ = _two_documents(tmp_path)
    queue = tmp_path / "main.json"
    core, hq = _queue_file(queue, ["proof/core"], ["proof/hq"])
    out = tmp_path / "out"
    claim = tmp_path / "claim.sh"
    claim.write_text(
        SLOW_CLAIM.format(first=core.id, manifest=lane_blocks.block_dir(out, core.id) / lane_blocks.MANIFEST)
    )
    finished = _serve(
        out,
        workers=1,
        options=["--queue", queue, "--claim", f"sh {claim} {{block}}"],
        PYTEST_ADDOPTS=f"-k '{CORE_RUNNER_ITEMS}'",
        **_own_corpus(corpus),
    )
    assert finished.returncode == 0, finished.tail()

    record = json.loads((out / lane_blocks.SERVE).read_text())
    assert {claim["block"]: claim["outcome"] for claim in record["claims"]} == {core.id: "claimed", hq.id: "claimed"}
    assert "was written while this claim ran" in (out / "claims" / f"{hq.id}.log").read_text()
    ran = {manifest["block"]: manifest for _, manifest in lane_blocks.read_manifests(out)}
    assert set(ran) == {core.id, hq.id}
    for manifest in ran.values():
        [group] = manifest["groups"]
        assert group["failure"] is None and group["worker"] == 1
        assert list(group["outcomes"].values()) == ["passed"]
    # The worker's Core runner started once, for the first block, and served the second.
    timings = json.loads((out / "workers" / "w1" / "hq-timings.json").read_text())
    assert len(timings["core_runner_start"]) == 1, timings


def test_a_shard_whose_corpus_emission_failed_runs_its_early_blocks_and_fails_by_name(tmp_path):
    early_queue = tmp_path / "early.json"
    (corpus_package,) = _queue_file(early_queue, ["proof/corpus"])
    out = tmp_path / "out"
    finished = _serve(
        out,
        workers=1,
        options=[
            "--early-queue",
            early_queue,
            "--queue",
            tmp_path / "never.json",
            "--claim",
            "static",
            "--wait-for",
            "exit 3",
        ],
    )
    assert finished.returncode == 3, finished.tail()
    record = json.loads((out / lane_blocks.SERVE).read_text())
    assert [manifest["block"] for _, manifest in lane_blocks.read_manifests(out)] == [corpus_package.id]
    assert any("corpus emission failed" in problem for problem in record["problems"])
