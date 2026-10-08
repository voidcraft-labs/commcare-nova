"""The harness's only way to talk to Formplayer.

`FormplayerRunner` starts Formplayer's whole Spring application in one JVM
(proof/formplayer/src: ``Runner`` calls Formplayer's own
``org.commcare.formplayer.Application.main``) on the classes and libraries of
Formplayer's boot jar in its launcher's order (proof/image/formplayer/build.sh
writes them to ``/opt/formplayer-app``), and exchanges JSON lines with it as
the Core runner's client does (proof/core/client.py). Formplayer gets what it
runs on in production:

- **Postgres**: a database of its own on the lane's Postgres, made here and
  migrated by Formplayer's own Flyway migrations when it starts, dropped when
  the runner closes;
- **Redis**: a real ``redis-server`` this runner starts and stops, on a
  loopback address of its own (Formplayer's configuration names Redis by host
  alone, ``redis.hostname``, so each runner's server has its own address at
  Redis's port and no two runners share one);
- **CommCare HQ**: the one address that is not production's. The runner's
  ``HqPeer`` is ``commcarehq.host``, and every request Formplayer makes of HQ
  comes back here as a protocol line that ``hq`` (a callable the caller gives)
  answers, each one recorded in ``Exchange.hq``. Formplayer runs in its own
  ``replace-host`` mode (``formplayer.externalRequestMode``,
  ``RewriteHostRequestInterceptor``), so the URLs an app itself names (its
  submission URL, a search's, a claim's) reach the peer too.

Every request to Formplayer is one HTTP request to its own web server
(``http``), so its filters, security chain, aspects, controllers and JSON
serialization all run. A request that outlives its deadline halts the JVM and
the next request starts a fresh one.

The client is called inside HQ's operations, whose frozen clock stops
``time.monotonic``, so every wait here is kept in C or by
``time.perf_counter``, as the Core runner's are.
"""

from __future__ import annotations

import base64
import itertools
import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from proof import processes
from proof.core.client import (
    CLIENT_GRACE_SECONDS,
    CLOCK_READ,
    CLOCK_READERS,
    COMPILE_DEADLINE_SECONDS,
    DEFAULT_CLOCK,
    JAVAC_OPTIONS,
    JVM_OPTIONS,
    SILENCE,
    STDERR_LIMIT,
    exited_within,
)

FORMPLAYER_DIR = Path(os.environ.get("PROOF_FORMPLAYER", "/opt/formplayer"))
APPLICATION_DIR = Path(os.environ.get("PROOF_FORMPLAYER_APP", "/opt/formplayer-app"))
SOURCE_DIR = Path(__file__).resolve().parent / "src"
MAIN_CLASS = "nova.proof.formplayer.Runner"
MAIN_CLASS_FILE = Path(*MAIN_CLASS.split(".")).with_suffix(".class")
# Names a directory compile_runner wrote, which runners start from instead of compiling.
CLASSES_ENVIRONMENT = "PROOF_FORMPLAYER_CLASSES"
CLOCK_REPLACEMENT = "nova.proof.formplayer.ProofClock.now()"
# Spring Boot offers the application it starts to every listener a spring.factories on the classpath names
# (Started.java says why the runner has one).
SPRING_FACTORIES = "org.springframework.context.ApplicationListener=nova.proof.formplayer.Started\n"
# Formplayer's start: Flyway's migrations, Hibernate's validation of them, and the web server.
START_TIMEOUT_SECONDS = 300.0
DEFAULT_MAX_HEAP = "1g"
# The key HQ and Formplayer share (commcarehq.formplayerAuthKey): Formplayer signs its session-details request
# with it, and HQ signs what it asks Formplayer. Its value is the harness's own; nothing outside the lane holds it.
AUTH_KEY = "proof-lane-formplayer-key"
# The lane's Postgres, as proof/compose.yaml names it.
POSTGRES_HOST = os.environ.get("PROOF_POSTGRES_HOST", "postgres")
POSTGRES_PORT = os.environ.get("PROOF_POSTGRES_PORT", "5432")
POSTGRES_USER = "commcarehq"
POSTGRES_PASSWORD = "commcarehq"
POSTGRES_MAINTENANCE_DATABASE = "commcarehq"
REDIS_READY = b"Ready to accept connections"
REDIS_START_SECONDS = 30.0
# Loopback addresses a runner's Redis is tried on, in order from the one its process id names.
REDIS_ADDRESSES = 200
# Numbers the databases this process's runners make.
_DATABASES = itertools.count(1)


