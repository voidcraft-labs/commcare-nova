"""``python -m proof.lane.serve``: one HQ boot, forked into pytest workers that run the lane's queued blocks.

    python -m proof.lane.serve --out DIR [--workers K] [--label NAME]
        [--early-queue FILE] [--queue FILE] [--claim static | '<command> {block}'] [--bin I/N]
        [--wait-for '<command>'] [--command-env NAME,...] [--worker-base N] [-- PYTEST ARGS...]

The server (this process) boots HQ (``proof.hq.boot``), restores HQ's
template database (``proof.hq.database.restore_template``), compiles the
Core runner's classes once (``proof.core.client.compile_runner``, named to
every runner as ``PROOF_CORE_CLASSES``) and warms HQ (``boot.warm``). For
each phase it collects the phase's tests once, then makes itself safe to
fork (``boot.prepare_for_fork``: one thread, no connection, a frozen heap)
and forks up to K workers (``proof.lane.worker``), each with its own lane
position (``PROOF_WORKER``), databases, Core runner and editor driver. It
hands each worker one group at a time (``proof.lane.broker``), and when every
group of a block has ended writes the block's manifest
(``blocks/<id>/block.json``, ``proof.lane.blocks``). A worker asks for its
next group in one of two ways: ``next``, answered once there is a group or
nothing more for it, and ``peek``, answered at once, with ``later`` while a
claim may still bring a block; a worker peeks before its group's last item,
so no item waits on a claim (``proof.lane.plugin``).

No other thread may run when the server forks: a lock another thread held at
the fork stays held in the worker. HQ's boot imports ddtrace, whose native
trace writer runs OS threads of its own (``tokio-rt-worker``, as many as the
container's CPUs allow) that Python's ``threading`` never lists; ddtrace's
own before-fork hook stops them
(``ddtrace/internal/writer/writer.py::NativeWriter.before_fork_hook``, run
from ``ddtrace/internal/forksafe.py``'s ``os.register_at_fork``) and each
child starts them again. That hook does not wait for the threads to exit,
and under load one can still be running when it returns. So the server reads
the process's OS threads (``/proc/self/task``) in a before-fork hook of its
own, registered before the boot so it runs after ddtrace's, and waits there
until its own thread is the only one (``THREADS_LEAVE_SECONDS`` at most); a
fork with any thread but the server's own is a problem of the run.

Phases. With no queue, the server runs what pytest collects from PYTEST ARGS
(the whole of ``proof/`` by default) as one block it claims itself: the run
``npm run proof`` makes (``proof/run.mjs``), whose queue it writes to
``queue.json``, naming the documents the corpus's sample leaves out where
the queue builder sampled it (``proof.lane.blocks.unsampled_documents``).
With ``--bin I/N`` as well, each collected group is a block of its own and
the server runs bin I of N of them, so N servers over the same collection
run it all once between them. With queues it runs the early
queue's blocks first (groups that need no corpus: each group's tests,
``proof.checks.sharding.collection_roots``), and the main queue's as soon as
it is known, every test under ``proof/`` but the early phase's; while early
groups still run, main workers take the slots early workers leave. An
early queue holding a group that reads the corpus (a document's, a
control's, or a package in ``proof.lane.blocks.CORPUS_PACKAGES``) is refused
at the start, before HQ boots. The main phase reads the corpus PROOF_CORPUS
names and never emits one, so a main queue already in place without that
corpus is refused at the start. A main queue that does not exist yet is
waited for with ``--wait-for``, a shell command run from the checkout that
exits 0 once the queue is at ``--queue`` (``PROOF_LANE_QUEUE``) and the
corpus at ``PROOF_CORPUS``, or 3 when the corpus emission failed (its
marker exists); any other exit is the server's failure.

Claims. ``--claim static`` owns every block (with ``--bin I/N``, the blocks
of bin I of N, ``proof.checks.sharding.static_bins``). Otherwise each block
is claimed by running the shell command with ``{block}`` replaced by the
block's id: exit 0 means this shard owns it, 1 that another shard does, and
anything else stops every claim; the shard finishes what it owns and fails.
It claims in queue order, or with ``--bin I/N`` its own bin's blocks first
and then every other bin's (``proof.checks.sharding.claim_order``), so the
shards of one run start on different blocks.
The variables ``--command-env`` names are taken out of the server's
environment and given only to these commands, never to a worker.

Workers fail apart: a worker that ends while running a group fails that
group with the reason, a group it was handed and had not started goes to
another worker, and a replacement takes its slot while the phase has work.
Every process the server or a worker started is stopped and reaped before
the server exits, the databases its workers made are dropped, and
``serve.json`` records the run: the fixed costs (boot, template, javac,
warm), each fork and what preparing it took, how long the shard waited for
the main queue (``waits``), the threads at each fork (Python's ``threads``
after preparing, the OS threads after preparing, ``osThreadsPrepared``, at
the fork itself, ``osThreadsAtFork``, and those still leaving when the
server's hook ran, ``osThreadsLeaving``, with how long they took), each
phase's collection (a digest of every item and its group), each claim, each
worker's exit, and every problem.

Exit status: 0 when every item it ran passed; 1 when an item failed; 2 when
the lane could not start (its arguments, its queue, a collection, the boot);
3 when a worker, a claim, the wait or the corpus emission failed during the
run, or a fork found another thread running; 5 when nothing was collected;
130 when interrupted.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from dataclasses import dataclass, field, replace
from pathlib import Path

import pytest

from proof import processes
from proof.checks import sharding
from proof.lane import blocks as lane_blocks
from proof.lane import worker as lane_worker
from proof.lane.broker import WAIT, Broker
from proof.store.keys import SELECTION_ENVIRONMENT

PROOF_DIR = sharding.PROOF_DIR
WORKTREE = PROOF_DIR.parent
INI = PROOF_DIR / "pytest.ini"

EXIT_PASSED, EXIT_FAILED, EXIT_REFUSED, EXIT_BROKEN, EXIT_NOTHING, EXIT_INTERRUPTED = 0, 1, 2, 3, 5, 130
# The claim command's answers, and the wait command's answer when the corpus emission failed.
CLAIMED, TAKEN = 0, 1
EMISSION_FAILED = 3
# pytest's exit statuses a worker may end with when nothing went wrong but its tests: passed, failed, none ran.
ORDINARY_EXITS = (0, 1, 5)
# Replacements for lost workers per slot, before the server stops replacing them.
REPLACEMENTS_PER_SLOT = 2
POLL_SECONDS = 1.0
TAIL = 4000


class Refused(Exception):
    """The lane cannot start as asked."""


def os_threads() -> list[str]:
    """This process's OS threads (``/proc/self/task``), each by its name, in thread id order."""
    names = []
    for entry in sorted(os.listdir("/proc/self/task"), key=int):
        try:
            names.append(Path("/proc/self/task", entry, "comm").read_text(encoding="utf-8").strip())
        except OSError:
            continue  # a thread that ended while it was read
    return names


