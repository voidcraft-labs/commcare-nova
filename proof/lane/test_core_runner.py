"""Every worker's Core runner starts from the classes its server compiled once, and keeps its deadlines in HQ's time.

Contracts (``proof.core.client``, as the lane's server and workers use it):

- A runner given compiled classes (``classes=``, or ``PROOF_CORE_CLASSES``
  for a runner over the runner's own sources) starts its JVM from them
  without compiling, answers as one that compiled its own, and leaves them
  in place when it closes, since the server's other workers start from them
  too; a directory without the runner's classes is refused by name. The
  plausible failures: each worker compiling again (a second of javac per
  worker), a runner deleting the server's classes when it closes, and a
  runner starting from an empty directory and failing later, nameless.
- The client waits for the JVM in C or by ``time.perf_counter``, so a
  request still ends at its deadline while HQ's operation has frozen
  ``time.monotonic`` (``proof.hq.determinism``). The plausible failure: a
  ``queue.Queue`` or ``Popen.wait`` timeout that counts with the frozen clock
  and waits forever for a JVM that never answers.
"""

from __future__ import annotations

import json
import sys
import zipfile

import pytest

from proof import processes
from proof.core.artifacts import BASIC_APP
from proof.core.client import (
    CLASSES_ENVIRONMENT,
    MAIN_CLASS_FILE,
    CoreRunner,
    CoreRunnerStartError,
    compile_runner,
)


def _form() -> bytes:
    with zipfile.ZipFile(BASIC_APP) as archive:
        return archive.read("modules-1/forms-0.xml")


def test_a_runner_starts_from_classes_compiled_once_and_leaves_them_in_place(tmp_path, monkeypatch):
    classes = tmp_path / "classes"
    assert compile_runner(classes) > 0
    assert (classes / MAIN_CLASS_FILE).is_file()
    with CoreRunner(classes=classes) as runner:
        assert runner.classes_dir == classes and runner.timings.compile is None
        given = json.loads(runner.validate_form(_form()))
    monkeypatch.setenv(CLASSES_ENVIRONMENT, str(classes))
    with CoreRunner() as runner:
        assert runner.classes_dir == classes and runner.timings.compile is None
    assert (classes / MAIN_CLASS_FILE).is_file(), "A runner removed the classes it was given."
    monkeypatch.delenv(CLASSES_ENVIRONMENT)
    with CoreRunner() as runner:
        assert runner.classes_dir != classes and runner.timings.compile is not None
        assert json.loads(runner.validate_form(_form())) == given

    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(CoreRunnerStartError, match=CLASSES_ENVIRONMENT) as refused:
        with CoreRunner(classes=empty):
            pass
    assert str(empty) in str(refused.value)


# Runs in a process of its own, so a wait that never ends is ended by this test's own deadline.
FROZEN = """
import datetime, json, os, signal, time
import time_machine
from proof.core import client

client.CLIENT_GRACE_SECONDS = 0.5
with client.CoreRunner() as runner:
    os.kill(runner.process.pid, signal.SIGSTOP)
    with time_machine.travel(datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc), tick=False):
        started = time.perf_counter()
        try:
            runner.validate_form(b"<h:html/>", deadline=0.5)
            outcome = "answered"
        except client.CoreDeadlineError:
            outcome = "deadline"
        print(json.dumps({"outcome": outcome, "seconds": time.perf_counter() - started, "alive": runner.alive}))
"""


def test_a_request_ends_at_its_deadline_while_hqs_clock_is_frozen(tmp_path):
    # Its own process group, so a client that never returns is stopped with its JVM (proof.processes).
    output, errors = tmp_path / "out.txt", tmp_path / "err.txt"
    with output.open("wb") as stdout, errors.open("wb") as stderr:
        status = processes.run([sys.executable, "-c", FROZEN], timeout=120, cwd=tmp_path, stdout=stdout, stderr=stderr)
    assert status == 0, errors.read_text()[-4000:]
    result = json.loads(output.read_text().strip().splitlines()[-1])
    assert result["outcome"] == "deadline"
    assert result["seconds"] < 30, result
    assert result["alive"] is False