class FormplayerRunnerError(Exception):
    """A request the runner refused or could not complete."""

    def __init__(self, message: str, *, kind: str = "internal", log: str = "", detail: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.kind = kind
        self.log = log
        self.detail = dict(detail or {})


class FormplayerStartError(FormplayerRunnerError):
    """The runner's sources did not compile, or Formplayer, its database or its Redis did not come up."""


class FormplayerDeadlineError(FormplayerRunnerError):
    """A request outlived its deadline; the JVM that ran it has halted."""


@dataclass(frozen=True)
class HqRequest:
    """One request Formplayer made of HQ, as the peer read it."""

    method: str
    path: str
    query: str
    headers: tuple[tuple[str, str], ...]
    body: bytes

    def header(self, name: str) -> str | None:
        for key, value in self.headers:
            if key.lower() == name.lower():
                return value
        return None


@dataclass(frozen=True)
class HqAnswer:
    """What HQ answers one of Formplayer's requests with."""

    status: int
    body: bytes = b""
    headers: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class Response:
    """Formplayer's answer to one HTTP request."""

    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)

    def header_values(self, name: str) -> list[str]:
        return [value for key, value in self.headers if key.lower() == name.lower()]


@dataclass(frozen=True)
class Exchange:
    """One request to Formplayer: its answer, each request it made of HQ with HQ's answer, and its log."""

    response: Response
    hq: tuple[tuple[HqRequest, HqAnswer], ...]
    log: str


HqHandler = Callable[[HqRequest], HqAnswer]


@dataclass
class Timings:
    """Measured costs, in seconds, for the proof lane's time budget."""

    compile: float | None = None
    database: list[float] = field(default_factory=list)
    redis: list[float] = field(default_factory=list)
    starts: list[float] = field(default_factory=list)


def refuse_hq(request: HqRequest) -> HqAnswer:
    """The handler of a runner given none: Formplayer asking HQ for anything is the caller's mistake."""
    raise FormplayerRunnerError(
        f"Formplayer asked HQ for {request.method} {request.path}, and this runner was given nothing to answer HQ's"
        " requests with. Give FormplayerRunner.http an `hq` handler that answers what the request needs.",
        kind="request",
    )


