"""Running the surface's Java helper (proof/surface/java) against Core's compiled classes.

The helper is compiled once per process with JDK 17 against Core's recorded
test classpath and JavaParser from the image's tools, the way the Core runner
is (proof/core/client.py), so a change to it never needs an image rebuild.

``run_java`` runs one command and keeps its result for the process;
``read_families`` runs several of the families' commands over the pinned
checkouts in one JVM (the helper's ``batch``), which parses each source file
once for all of them, and keeps each command's result as ``run_java`` would
have. No command can change a tree it reads (the helper's ``Code.UNCHANGED``
fails it), so each result is the one the command gives alone.
"""

from __future__ import annotations

import atexit
import copy
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from proof.surface.model import Sources, SurfaceError

SOURCE_DIR = Path(__file__).resolve().parent / "java"
MAIN_CLASS = "nova.proof.surface.Main"
JAVAPARSER = "java/javaparser-core-3.28.2.jar"
DEADLINE_SECONDS = 600
# Each command fits in well under 512 MB once JavaParser keeps no tokens (Code.load); a smaller ceiling keeps the
# helper's footprint small beside the lane's other processes. The serial collector keeps the work of a run that
# lasts seconds at what its one thread does: the JVM sizes its collector by the machine's processors otherwise,
# and on a machine with many, those threads cost more CPU than the helper's own. None of the options changes what
# a command computes.
JVM_OPTIONS = (
    "-Xmx512m",
    "-XX:+UseSerialGC",
    "-Duser.timezone=UTC",
    "-Duser.language=en",
    "-Duser.country=US",
    "-Dfile.encoding=UTF-8",
)
# The compilers, by how long a run lasts. A batch reads Core's and Android's whole Java for seconds, which the
# optimizing compiler pays for, on two threads rather than as many as the machine's processors allow; one command
# alone reads a few directories (a test's planted copy) for a second or less, where the client compiler alone
# costs least.
BATCH_COMPILER_OPTIONS = ("-XX:CICompilerCount=2",)
COMMAND_COMPILER_OPTIONS = ("-XX:TieredStopAtLevel=1",)
# javac's own JVM, for one short compile: the serial collector and the client compiler alone.
JAVAC_OPTIONS = ("-J-XX:+UseSerialGC", "-J-XX:TieredStopAtLevel=1")

_compiled: dict[str, Path] = {}
# Each command's result over the same checkouts, so families sharing one command read its output once.
_results: dict[tuple, Any] = {}


def classpath(sources: Sources) -> str:
    recorded = sources.core / "proof-test-classpath.txt"
    try:
        core = recorded.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise SurfaceError(
            f"The surface extractor reads Core's classes through its recorded test classpath at {recorded}, "
            f"which it could not read ({error}). The proof image writes it when it compiles Core."
        ) from error
    parser = sources.tools / JAVAPARSER
    if not parser.is_file():
        raise SurfaceError(f"The surface extractor needs JavaParser at {parser}; the proof image puts it there.")
    return f"{core}{os.pathsep}{parser}"


def compile_helper(sources: Sources, source_dir: Path, classes: Path) -> None:
    """Compiles the helper's Java under ``source_dir`` (``SOURCE_DIR``, or a test's planted copy) into ``classes``."""
    files = sorted(str(path) for path in source_dir.rglob("*.java"))
    try:
        compiled = subprocess.run(
            ["javac", *JAVAC_OPTIONS, "-encoding", "UTF-8", "-d", str(classes), "-cp", classpath(sources), *files],
            capture_output=True,
            timeout=DEADLINE_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SurfaceError(f"The surface extractor could not run javac ({error}).") from error
    if compiled.returncode != 0:
        raise SurfaceError(
            "The surface extractor's Java helper did not compile against Core's classpath:\n"
            + (compiled.stdout + compiled.stderr).decode("utf-8", "replace")[-4000:]
        )


def _classes(sources: Sources) -> Path:
    key = str(sources.core)
    if key in _compiled and _compiled[key].is_dir():
        return _compiled[key]
    work = Path(tempfile.mkdtemp(prefix="proof-surface-java-"))
    atexit.register(shutil.rmtree, work, True)
    classes = work / "classes"
    classes.mkdir()
    try:
        compile_helper(sources, SOURCE_DIR, classes)
    except SurfaceError:
        shutil.rmtree(work, ignore_errors=True)
        raise
    _compiled[key] = classes
    return classes


def helper_command(
    sources: Sources, classes: Path, command: str, core: Path | None, android: Path | None, extra=()
) -> list[str]:
    """The command line that runs one of the helper's commands (``batch`` among them) from ``classes``."""
    return [
        "java",
        *JVM_OPTIONS,
        *(BATCH_COMPILER_OPTIONS if command == "batch" else COMMAND_COMPILER_OPTIONS),
        "-cp",
        f"{classes}{os.pathsep}{classpath(sources)}",
        MAIN_CLASS,
        command,
        str(core or sources.core),
        str(android or sources.android),
        *extra,
    ]


def _key(sources: Sources, command: str, core: Path | None, android: Path | None, extra=()) -> tuple:
    return (str(sources.core), str(sources.android), command, str(core), str(android), tuple(extra))


def run_java(
    sources: Sources, command: str, core: Path | None = None, android: Path | None = None, extra: list[str] = ()
) -> Any:
    """Runs one command of the helper over the given checkouts (the pinned ones by default), once per process."""
    key = _key(sources, command, core, android, extra)
    if key not in _results:
        _results[key] = _run(sources, command, core, android, extra)
    return copy.deepcopy(_results[key])


def read_families(sources: Sources, commands: list[str]):
    """Runs those of ``commands`` this process has not run over the pinned checkouts in one JVM (the helper's
    ``batch``), keeping each one's result for ``run_java``."""
    pending = [command for command in commands if _key(sources, command, None, None) not in _results]
    if not pending:
        return
    read = _run(sources, "batch", None, None, pending)
    for command in pending:
        _results[_key(sources, command, None, None)] = read[command]


def _run(sources: Sources, command: str, core: Path | None, android: Path | None, extra) -> Any:
    classes = _classes(sources)
    try:
        finished = subprocess.run(
            helper_command(sources, classes, command, core, android, extra),
            capture_output=True,
            timeout=DEADLINE_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SurfaceError(f"The surface extractor could not run its Java {command} helper ({error}).") from error
    if finished.returncode != 0:
        raise SurfaceError(
            f"The surface extractor's Java {command} helper failed (exit {finished.returncode}):\n"
            + finished.stderr.decode("utf-8", "replace")[-4000:]
        )
    try:
        return json.loads(finished.stdout)
    except ValueError as error:
        raise SurfaceError(
            f"The surface extractor's Java {command} helper printed something that is not JSON."
        ) from error
