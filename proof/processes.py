"""Commands the harness runs, each stopped and reaped whole.

A command the harness runs can start processes its leader never waits for:
every ``node --import tsx`` starts an esbuild service, a Vitest run starts
workers, ``git`` starts its transport helpers, and Gradle's client starts
Core's test JVM. Left alone, such a process outlives the command, or lingers
unreaped once it exits. So ``ProcessGroup`` starts a command as the leader
of a session of its own, which puts it and every process it starts in one
process group, and ``stop()`` kills every process still in that group and
reaps each one, the leader included, however the command ended. The process
starting a ``ProcessGroup`` becomes its descendants' subreaper
(``PR_SET_CHILD_SUBREAPER``), so a process whose parent exited is reparented
to it rather than to init, and is reaped here too. In the proof lane the
fork server (``proof.lane.serve``) is the container's PID 1 and a subreaper
from its start, and reaps whatever reaches it (``reap_strays``); a forked
pytest worker becomes one when it starts its first ``ProcessGroup``, and
until then its orphans go to the server.

A process that leaves the group, as one that calls ``setsid`` does (a
single-use Gradle daemon, for one), is beyond a group kill, so a command run
here must not start one.

``run(command, timeout=...)`` runs a command to its end this way and returns
its leader's exit status, or raises ``TimedOut`` once everything it started
has been stopped and reaped.
"""

from __future__ import annotations

import ctypes
import os
import select
import shlex
import signal
import subprocess

# linux/prctl.h
_PR_SET_CHILD_SUBREAPER = 36


class TimedOut(RuntimeError):
    """A command ran past its deadline and was stopped, with every process it started."""


def become_subreaper():
    """Orphaned descendants of this process are reparented to it, so it can reap them."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(_PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, f"The harness could not become its children's subreaper: {os.strerror(error)}")


class ProcessGroup:
    """One command in a process group of its own, stopped and reaped whole.

    ``wait(timeout)`` says whether the leader exited within ``timeout``
    seconds, leaving it unreaped so the group's id stays this command's.
    ``fileno()`` is the leader's pidfd, readable once the leader has exited,
    for a caller that waits on it beside other files. ``stop()`` kills every
    process still in the group and reaps each one, the leader included, whose
    exit status is then ``returncode``; leaving the ``with`` block stops the
    command. Its output goes to files the caller passes, never to
    ``subprocess.PIPE``, which nothing here would drain.
    """

    def __init__(self, command, *, cwd=None, env=None, stdin=subprocess.DEVNULL, stdout=None, stderr=None):
        if subprocess.PIPE in (stdin, stdout, stderr):
            raise ValueError(
                "A process group's command reads and writes files the caller passes; nothing would drain a pipe."
            )
        become_subreaper()
        self._leader = subprocess.Popen(
            command, cwd=cwd, env=env, stdin=stdin, stdout=stdout, stderr=stderr, start_new_session=True
        )
        self.group = self._leader.pid
        self.returncode = None
        self._exited = None
        self._stopped = False
        try:
            self._exited = os.pidfd_open(self.group)
        except OSError:
            self.stop()
            raise

    def fileno(self) -> int:
        return self._exited

    def wait(self, timeout: float) -> bool:
        poller = select.poll()
        poller.register(self._exited, select.POLLIN)
        return bool(poller.poll(max(0, int(timeout * 1000))))

    def stop(self):
        if self._stopped:
            return
        self._stopped = True
        try:
            os.killpg(self.group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        # A member whose parent is reaped here was reparented to this process
        # before its parent became reapable, so it is found on a later round.
        while True:
            try:
                pid, status = os.waitpid(-self.group, 0)
            except ChildProcessError:
                break
            if pid == self._leader.pid:
                self.returncode = os.waitstatus_to_exitcode(status)
                self._leader.returncode = self.returncode
        if self._exited is not None:
            os.close(self._exited)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.stop()
        return False


def run(command, *, timeout: float, cwd=None, env=None, stdin=subprocess.DEVNULL, stdout=None, stderr=None) -> int:
    """Run ``command`` to its end in a group of its own; its leader's exit status.

    Whatever the command left running when its leader exited is stopped and
    reaped before this returns. A leader still running after ``timeout``
    seconds raises ``TimedOut``, once every process the command started has
    been stopped and reaped.
    """
    with ProcessGroup(command, cwd=cwd, env=env, stdin=stdin, stdout=stdout, stderr=stderr) as group:
        finished = group.wait(timeout)
    if not finished:
        raise TimedOut(
            f"`{shlex.join(str(part) for part in command)}` ran for more than {timeout} s and was stopped, "
            "with every process it started."
        )
    return group.returncode