class FormplayerRunner:
    """One Formplayer for a test session: its JVM, its database and its Redis."""

    def __init__(
        self,
        *,
        formplayer_dir: Path = FORMPLAYER_DIR,
        application_dir: Path = APPLICATION_DIR,
        source_dir: Path = SOURCE_DIR,
        start_timeout: float = START_TIMEOUT_SECONDS,
        max_heap: str = DEFAULT_MAX_HEAP,
        classes: Path | str | None = None,
    ):
        self._formplayer_dir = Path(formplayer_dir)
        self._application_dir = Path(application_dir)
        self._source_dir = Path(source_dir)
        self._start_timeout = start_timeout
        self._max_heap = max_heap
        if classes is None and Path(source_dir) == SOURCE_DIR and Path(formplayer_dir) == FORMPLAYER_DIR:
            classes = os.environ.get(CLASSES_ENVIRONMENT) or None
        self._given_classes = Path(classes) if classes is not None else None
        self._work: Path | None = None
        self._classes: Path | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._stdout_lines: queue.SimpleQueue[bytes | None] | None = None
        self._threads: list[threading.Thread] = []
        self._stderr = bytearray()
        self._stderr_lock = threading.Lock()
        self._redis: processes.ProcessGroup | None = None
        self._redis_address: str | None = None
        self._redis_log: Path | None = None
        self._database: str | None = None
        self._next_id = 1
        self._next_seed = 1
        self.ready: dict[str, Any] | None = None
        self.timings = Timings()
        self.restarts = 0
        self.last_log = ""

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> FormplayerRunner:
        try:
            self.start()
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def start(self) -> None:
        """Compiles the runner (once, unless given its classes), makes its database, starts its Redis and its JVM."""
        if self._work is None:
            self._work = Path(tempfile.mkdtemp(prefix="proof-formplayer-"))
        if self._classes is None:
            if self._given_classes is not None:
                self._classes = given_classes(self._given_classes)
            else:
                classes = self._work / "classes"
                self.timings.compile = compile_runner(
                    classes,
                    formplayer_dir=self._formplayer_dir,
                    application_dir=self._application_dir,
                    source_dir=self._source_dir,
                )
                self._classes = classes
        if self._process is None:
            self._launch()

    @property
    def alive(self) -> bool:
        return self._process is not None and self._process.poll() is None

    @property
    def process(self) -> subprocess.Popen[bytes] | None:
        """The current JVM, or None when none is running."""
        return self._process

    @property
    def redis_process(self) -> processes.ProcessGroup | None:
        """The current Redis, or None when none is running."""
        return self._redis

    @property
    def redis_address(self) -> str | None:
        """The loopback address of the current Redis, which HQ shares with Formplayer as in production
        (``proof.hq.redis.adopt``); None when none is running."""
        return self._redis_address

    @property
    def reader_threads(self) -> tuple[threading.Thread, ...]:
        return tuple(self._threads)

    @property
    def stderr(self) -> str:
        with self._stderr_lock:
            return self._stderr.decode("utf-8", "replace")

    def _launch(self) -> None:
        """A fresh Formplayer over a fresh database and a fresh Redis: nothing of an earlier one's state."""
        assert self._work is not None and self._classes is not None
        self._stop_services()
        state = self._work / f"state-{self.restarts}"
        shutil.rmtree(state, ignore_errors=True)
        (state / "tmp").mkdir(parents=True)
        started = time.perf_counter()
        # A name no other runner of this process, and no other process, makes: two runners of one process (a
        # test's own beside the session's) must never take each other's database.
        self._database = make_database(f"formplayer_{os.getpid()}_{next(_DATABASES)}")
        self.timings.database.append(time.perf_counter() - started)
        started = time.perf_counter()
        self._start_redis(state)
        self.timings.redis.append(time.perf_counter() - started)
        command = [
            "java",
            f"-Xmx{self._max_heap}",
            *JVM_OPTIONS,
            f"-Dnova.proof.formplayer={self._formplayer_dir}",
            f"-Djava.io.tmpdir={state / 'tmp'}",
            # Formplayer's configuration, by the names its application.properties reads from the environment.
            f"-DAUTH_KEY={AUTH_KEY}",
            f"-DPOSTGRESQL_HOST={POSTGRES_HOST}",
            f"-DPOSTGRESQL_PORT={POSTGRES_PORT}",
            f"-DPOSTGRESQL_DATABASE={self._database}",
            f"-DPOSTGRESQL_USERNAME={POSTGRES_USER}",
            # Formplayer's own spelling of the name (application.properties).
            f"-DPOSTGRESQL_PASSWROD={POSTGRES_PASSWORD}",
            f"-DREDIS_HOSTNAME={self._redis_address}",
            "-DEXTERNAL_REQUEST_MODE=replace-host",
            # Its SQLite sandboxes (each user's restore, each installed app) live under the runner's state.
            f"-Dsqlite.dataDir={state / 'dbs'}/",
            f"-Dsqlite.tmpDataDir={state / 'tmp_dbs'}/",
            # Formplayer's actuator endpoints bind a second, fixed port in production; the lane reads none of them.
            "-Dmanagement.server.port=-1",
            "-cp",
            f"{self._classes}{os.pathsep}{application_classpath(self._application_dir)}",
            MAIN_CLASS,
        ]
        started = time.perf_counter()
        with self._stderr_lock:
            self._stderr.clear()
        try:
            process = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=state
            )
        except OSError as error:
            self._stop_services()
            raise FormplayerStartError(f"The Formplayer runner could not start java: {error}.") from error
        lines: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
        self._process = process
        self._stdout_lines = lines
        self._threads = [
            threading.Thread(target=self._pump_stdout, args=(process, lines), name="formplayer-stdout", daemon=True),
            threading.Thread(target=self._pump_stderr, args=(process,), name="formplayer-stderr", daemon=True),
        ]
        for thread in self._threads:
            thread.start()
        line = self._next_line(self._start_timeout)
        try:
            ready = json.loads(line) if isinstance(line, bytes) else None
        except ValueError:
            ready = None
        if not isinstance(ready, dict) or ready.get("ready") is not True:
            self._stop_process()
            self._stop_services()
            shown = line[:2000] if isinstance(line, bytes) else line
            raise FormplayerStartError(
                f"Formplayer did not come up within {self._start_timeout} s (the runner wrote {shown!r} in place of"
                f" its ready line). Its stderr, where a failed start writes Formplayer's own log:\n{self.stderr}"
            )
        self.ready = ready
        self.last_log = ready.get("log", "")
        self._next_seed = 1
        self.timings.starts.append(time.perf_counter() - started)

    def _start_redis(self, state: Path) -> None:
        """A real redis-server of this runner's own, on the first loopback address that is free at Redis's port."""
        data = state / "redis"
        data.mkdir()
        log = state / "redis.log"
        tried = []
        for offset in range(REDIS_ADDRESSES):
            # 127.0.1.2 to 127.0.200.201: every address of 127/8 is the machine's own on Linux.
            slot = (os.getpid() + offset) % (REDIS_ADDRESSES * 200)
            address = f"127.0.{slot // 200 + 1}.{slot % 200 + 2}"
            with log.open("wb") as output:
                group = processes.ProcessGroup(
                    [
                        "redis-server",
                        "--bind",
                        address,
                        "--port",
                        "6379",
                        "--protected-mode",
                        "yes",
                        "--save",
                        "",
                        "--appendonly",
                        "no",
                        "--dir",
                        str(data),
                    ],
                    stdout=output,
                    stderr=subprocess.STDOUT,
                )
            waited = time.perf_counter()
            while time.perf_counter() - waited < REDIS_START_SECONDS:
                if REDIS_READY in log.read_bytes():
                    self._redis, self._redis_address, self._redis_log = group, address, log
                    return
                if group.wait(0.05):
                    break
            group.stop()
            tried.append(f"{address}: {log.read_text(encoding='utf-8', errors='replace')[-400:]}")
            if b"Address already in use" not in log.read_bytes():
                break
        raise FormplayerStartError(
            "The Formplayer runner could not start a redis-server of its own. What each try wrote:\n"
            + "\n".join(tried)
            + "\nThe proof image installs redis-server; check that this image has it."
        )

    def _stop_services(self) -> None:
        if self._redis is not None:
            self._redis.stop()
            self._redis = None
            self._redis_address = None
        if self._database is not None:
            drop_database(self._database)
            self._database = None

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

    def _next_line(self, timeout: float):
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
        """Ends the JVM (closing its stdin ends the runner), its Redis and its database, and removes its files."""
        try:
            process = self._process
            if process is not None and process.poll() is None and process.stdin is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
                exited_within(process, 30)
            self._stop_process()
        finally:
            try:
                self._stop_services()
            finally:
                if self._work is not None:
                    shutil.rmtree(self._work, ignore_errors=True)
                    self._work = None
                    self._classes = None

    # -- requests ----------------------------------------------------------

    def _write(self, message: dict[str, Any], what: str) -> None:
        process = self._process
        assert process is not None and process.stdin is not None
        try:
            process.stdin.write(json.dumps(message).encode("utf-8") + b"\n")
            process.stdin.flush()
        except OSError as error:
            returncode = self._stop_process()
            raise FormplayerRunnerError(
                f"The Formplayer runner's JVM stopped before it read {what} (exit status {returncode})."
                f" Its stderr:\n{self.stderr}"
            ) from error

    def request(
        self, op: str, *, deadline: float, hq: HqHandler = refuse_hq, **args: Any
    ) -> tuple[dict[str, Any], list[tuple[HqRequest, HqAnswer]]]:
        """Sends one request, answers each request Formplayer makes of HQ while it runs, and returns its result."""
        if self._work is None or self._classes is None:
            raise FormplayerRunnerError(
                "The Formplayer runner is not started; use it as a context manager or call start()."
            )
        if not self.alive:
            if self._process is not None:
                self._stop_process()
            self.restarts += 1
            self._launch()
        request_id = self._next_id
        self._next_id += 1
        self._write({"id": request_id, "op": op, "deadlineMs": max(1, int(deadline * 1000)), **args}, f"the {op}")
        asked: list[tuple[HqRequest, HqAnswer]] = []
        while True:
            answer = self._next_line(deadline + CLIENT_GRACE_SECONDS)
            if answer is SILENCE:
                self._stop_process()
                raise FormplayerDeadlineError(
                    f"The Formplayer runner did not answer the {op} request within its deadline of {deadline} s plus"
                    f" {CLIENT_GRACE_SECONDS} s, so the client stopped it.",
                    kind="deadline",
                )
            if answer is None:
                returncode = self._stop_process(kill=False)
                raise FormplayerRunnerError(
                    f"The Formplayer runner's JVM exited (status {returncode}) while answering the {op} request."
                    f" Its stderr:\n{self.stderr}"
                )
            assert isinstance(answer, bytes)
            try:
                response = json.loads(answer)
            except ValueError:
                response = None
            if not isinstance(response, dict):
                self._stop_process()
                raise FormplayerRunnerError(
                    f"The Formplayer runner answered the {op} request with a line that is not a JSON object:"
                    f" {answer[:2000]!r}. Something in the JVM wrote to the protocol stream, so the client stopped"
                    " it; the next request starts a fresh one."
                )
            if "hq" in response and "request" in response:
                asked.append(self._answer_hq(response, hq))
                continue
            if response.get("id") != request_id:
                self._stop_process()
                raise FormplayerRunnerError(
                    f"The Formplayer runner answered request {response.get('id')!r} while the client waited for"
                    f" {request_id}; the protocol is out of step, so the client stopped the JVM."
                )
            self.last_log = response.get("log", "")
            if response.get("ok"):
                return response["result"], asked
            error = response.get("error") or {}
            kind = error.get("kind", "internal")
            message = error.get("message", "The Formplayer runner refused the request without a message.")
            if kind == "deadline":
                self._stop_process(kill=False)
                # Where Formplayer's threads stood, which the runner reads before it halts (Runner.threads).
                stood = error.get("trace")
                raise FormplayerDeadlineError(
                    f"{message}\nWhere Formplayer's threads stood:\n{stood}" if stood else message,
                    kind=kind,
                    log=self.last_log,
                    detail=error,
                )
            raise FormplayerRunnerError(message, kind=kind, log=self.last_log, detail=error)

    def _answer_hq(self, line: dict[str, Any], hq: HqHandler) -> tuple[HqRequest, HqAnswer]:
        """Answers one request Formplayer made of HQ. A handler that raises ends the runner: Formplayer is left
        mid-request, holding a lock and a half-written sandbox, so nothing after it would be Formplayer's own."""
        asked = line["request"]
        request = HqRequest(
            method=asked["method"],
            path=asked["path"],
            query=asked.get("query", ""),
            headers=tuple((name, value) for name, value in asked.get("headers", [])),
            body=base64.b64decode(asked.get("bodyBase64", "")),
        )
        try:
            answer = hq(request)
        except BaseException:
            self._stop_process()
            raise
        self._write(
            {
                "hq": line["hq"],
                "status": answer.status,
                "headers": [list(pair) for pair in answer.headers],
                "bodyBase64": base64.b64encode(answer.body).decode("ascii"),
            },
            "HQ's answer",
        )
        return request, answer

    # -- operations --------------------------------------------------------

    def http(
        self,
        path: str,
        body: Any = None,
        *,
        method: str = "POST",
        headers: Sequence[tuple[str, str]] = (),
        hq: HqHandler = refuse_hq,
        deadline: float = 120.0,
    ) -> Exchange:
        """One HTTP request to Formplayer's own web server.

        ``body`` is bytes as they are, or a JSON value sent as ``application/json``.
        Core's random source is seeded from the request's ordinal in this JVM,
        so the ids an app's logic draws are the same on every run of the same
        requests.
        """
        sent = list(headers)
        if body is None:
            raw = b""
        elif isinstance(body, bytes | bytearray):
            raw = bytes(body)
        else:
            raw = json.dumps(body).encode("utf-8")
            if not any(name.lower() == "content-type" for name, _ in sent):
                sent.append(("Content-Type", "application/json"))
        seed = self._next_seed
        self._next_seed += 1
        result, asked = self.request(
            "http",
            deadline=deadline,
            hq=hq,
            method=method,
            path=path,
            headers=[list(pair) for pair in sent],
            bodyBase64=base64.b64encode(raw).decode("ascii"),
            seed=seed,
        )
        response = Response(
            status=result["status"],
            headers=tuple((name, value) for name, value in result["headers"]),
            body=base64.b64decode(result["bodyBase64"]),
        )
        return Exchange(response=response, hq=tuple(asked), log=self.last_log)

    def reseed(self) -> None:
        """The next request's seed is the first again: a run's requests seed Core's random source by their place
        in the run, so the ids an app's logic draws in it do not depend on what this JVM answered before."""
        self._next_seed = 1

    def set_clock(self, instant: str = DEFAULT_CLOCK) -> None:
        """The instant now(), today() and dow() read in an app's logic, until set again."""
        self.request("clock", deadline=30.0, instant=instant)

    def sync_times(self) -> dict[str, int]:
        """Formplayer's record of when each user last synced, by the key RestoreFactory writes it under."""
        result, _ = self.request("syncTimes", deadline=30.0)
        return result

    def forget_caches(self) -> list[str]:
        """Empties Formplayer's in-memory caches, as a fresh Formplayer holds them: each keeps an entry for five
        minutes of the machine's time, so a session that follows another within five minutes would read that one's
        search results without asking HQ, and a later one would ask. Returns the caches emptied."""
        result, _ = self.request("forgetCaches", deadline=30.0)
        return list(result["cleared"])

    def age_sync(self, key: str, seconds: float) -> dict[str, Any]:
        """Moves one user's last sync back, as their record holds after that long away."""
        result, _ = self.request("ageSync", deadline=30.0, key=key, millis=int(seconds * 1000))
        return result


