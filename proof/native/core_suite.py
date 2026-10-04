"""The native Core proofs, run through CommCare Core's own Gradle test build.

``run_core_tests(selection, ...)`` runs Core's ``test`` task at the pinned
checkout (``PROOF_CORE``, /opt/core in the image) with Gradle offline against
the image's warm Gradle home, the proof classes in ``core/`` added to Core's
test source set by ``core/native-proof.init.gradle``, and the harness's native
output directory on the test JVM's classpath. It returns each class's results
as JUnit reported them.

Gradle's exit status speaks only for the build (the init script sets
``ignoreFailures``): a class that fails is reported from its JUnit XML, and a
build that fails (a proof that does not compile, a JVM that dies, a build
that runs out of time) raises ``CoreBuildFailed`` with Gradle's output.

Every process a build starts is stopped and reaped before the call returns,
however the build ended (``proof.processes.run``). The build runs in
Gradle's own client JVM, whose heap comes from ``GRADLE_OPTS``: JVM settings
asked for through ``-Dorg.gradle.jvmargs`` make a ``--no-daemon`` client fork
a single-use daemon, which detaches into a session of its own, beyond the
build's process group. With ``GRADLE_OPTS`` the client and the test JVM it
starts share that one group.
"""

import os
import subprocess
import time
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass, field
from pathlib import Path

from proof import processes

CORE_DIR = Path(os.environ.get("PROOF_CORE", "/opt/core"))
SOURCES = Path(__file__).resolve().parent / "core"
INIT_SCRIPT = SOURCES / "native-proof.init.gradle"
PACKAGE = "nova.compatibility"
# Gradle compiles Core's test source set with the proof classes, then runs
# them; both take well under this on the lane's runners.
GRADLE_TIMEOUT_SECONDS = 900
# The Gradle client's own heap, in GRADLE_OPTS; the test JVM's is set in the
# init script. The serial collector and the client compiler alone keep the
# CPU of a build that lasts seconds at what its own thread does: sized by the
# machine's processors otherwise, the JVM's collector and compiler threads
# cost more than the build. Neither changes what the build runs.
GRADLE_JVM_ARGS = "-Xmx768m -XX:MaxMetaspaceSize=384m -XX:+UseSerialGC -XX:TieredStopAtLevel=1"


class CoreBuildFailed(RuntimeError):
    """Core's Gradle build did not run the proofs: it failed before or around them."""


@dataclass(frozen=True)
class CoreTest:
    name: str
    # "passed", "failed", "error" or "skipped"
    outcome: str
    seconds: float
    message: str = ""
    detail: str = ""


@dataclass
class CoreClass:
    name: str
    seconds: float
    tests: list[CoreTest] = field(default_factory=list)

    def problems(self):
        return [test for test in self.tests if test.outcome != "passed"]


@dataclass
class CoreRun:
    selection: str
    seconds: float
    log: Path
    classes: dict[str, CoreClass]


def _parse_report(path: Path) -> CoreClass:
    suite = ElementTree.parse(path).getroot()
    name = suite.get("name", "").removeprefix(f"{PACKAGE}.")
    result = CoreClass(name=name, seconds=float(suite.get("time") or 0))
    for case in suite.iter("testcase"):
        outcome, message, detail = "passed", "", ""
        for kind in ("failure", "error", "skipped"):
            element = case.find(kind)
            if element is not None:
                outcome = "failed" if kind == "failure" else kind
                message = element.get("message") or ""
                detail = element.text or ""
                break
        result.tests.append(CoreTest(case.get("name", ""), outcome, float(case.get("time") or 0), message, detail))
    return result


def core_tests_command(selection: str, *, native_dir: Path, reports: Path) -> list[str]:
    """Gradle's command line for the proof classes ``selection`` names (a Gradle ``--tests`` pattern)."""
    return [
        "gradle",
        "--offline",
        "--no-daemon",
        "--console=plain",
        "-I",
        str(INIT_SCRIPT),
        f"-PnovaProofSources={SOURCES}",
        f"-PnovaProofNative={native_dir}",
        f"-PnovaProofReports={reports}",
        "test",
        "--tests",
        f"{PACKAGE}.{selection}",
    ]


def run_core_tests(selection: str, *, native_dir: Path, work_dir: Path) -> CoreRun:
    """Run the proof classes ``selection`` names (a Gradle ``--tests`` pattern) and read their results."""
    reports = work_dir / "junit"
    work_dir.mkdir(parents=True, exist_ok=True)
    log = work_dir / "gradle.log"
    command = core_tests_command(selection, native_dir=native_dir, reports=reports)
    environment = {**os.environ, "GRADLE_OPTS": GRADLE_JVM_ARGS}
    started = time.perf_counter()
    try:
        with log.open("wb") as output:
            returncode = processes.run(
                command,
                timeout=GRADLE_TIMEOUT_SECONDS,
                cwd=CORE_DIR,
                env=environment,
                stdout=output,
                stderr=subprocess.STDOUT,
            )
    except processes.TimedOut:
        raise CoreBuildFailed(
            f"Core's Gradle build ran the native proofs ({selection}) for more than {GRADLE_TIMEOUT_SECONDS} s "
            f"and was stopped, with every process it started. Its output is in {log}."
        ) from None
    seconds = time.perf_counter() - started
    if returncode != 0:
        tail = log.read_text(errors="replace")[-8000:]
        raise CoreBuildFailed(
            f"Core's Gradle build could not run the native proofs ({selection}): it exited with status "
            f"{returncode}. A proof class that no longer compiles against Core at the pin shows here; "
            f"the whole output is in {log}.\n{tail}"
        )
    classes = {}
    for path in sorted(reports.glob(f"TEST-{PACKAGE}.*.xml")):
        result = _parse_report(path)
        classes[result.name] = result
    return CoreRun(selection=selection, seconds=seconds, log=log, classes=classes)
