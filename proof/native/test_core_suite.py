"""A Core build stopped at its deadline leaves no Gradle JVM behind.

Contract: when ``core_suite.run_core_tests`` passes its deadline it stops
the build with every process it started, down to Core's test JVM, reaps
each one (``proof.processes.run``), and raises ``CoreBuildFailed``. The
plausible failures: a single-use Gradle daemon (forked when JVM settings
reach Gradle as ``-Dorg.gradle.jvmargs``) that detaches from the build's
process group and outlives it with the test JVM it started, and a test JVM
left running, or unreaped, when only Gradle's client is killed.

The deadline passes while the whole process tree is running: Core's test JVM
runs under Gradle's own ``--debug-jvm``, which holds it suspended until a
debugger attaches and has it print "Listening for transport" once it is up,
and the build's wait follows Gradle's log until that line, then answers that
the deadline has passed. Whatever Gradle JVM the stop missed is killed and
reaped before the test asserts, so a failing run leaves nothing behind.
"""

import ctypes
import os
import select
import signal
import time
from pathlib import Path

import pytest

from proof import processes
from proof.native import core_suite

# Gradle compiles the proof classes before it starts Core's test JVM; this
# bounds a build that never gets there.
TEST_JVM_DEADLINE_SECONDS = 300
TEST_JVM_LISTENING = b"Listening for transport dt_socket"
# linux/inotify.h
_IN_MODIFY = 0x00000002


def _processes():
    """Every process this container can see: pid -> (state, process group, command line)."""
    found = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = Path("/proc", entry, "stat").read_text()
            command = Path("/proc", entry, "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue  # it exited while the listing was read
        fields = stat[stat.rindex(")") + 2 :].split()
        found[int(entry)] = (fields[0], int(fields[2]), command)
    return found


def _gradle_jvms():
    """Live Gradle JVMs: its client, a daemon, or a worker such as Core's test JVM."""
    return {
        pid: command for pid, (state, _, command) in _processes().items() if state != "Z" and "org.gradle" in command
    }


def _members(group):
    """Every process still in ``group``, running or waiting to be reaped."""
    return {pid: (state, command) for pid, (state, pgrp, command) in _processes().items() if pgrp == group}


def _follow(path, marker, exited, seconds):
    """``path``'s bytes, read as the file grows until they hold ``marker``, ``exited`` is readable, or time is up.

    Returns the bytes and ``None``, or the bytes and what ended the reading
    before ``marker`` appeared.
    """
    libc = ctypes.CDLL(None, use_errno=True)
    watch = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
    if watch < 0:
        raise OSError(ctypes.get_errno(), "The test could not watch Gradle's log (inotify_init1).")
    try:
        if libc.inotify_add_watch(watch, os.fsencode(path), _IN_MODIFY) < 0:
            raise OSError(ctypes.get_errno(), f"The test could not watch Gradle's log {path} (inotify_add_watch).")
        poller = select.poll()
        poller.register(watch, select.POLLIN)
        poller.register(exited, select.POLLIN)
        deadline = time.monotonic() + seconds
        seen = b""
        with open(path, "rb") as log:
            while True:
                seen += log.read()
                if marker in seen:
                    return seen, None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return seen, "the deadline passed"
                ready = {fd for fd, _ in poller.poll(int(remaining * 1000) + 1)}
                if exited in ready:
                    seen += log.read()
                    return seen, None if marker in seen else "Gradle exited"
                if watch in ready:
                    os.read(watch, 65536)
    finally:
        os.close(watch)


def _stop_new_gradle_jvms(before):
    """Kill and reap every Gradle JVM that was not running before the test, and say which were found."""
    found = {pid: jvm for pid, jvm in _gradle_jvms().items() if pid not in before}
    for pid in found:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    # A JVM is this process's to reap once its parent has died (the harness
    # is the subreaper), so a child JVM is reaped on a round after its parent.
    remaining = set(found)
    while remaining:
        reaped = set()
        for pid in sorted(remaining):
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                continue
            reaped.add(pid)
        if not reaped:
            break
        remaining -= reaped
    return found


def test_a_core_build_past_its_deadline_is_stopped_whole(tmp_path, monkeypatch):
    before = set(_gradle_jvms())
    work = tmp_path / "work"
    (tmp_path / "native").mkdir()
    observed = {}
    command = core_suite.core_tests_command
    monkeypatch.setattr(
        core_suite, "core_tests_command", lambda *args, **kwargs: [*command(*args, **kwargs), "--debug-jvm"]
    )

    def deadline_once_listening(build, timeout):
        observed["output"], observed["missed"] = _follow(
            work / "gradle.log", TEST_JVM_LISTENING, build.fileno(), TEST_JVM_DEADLINE_SECONDS
        )
        observed["group"] = build.group
        observed["running"] = {pid: jvm for pid, jvm in _gradle_jvms().items() if pid not in before}
        observed["members"] = _members(build.group)
        return False

    monkeypatch.setattr(processes.ProcessGroup, "wait", deadline_once_listening)
    try:
        with pytest.raises(core_suite.CoreBuildFailed, match="was stopped, with every process it started"):
            core_suite.run_core_tests("ArithmeticRuntimeTest", native_dir=tmp_path / "native", work_dir=work)
    finally:
        survivors = _stop_new_gradle_jvms(before)

    assert observed["missed"] is None, (
        f"Core's test JVM never started under --debug-jvm ({observed['missed']}), so the deadline did not pass "
        f"with the build's whole tree up. Gradle's output ends:\n{observed['output'].decode(errors='replace')[-4000:]}"
    )
    workers = [pid for pid, jvm in observed["running"].items() if "GradleWorkerMain" in jvm]
    assert workers, f"No Gradle worker JVM was running Core's tests when the deadline passed: {observed['running']}"
    outside = {pid: jvm for pid, jvm in observed["running"].items() if pid not in observed["members"]}
    assert not outside, f"Gradle JVMs ran outside the build's process group, which a stop cannot reach: {outside}"
    assert not survivors, f"Gradle JVMs survived the build that ran out of time: {survivors}"
    assert not _members(observed["group"]), (
        f"Processes of the stopped build remain, running or unreaped: {_members(observed['group'])}"
    )