def application_classpath(application_dir: Path = APPLICATION_DIR) -> str:
    """Formplayer's boot jar's classes and libraries, in its launcher's order, as the image recorded them."""
    recorded = Path(application_dir) / "classpath.txt"
    try:
        return os.pathsep.join(recorded.read_text(encoding="utf-8").split())
    except OSError as error:
        raise FormplayerStartError(
            f"The Formplayer runner needs Formplayer's recorded classpath at {recorded}, which it could not read"
            f" ({error}). The proof image writes it when it builds Formplayer (proof/image/formplayer/build.sh)."
        ) from error


def vendored_core_commit(application_dir: Path = APPLICATION_DIR) -> str:
    """The Core commit the image's Formplayer was built with (its libs/commcare submodule)."""
    return (Path(application_dir) / "vendored-core-commit").read_text(encoding="utf-8").strip()


def _clock_readers(formplayer_dir: Path, work: Path) -> list[str]:
    """The vendored Core's clock-reading classes, from its own source, reading the runner's clock instead."""
    written = []
    for relative in CLOCK_READERS:
        original = Path(formplayer_dir) / "libs" / "commcare" / "src" / "main" / "java" / relative
        try:
            text = original.read_text(encoding="utf-8")
        except OSError as error:
            raise FormplayerStartError(
                f"The Formplayer runner freezes the clock by recompiling {original}, which it could not read ({error})."
            ) from error
        if text.count(CLOCK_READ) != 1:
            raise FormplayerStartError(
                f"The Formplayer runner expects the vendored Core's {relative} to read the clock with exactly one"
                f" `{CLOCK_READ}`, and it has {text.count(CLOCK_READ)}. Core's clock changed at the commit"
                " Formplayer vendors; revisit ProofClock before trusting what Formplayer answers."
            )
        target = work / "clock" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text.replace(CLOCK_READ, CLOCK_REPLACEMENT), encoding="utf-8")
        written.append(str(target))
    return written


