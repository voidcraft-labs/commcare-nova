"""The runner process: it starts on Core at its pin, honors deadlines, survives its JVM dying, and is always joined.

Each test here owns its own runner, since a deadline or a JVM that dies takes
the shared runner's apps with it.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import zipfile
from pathlib import Path

import pytest

from proof.core.artifacts import BASIC_APP, BASIC_RESTORE
from proof.core.client import (
    CORE_DIR,
    DEADLINE_EXIT,
    MAIN_CLASS,
    CoreDeadlineError,
    CoreRunner,
    CoreRunnerError,
    CoreRunnerStartError,
)

PINS = Path(__file__).resolve().parents[1] / "pins.json"

# A form whose one expression cannot finish: 1500 nodes counted inside a
# count inside a count is more than three billion steps.
RUNAWAY_FORM = (
    b'<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml">'
    b'<h:head><h:title>Runaway</h:title><model><instance><data xmlns="http://example.org/runaway">'
    + b"<a/>" * 1500
    + b"</data></instance></model></h:head><h:body/></h:html>"
)
RUNAWAY = "count(/data/a[count(/data/a[count(/data/a) > 0]) > 0])"


def test_the_runner_announces_core_at_its_pin():
    pins = json.loads(PINS.read_text(encoding="utf-8"))
    with CoreRunner() as runner:
        assert runner.ready["core"]["commit"] == pins["commcare-core"]["commit"]
        assert runner.ready["clockReaders"] == ["XPathNowFunc", "XPathTodayFunc", "Text"]


def test_a_request_past_its_deadline_fails_and_the_next_runs_on_a_fresh_jvm():
    with CoreRunner() as runner:
        report = runner.admit(BASIC_APP)
        first = runner.process
        with pytest.raises(CoreDeadlineError) as breached:
            runner.evaluate(
                deadline=0.5,
                restoreBase64=base64.b64encode(BASIC_RESTORE.read_bytes()).decode(),
                formBase64=base64.b64encode(RUNAWAY_FORM).decode(),
                expressions=[RUNAWAY],
            )
        assert breached.value.kind == "deadline"
        assert first.returncode == DEADLINE_EXIT
        assert not runner.alive

        assert json.loads(runner.validate_form(read_form()))["validated"] is True
        assert runner.restarts == 1
        assert runner.process is not first

        with pytest.raises(CoreRunnerError) as stale:
            runner.session(report["app"], restore=BASIC_RESTORE.read_bytes())
        assert stale.value.kind == "request"


def read_form() -> bytes:
    with zipfile.ZipFile(BASIC_APP) as archive:
        return archive.read("modules-1/forms-0.xml")


def test_the_jvm_is_joined_when_the_client_closes_after_a_failure():
    runner = CoreRunner()
    with pytest.raises(RuntimeError, match="a failing test"):
        with runner:
            process = runner.process
            threads = runner.reader_threads
            assert runner.alive
            raise RuntimeError("a failing test")
    assert process.returncode == 0
    assert not any(thread.is_alive() for thread in threads)
    assert not runner.alive


def test_sources_that_do_not_compile_fail_the_start(tmp_path):
    broken = tmp_path / "src" / "nova" / "proof" / "core"
    broken.mkdir(parents=True)
    (broken / "Runner.java").write_text("package nova.proof.core; class Runner { not java }", encoding="utf-8")
    runner = CoreRunner(source_dir=tmp_path / "src")
    with pytest.raises(CoreRunnerStartError, match="did not compile"):
        with runner:
            pass
    assert runner.process is None


def test_the_runner_refuses_to_start_on_cores_own_clock():
    """With Core's classes ahead of the runner's, now() would read the wall clock; the JVM must not announce itself."""
    with CoreRunner() as runner:
        classes = runner.classes_dir
        classpath = runner.classpath
        started = subprocess.run(
            ["java", f"-Dnova.proof.core={CORE_DIR}", "-cp", f"{classpath}{os.pathsep}{classes}", MAIN_CLASS],
            input=b"",
            capture_output=True,
            timeout=120,
            check=False,
        )
    assert started.returncode == 2
    assert started.stdout == b""
    assert b"XPathNowFunc" in started.stderr


# A form whose instance alone is far more than a 32 MB heap holds once Core has parsed it.
HUGE_FORM = (
    b'<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml">'
    b'<h:head><h:title>Huge</h:title><model><instance><data xmlns="http://example.org/huge">'
    + b"<a/>" * 400_000
    + b"</data></instance></model></h:head><h:body/></h:html>"
)


def test_a_jvm_out_of_memory_fails_its_request_by_name_and_the_next_runs_on_a_fresh_jvm():
    """HotSpot's own exit message goes to stderr, never into the protocol stream the client reads."""
    with CoreRunner(max_heap="32m") as runner:
        assert json.loads(runner.validate_form(read_form()))["validated"] is True
        first = runner.process
        with pytest.raises(CoreRunnerError) as died:
            runner.evaluate(
                restoreBase64=base64.b64encode(BASIC_RESTORE.read_bytes()).decode(),
                formBase64=base64.b64encode(HUGE_FORM).decode(),
            )
        assert "OutOfMemoryError" in str(died.value)
        assert "OutOfMemoryError" in runner.stderr
        assert first.returncode == 3
        assert not runner.alive

        assert json.loads(runner.validate_form(read_form()))["validated"] is True
        assert runner.restarts == 1


# A stand-in runner that announces itself, then answers every request with a line
# that is not the protocol: what the client would read if anything in the JVM
# wrote to standard output. ProofClock is here because the client compiles Core's
# clock readers against it.
STRAY_RUNNER = """
package nova.proof.core;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

public final class Runner {
    public static void main(String[] args) throws IOException {
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        out.println("{\\"ready\\": true}");
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        while (in.readLine() != null) {
            out.println("a line that is not the protocol");
        }
    }
}
"""
STRAY_CLOCK = """
package nova.proof.core;

public final class ProofClock {
    public static java.util.Date now() {
        return new java.util.Date(0);
    }
}
"""


def test_a_line_that_is_not_the_protocol_fails_its_request_by_name_and_stops_the_jvm(tmp_path):
    sources = tmp_path / "src" / "nova" / "proof" / "core"
    sources.mkdir(parents=True)
    (sources / "Runner.java").write_text(STRAY_RUNNER, encoding="utf-8")
    (sources / "ProofClock.java").write_text(STRAY_CLOCK, encoding="utf-8")
    runner = CoreRunner(source_dir=tmp_path / "src")
    with runner:
        first = runner.process
        with pytest.raises(CoreRunnerError, match="not a JSON object") as stray:
            runner.validate_form(read_form())
        assert "a line that is not the protocol" in str(stray.value)
        assert first.returncode is not None
        assert not runner.alive

        with pytest.raises(CoreRunnerError, match="not a JSON object"):
            runner.validate_form(read_form())
        assert runner.restarts == 1
        assert not runner.alive
    assert runner.process is None
