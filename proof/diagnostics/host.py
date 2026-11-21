"""A POSIX process supervisor for a single bounded diagnostic, including a wedged container or teardown."""

from __future__ import annotations

import fcntl
import json
import os
import secrets
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

BOOTSTRAP_SECONDS = 600
SHUTDOWN_SECONDS = 20
CLEANUP_SECONDS = 15
ROOT = Path(__file__).resolve().parents[2]


def _kill(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def _cleanup(project, env):
    # The outer host can remove only its randomly named replay's resources. A cache in use by another lane is shared.
    env = {
        **env,
        "PROOF_IMAGE": env.get("PROOF_IMAGE") or json.loads((ROOT / "proof/image.lock").read_bytes())["image"],
    }
    commands = [
        (["rm", "--force", project + "-deps", project + "-reader"], b"no such container"),
        (
            [
                "compose",
                "-f",
                str(ROOT / "proof/compose.yaml"),
                "-p",
                project,
                "down",
                "--volumes",
                "--remove-orphans",
                "--timeout",
                "1",
            ],
            None,
        ),
        (["volume", "rm", "--force", project + "-modules"], b"no such volume"),
    ]
    until = time.monotonic() + CLEANUP_SECONDS
    cleaned = True
    for args, absent in commands:
        try:
            child = subprocess.run(
                ["docker", *args], env=env, capture_output=True, timeout=max(0.1, until - time.monotonic())
            )
        except (OSError, subprocess.TimeoutExpired):
            cleaned = False
            continue
        if child.returncode:
            lines = child.stderr.lower().splitlines()
            cleaned = cleaned and bool(absent and lines and all(absent in line for line in lines))
    return cleaned


def _group_stopped(pid):
    # A docker CLI descendant must not be able to create the reader after the daemon's absence check.
    _kill(pid, signal.SIGKILL)
    until = time.perf_counter() + SHUTDOWN_SECONDS
    while True:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return True
        if time.perf_counter() >= until:
            return False
        time.sleep(0.05)


def _seal(project, output, env):
    # The named reader alone mounts /out. The same checked Docker absence and plain-file walk serve hosted shards.
    try:
        return subprocess.run(
            ["node", str(ROOT / "proof/run.mjs"), "--seal-replay", project, str(output)],
            env=env, timeout=180, check=False,
        ).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def status_path(output):
    return output.with_name(output.name + ".host-status.json")


@contextmanager
def certified_output(output, successful):
    """Exclude another launcher for the whole time the collector is reading this supervisor's certified output."""
    fd = os.open(status_path(output), os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as src:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 4096:
            raise ValueError("Invalid host receipt.")
        record = json.loads(src.read(4097))
        if not isinstance(record, dict) or record.get("sealed") is not True:
            raise ValueError("The supervisor did not certify the diagnostic output.")
        code = record.get("exit")
        status = record.get("status")
        valid = type(code) is int and (
            (status == "finished" and code == 0) or (status == "failed" and 1 <= code <= 255)
            or (status == "timed-out" and code == 124) or (status == "interrupted" and code in (130, 143))
        )
        expected_cleanup = True if status in ("interrupted", "timed-out") else None
        if not valid or record.get("dockerCleanup", False) is not expected_cleanup or (code == 0) != successful:
            raise ValueError("The host receipt disagrees with the observation outcome.")
        info = output.lstat()
        if not stat.S_ISDIR(info.st_mode) or record.get("output") != [info.st_dev, info.st_ino]:
            raise ValueError("The supervisor sealed another output directory.")
        yield record


def supervise(command, output, *, work, grace=SHUTDOWN_SECONDS, environ=None, cleanup=_cleanup, seal=_seal):
    """Reap the launcher and certify its output from outside the writable mount."""
    env = os.environ if environ is None else environ
    project = "nova-proof-replay-" + secrets.token_hex(8)
    started = time.perf_counter()
    stop = None
    old = {}

    def interrupt(signum, frame):
        nonlocal stop
        if stop is None:
            stop = ("interrupted", 128 + signum)

    info = output.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError("A diagnostic needs a real output directory.")
    path = status_path(output)
    try:
        record_fd = os.open(path, os.O_RDWR | os.O_EXCL | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        # A previous certified run may reuse an emptied output. An unfinished run could still own its mount.
        record_fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            fcntl.flock(record_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            old_info = os.fstat(record_fd)
            if (not stat.S_ISREG(old_info.st_mode) or old_info.st_nlink != 1 or old_info.st_size > 4096
                    or json.loads(os.read(record_fd, 4097)).get("sealed") is not True):
                raise ValueError("Use a new output directory while the earlier replay is uncertified.")
            os.ftruncate(record_fd, 0)
            os.lseek(record_fd, 0, os.SEEK_SET)
        except BaseException:
            os.close(record_fd)
            raise
    fcntl.flock(record_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    child, cleaned, sealed = None, None, False
    status, code = "launch-failed", 2
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            old[sig] = signal.signal(sig, interrupt)
        deadline = int(time.time() + work)
        child = subprocess.Popen(
            command, start_new_session=True,
            env={**env, "PROOF_OUT_DIR": str(output), "PROOF_DIAGNOSTIC_PROJECT": project,
                 "PROOF_DIAGNOSTIC_DEADLINE_AT": str(deadline)},
        )
        while stop is None:
            remaining = work - (time.perf_counter() - started)
            if remaining <= 0:
                stop = ("timed-out", 124)
                break
            try:
                result = child.wait(timeout=min(remaining, 0.25))
            except subprocess.TimeoutExpired:
                continue
            code = result if result >= 0 else 128 - result
            status = "finished" if code == 0 else "failed"
            break
        if stop:
            status, code = stop
            _kill(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                _kill(child.pid, signal.SIGKILL)
            child.wait()
        group_gone = _group_stopped(child.pid)
        if stop:
            cleaned = cleanup(project, env)
        if group_gone and cleaned is not False:
            sealed = seal(project, output, env)
        return code if sealed else (code or 1)
    finally:
        try:
            record = {
                "status": status, "exit": code, "sealed": sealed, "output": [info.st_dev, info.st_ino],
                "elapsedSeconds": round(time.perf_counter() - started, 2),
                "bootstrapAllowance": BOOTSTRAP_SECONDS, "dockerCleanup": cleaned,
            }
            with os.fdopen(record_fd, "w") as report:
                json.dump(record, report)
        finally:
            for sig, handler in old.items():
                signal.signal(sig, handler)


if __name__ == "__main__":
    # The outer Node CLI validates the sole selector before the child can enter this internal path.
    seconds = json.loads(os.environ["PROOF_REPLAY_STAGE"])["seconds"]
    if type(seconds) is not int or not 1 <= seconds <= 1200:
        sys.exit("A replay takes a deadline of 1 to 1200 whole seconds.")
    sys.exit(supervise(sys.argv[1:], Path(os.environ["PROOF_OUT_DIR"]), work=seconds + BOOTSTRAP_SECONDS))
