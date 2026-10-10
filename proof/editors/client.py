"""The harness's only way to drive HQ's editors in a browser.

``EditorDriver`` starts one editor driver (``proof/editors/driver/driver.mjs``:
node, with Chromium through the image's playwright-core) and exchanges JSON
lines with it. Every request a page makes to HQ comes back to Python while
Python waits on the operation, and Python answers it with HQ's response
(``proof.editors.hq``), so HQ only ever runs on the thread that started the
operation. ``run`` runs steps in a fresh browser context; ``operation`` runs
any of the driver's operations (``view`` and ``vellum`` on the pages the
driver keeps between operations among them), and hands the phases a view
announces to a callback of the caller's, which the driver waits on before
it goes on. Every operation
carries a deadline: a driver that stops answering is stopped, and the next
operation starts a fresh one. Use it as a context manager so the driver and
its reader threads are joined on every exit path.

The driver's Chromium is not in the driver's process group (Playwright
launches it detached, in a session of its own: playwright-core's
``launchProcess``), so a forced stop kills the driver's group and then every
process that descended from the driver, Chromium's own groups included,
found before the kill in ``/proc``, and returns once each of them has ended
(a kill is delivered when the kernel next runs the process, which on a
loaded machine is not at once), waiting on each process's pid file
descriptor; one still running ``KILLED_WAIT_SECONDS`` after the kill fails
the stop by its pid. A driver shut down cleanly closes Chromium itself.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import select
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DRIVER = Path(__file__).resolve().parent / "driver" / "driver.mjs"
EDITORS_DIR = Path(os.environ.get("PROOF_EDITORS", "/opt/editors"))
TOOLS_DIR = Path(os.environ.get("PROOF_TOOLS", "/opt/proof-tools"))
# How long the client waits past an operation's own deadline before it stops
# a driver that has not answered at all.
CLIENT_GRACE_SECONDS = 30.0
# How long a forced stop waits for the processes it killed to end.
KILLED_WAIT_SECONDS = 10.0
STDERR_LIMIT = 256 * 1024
# Deadlines are kept on time.perf_counter and waited for in C
# (queue.SimpleQueue.get): HQ's operations run under time-machine
# (proof.hq.determinism), which freezes time.monotonic while one is open and,
# once one has run, has it read the wall clock, so a deadline taken on
# time.monotonic before an HQ answer is meaningless after it.


class EditorDriverError(Exception):
    """An operation the driver refused or could not complete."""

    def __init__(self, message: str, *, kind: str = "internal", detail: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.kind = kind
        self.detail = dict(detail or {})


class EditorDriverStartError(EditorDriverError):
    """The driver did not start: node or Chromium did not come up."""


class EditorDeadlineError(EditorDriverError):
    """An operation outlived its deadline."""


@dataclass(frozen=True)
class PageRequest:
    """A request the page made, handed to Python to answer.

    ``phase`` is the part of the operation the driver asked it in: ``run``
    for a fresh-context run, ``load``, ``section:<i>`` (a section's held
    save) or ``followup:<i>`` (what the page asked after it) for a view,
    ``vellum`` for a Vellum run. ``forwarded`` numbers the request in the
    driver's sequence of exchange events (None for a fresh-context run).
    """

    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None
    phase: str | None = None
    forwarded: int | None = None


@dataclass(frozen=True)
class Phase:
    """A part of a view operation starting or ending: ``name`` (``section:<i>``) and ``event`` (start or end)."""

    name: str
    event: str


@dataclass(frozen=True)
class PageResponse:
    status: int
    headers: Sequence[tuple[str, str]]
    body: bytes


Answer = Callable[[PageRequest], PageResponse]
OnPhase = Callable[[Phase], None]


@dataclass
class Timings:
    """Measured costs, in seconds, for the proof lane's time budget."""

    starts: list[float] = field(default_factory=list)
    runs: list[float] = field(default_factory=list)


class _Silence:
    """What the client reads when the driver writes nothing before a wait runs out."""