# How long the before-fork hook waits for threads another hook stopped to leave: ddtrace stops its native
# writer's threads without waiting for them to exit, and one can still be running when its hook returns.
THREADS_LEAVE_SECONDS = 2.0
# What the before-fork hook ``Server._prepare`` registers saw at the latest fork.
_AT_FORK: dict = {}


def _note_threads_at_fork() -> None:
    """The OS threads at the fork, once every thread but this one has left (up to ``THREADS_LEAVE_SECONDS``)."""
    started = time.perf_counter()
    first = threads = os_threads()
    while len(threads) > 1 and time.perf_counter() - started < THREADS_LEAVE_SECONDS:
        time.sleep(0.0005)
        threads = os_threads()
    _AT_FORK.update(threads=threads, leaving=first if first != threads else [], waited=time.perf_counter() - started)


class Interrupted(BaseException):
    """The server was asked to stop (SIGINT or SIGTERM)."""


def _interrupt(signum, frame):
    raise Interrupted(signal.Signals(signum).name)


def _tail(path: Path, limit: int = TAIL) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[-limit:]
    except OSError:
        return "(it wrote nothing)"


def say(message: str) -> None:
    print(f"[lane] {message}", flush=True)


@dataclass
class PhaseInfo:
    name: str
    args: list[str]
    local: bool = False
    collected: bool = False
    groups: dict[str, str] = field(default_factory=dict)
    by_group: dict[str, list[str]] = field(default_factory=dict)
    digest: str | None = None
    record: dict = field(default_factory=dict)


@dataclass
class Worker:
    sequence: int
    slot: int
    phase: str
    pid: int
    pidfd: int
    sock: socket.socket
    output: int | None
    log: object
    inbox: bytes = b""
    pending_line: bytes = b""
    assignments: dict = field(default_factory=dict)
    waiting: bool = False
    refusal: str | None = None
    exited: int | None = None
    forked: float = 0.0


@dataclass
class Command:
    kind: str  # claim or wait
    group: processes.ProcessGroup
    log: Path
    started: float
    phase: str | None = None
    block: str | None = None


