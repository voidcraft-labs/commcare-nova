"""The harness's only way to talk to CommCare Core.

`CoreRunner` compiles the runner's Java sources (proof/core/src) with JDK 17
against Core's recorded test classpath, starts one JVM, and exchanges one JSON
line per request and response with it. Every request carries a deadline the
JVM enforces; a request that outlives it fails, the JVM halts (Core cannot
interrupt an XPath evaluation), and the next request starts a fresh JVM.
Use it as a context manager so the JVM is shut down and joined on every exit
path.

A process that starts several runners compiles once: ``compile_runner(path)``
writes the classes into a directory, and each runner given that directory
(``classes=``, or ``PROOF_CORE_CLASSES`` for a runner over the runner's own
sources on the image's Core) starts its JVM from it without compiling, and
leaves it in place when it closes. The lane's server compiles before it
forks, so every worker's JVM runs the same classes.

The client is called inside HQ's operations, whose frozen clock stops
``time.monotonic`` (``proof.hq.determinism``), so every wait here is kept in C
or by ``time.perf_counter``: the JVM's lines arrive through a
``queue.SimpleQueue``, a process's exit is awaited on its pidfd, and javac
runs through ``proof.processes``.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from proof import processes

CORE_DIR = Path(os.environ.get("PROOF_CORE", "/opt/core"))
SOURCE_DIR = Path(__file__).resolve().parent / "src"
ANSWERS_PATH = Path(__file__).resolve().parent / "answers.json"
MAIN_CLASS = "nova.proof.core.Runner"
# Names a directory compile_runner wrote, which runners start from instead of compiling.
CLASSES_ENVIRONMENT = "PROOF_CORE_CLASSES"
MAIN_CLASS_FILE = Path(*MAIN_CLASS.split(".")).with_suffix(".class")
# A compile takes a few seconds; this bounds a javac that never finishes.
COMPILE_DEADLINE_SECONDS = 300
# javac's own JVM for one short compile: the serial collector and the client compiler alone. Sized by the
# machine's processors otherwise, its collector and compiler threads cost more CPU than the compile itself; the
# class files are the same.
JAVAC_OPTIONS = ("-J-XX:+UseSerialGC", "-J-XX:TieredStopAtLevel=1")
# The runner's exit status when it halts after a deadline (Runner.DEADLINE_EXIT).
DEADLINE_EXIT = 75
# How long the client waits past a request's own deadline before it stops a
# runner that has not answered at all.
CLIENT_GRACE_SECONDS = 30.0
STDERR_LIMIT = 256 * 1024
# The instant Core's clock reads (now(), today(), dow()) in every session and
# evaluation, unless a request names another (ProofClock).
DEFAULT_CLOCK = "2026-01-15T10:30:00.000Z"
# Core's clock reads an app's logic reaches: now() (XPathNowFunc.evalBody),
# today() (XPathTodayFunc.evalBody) and the dow() that suite XPath texts get
# (Text.evaluate). The runner compiles these three classes from Core's own
# source at the pinned checkout with that one expression replaced by the
# runner's clock, and puts them ahead of Core's classes on the classpath
# (ProofClock says why no other clock read reaches a trace).
CLOCK_READERS = (
    "org/javarosa/xpath/expr/XPathNowFunc.java",
    "org/javarosa/xpath/expr/XPathTodayFunc.java",
    "org/commcare/suite/model/Text.java",
)
CLOCK_READ = "new Date()"
CLOCK_REPLACEMENT = "nova.proof.core.ProofClock.now()"

DEFAULT_MAX_HEAP = "1g"
# The JVM's locale and zone are fixed so Core's case-insensitive search and its
# date arithmetic do not depend on the machine (EntityStringFilterer lower-cases
# with Locale.getDefault(); DateUtils reads the default zone). HotSpot writes its
# own messages (an out-of-memory exit, VM warnings) to standard output unless
# told otherwise, and standard output is the protocol, so they go to stderr.
# The serial collector and the client compiler alone keep the runner's CPU at
# what its requests need: a lane worker's runner serves a few documents, and
# the optimizing compiler's work for them costs more CPU than it saves.
# Neither changes what a request computes.
JVM_OPTIONS = (
    "-XX:+ExitOnOutOfMemoryError",
    "-XX:+DisplayVMOutputToStderr",
    "-XX:+UseSerialGC",
    "-XX:TieredStopAtLevel=1",
    "-Duser.timezone=UTC",
    "-Duser.language=en",
    "-Duser.country=US",
    "-Dfile.encoding=UTF-8",
)


class CoreRunnerError(Exception):
    """A request the runner refused or could not complete."""

    def __init__(self, message: str, *, kind: str = "internal", log: str = "", detail: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.kind = kind
        self.log = log
        self.detail = dict(detail or {})


class CoreRunnerStartError(CoreRunnerError):
    """The runner's sources did not compile, or its JVM did not come up."""


