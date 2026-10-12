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

A request is a JSON object (``Reader.java`` names them); its answer is what Android read. A request given a
``peer`` is a device with a network: the app's own HTTP client goes through a loopback proxy this process
answers (``proof.android.peer``, ``Peer.java``), every request it makes is answered by ``peer.http`` (in the
lane, HQ's own views over the state the device is served, ``proof.android.hq``), and the device's messages of
where its sessions begin go to ``peer.control``; all of them on the thread that made the request, while the
JVM runs, so HQ answers each on the thread that holds its unit. A request given no peer is a device with no
server: the project's test application answers its network with its own mocks, as in the project's own tests.
What Android itself gives for an input is part of an answer (an install status, a screen's own alert). A
request the reader could not answer (an exception in the reader, a JVM that fails, a deadline) raises
``AndroidReaderError``, so no record holds it. The devices of one machine together run on half its processors
(``_slot``), so a browser's page, HQ and Formplayer beside them are never starved of the rest.

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
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from proof.android import peer as network

RUNTIME_ENVIRONMENT = "PROOF_ANDROID_RUNTIME"
# The JDK the runtime was built with (toolchain.json), where the reader runs beside the lane's image, whose own
# JDK is another build.
JDK_ENVIRONMENT = "PROOF_ANDROID_JDK"
DEFAULT_RUNTIME = Path("/opt/android-reader")
MAIN_CLASS = "nova.proof.android.Runner"
SOURCE_DIR = Path(__file__).resolve().parent / "src"
# The real small files a walk gives a form's capture questions (Captures.java), the ones every reader's walk
# gives (beside the answer table that names them), named to the JVM by a system property, never in a request: a
# request's key names what it reads, and the reader's fingerprint names the files (records.fingerprint).
CAPTURES_DIR = Path(__file__).resolve().parents[1] / "core" / "captures"
COMPILE_SECONDS = 300.0
# A device walks every path of the app, every case of each list and every language (Screens.java) in one JVM:
# a second or two a walk beside HQ, and the longest request of the slices that proved it took 139 s on a machine
# running twice its processors' load. A request past this says how far it walked (``_unanswered``).
REQUEST_SECONDS = 900.0
LOG_LIMIT = 256 * 1024
# How much of that a failure's message carries, and the header Runner.java prints JUnit's report of the reader's
# own failure under (``Failure.getTestHeader``: the test method and its class).
SHOWN_LOG = 8 * 1024
FAILURE_HEADER = "(nova.proof.android.Reader): "
# Core's clock reads an app's logic reaches (now(), today(), and the dow() of a suite's XPath texts): the reader
# compiles these three classes from Core's own source in the runtime, with that one expression reading the
# reader's clock, ahead of Core's on the classpath, as the Core runner does (proof/core/client.py, whose names
# these are; ProofClock.java says why).
CLOCK_READERS = (
    "org/javarosa/xpath/expr/XPathNowFunc.java",
    "org/javarosa/xpath/expr/XPathTodayFunc.java",
    "org/commcare/suite/model/Text.java",
)
CLOCK_READ = "new Date()"
CLOCK_REPLACEMENT = "nova.proof.android.ProofClock.now()"
# The project runs its unit tests with -noverify and a 2 GB heap (app/build.gradle, testOptions.unitTests.all).
# The zone and locale are fixed so nothing Android formats depends on the machine, and Robolectric reads its
# Android runtime from the runtime's own directory, never the network.
#
# The code cache is reserved at 240 MB, the size HotSpot gives a JVM with both compilers (as the runners' is,
# proof/core/client.py), whatever compilers run. At the 48 MB a JVM that stops at the client compiler gets, a
# device filled it about thirty seconds into a request: the JVM then compiles nothing more, and cannot make a
# method handle's intrinsic either, so the app raised an InternalError ("no such method:
# MethodHandle.linkToStatic") wherever it first needed one, which a record kept as a crash of the app, or the JVM
# ended the request. A request whose JVM filled it all the same is refused (``CODE_CACHE_FULL``): what such a JVM
# read is not what Android does.
#
# A document has some fifty device requests. Most are short (an install, an update, an app of a few walks: twelve
# to fifteen seconds, most of it the JVM and Robolectric starting), and a few walk every path, case and language
# of an app with lists and languages: dozens of walks, a minute and more of the same code. Two settings are for
# both, each measured on a short request (the survey control's app, 4 walks) and a long one (basic_tests.ccz
# with two cases, 106 walks, selfcheck.py's own):
#
# - The second compiler only for what a long request keeps hot, on one thread. With the client compiler alone
#   (-XX:TieredStopAtLevel=1, which a JVM that lives seconds wants) the long request took twice the time (273 s
#   and 477 CPU-seconds against 124 and 263). With both compilers as the JVM sets them, a short request took
#   the same 15 s and 48 CPU-seconds against 21: the second compiler's threads compile for the whole of a
#   request too short to gain from it. With its thresholds ten times the defaults and one thread for each
#   compiler (-XX:Tier4*, -XX:CICompilerCount=2), a short request takes 22 CPU-seconds and the long one 131 s
#   and 197. Measured side by side on a proof machine running other lanes (60 to 90 of its 128 processors
#   busy), so the seconds are slower than a quiet machine's and the CPU-seconds are the comparison.
# - A young generation of 1200 MB with survivor spaces of 300 MB each. Every theme a screen's views are made
#   with is a table Robolectric keeps outside the Java object that owns it and frees once the collector has
#   found the owner dead (its resources are a port of Android's native ones), some 200 KB each and several a
#   screen. With the default young generation (a third of the heap, survivors a tenth of that) those tables
#   overflow the survivor space and are promoted, and the serial collector empties the old generation only by
#   stopping the device: a full collection of a second or more every five, 35 s of the long request's 96 on a
#   quiet machine. With this one they die young: 75 s, 13 of them collecting, and no full collection for want
#   of room.
JVM_OPTIONS = (
    "-noverify",
    "-Xmx2g",
    "-Xmn1200m",
    "-XX:SurvivorRatio=2",
    "-XX:+ExitOnOutOfMemoryError",
    "-XX:+UseSerialGC",
    "-XX:ReservedCodeCacheSize=240m",
    "-XX:CICompilerCount=2",
    "-XX:Tier4InvocationThreshold=50000",
    "-XX:Tier4MinInvocationThreshold=6000",
    "-XX:Tier4CompileThreshold=150000",
    "-XX:Tier4BackEdgeThreshold=400000",
    "-Duser.timezone=UTC",
    "-Duser.language=en",
    "-Duser.country=US",
    "-Dfile.encoding=UTF-8",
    "-Drobolectric.offline=true",
)
# What HotSpot writes when its code cache is full (one heap of it, or a segment by its name).
CODE_CACHE_FULL = b"is full. Compiler has been disabled."
# Where the reader's native libraries exist. Robolectric ships its native runtime for these alone
# (org.robolectric:nativeruntime-dist-compat, native/<os>/<arch>), and commcare-android's tests open every
# database through it; on linux/arm64 a device does not even start, for want of Conscrypt's library
# (UnsatisfiedLinkError: conscrypt_openjdk_jni-linux-aarch_64).
NATIVE_PLATFORMS = frozenset({("Linux", "x86_64"), ("Darwin", "arm64"), ("Darwin", "x86_64")})
# Where the machine's places for a device's JVM are kept (``_slot``): a directory every process of the machine
# that reads with Android shares, the system's temporary directory unless this names another.
SLOTS_ENVIRONMENT = "PROOF_ANDROID_SLOTS"
SLOT_POLL_SECONDS = 0.2


class AndroidReaderError(Exception):
    """A request the reader refused or could not complete; ``log`` is what the JVM wrote, whose end the message
    carries (``SHOWN_LOG``), so a failure says why the JVM stopped wherever it is reported."""

    def __init__(self, message: str, *, log: str = ""):
        super().__init__(message)
        self.log = log

    def __str__(self) -> str:
        message = super().__str__()
        if not self.log:
            return message
        # JUnit's report of the reader's own failure, which Runner.java prints under the test's header, and
        # otherwise the end of the log: the app logs on after the report, so the end alone can miss it.
        at = self.log.rfind(FAILURE_HEADER)
        if at != -1:
            start = self.log.rfind("\n", 0, at) + 1
            return f"{message}\nWhat JUnit reported of the reader:\n{self.log[start : start + SHOWN_LOG]}"
        return f"{message}\nThe end of what the JVM wrote:\n{self.log[-SHOWN_LOG:]}"


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
            f"The Android reader has no native libraries for {here[0]} on {here[1]}: Conscrypt, which Robolectric"
            " loads as the device starts, and Robolectric's own native runtime, through which commcare-android's"
            " tests open their databases, ship none for it. The reader runs on linux/amd64 and on macOS"
            " (proof/android/README.md)."
        )
    return None


@contextmanager
def _slot():
    """One of the machine's places for a device's JVM, held while it runs (``SLOTS_ENVIRONMENT``): every process of
    the machine that reads with Android takes one, so the devices together keep to half the machine's processors
    and the browser, HQ and Formplayer beside them keep the rest. A request waits for a place before its JVM
    starts, so the wait is never counted against its deadline."""
    import fcntl

    directory = Path(os.environ.get(SLOTS_ENVIRONMENT) or Path(tempfile.gettempdir()) / "proof-android-slots")
    directory.mkdir(parents=True, exist_ok=True)
    count = max(1, (os.cpu_count() or 2) // 2)
    while True:
        for index in range(count):
            handle = open(directory / f"{index}.lock", "a+b")  # noqa: SIM115 (held until the JVM exits)
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                handle.close()
                continue
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)
                handle.close()
            return
        time.sleep(SLOT_POLL_SECONDS)


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
        # Requests may be made from several threads at once, each a JVM of its own.
        self._lock = threading.Lock()
        # What each request took, in seconds, for the lane's budget.
        self.seconds: list[float] = []
        # The authority the devices given a network trust (proof.android.peer), made once a reader.
        self._network_authority = None

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
        sources += self._clock_readers(classes.parent / "clock")
        android = sorted(str(path) for path in (self._runtime / runtime["robolectric"]).glob("*.jar"))
        classes.mkdir(parents=True)
        log_path = classes.parent / "javac.log"
        command = [
            _java("javac"), "-J-XX:+UseSerialGC", "-J-XX:TieredStopAtLevel=1", "-encoding", "UTF-8", "-nowarn",
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

    def _clock_readers(self, target: Path) -> list[str]:
        """Core's clock-reading classes, from the runtime's own Core checkout, reading the reader's clock."""
        core = Path(self._runtime_json()["workdir"]).parents[1] / "commcare-core" / "src" / "main" / "java"
        written = []
        for relative in CLOCK_READERS:
            try:
                text = (core / relative).read_text(encoding="utf-8")
            except OSError as error:
                raise AndroidReaderError(
                    f"The Android reader freezes the clock by recompiling {core / relative}, which it could not"
                    f" read ({error})."
                ) from error
            if text.count(CLOCK_READ) != 1:
                raise AndroidReaderError(
                    f"The Android reader expects Core's {relative} to read the clock with exactly one"
                    f" `{CLOCK_READ}`, and it has {text.count(CLOCK_READ)}. Core's clock changed at this pin;"
                    " revisit ProofClock before trusting a record."
                )
            path = target / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text.replace(CLOCK_READ, CLOCK_REPLACEMENT), encoding="utf-8")
            written.append(str(path))
        return written

    def close(self) -> None:
        if self._work is not None:
            shutil.rmtree(self._work, ignore_errors=True)
            self._work = None

    def _command(self, request: Path, answer: Path, temporary: Path, proxy=None, drawn=None) -> tuple[list[str], str]:
        runtime = self._runtime_json()
        network_properties = [f"-Dnova.proof.android.drawn={drawn}"] if drawn is not None else []
        if proxy is not None:
            network_properties += [
                f"-Dnova.proof.android.peer={proxy.address}",
                f"-Dnova.proof.android.peerAuthority={proxy.authority.certificate}",
            ]
        command = [
            _java("java"),
            *JVM_OPTIONS,
            f"-Drobolectric.dependency.dir={self._runtime / runtime['robolectric']}",
            f"-Dnova.proof.android.captures={CAPTURES_DIR}",
            f"-Djava.io.tmpdir={temporary}",
            *network_properties,
            "-cp",
            os.pathsep.join([str(self._classes), *self._classpath()]),
            MAIN_CLASS,
            str(request),
            str(answer),
        ]
        return command, runtime["workdir"]

    def _authority(self) -> network.Authority:
        with self._lock:
            if self._network_authority is None:
                self._network_authority = network.Authority(self._work / "authority")
            return self._network_authority

    def request(self, op: str, *, deadline: float = REQUEST_SECONDS, peer=None, drawn=None, **arguments) -> dict:
        """One request's answer: what Android read, on a device of its own, with ``peer`` its network where one
        is given (the module's docstring), and each picture it draws written into the directory ``drawn`` names,
        as ``<sha256>.png``, where one is given."""
        if self._work is None:
            raise AndroidReaderError("The Android reader is not started; use it as a context manager.")
        with self._lock:
            number, self._next = self._next, self._next + 1
        scratch = self._work / f"request-{number}"
        temporary = scratch / "tmp"
        temporary.mkdir(parents=True)
        request_path, answer_path, log_path = scratch / "request.json", scratch / "answer.json", scratch / "jvm.log"
        request_path.write_text(json.dumps({"op": op, **arguments}), encoding="utf-8")
        proxy = network.Proxy(peer, self._authority()) if peer is not None else None
        command, workdir = self._command(request_path, answer_path, temporary, proxy, drawn)
        try:
            with _slot(), open(log_path, "wb") as log:
                started = time.perf_counter()
                try:
                    if proxy is None:
                        status = _run(command, timeout=deadline, cwd=workdir, log=log)
                    else:
                        status = proxy.serve(command, timeout=deadline, cwd=workdir, log=log)
                except network.PeerFailed as error:
                    raise PeerFailed(str(error), log=_tail(log_path)) from error
                except OSError as error:
                    raise AndroidReaderError(f"The Android reader could not start java: {error}.") from error
                except Exception as error:
                    # The deadline, as each runner raises it, none of them an OSError (the peer's PastDeadline,
                    # subprocess.TimeoutExpired, proof.processes.TimedOut): a JVM that ran past its deadline
                    # started, and its log says how far it got.
                    raise _unanswered(op, deadline, log_path) from error
            if _wrote(log_path, CODE_CACHE_FULL):
                raise AndroidReaderError(
                    f"The Android reader's JVM filled its code cache answering the {op} request, after which it"
                    " compiles nothing and may raise where it needs a method handle, so what it answered is not"
                    " what Android does. Reserve it more (JVM_OPTIONS, -XX:ReservedCodeCacheSize).",
                    log=_tail(log_path),
                )
            with self._lock:
                self.seconds.append(round(time.perf_counter() - started, 3))
                # What the JVM wrote answering the last request (Android's own log among it), for a person
                # reading why Android gave the answer it did.
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
            if proxy is not None:
                proxy.close()
            shutil.rmtree(scratch, ignore_errors=True)


class PeerFailed(AndroidReaderError):
    """What answered the device's network raised, which ends the request: the harness's refusal, never HQ's
    answer (HQ's own views answer what they refuse)."""


def _java(tool: str) -> str:
    """The JDK tool the reader runs: the toolchain's JDK where ``PROOF_ANDROID_JDK`` names it (the one the
    runtime was built with, ``toolchain.json``), else the one on the path."""
    home = os.environ.get(JDK_ENVIRONMENT)
    return str(Path(home) / "bin" / tool) if home else tool


def _wrote(path: Path, marker: bytes) -> bool:
    """Whether the JVM's log holds ``marker`` anywhere."""
    try:
        with open(path, "rb") as log:
            return any(marker in line for line in log)
    except OSError:
        return False


# The line the JVM writes as it ends each walk (Screens.java, guarded): the walk and how long it took.
WALKED = "nova-proof walk "


def _unanswered(op: str, deadline: float, log_path: Path) -> AndroidReaderError:
    """The error for a request the JVM did not answer by its deadline, naming how far it had walked."""
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []
    walked = [line[len(WALKED) :] for line in lines if line.startswith(WALKED)]
    reached = f" It had ended {len(walked)} walks, the last {walked[-1]}." if walked else ""
    return AndroidReaderError(
        f"The Android reader did not answer the {op} request within {deadline} s and was stopped.{reached}"
        " The end of its output is this error's log.",
        log=_tail(log_path),
    )


def _tail(path: Path) -> str:
    try:
        content = path.read_bytes()
    except OSError:
        return ""
    return content[-LOG_LIMIT:].decode("utf-8", "replace")