class Server:
    def __init__(self, options):
        self.options = options
        self.out = Path(options.out)
        self.k = options.workers
        self.base = options.worker_base
        self.label = options.label
        self.command_env = {}
        self.broker = Broker(sharding.estimate(sharding.load_timings()))
        self.phases: dict[str, PhaseInfo] = {}
        self.workers: dict[int, Worker] = {}
        self.commands: list[Command] = []
        self.free_slots = list(range(1, self.k + 1))
        self.replacements = 0
        self.sequence = 0
        self.problems: list[str] = []
        self.stopping: str | None = None
        # Phases whose workers cannot run (a collection that failed, or differs between processes): phase -> why.
        self.broken: dict[str, str] = {}
        self.classes: Path | None = None
        self.restored = False
        self.failing: list[str] = []
        self.ran_items = 0
        self.collect_only_code: int | None = None
        self.record: dict = {
            "version": 1,
            "label": self.label,
            "workers": self.k,
            "fixed": {},
            "waits": {},
            "forks": [],
            "phases": [],
            "claims": [],
            "workersRun": [],
            "problems": self.problems,
            # What the server collected with beyond its own arguments, and in what environment: a run of any
            # other selection holds only some of each group's items, and one in another environment than the queue
            # keys a package group under ran it otherwise, so the evidence store keeps no such outcome
            # (proof.store.pack).
            "selection": {
                "pytest": list(options.pytest),
                "addopts": os.environ.get("PYTEST_ADDOPTS") or None,
                "environment": {name: os.environ.get(name) for name in SELECTION_ENVIRONMENT},
            },
        }

    # Starting ------------------------------------------------------------------------

    def _refuse_environment(self):
        if os.environ.get("PROOF_SHARD"):
            raise Refused(
                f"PROOF_SHARD is set ({os.environ['PROOF_SHARD']}), and the lane no longer splits its items into"
                " shard bins: a shard claims blocks from the queue (--claim), or takes a bin of them (--bin I/N)."
                " Unset PROOF_SHARD."
            )
        options = self.options
        if self.k < 1:
            raise Refused(f"--workers takes a whole number of at least one; got {self.k}.")
        queued = options.early_queue is not None or options.queue is not None
        if options.claim != "static" and "{block}" not in options.claim:
            raise Refused(f"--claim takes static, or a command naming the block as {{block}}; got {options.claim!r}.")
        if options.claim != "static" and not queued:
            raise Refused("--claim with a command claims a queue's blocks: name the queues (--early-queue, --queue).")
        if queued and options.pytest:
            raise Refused(
                "A run over queues collects each phase's tests itself, so it takes no pytest arguments; got"
                f" {' '.join(options.pytest)}."
            )
        if options.wait_for is not None and options.queue is None:
            raise Refused("--wait-for waits for the main queue: name where it arrives with --queue.")
        if options.queue is not None and not options.queue.exists() and options.wait_for is None:
            raise Refused(
                f"The main queue {options.queue} does not exist, and nothing waits for it: add --wait-for with the"
                " command that brings it."
            )
        if options.early_queue is not None:
            early = self._load(options.early_queue, "early")
            reading = sorted(name for name in early.groups() if lane_blocks.reads_corpus(name))
            if reading:
                raise Refused(
                    f"The early queue {options.early_queue} holds {', '.join(reading[:5])}: their checks read the"
                    " corpus (its documents, or the native products it carries), which the early phase runs without."
                    " Queue them in the main queue."
                )
        if options.queue is not None and options.queue.exists():
            corpus = os.environ.get("PROOF_CORPUS")
            if not corpus or not Path(corpus, "index.json").is_file():
                raise Refused(
                    f"--queue runs the corpus's documents, and PROOF_CORPUS ({corpus or 'unset'}) names no corpus"
                    " (index.json); a shard never emits one. Download the corpus and name it with PROOF_CORPUS."
                )
        for name in options.command_env:
            if name in os.environ:
                self.command_env[name] = os.environ.pop(name)

    def _prepare(self):
        """Boot, template, javac and warm, once, before any fork."""
        # Before the boot imports ddtrace, so this hook runs after ddtrace's own, at the fork itself.
        os.register_at_fork(before=_note_threads_at_fork)
        fixed = self.record["fixed"]
        self.out.mkdir(parents=True, exist_ok=True)
        os.environ["PROOF_OUT"] = str(self.out)
        os.environ["PROOF_WORKER"] = f"{self.base + 1}/{self.base + self.k}"
        processes.become_subreaper()

        from proof.core.client import CLASSES_ENVIRONMENT, compile_runner
        from proof.hq import boot, database

        started = time.perf_counter()
        report = boot.boot()
        fixed["boot"] = round(time.perf_counter() - started, 3)
        fixed["bootSteps"] = report.steps
        say(f"Booted HQ in {fixed['boot']} s.")
        started = time.perf_counter()
        database.restore_template()
        self.restored = True
        fixed["template"] = round(time.perf_counter() - started, 3)
        self.classes = Path(tempfile.mkdtemp(prefix="proof-lane-core-")) / "classes"
        fixed["javac"] = round(compile_runner(self.classes), 3)
        os.environ[CLASSES_ENVIRONMENT] = str(self.classes)
        started = time.perf_counter()
        boot.warm()
        fixed["warm"] = round(time.perf_counter() - started, 3)
        say(
            f"Restored HQ's template in {fixed['template']} s, compiled the Core runner in {fixed['javac']} s,"
            f" warmed HQ in {fixed['warm']} s."
        )

    def _base_args(self) -> list[str]:
        return ["-c", str(INI), "--rootdir", str(PROOF_DIR), "-o", "console_output_style=classic"]

    def _plan(self):
        options = self.options
        if options.early_queue is None and options.queue is None:
            args = list(options.pytest) or ["-c", str(INI), "--rootdir", str(PROOF_DIR), str(PROOF_DIR)]
            self.phases["main"] = PhaseInfo("main", [*args, "-o", "console_output_style=classic"], local=True)
            self.broker.add_phase("main", static=True)
            return
        static = options.claim == "static"
        early_roots: list[Path] = []
        if options.early_queue is not None:
            queue = self._load(options.early_queue, "early")
            early_roots = sharding.collection_roots(queue.groups())
            self.phases["early"] = PhaseInfo("early", [*self._base_args(), *map(str, early_roots)])
            self.broker.add_phase("early", static=static)
            self.broker.offer("early", self._binned(queue))
        if options.queue is not None:
            ignored = [f"--ignore={root}" for root in early_roots]
            self.phases["main"] = PhaseInfo("main", [*self._base_args(), str(PROOF_DIR), *ignored])
            self.broker.add_phase("main", static=static)
            if options.queue.exists():
                self.broker.offer("main", self._binned(self._load(options.queue, "main")))
            else:
                self._start_wait()

    def _load(self, path: Path, phase: str) -> lane_blocks.Queue:
        try:
            return lane_blocks.load_queue(path)
        except lane_blocks.QueueError as error:
            raise Refused(f"The {phase} queue cannot be run: {error}") from error

    def _binned(self, queue: lane_blocks.Queue) -> list:
        """The queue's blocks this shard takes, in its order: with ``--bin I/N``, bin I of N alone where it claims
        statically, and otherwise every block, its own bin's first (``sharding.claim_order``)."""
        if self.options.bin is None:
            return list(queue.blocks)
        index, count = self.options.bin
        if self.options.claim != "static":
            return sharding.claim_order(queue.blocks, index, count)
        return sharding.static_bins(queue.blocks, count)[index - 1]

    # Commands --------------------------------------------------------------------------

    def _command(self, kind: str, text: str, log: Path, **extra) -> Command:
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("wb") as output:
            group = processes.ProcessGroup(
                ["sh", "-c", text],
                cwd=str(WORKTREE),
                env={**os.environ, **self.command_env, **extra.pop("env", {})},
                stdout=output,
                stderr=subprocess.STDOUT,
            )
        command = Command(kind, group, log, time.perf_counter(), **extra)
        self.commands.append(command)
        return command

    def _start_wait(self):
        queue = str(self.options.queue)
        say(f"Waiting for the main queue at {queue} ({self.options.wait_for}).")
        self._command(
            "wait",
            self.options.wait_for,
            self.out / "wait.log",
            env={"PROOF_LANE_QUEUE": queue},
            phase="main",
        )

    def _start_claims(self):
        if self.stopping:
            return
        for phase, block in self.broker.claims_to_start():
            text = self.options.claim.replace("{block}", block.id)
            self._command(
                "claim",
                text,
                self.out / "claims" / f"{block.id}.log",
                env={"PROOF_LANE_BLOCK": block.id},
                phase=phase,
                block=block.id,
            )

    def _command_ended(self, command: Command):
        command.group.stop()
        self.commands.remove(command)
        code = command.group.returncode
        seconds = round(time.perf_counter() - command.started, 3)
        if command.kind == "claim":
            outcome = "claimed" if code == CLAIMED else "taken" if code == TAKEN else "failed"
            reason = None
            if outcome == "failed":
                reason = (
                    f"Claiming block {command.block} failed (the claim command exited {code}), so this shard"
                    f" claims nothing more. Its output ({command.log}) ends:\n{_tail(command.log)}"
                )
                self.problems.append(reason)
            self.broker.claimed(command.phase, command.block, outcome, reason)
            self.record["claims"].append(
                {"phase": command.phase, "block": command.block, "outcome": outcome, "seconds": seconds}
            )
            if outcome == "claimed":
                say(f"Claimed block {command.block[:12]} of the {command.phase} queue in {seconds} s.")
            return
        # The wait for the main queue: time the shard spent idle on another job, never one of its fixed costs.
        self.record["waits"]["queue"] = seconds
        if code == EMISSION_FAILED:
            self.problems.append(
                "The corpus emission failed before this shard could run the main queue (the wait command found its"
                " marker), so no document ran here; the emit step of the job that emits the corpus says why."
            )
            self.broker.cancel("main")
            return
        if code != 0:
            self.problems.append(
                f"Waiting for the main queue failed (the wait command exited {code}), so no document ran here."
                f" Its output ({command.log}) ends:\n{_tail(command.log)}"
            )
            self.broker.cancel("main")
            return
        corpus = os.environ.get("PROOF_CORPUS")
        if not corpus or not Path(corpus, "index.json").is_file():
            self.problems.append(
                f"The wait command brought the main queue, and PROOF_CORPUS ({corpus or 'unset'}) holds no corpus"
                " (index.json), so the documents cannot be collected."
            )
            self.broker.cancel("main")
            return
        try:
            queue = lane_blocks.load_queue(self.options.queue)
        except lane_blocks.QueueError as error:
            self.problems.append(f"The main queue cannot be run: {error}")
            self.broker.cancel("main")
            return
        say(f"The main queue arrived after {seconds} s: {len(queue.blocks)} blocks.")
        self.broker.offer("main", self._binned(queue))

    # Collecting ------------------------------------------------------------------------------

    def _in_log(self, log: Path, call):
        """``call()`` with this process's standard output and error going to ``log``."""
        sys.stdout.flush()
        sys.stderr.flush()
        saved = os.dup(1), os.dup(2)
        try:
            with log.open("wb") as output:
                os.dup2(output.fileno(), 1)
                os.dup2(output.fileno(), 2)
                try:
                    return call()
                finally:
                    sys.stdout.flush()
                    sys.stderr.flush()
        finally:
            os.dup2(saved[0], 1)
            os.dup2(saved[1], 2)
            os.close(saved[0])
            os.close(saved[1])

    def _collect(self, info: PhaseInfo):
        log = self.out / f"collect-{info.name}.log"
        emits = info.local and not os.environ.get("PROOF_CORPUS")
        say(
            f"Collecting the {info.name} phase's tests (its output: {log.name})"
            + (", emitting the corpus first if the selection reads it, as PROOF_CORPUS is unset." if emits else ".")
        )
        collector = _Collector()
        started = time.perf_counter()
        code = self._in_log(log, lambda: pytest.main([*info.args, "--collect-only", "-qq"], plugins=[collector]))
        seconds = round(time.perf_counter() - started, 3)
        if int(code) not in (0, EXIT_NOTHING) or collector.errors:
            raise Refused(
                f"Collecting the {info.name} phase's tests failed (pytest exit {int(code)},"
                f" {collector.errors} collection errors), so no worker started. Its output ({log}) ends:\n" + _tail(log)
            )
        info.collected = True
        info.groups = collector.groups
        info.by_group = {}
        for node_id, group in collector.groups.items():
            info.by_group.setdefault(group, []).append(node_id)
        info.digest = lane_blocks.collection_digest(info.groups)
        if not os.environ.get("PROOF_CORPUS") and (self.out / "corpus" / "index.json").is_file():
            # The collection emitted the corpus (proof.checks.corpus.corpus_root); every worker reads that one.
            os.environ["PROOF_CORPUS"] = str(self.out / "corpus")
        info.record = {
            "phase": info.name,
            "seconds": seconds,
            "collected": {
                "digest": info.digest,
                "items": len(info.groups),
                "groups": {group: len(ids) for group, ids in sorted(info.by_group.items())},
            },
        }
        self.record["phases"].append(info.record)
        say(f"Collected the {info.name} phase in {seconds} s: {len(info.groups)} items in {len(info.by_group)} groups.")
        if info.local:
            estimate = sharding.estimate(sharding.load_timings())
            estimates = {group: estimate(group) for group in info.by_group}
            # With --bin, one block per group, so every shard's bin of them is the same split.
            queue = (
                lane_blocks.block_per_group(estimates)
                if self.options.bin is not None
                else lane_blocks.single_block(estimates)
            )
            corpus = os.environ.get("PROOF_CORPUS")
            if corpus and Path(corpus, "index.json").is_file():
                # A corpus the queue builder sampled names the documents it leaves out, for the gate.
                queue = replace(queue, unsampled=lane_blocks.unsampled_documents(Path(corpus)))
            lane_blocks.write_json(self.out / "queue.json", lane_blocks.queue_json(queue))
            self.broker.offer(info.name, self._binned(queue) if info.by_group else [])
            return
        accounted = set()
        for path in (self.options.early_queue, self.options.queue):
            if path is not None and path.exists():
                queue = lane_blocks.load_queue(path)
                accounted |= queue.groups() | {entry.group for entry in queue.cached}
        info.record["unaccounted"] = sorted(set(info.by_group) - accounted)
        queued = {name for block in self.broker.phases[info.name].blocks for name in block.names}
        missing = sorted(queued - set(info.by_group))
        if missing:
            say(f"The {info.name} queue names groups this collection holds no item of: {', '.join(missing[:5])}.")

    # Workers --------------------------------------------------------------------------------

    def _server_fds(self) -> list[int]:
        fds = []
        for held in self.workers.values():
            fds += [held.pidfd, held.sock.fileno(), held.log.fileno()]
            if held.output is not None:
                fds.append(held.output)
        for command in self.commands:
            fds.append(command.group.fileno())
        return fds

    def _fork(self, info: PhaseInfo):
        from proof.hq import boot

        slot = self.free_slots.pop(0)
        self.sequence += 1
        sequence = self.sequence
        started = time.perf_counter()
        boot.prepare_for_fork()
        prepared = round(time.perf_counter() - started, 4)
        threads = [thread.name for thread in threading.enumerate()]
        prepared_threads = os_threads()
        ours, theirs = socket.socketpair()
        read_end, write_end = os.pipe()
        close_fds = self._server_fds()
        sys.stdout.flush()
        sys.stderr.flush()
        _AT_FORK.clear()
        started = time.perf_counter()
        pid = os.fork()
        if pid == 0:
            try:
                ours.close()
                os.close(read_end)
                lane_worker.run(
                    channel=theirs,
                    output_fd=write_end,
                    close_fds=close_fds,
                    sequence=sequence,
                    position=f"{self.base + slot}/{self.base + self.k}",
                    workers=self.k,
                    out=self.out,
                    label=self.label,
                    pytest_args=info.args,
                )
            finally:
                os._exit(lane_worker.EXIT_ESCAPED)
        forked = round(time.perf_counter() - started, 4)
        at_fork = _AT_FORK.get("threads")
        if at_fork is None or len(at_fork) != 1:
            self.problems.append(
                f"Worker w{sequence} was forked while the server ran the OS threads {at_fork}, not its own alone: a"
                " lock another thread held at the fork stays held in the worker, so what it observes cannot be"
                " trusted. serve.json's forks name the threads after preparing and at the fork."
            )
        theirs.close()
        os.close(write_end)
        ours.setblocking(False)
        os.set_blocking(read_end, False)
        (self.out / "workers").mkdir(parents=True, exist_ok=True)
        held = Worker(
            sequence,
            slot,
            info.name,
            pid,
            os.pidfd_open(pid),
            ours,
            read_end,
            (self.out / "workers" / f"w{sequence}.log").open("ab"),
        )
        held.forked = time.perf_counter()
        self.workers[pid] = held
        self.record["forks"].append(
            {
                "worker": sequence,
                "slot": slot,
                "phase": info.name,
                "threads": threads,
                "osThreadsPrepared": prepared_threads,
                "osThreadsAtFork": at_fork,
                # Threads still leaving when the hook ran (stopped by an earlier hook), and how long they took.
                "osThreadsLeaving": _AT_FORK.get("leaving"),
                "osThreadsWaited": round(_AT_FORK.get("waited", 0.0), 6),
                "prepare": prepared,
                "fork": forked,
            }
        )

    def _live(self, phase: str | None = None) -> list[Worker]:
        return [held for held in self.workers.values() if phase is None or held.phase == phase]

    def _advance(self):
        """Collect each phase that owns a block, and fork workers into free slots, earlier phases first."""
        for name, info in self.phases.items():
            if self.stopping:
                return
            if name in self.broken:
                continue
            phase = self.broker.phases[name]
            if not info.collected:
                if info.local:
                    self._collect(info)
                elif phase.available and self.broker.owned(name):
                    try:
                        self._collect(info)
                    except Refused as error:
                        # Its claimed blocks stay unrun, which the gate reports; the other phase still runs.
                        self.broken[name] = str(error)
                        self.problems.append(str(error))
                        continue
                else:
                    continue
            wanted = min(self.k, self.broker.demand(name))
            while (
                self.free_slots
                and len(self._live(name)) < wanted
                and self.replacements <= REPLACEMENTS_PER_SLOT * self.k
            ):
                self._fork(info)

    def _send(self, held: Worker, message: dict):
        held.sock.setblocking(True)
        try:
            held.sock.sendall(json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n")
        except OSError:
            pass  # the worker is gone; its exit settles what it held
        finally:
            held.sock.setblocking(False)

    def _hand_out(self, held: Worker, *, wait: bool = True) -> bool:
        """Answer the worker's request for a group; False while it must wait (``next``), never for a ``peek``."""
        if held.refusal or self.stopping or held.phase in self.broken:
            self._send(held, {"group": None})
            return True
        assignment = self.broker.next_for(held.phase, held.sequence)
        if assignment == WAIT:
            if wait:
                return False
            self._send(held, {"group": None, "later": True})
            return True
        if assignment is None:
            self._send(held, {"group": None})
            return True
        lane_blocks.block_dir(self.out, assignment.block).mkdir(parents=True, exist_ok=True)
        held.assignments[(assignment.block, assignment.group)] = assignment
        self._send(
            held,
            {
                "group": assignment.group,
                "block": assignment.block,
                "fresh": assignment.fresh,
                "phase": assignment.phase,
            },
        )
        return True

    def _message(self, held: Worker, message: dict):
        kind = message.get("t")
        if kind == "collected":
            # From the fork to the worker's own collection: its session's start.
            fork = next(fork for fork in self.record["forks"] if fork["worker"] == held.sequence)
            fork["collected"] = round(time.perf_counter() - held.forked, 3)
            info = self.phases[held.phase]
            if message.get("errors") or message.get("digest") != info.digest:
                held.refusal = (
                    f"Worker w{held.sequence} collected {message.get('count')} items"
                    f" ({message.get('errors')} collection errors) unlike the server's {len(info.groups)}, so the"
                    f" {held.phase} phase runs nothing more: a collection must not depend on the process."
                )
                self.problems.append(held.refusal)
                self.broken[held.phase] = held.refusal
        elif kind in ("next", "peek"):
            if held.exited is not None:
                return  # a request the worker sent before it ended; nothing is handed to it now
            if not self._hand_out(held, wait=kind == "next"):
                held.waiting = True
                self.broker.wait(held.phase)
        elif kind == "started":
            assignment = held.assignments.get((message["block"], message["group"]))
            if assignment is not None:
                self.broker.started(assignment)
        elif kind == "finished":
            assignment = held.assignments.pop((message["block"], message["group"]), None)
            if assignment is None:
                return
            outcomes = message.get("outcomes", {})
            failing = sorted(node_id for node_id, outcome in outcomes.items() if outcome in lane_blocks.FAILING)
            self.failing += failing
            self.ran_items += len(outcomes)
            self.broker.ended(
                assignment, {"outcomes": outcomes, "seconds": message.get("seconds"), "worker": held.sequence}
            )
            say(
                f"w{held.sequence} finished {assignment.group}: {len(outcomes) - len(failing)} of {len(outcomes)}"
                f" items passed in {message.get('seconds')} s."
            )
        elif kind == "stop":
            self.stopping = f"a worker stopped the run ({message.get('reason')})"
            say(f"Stopping: {self.stopping}.")

    def _read_channel(self, held: Worker):
        try:
            chunk = held.sock.recv(65536)
        except BlockingIOError:
            return
        except OSError:
            chunk = b""
        if not chunk:
            return
        held.inbox += chunk
        while b"\n" in held.inbox:
            line, held.inbox = held.inbox.split(b"\n", 1)
            self._message(held, json.loads(line))

    def _read_output(self, held: Worker, final: bool = False):
        while held.output is not None:
            try:
                chunk = os.read(held.output, 65536)
            except BlockingIOError:
                return
            if not chunk:
                os.close(held.output)
                held.output = None
                if held.pending_line:
                    self._forward(held, held.pending_line)
                    held.pending_line = b""
                return
            held.log.write(chunk)
            lines = (held.pending_line + chunk).split(b"\n")
            held.pending_line = lines.pop()
            for line in lines:
                self._forward(held, line)
            if not final:
                return

    def _forward(self, held: Worker, line: bytes):
        sys.stdout.write(f"[w{held.sequence}] {line.decode('utf-8', 'replace')}\n")
        sys.stdout.flush()

    def _drain_channel(self, held: Worker):
        """Every message the worker sent before it ended."""
        while True:
            try:
                chunk = held.sock.recv(65536)
            except (BlockingIOError, OSError):
                chunk = b""
            if not chunk:
                return
            held.inbox += chunk
            while b"\n" in held.inbox:
                line, held.inbox = held.inbox.split(b"\n", 1)
                self._message(held, json.loads(line))

    def _worker_ended(self, held: Worker):
        _, status = os.waitpid(held.pid, 0)
        code = os.waitstatus_to_exitcode(status)
        held.exited = code
        self._drain_channel(held)
        self._read_output(held, final=True)
        if held.output is not None:
            os.close(held.output)
            held.output = None
        os.close(held.pidfd)
        held.sock.close()
        held.log.close()
        try:
            os.killpg(held.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        del self.workers[held.pid]
        self.free_slots.append(held.slot)
        self.free_slots.sort()
        if held.waiting:
            self.broker.stop_waiting(held.phase)
        reason = (
            f"worker w{held.sequence} exited with status {code} while running it"
            f" (its log: workers/w{held.sequence}.log)"
        )
        lost_running = False
        for assignment in held.assignments.values():
            lost_running |= self.broker.status(assignment) == "running"
            self.broker.lost(assignment, reason)
        ordinary = code in ORDINARY_EXITS or (self.stopping and code == 2)
        if lost_running or not ordinary:
            self.replacements += 1
            if not held.refusal:
                self.problems.append(
                    f"Worker w{held.sequence} ({held.phase} phase) exited with status {code}"
                    + (", failing the group it was running." if lost_running else ".")
                    + f" Its log: workers/w{held.sequence}.log."
                )
        self.record["workersRun"].append(
            {"worker": held.sequence, "slot": held.slot, "phase": held.phase, "status": code}
        )

    # The loop ---------------------------------------------------------------------------------

    def _answer_waiting(self):
        for held in list(self.workers.values()):
            if held.waiting and self._hand_out(held):
                held.waiting = False
                self.broker.stop_waiting(held.phase)

    def _write_completed(self):
        for name, run in self.broker.take_completed():
            self._write_block(name, run)

    def _write_block(self, name: str, run, unfinished: str | None = None):
        info = self.phases[name]
        groups = []
        for group, state in run.groups.items():
            failure = state.failure
            if state.status not in ("finished", "failed"):
                failure = unfinished or "it never ran"
            groups.append(
                lane_blocks.group_record(
                    group=group,
                    fresh=state.queued.fresh,
                    collected=info.by_group.get(group, []),
                    outcomes=state.record.get("outcomes", {}),
                    worker=state.worker,
                    seconds=state.record.get("seconds"),
                    failure=failure,
                )
            )
        path = lane_blocks.block_dir(self.out, run.block.id) / lane_blocks.MANIFEST
        lane_blocks.write_json(path, lane_blocks.manifest(run.block, phase=name, shard=self.label, groups=groups))
        run.written = True

    def _done(self) -> bool:
        """Whether nothing can happen any more: no worker and no command runs after claiming and forking."""
        return not self.workers and not self.commands

    def _poll(self):
        poller = select.poll()
        handlers = {}
        for held in self.workers.values():
            for fd, handler in (
                (held.sock.fileno(), lambda held=held: self._read_channel(held)),
                (held.pidfd, lambda held=held: self._worker_ended(held)),
            ):
                poller.register(fd, select.POLLIN)
                handlers[fd] = handler
            if held.output is not None:
                poller.register(held.output, select.POLLIN)
                handlers[held.output] = lambda held=held: self._read_output(held)
        for command in self.commands:
            poller.register(command.group.fileno(), select.POLLIN)
            handlers[command.group.fileno()] = lambda command=command: self._command_ended(command)
        ready = poller.poll(int(POLL_SECONDS * 1000))
        # A worker's exit last, after what it wrote before it.
        ready.sort(key=lambda event: any(event[0] == held.pidfd for held in self.workers.values()))
        for fd, _ in ready:
            handler = handlers.get(fd)
            if handler is not None:
                handler()

    def _loop(self):
        swept = time.perf_counter()
        while True:
            self._start_claims()
            self._advance()
            self._answer_waiting()
            self._write_completed()
            if self._done():
                return
            self._poll()
            if time.perf_counter() - swept >= POLL_SECONDS:
                reap_strays(self._known())
                swept = time.perf_counter()

    def _known(self) -> set[int]:
        return {held.pid for held in self.workers.values()} | {command.group.group for command in self.commands}

    # Ending -------------------------------------------------------------------------------------

    def _shutdown(self):
        for held in list(self.workers.values()):
            try:
                os.killpg(held.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            self._worker_ended(held)
        for command in list(self.commands):
            command.group.stop()
            self.commands.remove(command)
        for _ in range(20):
            if not reap_strays(set()):
                break
        for name, phase in self.broker.phases.items():
            for run in phase.runs.values():
                if not run.written:
                    reason = self.stopping or self.broken.get(name) or "the server ended first"
                    self._write_block(name, run, unfinished=f"not run: {reason}")
        if self.restored:
            try:
                self._drop_databases()
            except BaseException as error:  # noqa: BLE001 - recorded, and the run's own outcome stands
                self.problems.append(f"Dropping the lane's databases failed: {error}")
        if self.classes is not None:
            shutil.rmtree(self.classes.parent, ignore_errors=True)

    def _drop_databases(self):
        """The template this server restored, and whatever a lost worker left under its slot's names."""
        import psycopg2
        from django.db import connections

        from proof.hq import database

        connections.close_all()
        database.drop_template()
        settings = connections["default"].settings_dict
        connection = psycopg2.connect(
            dbname=settings["TEST"]["NAME"],
            user=settings["USER"],
            password=settings["PASSWORD"],
            host=settings["HOST"],
            port=settings["PORT"],
        )
        connection.autocommit = True
        try:
            with connection.cursor() as cursor:
                for slot in range(1, self.k + 1):
                    namespace = f"proof_hq_w{self.base + slot}_"
                    cursor.execute("SELECT datname FROM pg_database WHERE starts_with(datname, %s)", [namespace])
                    for (name,) in cursor.fetchall():
                        cursor.execute(f'ALTER DATABASE "{name}" WITH IS_TEMPLATE false')
                        cursor.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        finally:
            connection.close()

    def _exit_code(self, interrupted: bool) -> int:
        if interrupted:
            return EXIT_INTERRUPTED
        if self.problems:
            return EXIT_BROKEN
        if self.failing:
            return EXIT_FAILED
        if not any(info.groups for info in self.phases.values()) and all(info.local for info in self.phases.values()):
            return EXIT_NOTHING
        return EXIT_PASSED

    def _summary(self, code: int):
        blocks = sum(1 for phase in self.broker.phases.values() for _ in phase.runs)
        say(f"Ran {blocks} blocks, {self.ran_items} items; {len(self.failing)} failed.")
        for node_id in self.failing[:30]:
            say(f"  failed: {node_id}")
        for problem in self.problems:
            say(f"Problem: {problem}")
        say(f"Exit status {code}; the run's record is {self.out / lane_blocks.SERVE}.")

    def run(self) -> int:
        signal.signal(signal.SIGTERM, _interrupt)
        signal.signal(signal.SIGINT, _interrupt)
        code = EXIT_PASSED
        interrupted = refused = False
        started = time.perf_counter()
        try:
            self._refuse_environment()
            self._prepare()
            self._plan()
            if self.options.collect_only:
                self.collect_only_code = int(pytest.main(self.phases["main"].args))
            else:
                self._loop()
        except Refused as error:
            refused = True
            self.problems.append(str(error))
        except Interrupted as error:
            interrupted = True
            self.problems.append(f"The server was interrupted ({error}).")
        except BaseException:
            self.problems.append("The server failed:\n" + traceback.format_exc())
        finally:
            # Ending is not interrupted: every process is stopped and reaped, and the record written.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                self._shutdown()
            finally:
                code = EXIT_REFUSED if refused else self._exit_code(interrupted)
                if self.collect_only_code is not None and not refused and not interrupted:
                    code = self.collect_only_code
                self.record["seconds"] = round(time.perf_counter() - started, 3)
                self.record["exit"] = code
                self.record["failing"] = self.failing
                lane_blocks.write_json(self.out / lane_blocks.SERVE, self.record)
                self._summary(code)
        return code


class _Collector:
    """The server's own collection of a phase: each item's group, and the collection's errors."""

    def __init__(self):
        self.groups: dict[str, str] = {}
        self.errors = 0

    @pytest.hookimpl(trylast=True)
    def pytest_collection_modifyitems(self, session, config, items):
        self.groups = {item.nodeid: sharding.item_group(item) for item in items}

    def pytest_collectreport(self, report):
        if report.failed:
            self.errors += 1


def _children() -> dict[int, list[int]]:
    """Every process's children, read from /proc."""
    children: dict[int, list[int]] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = Path("/proc", entry, "stat").read_text()
        except OSError:
            continue
        parent = int(stat[stat.rindex(")") + 2 :].split()[1])
        children.setdefault(parent, []).append(int(entry))
    return children


def reap_strays(known: set[int]) -> int:
    """Stop and reap every child of this process it does not know of, with their descendants; how many.

    A worker that dies leaves what it started (its JVM, its editor driver
    and Chromium) to this process, their subreaper; so does a command whose
    leader exits before its children.
    """
    tree = _children()
    strays = [pid for pid in tree.get(os.getpid(), []) if pid not in known]
    for stray in strays:
        stack, members = [stray], []
        while stack:
            pid = stack.pop()
            members.append(pid)
            stack.extend(tree.get(pid, []))
        for pid in members:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.waitpid(stray, 0)
        except ChildProcessError:
            pass
    return len(strays)


def _position(value: str):
    try:
        return sharding.parse_shard(value, "--bin")
    except sharding.ShardError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def parse_arguments(argv):
    if "--" in argv:
        split = argv.index("--")
        argv, pytest_args = argv[:split], argv[split + 1 :]
    else:
        pytest_args = []
    parser = argparse.ArgumentParser(prog="python -m proof.lane.serve", description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help="the run's output directory")
    parser.add_argument("--workers", type=int, default=1, help="how many workers run at once (default 1)")
    parser.add_argument("--label", default="local", help="this shard's name in its records (default local)")
    parser.add_argument("--early-queue", type=Path, help="the early queue: groups that need no corpus")
    parser.add_argument("--queue", type=Path, help="the main queue; with --wait-for, where it arrives")
    parser.add_argument("--claim", default="static", help="static, or a command claiming {block}")
    parser.add_argument(
        "--bin",
        type=_position,
        help="run bin I of N of the blocks (--claim static), or claim them first (a claim command)",
    )
    parser.add_argument("--wait-for", help="a command that exits 0 once the main queue and the corpus are in place")
    parser.add_argument(
        "--command-env",
        default="",
        type=lambda text: [name for name in text.split(",") if name],
        help="variables only the claim and wait commands see, comma-separated",
    )
    parser.add_argument(
        "--worker-base",
        type=int,
        default=0,
        help="lane positions start after this one: the server's databases are position N+1's (default 0)",
    )
    options = parser.parse_args(argv)
    options.pytest = pytest_args
    options.collect_only = any(arg in ("--collect-only", "--co") for arg in pytest_args)
    return options


def main(argv=None) -> int:
    options = parse_arguments(list(sys.argv[1:] if argv is None else argv))
    return Server(options).run()


if __name__ == "__main__":
    sys.exit(main())