class CoreDeadlineError(CoreRunnerError):
    """A request outlived its deadline; the JVM that ran it has halted."""


class _Silence:
    """What the client reads when the JVM writes nothing before a wait runs out."""


SILENCE = _Silence()


@dataclass
class Timings:
    """Measured costs, in seconds, for the proof lane's time budget."""

    compile: float | None = None
    starts: list[float] = field(default_factory=list)


@dataclass(frozen=True)
class AppHandle:
    """An archive the runner admitted, valid only in the JVM that admitted it."""

    handle: str
    generation: int


class CoreRunner:
    """One Core runner JVM for a test session."""

    def __init__(
        self,
        *,
        core_dir: Path = CORE_DIR,
        source_dir: Path = SOURCE_DIR,
        start_timeout: float = 120.0,
        max_heap: str = DEFAULT_MAX_HEAP,
        classes: Path | str | None = None,
    ):
        self._core_dir = Path(core_dir)
        self._source_dir = Path(source_dir)
        self._start_timeout = start_timeout
        self._max_heap = max_heap
        if classes is None and Path(source_dir) == SOURCE_DIR and Path(core_dir) == CORE_DIR:
            # The process's compiled classes are of these sources on this Core; a runner over others compiles.
            classes = os.environ.get(CLASSES_ENVIRONMENT) or None
        self._given_classes = Path(classes) if classes is not None else None
        self._work: Path | None = None
        self._classes: Path | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._stdout_lines: queue.SimpleQueue[bytes | None] | None = None
        self._threads: list[threading.Thread] = []
        self._stderr = bytearray()
        self._stderr_lock = threading.Lock()
        self._next_id = 1
        self._generation = 0
        self.ready: dict[str, Any] | None = None
        self.timings = Timings()
        self.restarts = 0
        self.last_log = ""

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> CoreRunner:
        try:
            self.start()
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def start(self) -> None:
        """Compiles the runner (once, unless given its classes) and starts its JVM, raising when either fails."""
        if self._work is None:
            self._work = Path(tempfile.mkdtemp(prefix="proof-core-"))
        if self._classes is None:
            if self._given_classes is not None:
                self._classes = given_classes(self._given_classes)
            else:
                classes = self._work / "classes"
                self.timings.compile = compile_runner(classes, core_dir=self._core_dir, source_dir=self._source_dir)
                self._classes = classes
        if self._process is None:
            self._launch()

    @property
    def temporary(self) -> Path:
        """The directory the runner's JVM writes its temporary files in (``java.io.tmpdir``)."""
        assert self._work is not None
        directory = self._work / "tmp"
        directory.mkdir(exist_ok=True)
        return directory

    @property
    def classpath(self) -> str:
        return test_classpath(self._core_dir)

    def _launch(self) -> None:
        assert self._work is not None and self._classes is not None
        command = [
            "java",
            f"-Xmx{self._max_heap}",
            *JVM_OPTIONS,
            f"-Dnova.proof.core={self._core_dir}",
            # The runner's own temporary files (a directory admitted through a
            # temporary archive, Admission.java) stay in its own work
            # directory, apart from every other runner's in the container.
            f"-Djava.io.tmpdir={self.temporary}",
            "-cp",
            f"{self._classes}{os.pathsep}{self.classpath}",
            MAIN_CLASS,
        ]
        started = time.perf_counter()
        with self._stderr_lock:
            self._stderr.clear()
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self._work,
            )
        except OSError as error:
            raise CoreRunnerStartError(f"The Core runner could not start java: {error}.") from error
        lines: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
        self._process = process
        self._stdout_lines = lines
        self._threads = [
            threading.Thread(target=self._pump_stdout, args=(process, lines), name="core-runner-stdout", daemon=True),
            threading.Thread(target=self._pump_stderr, args=(process,), name="core-runner-stderr", daemon=True),
        ]
        for thread in self._threads:
            thread.start()
        line = self._next_line(self._start_timeout)
        try:
            ready = json.loads(line) if isinstance(line, bytes) else None
        except ValueError:  # not JSON, or not UTF-8
            ready = None
        if not isinstance(ready, dict) or ready.get("ready") is not True:
            self._stop_process()
            raise CoreRunnerStartError(
                f"The Core runner's JVM did not announce itself ready (it wrote {line!r}). Its stderr:\n{self.stderr}"
            )
        self._generation += 1
        self.ready = ready
        self.timings.starts.append(time.perf_counter() - started)

    @staticmethod
    def _pump_stdout(process: subprocess.Popen[bytes], lines: queue.SimpleQueue[bytes | None]) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    def _pump_stderr(self, process: subprocess.Popen[bytes]) -> None:
        assert process.stderr is not None
        for chunk in process.stderr:
            with self._stderr_lock:
                self._stderr.extend(chunk)
                if len(self._stderr) > STDERR_LIMIT:
                    del self._stderr[: len(self._stderr) - STDERR_LIMIT]

    @property
    def process(self) -> subprocess.Popen[bytes] | None:
        """The current JVM, or None when none is running."""
        return self._process

    @property
    def reader_threads(self) -> tuple[threading.Thread, ...]:
        """The threads reading the current JVM's stdout and stderr."""
        return tuple(self._threads)

    @property
    def classes_dir(self) -> Path | None:
        """Where the runner's compiled classes are, once compiled or given."""
        return self._classes

    @property
    def stderr(self) -> str:
        with self._stderr_lock:
            return self._stderr.decode("utf-8", "replace")

    @property
    def alive(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _next_line(self, timeout: float) -> bytes | None | _Silence:
        """The JVM's next stdout line; None when its stdout closed; SILENCE when it wrote nothing in time."""
        assert self._stdout_lines is not None
        try:
            return self._stdout_lines.get(timeout=timeout)
        except queue.Empty:
            return SILENCE

    def _stop_process(self, *, kill: bool = True) -> int | None:
        """Ends the current JVM (killing it when asked) and joins its reader threads."""
        process = self._process
        if process is None:
            return None
        if kill and process.poll() is None:
            process.kill()
        if not exited_within(process, 30):
            process.kill()
        returncode = process.wait()
        for thread in self._threads:
            thread.join(timeout=30)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        self._process = None
        self._stdout_lines = None
        self._threads = []
        return returncode

    def close(self) -> None:
        """Shuts the JVM down, joins it and its reader threads, and removes the compiled classes."""
        try:
            if self.alive:
                try:
                    self._send({"op": "shutdown"}, deadline=10.0)
                except CoreRunnerError:
                    pass
            if self._process is not None:
                exited_within(self._process, 30)
            self._stop_process()
        finally:
            if self._work is not None:
                shutil.rmtree(self._work, ignore_errors=True)
                self._work = None
                self._classes = None

    # -- requests ----------------------------------------------------------

    def request(self, op: str, *, deadline: float, **args: Any) -> dict[str, Any]:
        """Sends one request and returns its result, starting a fresh JVM first when the last one halted."""
        if self._work is None or self._classes is None:
            raise CoreRunnerError("The Core runner is not started; use it as a context manager or call start().")
        if not self.alive:
            if self._process is not None:
                self._stop_process()
            self._launch()
            self.restarts += 1
        return self._send({"op": op, **args}, deadline=deadline)

    def _send(self, message: dict[str, Any], *, deadline: float) -> dict[str, Any]:
        process = self._process
        assert process is not None and process.stdin is not None
        request_id = self._next_id
        self._next_id += 1
        op = message["op"]
        line = json.dumps({"id": request_id, "deadlineMs": max(1, int(deadline * 1000)), **message})
        try:
            process.stdin.write(line.encode("utf-8") + b"\n")
            process.stdin.flush()
        except OSError as error:
            returncode = self._stop_process()
            raise CoreRunnerError(
                f"The Core runner's JVM stopped before it read the {op} request (exit status {returncode})."
                f" Its stderr:\n{self.stderr}"
            ) from error
        answer = self._next_line(deadline + CLIENT_GRACE_SECONDS)
        if answer is SILENCE:
            self._stop_process()
            raise CoreDeadlineError(
                f"The Core runner did not answer the {op} request within its deadline of {deadline} s plus"
                f" {CLIENT_GRACE_SECONDS} s, so the client stopped it.",
                kind="deadline",
            )
        if answer is None:
            returncode = self._stop_process(kill=False)
            raise CoreRunnerError(
                f"The Core runner's JVM exited (status {returncode}) while answering the {op} request."
                f" Its stderr:\n{self.stderr}"
            )
        assert isinstance(answer, bytes)
        try:
            response = json.loads(answer)
        except ValueError:  # not JSON, or not UTF-8
            response = None
        if not isinstance(response, dict):
            self._stop_process()
            raise CoreRunnerError(
                f"The Core runner answered the {op} request with a line that is not a JSON object:"
                f" {answer[:2000]!r}. Something in the JVM wrote to the protocol stream, so the client stopped"
                f" it; the next request starts a fresh one. Its stderr:\n{self.stderr}"
            )
        if response.get("id") != request_id:
            self._stop_process()
            raise CoreRunnerError(
                f"The Core runner answered request {response.get('id')!r} while the client waited for"
                f" {request_id}; the protocol is out of step, so the client stopped the JVM."
            )
        self.last_log = response.get("log", "")
        if response.get("ok"):
            return response["result"]
        error = response.get("error") or {}
        kind = error.get("kind", "internal")
        message_text = error.get("message", "The Core runner refused the request without a message.")
        if kind == "deadline":
            self._stop_process(kill=False)
            raise CoreDeadlineError(message_text, kind=kind, log=self.last_log, detail=error)
        raise CoreRunnerError(message_text, kind=kind, log=self.last_log, detail=error)

    # -- operations --------------------------------------------------------

    def validate_form(self, xml: bytes, *, deadline: float = 60.0) -> str:
        """Formplayer's validate_form response body for these form bytes, exactly as Formplayer writes it."""
        result = self.request("validateForm", deadline=deadline, xmlBase64=base64.b64encode(xml).decode("ascii"))
        return result["report"]

    def admit(
        self, path: Path | str, *, platform_version: str | None = None, deadline: float = 180.0
    ) -> dict[str, Any]:
        """Admits a .ccz, or a directory holding an archive's entries, and returns Core's admission report.

        The report's "app" is an AppHandle when the archive was admitted. The
        JVM reads the archive itself, so where the evidence store guards an
        observation (``proof.store.guard``, imported only by a store that
        observes), its open scope holds ``path`` first, as if this process
        read it.
        """
        guard = sys.modules.get("proof.store.guard")
        if guard is not None:
            guard.named(path)
        args: dict[str, Any] = {"path": str(path)}
        if platform_version is not None:
            args["platformVersion"] = platform_version
        report = self.request("admit", deadline=deadline, **args)
        handle = report.get("appHandle")
        report["app"] = AppHandle(handle, self._generation) if handle else None
        return report

    def release(self, app: AppHandle, *, deadline: float = 30.0) -> None:
        self._require_current(app)
        self.request("release", deadline=deadline, appHandle=app.handle)

    def session(
        self,
        app: AppHandle,
        *,
        restore: bytes,
        answer_table: Mapping[str, Any] | None = None,
        script: Sequence[Mapping[str, Any]] | None = None,
        question_kinds: Mapping[str, str] | None = None,
        locale: str | None = None,
        clock: str = DEFAULT_CLOCK,
        after_submit: bool = False,
        deadline: float = 600.0,
    ) -> dict[str, Any]:
        """Runs scripted sessions over the admitted app and returns their trace.

        Without a script the runner derives one from the app (every menu command,
        every reachable form with the first entity of each list); the trace
        records the script it ran, so the same script can replay on another build.
        With ``after_submit``, each submitted form's ``stackAfterSubmit`` also
        holds ``next``: what Core's session needs for the frame the submission
        left it, and the form it opens where it needs nothing (``FormRun.next``).
        """
        self._require_current(app)
        args: dict[str, Any] = {
            "appHandle": app.handle,
            "restoreBase64": base64.b64encode(restore).decode("ascii"),
            "answerTable": dict(answer_table) if answer_table is not None else load_answer_table(),
            "clock": clock,
        }
        if script is not None:
            args["script"] = list(script)
        if question_kinds is not None:
            args["questionKinds"] = dict(question_kinds)
        if locale is not None:
            args["locale"] = locale
        if after_submit:
            args["afterSubmit"] = True
        return self.request("session", deadline=deadline, **args)

    def evaluate(self, *, deadline: float = 120.0, app: AppHandle | None = None, **args: Any) -> dict[str, Any]:
        """Opens a form or a case list with the given session and case data and reports what Core computes."""
        if app is not None:
            self._require_current(app)
            args["appHandle"] = app.handle
        args.setdefault("clock", DEFAULT_CLOCK)
        return self.request("evaluate", deadline=deadline, **args)

    def holds(self, app: AppHandle) -> bool:
        """Whether the running JVM is the one that admitted this app."""
        return app.generation == self._generation and self.alive

    def _require_current(self, app: AppHandle) -> None:
        if not self.holds(app):
            raise CoreRunnerError(
                f"App {app.handle} was admitted by a Core runner JVM that has since restarted; admit the archive"
                " again in this one.",
                kind="request",
            )


def exited_within(process: subprocess.Popen, timeout: float) -> bool:
    """Whether ``process`` exits within ``timeout`` seconds, awaited on its pidfd (a wait in C); it stays unreaped."""
    if process.returncode is not None:
        return True
    descriptor = os.pidfd_open(process.pid)
    try:
        poller = select.poll()
        poller.register(descriptor, select.POLLIN)
        return bool(poller.poll(max(0, int(timeout * 1000))))
    finally:
        os.close(descriptor)


def test_classpath(core_dir: Path = CORE_DIR) -> str:
    """Core's test runtime classpath, as the proof image recorded it when it compiled Core."""
    recorded = Path(core_dir) / "proof-test-classpath.txt"
    try:
        return recorded.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise CoreRunnerStartError(
            f"The Core runner needs Core's recorded test classpath at {recorded}, which it could not read"
            f" ({error}). It is written when the proof image compiles Core."
        ) from error


def _clock_readers(core_dir: Path, work: Path) -> list[str]:
    """Core's clock-reading classes, from Core's source, reading the runner's clock instead."""
    written = []
    for relative in CLOCK_READERS:
        original = Path(core_dir) / "src" / "main" / "java" / relative
        try:
            text = original.read_text(encoding="utf-8")
        except OSError as error:
            raise CoreRunnerStartError(
                f"The Core runner freezes the clock by recompiling {original}, which it could not read ({error})."
            ) from error
        if text.count(CLOCK_READ) != 1:
            raise CoreRunnerStartError(
                f"The Core runner expects Core's {relative} to read the clock with exactly one"
                f" `{CLOCK_READ}`, and it has {text.count(CLOCK_READ)}. Core's clock changed at this pin;"
                " revisit ProofClock before trusting a trace."
            )
        target = work / "clock" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text.replace(CLOCK_READ, CLOCK_REPLACEMENT), encoding="utf-8")
        written.append(str(target))
    return written


