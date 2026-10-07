"""The harness's only way to talk to commcare-android.

``AndroidReader.request(op, ...)`` answers one request with commcare-android's own classes at the pinned
checkout, run under Robolectric as the project's own unit tests run them: its application, its installers, its
activities and views. Each request is one JVM (``nova.proof.android.Runner``) and one device: commcare-android
keeps state in statics a device's process holds for its whole life (Core's reference roots, the localizer, the
form controller), so a second device in the same JVM would start with the first one's.

The runtime is what one build of commcare-android's unit tests leaves (``proof/android/build-runtime.sh``,
``proof/android/README.md``): ``runtime.json`` names the unit-test classpath Gradle recorded, the directory the
project's tests run from, and the directory holding Robolectric's Android runtime, which Robolectric would
otherwise fetch from the network. ``PROOF_ANDROID_RUNTIME`` names the runtime's directory. The reader's own
classes (``proof/android/src``) are compiled against that classpath when the reader starts, once, so a runtime
is a function of the pins alone and a change to the reader needs no new one.

A request is a JSON object (``Reader.java`` names them); its answer is what Android read. What Android itself
gives for an input is part of an answer (an install status, a screen's own alert). A request the reader could not
answer (an exception in the reader, a JVM that fails, a deadline) raises ``AndroidReaderError``, so no record
holds it.

Standard library only. The JVM runs through ``proof.processes`` where that runs (Linux, the lane), which stops
and reaps everything the JVM started; on macOS, where a person runs the reader by hand, the JVM is a process
group of its own, killed whole on a deadline.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

RUNTIME_ENVIRONMENT = "PROOF_ANDROID_RUNTIME"
DEFAULT_RUNTIME = Path("/opt/android-reader")
MAIN_CLASS = "nova.proof.android.Runner"
SOURCE_DIR = Path(__file__).resolve().parent / "src"
COMPILE_SECONDS = 300.0
REQUEST_SECONDS = 300.0
LOG_LIMIT = 256 * 1024
# The project runs its unit tests with -noverify and a 2 GB heap (app/build.gradle, testOptions.unitTests.all).
# The zone and locale are fixed so nothing Android formats depends on the machine, and Robolectric reads its
# Android runtime from the runtime's own directory, never the network.
JVM_OPTIONS = (
    "-noverify",
    "-Xmx2g",
    "-XX:+ExitOnOutOfMemoryError",
    "-XX:+UseSerialGC",
    "-XX:TieredStopAtLevel=1",
    "-Duser.timezone=UTC",
    "-Duser.language=en",
    "-Duser.country=US",
    "-Dfile.encoding=UTF-8",
    "-Drobolectric.offline=true",
)
# Where Robolectric's own SQLite runs: it ships its native runtime for these alone
# (org.robolectric:nativeruntime-dist-compat, native/<os>/<arch>), and commcare-android's tests open every
# database through it.
NATIVE_PLATFORMS = frozenset({("Linux", "x86_64"), ("Darwin", "arm64"), ("Darwin", "x86_64")})


class AndroidReaderError(Exception):
    """A request the reader refused or could not complete; ``log`` is what the JVM wrote."""

    def __init__(self, message: str, *, log: str = ""):
        super().__init__(message)
        self.log = log


class AndroidReaderUnavailable(AndroidReaderError):
    """This machine has no Android reader runtime, or Robolectric has no native runtime for it."""


def runtime_directory() -> Path:
    return Path(os.environ.get(RUNTIME_ENVIRONMENT) or DEFAULT_RUNTIME)


def unavailable(directory: Path | None = None) -> str | None:
    """Why the reader cannot run here, or None where it can."""
    directory = runtime_directory() if directory is None else directory
    if not (directory / "runtime.json").is_file():
        return (
            f"The Android reader's runtime is not at {directory} (no runtime.json there). The proof image builds"
            f" it at {DEFAULT_RUNTIME}, and {RUNTIME_ENVIRONMENT} names one built elsewhere"
            " (proof/android/README.md)."
        )
    here = (platform.system(), platform.machine())
    if here not in NATIVE_PLATFORMS:
        return (
            f"Robolectric ships no native runtime for {here[0]} on {here[1]}, and commcare-android's tests open"
            " their databases through it. The Android reader runs on linux/amd64 and on macOS"
            " (proof/android/README.md)."
        )
    return None


def _run(command, *, timeout, cwd, log) -> int:
    """The command's exit status, with everything it started stopped; ``subprocess.TimeoutExpired`` or
    ``proof.processes.TimedOut`` past the deadline."""
    if sys.platform.startswith("linux"):
        from proof import processes

        return processes.run(command, timeout=timeout, cwd=cwd, stdout=log, stderr=log)
    process = subprocess.Popen(
        command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True
    )
    try:
        return process.wait(timeout=timeout)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


class AndroidReader:
    """The Android reader over one runtime. Use it as a context manager: it removes its work directory."""

    def __init__(self, runtime: Path | str | None = None, *, sources: Path | str | None = None):
        self._runtime = Path(runtime) if runtime is not None else runtime_directory()
        self._sources = Path(sources) if sources is not None else SOURCE_DIR
        self._work: Path | None = None
        self._classes: Path | None = None
        self.compile_seconds: float | None = None
        self.last_log = ""
        self._next = 1
        # What each request took, in seconds, for the lane's budget.
        self.seconds: list[float] = []

    def __enter__(self) -> AndroidReader:
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def start(self) -> None:
        reason = unavailable(self._runtime)
        if reason is not None:
            raise AndroidReaderUnavailable(reason)
        if self._work is None:
            self._work = Path(tempfile.mkdtemp(prefix="proof-android-"))
            try:
                self._classes = self._compile(self._work / "classes")
            except BaseException:
                self.close()
                raise

    def _runtime_json(self) -> dict:
        return json.loads((self._runtime / "runtime.json").read_text(encoding="utf-8"))

    def _classpath(self) -> list[str]:
        runtime = self._runtime_json()
        entries = (self._runtime / runtime["classpath"]).read_text(encoding="utf-8").split("\n")
        return [entry for entry in entries if entry]

    def _compile(self, classes: Path) -> Path:
        """The reader's sources compiled against Robolectric's Android runtime and the unit-test classpath, the
        Android runtime first: its classes are the ones the reader runs on (``android.*``, and the ``org.json``
        Android ships, which is older than the one on the project's test classpath)."""
        runtime = self._runtime_json()
        sources = sorted(str(path) for path in self._sources.rglob("*.java"))
        if not sources:
            raise AndroidReaderError(f"The Android reader found no Java sources under {self._sources}.")
        android = sorted(str(path) for path in (self._runtime / runtime["robolectric"]).glob("*.jar"))
        classes.mkdir(parents=True)
        log_path = classes.parent / "javac.log"
        command = [
            "javac", "-J-XX:+UseSerialGC", "-J-XX:TieredStopAtLevel=1", "-encoding", "UTF-8", "-nowarn",
            "-proc:none", "-d", str(classes), "-cp", os.pathsep.join([*android, *self._classpath()]), *sources,
        ]  # fmt: skip
        started = time.perf_counter()
        with open(log_path, "wb") as log:
            try:
                status = _run(command, timeout=COMPILE_SECONDS, cwd=str(classes.parent), log=log)
            except OSError as error:
                raise AndroidReaderError(f"The Android reader could not run javac: {error}.") from error
        self.compile_seconds = round(time.perf_counter() - started, 3)
        if status != 0:
            raise AndroidReaderError(
                "The Android reader's sources did not compile against commcare-android's unit-test classpath."
                " javac's output is this error's log.",
                log=_tail(log_path),
            )
        return classes

    def close(self) -> None:
        if self._work is not None:
            shutil.rmtree(self._work, ignore_errors=True)
            self._work = None

    def _command(self, request: Path, answer: Path, temporary: Path) -> tuple[list[str], str]:
        runtime = self._runtime_json()
        command = [
            "java",
            *JVM_OPTIONS,
            f"-Drobolectric.dependency.dir={self._runtime / runtime['robolectric']}",
            f"-Djava.io.tmpdir={temporary}",
            "-cp",
            os.pathsep.join([str(self._classes), *self._classpath()]),
            MAIN_CLASS,
            str(request),
            str(answer),
        ]
        return command, runtime["workdir"]

    def request(self, op: str, *, deadline: float = REQUEST_SECONDS, **arguments) -> dict:
        """One request's answer: what Android read, on a device of its own."""
        if self._work is None:
            raise AndroidReaderError("The Android reader is not started; use it as a context manager.")
        number, self._next = self._next, self._next + 1
        scratch = self._work / f"request-{number}"
        temporary = scratch / "tmp"
        temporary.mkdir(parents=True)
        request_path, answer_path, log_path = scratch / "request.json", scratch / "answer.json", scratch / "jvm.log"
        request_path.write_text(json.dumps({"op": op, **arguments}), encoding="utf-8")
        command, workdir = self._command(request_path, answer_path, temporary)
        started = time.perf_counter()
        try:
            with open(log_path, "wb") as log:
                try:
                    status = _run(command, timeout=deadline, cwd=workdir, log=log)
                except OSError as error:
                    raise AndroidReaderError(f"The Android reader could not start java: {error}.") from error
                except Exception as error:  # the deadline, as either runner raises it
                    raise AndroidReaderError(
                        f"The Android reader did not answer the {op} request within {deadline} s and was stopped.",
                        log=_tail(log_path),
                    ) from error
            self.seconds.append(round(time.perf_counter() - started, 3))
            # What the JVM wrote answering the last request (Android's own log among it), for a person reading
            # why Android gave the answer it did.
            self.last_log = _tail(log_path)
            if status != 0 or not answer_path.is_file():
                raise AndroidReaderError(
                    f"The Android reader's JVM exited with status {status} answering the {op} request"
                    + ("" if answer_path.is_file() else ", and wrote no answer")
                    + ". Its output is this error's log.",
                    log=_tail(log_path),
                )
            answer = json.loads(answer_path.read_text(encoding="utf-8"))
            if "error" in answer:
                error = answer["error"]
                raise AndroidReaderError(
                    f"The Android reader raised {error['class']} answering the {op} request: {error['message']}",
                    log=error.get("stack", ""),
                )
            return answer["ok"]
        finally:
            shutil.rmtree(scratch, ignore_errors=True)


def _tail(path: Path) -> str:
    try:
        content = path.read_bytes()
    except OSError:
        return ""
    return content[-LOG_LIMIT:].decode("utf-8", "replace")
