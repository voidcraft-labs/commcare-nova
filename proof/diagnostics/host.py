"""A POSIX process supervisor for a single bounded diagnostic, including a wedged container or teardown."""

from __future__ import annotations

import json
import os
import secrets
import signal
import subprocess
import sys
import time
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


def supervise(command, output, *, work, grace=SHUTDOWN_SECONDS, environ=None, cleanup=_cleanup):
    """Hold the host directory and the child process group for the entire run, including cancellation."""
    env = os.environ if environ is None else environ
    project = "nova-proof-replay-" + secrets.token_hex(8)
    started = time.perf_counter()
    stop = None
    old = {}

    def interrupt(signum, frame):
        nonlocal stop
        if stop is None:
            stop = ("interrupted", 128 + signum)

    directory = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    child, cleaned = None, None
    status, code = "launch-failed", 2
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            old[sig] = signal.signal(sig, interrupt)
        deadline = int(time.time() + work)
        child = subprocess.Popen(
            command,
            start_new_session=True,
            env={
                **env,
                "PROOF_OUT_DIR": str(output),
                "PROOF_DIAGNOSTIC_PROJECT": project,
                "PROOF_DIAGNOSTIC_DEADLINE_AT": str(deadline),
            },
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
                pass
            _kill(child.pid, signal.SIGKILL)
            child.wait()
            cleaned = cleanup(project, env)
        return code
    finally:
        try:
            record = {
                "status": status,
                "exit": code,
                "elapsedSeconds": round(time.perf_counter() - started, 2),
                "bootstrapAllowance": BOOTSTRAP_SECONDS,
                "dockerCleanup": cleaned,
            }
            # The mount's parent is owned by the host. Never follow a file or directory the child might have replaced.
            staged = ".host-status-" + secrets.token_hex(8)
            fd = os.open(staged, os.O_WRONLY | os.O_EXCL | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(fd, "w") as report:
                json.dump(record, report)
            os.replace(staged, "host-status.json", src_dir_fd=directory, dst_dir_fd=directory)
        finally:
            os.close(directory)
            for sig, handler in old.items():
                signal.signal(sig, handler)


if __name__ == "__main__":
    # The outer Node CLI validates the sole selector before the child can enter this internal path.
    seconds = json.loads(os.environ["PROOF_REPLAY_STAGE"])["seconds"]
    if type(seconds) is not int or not 1 <= seconds <= 1200:
        sys.exit("A replay takes a deadline of 1 to 1200 whole seconds.")
    sys.exit(supervise(sys.argv[1:], Path(os.environ["PROOF_OUT_DIR"]), work=seconds + BOOTSTRAP_SECONDS))