def compile_runner(
    classes: Path,
    *,
    formplayer_dir: Path = FORMPLAYER_DIR,
    application_dir: Path = APPLICATION_DIR,
    source_dir: Path = SOURCE_DIR,
) -> float:
    """Compile the runner's sources, with the vendored Core's clock readers reading its clock, into ``classes``.

    ``classes`` must not exist yet. Returns the compile's seconds.
    """
    classes = Path(classes)
    sources = sorted(str(path) for path in Path(source_dir).rglob("*.java"))
    if not sources:
        raise FormplayerStartError(f"The Formplayer runner found no Java sources under {source_dir}.")
    classpath = application_classpath(application_dir)
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="proof-formplayer-compile-") as scratch:
        work = Path(scratch)
        sources += _clock_readers(formplayer_dir, work)
        classes.mkdir(parents=True)
        log = work / "javac.log"
        try:
            with log.open("wb") as output:
                status = processes.run(
                    # -proc:none: the classpath holds Lombok and Spring's annotation processors, which are
                    # Formplayer's build's, not the runner's.
                    [
                        "javac",
                        *JAVAC_OPTIONS,
                        "-proc:none",
                        "-encoding",
                        "UTF-8",
                        "-d",
                        str(classes),
                        "-cp",
                        classpath,
                        *sources,
                    ],
                    timeout=COMPILE_DEADLINE_SECONDS,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                )
        except (OSError, processes.TimedOut) as error:
            raise FormplayerStartError(f"The Formplayer runner could not run javac: {error}") from error
        if status != 0:
            raise FormplayerStartError(
                "The Formplayer runner's sources did not compile against Formplayer's classpath:\n"
                + log.read_text(encoding="utf-8", errors="replace")
            )
    factories = classes / "META-INF" / "spring.factories"
    factories.parent.mkdir(parents=True)
    factories.write_text(SPRING_FACTORIES, encoding="utf-8")
    return time.perf_counter() - started