SILENCE = _Silence()


class EditorDriver:
    """One editor driver process for a test session."""

    def __init__(
        self,
        *,
        driver: Path = DRIVER,
        editors_dir: Path = EDITORS_DIR,
        tools_dir: Path = TOOLS_DIR,
        start_timeout: float = 60.0,
    ):
        self._driver = Path(driver)
        self._editors_dir = Path(editors_dir)
        self._tools_dir = Path(tools_dir)
        self._start_timeout = start_timeout
        self._process: subprocess.Popen[bytes] | None = None
        self._lines: queue.SimpleQueue[bytes | None] | None = None
        self._threads: list[threading.Thread] = []
        self._stderr = bytearray()
        self._stderr_lock = threading.Lock()
        self._next_id = 1
        self._statics: set[str] = set()
        self.ready: dict[str, Any] | None = None
        self.timings = Timings()
        self.restarts = 0

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> EditorDriver:
        try:
            self.start()
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def start(self) -> None:
        """Starts the driver, raising when node or Chromium does not come up."""
        if self._process is None:
            self._launch()

    def _launch(self) -> None:
        build = self._editors_dir / "build.json"
        if not build.is_file():
            raise EditorDriverStartError(
                f"The editor driver serves HQ's editor bundles from {self._editors_dir}, and {build} is not"
                " there. The proof image builds them (proof/image/editors/build.mjs)."
            )
        environment = {
            **os.environ,
            "PROOF_EDITORS": str(self._editors_dir),
            "PROOF_TOOLS": str(self._tools_dir),
        }
        started = time.perf_counter()
        with self._stderr_lock:
            self._stderr.clear()
        try:
            # Its own process group, so a forced stop reaches the driver and
            # anything it starts in its group; Chromium is stopped by its tree.
            process = subprocess.Popen(
                ["node", str(self._driver)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=environment,
                start_new_session=True,
            )
        except OSError as error:
            raise EditorDriverStartError(f"The editor driver could not start node: {error}.") from error
        lines: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
        self._process = process
        self._lines = lines
        self._threads = [
            threading.Thread(target=self._pump_stdout, args=(process, lines), name="editor-driver-stdout", daemon=True),
            threading.Thread(target=self._pump_stderr, args=(process,), name="editor-driver-stderr", daemon=True),
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
            raise EditorDriverStartError(
                f"The editor driver did not announce itself ready (it wrote {line!r}). Its stderr:\n{self.stderr}"
            )
        self.ready = ready
        self._statics = set()
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
        return self._process

    @property
    def reader_threads(self) -> tuple[threading.Thread, ...]:
        return tuple(self._threads)

    @property
    def alive(self) -> bool:
        return self._process is not None and self._process.poll() is None

    @property
    def stderr(self) -> str:
        with self._stderr_lock:
            return self._stderr.decode("utf-8", "replace")

    def _next_line(self, timeout: float) -> bytes | None | _Silence:
        assert self._lines is not None
        try:
            return self._lines.get(timeout=max(timeout, 0.0))
        except queue.Empty:
            return SILENCE

    def _write(self, message: Mapping[str, Any]) -> None:
        process = self._process
        assert process is not None and process.stdin is not None
        process.stdin.write(json.dumps(message).encode("utf-8") + b"\n")
        process.stdin.flush()

    def descendants(self) -> list[int]:
        """The processes that descend from the running driver (its Chromium among them), by pid."""
        process = self._process
        if process is None or process.poll() is not None:
            return []
        return process_tree(process.pid)

    def _stop_process(self, *, kill: bool = True) -> int | None:
        """Ends the driver (killing it and every process it started when asked) and joins its reader threads.

        A forced stop returns once every process it killed has ended (gone,
        or a zombie no parent has reaped yet). Where one is still running
        ``KILLED_WAIT_SECONDS`` after the kill, the driver is put away all
        the same (the next operation starts a fresh one) and the stop fails
        naming it (``EditorDriverError``).
        """
        process = self._process
        if process is None:
            return None
        started = []
        watched = {}
        if kill:
            # Found before the driver dies: once it is gone its children are
            # reparented and can no longer be told apart. Each is watched by a
            # pid file descriptor opened before the kill, which names that
            # process and no later one given its pid.
            started = self.descendants()
            watched = _pid_descriptors(started)
        try:
            if kill:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                for pid in started:
                    _kill_tree_member(pid)
            try:
                returncode = process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                returncode = process.wait()
            for thread in self._threads:
                thread.join(timeout=30)
        finally:
            # Closes every descriptor, whatever ended the stop.
            running = _await_ended(watched, KILLED_WAIT_SECONDS)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        self._process = None
        self._lines = None
        self._threads = []
        if running:
            described = ", ".join(f"{pid} ({_described(pid)})" for pid in running)
            raise EditorDriverError(
                f"The client killed the editor driver and the {len(started)} processes it started, and"
                f" {len(running)} of them were still running {KILLED_WAIT_SECONDS:g} s later: {described}. A process"
                " that outlives SIGKILL is held in the kernel (its State in /proc/<pid>/status says how); the next"
                " operation starts a fresh driver, and these keep their memory until they end."
            )
        return returncode

    def close(self) -> None:
        """Shuts the driver down (it closes Chromium) and joins it and its reader threads."""
        if self.alive:
            try:
                self._send({"op": "shutdown"}, deadline=30.0, answer=None, on_phase=None)
            except EditorDriverError:
                pass
        if self._process is not None:
            try:
                self._process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                pass
        self._stop_process()

    # -- operations --------------------------------------------------------

    def run(
        self,
        steps: Sequence[Mapping[str, Any]],
        *,
        answer: Answer,
        deadline: float = 120.0,
        cookies: Mapping[str, str] | None = None,
        seed: Mapping[str, Any] | None = None,
        timers: bool = False,
    ) -> dict[str, Any]:
        """Runs page steps in a fresh browser context, answering the page's HQ requests with ``answer``.

        ``cookies`` are set for HQ's origin before the first step: what HQ's
        response to a page the run does not load (the form designer page, for
        the Vellum host) would have set in the browser. ``seed`` (``{seed,
        epoch}``) fixes the pages' clock and randomness
        (``driver/steps/page/seed.js``). With ``timers`` every document counts
        its short one-off timers (``driver/steps/page/timers.js``), for the
        steps that settle on them.
        """
        message: dict[str, Any] = {"op": "run", "steps": list(steps)}
        if cookies:
            message["cookies"] = cookie_list(cookies)
        if seed is not None:
            message["seed"] = dict(seed)
        if timers:
            message["timers"] = True
        return self.operation(message, answer=answer, deadline=deadline)

    def operation(
        self,
        message: Mapping[str, Any],
        *,
        answer: Answer | None,
        on_phase: OnPhase | None = None,
        deadline: float = 120.0,
    ) -> dict[str, Any]:
        """Runs one driver operation (``message`` names it as ``op``), answering its HQ requests with ``answer``.

        ``on_phase`` is called with each phase a view operation announces,
        and the driver waits for it to return; one that raises stops the
        driver (the next operation starts a fresh one), and the error reaches
        the caller.
        """
        self._ensure_running()
        started = time.perf_counter()
        result = self._send(dict(message), deadline=deadline, answer=answer, on_phase=on_phase)
        self.timings.runs.append(time.perf_counter() - started)
        return result

    def register_static(self, path: str, body: bytes, content_type: str) -> None:
        """Has the driver's origin serve ``body`` at ``path`` (under /static/), once per driver process."""
        self._ensure_running()
        if path in self._statics:
            return
        self._send(
            {
                "op": "static",
                "path": path,
                "contentType": content_type,
                "bodyBase64": base64.b64encode(body).decode("ascii"),
            },
            deadline=30.0,
            answer=None,
            on_phase=None,
        )
        self._statics.add(path)

    def stats(self) -> dict[str, Any]:
        """What the driver has done (loads, pages recycled) and the resident memory of its processes, in kB."""
        self._ensure_running()
        stats = self._send({"op": "stats"}, deadline=30.0, answer=None, on_phase=None)
        stats["rssKb"] = sum(resident_kilobytes(pid) for pid in [self._process.pid, *self.descendants()])
        return stats

    @property
    def navigation_headers(self) -> dict[str, str]:
        """The headers Chromium sends with a top-level navigation to the driver's origin (no cookie among them)."""
        self._ensure_running()
        return dict(self.ready.get("navigationHeaders") or {})

    def _ensure_running(self) -> None:
        if not self.alive:
            # The driver that was started has stopped (a deadline, a protocol
            # error, an answer that raised): this operation gets a fresh one.
            if self._process is not None:
                self._stop_process()
            self._launch()
            self.restarts += 1

    def _send(
        self, message: dict[str, Any], *, deadline: float, answer: Answer | None, on_phase: OnPhase | None
    ) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        op = message["op"]
        ends = time.perf_counter() + deadline + CLIENT_GRACE_SECONDS
        try:
            self._write({"id": request_id, "deadlineMs": max(1, int(deadline * 1000)), **message})
        except OSError as error:
            returncode = self._stop_process()
            raise EditorDriverError(
                f"The editor driver stopped before it read the {op} operation (exit status {returncode})."
                f" Its stderr:\n{self.stderr}"
            ) from error
        while True:
            line = self._next_line(ends - time.perf_counter())
            if line is SILENCE:
                self._stop_process()
                raise EditorDeadlineError(
                    f"The editor driver did not finish the {op} operation within its deadline of {deadline} s"
                    f" plus {CLIENT_GRACE_SECONDS} s, so the client stopped it.",
                    kind="deadline",
                )
            if line is None:
                returncode = self._stop_process(kill=False)
                raise EditorDriverError(
                    f"The editor driver exited (status {returncode}) during the {op} operation."
                    f" Its stderr:\n{self.stderr}"
                )
            assert isinstance(line, bytes)
            try:
                received = json.loads(line)
            except ValueError:
                received = None
            if not isinstance(received, dict):
                self._stop_process()
                raise EditorDriverError(
                    f"The editor driver wrote a line that is not a JSON object during the {op} operation:"
                    f" {line[:2000]!r}. The client stopped it. Its stderr:\n{self.stderr}"
                )
            if "hq" in received:
                self._answer(received["hq"], answer)
                continue
            if "phase" in received:
                self._phase(received["phase"], on_phase)
                continue
            if received.get("id") != request_id:
                self._stop_process()
                raise EditorDriverError(
                    f"The editor driver answered operation {received.get('id')!r} while the client waited for"
                    f" {request_id}; the protocol is out of step, so the client stopped it."
                )
            if received.get("ok"):
                return received["result"]
            error = received.get("error") or {}
            kind = error.get("kind", "internal")
            text = error.get("message", "The editor driver refused the operation without a message.")
            if kind == "deadline":
                raise EditorDeadlineError(text, kind=kind, detail=error)
            raise EditorDriverError(text, kind=kind, detail=error)

    def _answer(self, asked: Mapping[str, Any], answer: Answer | None) -> None:
        if answer is None:
            raise EditorDriverError("The editor driver asked HQ to answer a request outside any page run.")
        body = asked.get("bodyBase64")
        request = PageRequest(
            method=asked["method"],
            url=asked["url"],
            headers=dict(asked.get("headers") or {}),
            body=base64.b64decode(body) if body is not None else None,
            phase=asked.get("phase"),
            forwarded=asked.get("forwarded"),
        )
        # HQ answers on this thread; the driver waits on the reply. An answer
        # that raises leaves the page waiting, so the driver is stopped (the
        # next operation starts a fresh one) and the error goes to the caller.
        try:
            response = answer(request)
        except BaseException:
            self._stop_process()
            raise
        self._write(
            {
                "reply": asked["rid"],
                "status": response.status,
                "headers": [list(header) for header in response.headers],
                "bodyBase64": base64.b64encode(response.body).decode("ascii"),
            }
        )

    def _phase(self, announced: Mapping[str, Any], on_phase: OnPhase | None) -> None:
        if on_phase is None:
            self._stop_process()
            raise EditorDriverError(
                f"The editor driver announced the phase {announced!r} to an operation that takes none; the client"
                " stopped it."
            )
        # The caller's fork opens or closes here; an error leaves the page
        # waiting, so the driver is stopped and the error goes to the caller.
        try:
            on_phase(Phase(name=announced["name"], event=announced["event"]))
        except BaseException:
            self._stop_process()
            raise
        self._write({"phaseReady": announced["pid"]})


def cookie_list(cookies: Mapping[str, str]) -> list[dict[str, str]]:
    """Cookies as the driver takes them: a list of ``{name, value}`` for HQ's origin, in order."""
    return [{"name": name, "value": value} for name, value in cookies.items()]


def resident_kilobytes(pid: int) -> int:
    """A live process's resident memory in kB (``/proc/<pid>/status``), or 0 when it is gone."""
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        return 0
    return 0


def process_tree(root: int) -> list[int]:
    """Every live process descending from ``root``, read from ``/proc`` (Linux), children before grandchildren."""
    children: dict[int, list[int]] = {}
    for entry in Path("/proc").iterdir() if Path("/proc").is_dir() else ():
        if not entry.name.isdigit():
            continue
        stat = _stat(int(entry.name))
        if stat is not None:
            children.setdefault(stat[1], []).append(int(entry.name))
    found, pending = [], [root]
    while pending:
        for child in sorted(children.get(pending.pop(0), [])):
            found.append(child)
            pending.append(child)
    return found


def _stat(pid: int) -> tuple[str, int, int] | None:
    """A process's (state, parent pid, process group), or None when it is gone."""
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    # The command name is parenthesized and may hold spaces; the fields follow it.
    fields = text[text.rindex(")") + 2 :].split()
    return fields[0], int(fields[1]), int(fields[2])


def has_exited(pid: int) -> bool:
    """Whether a process has ended: gone, or a zombie waiting for a parent that never reaps it."""
    stat = _stat(pid)
    return stat is None or stat[0] in ("Z", "X")


def _described(pid: int) -> str:
    """A process's state and command line as ``/proc`` shows them, for an error that names it."""
    stat = _stat(pid)
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
    except OSError:
        command = ""
    state = "gone" if stat is None else f"state {stat[0]}"
    return f"{state}, {command[:200]}" if command else state


def _pid_descriptors(pids: Sequence[int]) -> dict[int, int]:
    """A pid file descriptor for each process in ``pids`` that is still there (``os.pidfd_open``), pid by descriptor."""
    found = {}
    for pid in pids:
        try:
            found[os.pidfd_open(pid)] = pid
        except ProcessLookupError:
            pass
    return found


def _await_ended(watched: Mapping[int, int], seconds: float) -> list[int]:
    """Waits until every watched process has ended, at most ``seconds``; the pids of those still running.

    ``watched`` is ``_pid_descriptors``'s; the kernel marks a pid file
    descriptor readable once its process has ended (a zombie included), and
    every descriptor is closed before this returns.
    """
    running = dict(watched)
    poller = select.poll()
    try:
        for descriptor in running:
            poller.register(descriptor, select.POLLIN)
        ends = time.perf_counter() + seconds
        while running:
            left = ends - time.perf_counter()
            if left <= 0:
                break
            for descriptor, _ in poller.poll(left * 1000):
                poller.unregister(descriptor)
                os.close(descriptor)
                del running[descriptor]
        return sorted(running.values())
    finally:
        for descriptor in running:
            os.close(descriptor)


def _kill_tree_member(pid: int) -> None:
    """Kills a process the driver started, and its own process group when it leads one."""
    stat = _stat(pid)
    if stat is None:
        return
    try:
        if stat[2] == pid:
            os.killpg(pid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