def compile_runner(classes: Path, *, core_dir: Path = CORE_DIR, source_dir: Path = SOURCE_DIR) -> float:
    """Compile the runner's sources, with Core's clock readers reading its clock, into ``classes``; its seconds.

    ``classes`` must not exist yet: it is made here, so it holds only this
    compile's output.
    """
    classes = Path(classes)
    sources = sorted(str(path) for path in Path(source_dir).rglob("*.java"))
    if not sources:
        raise CoreRunnerStartError(f"The Core runner found no Java sources under {source_dir}.")
    classpath = test_classpath(core_dir)
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="proof-core-compile-") as scratch:
        work = Path(scratch)
        sources += _clock_readers(core_dir, work)
        classes.mkdir(parents=True)
        log = work / "javac.log"
        try:
            with log.open("wb") as output:
                status = processes.run(
                    ["javac", *JAVAC_OPTIONS, "-encoding", "UTF-8", "-d", str(classes), "-cp", classpath, *sources],
                    timeout=COMPILE_DEADLINE_SECONDS,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                )
        except (OSError, processes.TimedOut) as error:
            raise CoreRunnerStartError(f"The Core runner could not run javac: {error}") from error
        if status != 0:
            raise CoreRunnerStartError(
                "The Core runner's sources did not compile against Core's test classpath:\n"
                + log.read_text(encoding="utf-8", errors="replace")
            )
    return time.perf_counter() - started


def given_classes(classes: Path) -> Path:
    """``classes``, a directory compile_runner wrote, or the refusal naming what it lacks."""
    if not (Path(classes) / MAIN_CLASS_FILE).is_file():
        raise CoreRunnerStartError(
            f"The Core runner was given its compiled classes at {classes} ({CLASSES_ENVIRONMENT}), and"
            f" {MAIN_CLASS_FILE} is not there. Compile them with proof.core.client.compile_runner, or leave"
            f" {CLASSES_ENVIRONMENT} unset to have each runner compile its own."
        )
    return Path(classes)


def load_answer_table(path: Path = ANSWERS_PATH) -> dict[str, Any]:
    """The fixed answer table sessions answer questions from (proof/core/answers.json)."""
    return json.loads(path.read_text(encoding="utf-8"))