def given_classes(classes: Path) -> Path:
    """``classes``, a directory compile_runner wrote, or the refusal naming what it lacks."""
    if not (Path(classes) / MAIN_CLASS_FILE).is_file():
        raise FormplayerStartError(
            f"The Formplayer runner was given its compiled classes at {classes} ({CLASSES_ENVIRONMENT}), and"
            f" {MAIN_CLASS_FILE} is not there. Compile them with proof.formplayer.client.compile_runner, or leave"
            f" {CLASSES_ENVIRONMENT} unset to have each runner compile its own."
        )
    return Path(classes)


def _psql(statement: str) -> tuple[int, str]:
    with tempfile.TemporaryFile() as output:
        status = processes.run(
            [
                "psql",
                "--no-psqlrc",
                "--set",
                "ON_ERROR_STOP=1",
                "--host",
                POSTGRES_HOST,
                "--port",
                POSTGRES_PORT,
                "--username",
                POSTGRES_USER,
                "--dbname",
                POSTGRES_MAINTENANCE_DATABASE,
                "--command",
                statement,
            ],
            timeout=60,
            env={**os.environ, "PGPASSWORD": POSTGRES_PASSWORD},
            stdout=output,
            stderr=subprocess.STDOUT,
        )
        output.seek(0)
        return status, output.read().decode("utf-8", "replace")


def make_database(name: str) -> str:
    """An empty database on the lane's Postgres for one Formplayer, which Formplayer's own migrations fill."""
    if not name.replace("_", "").isalnum():
        raise FormplayerStartError(f"The Formplayer runner names its database {name!r}, which is not a plain name.")
    drop_database(name)
    status, output = _psql(f'CREATE DATABASE "{name}"')
    if status != 0:
        raise FormplayerStartError(
            f"The Formplayer runner could not create its database {name} on the lane's Postgres at"
            f" {POSTGRES_HOST}:{POSTGRES_PORT}:\n{output}"
        )
    return name


def drop_database(name: str) -> None:
    _psql(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
