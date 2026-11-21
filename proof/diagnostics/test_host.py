"""The outer host certifies output only after the actual launcher stops and Docker confirms writer absence."""

import json
import os
import signal
import subprocess
import sys

import pytest

from proof.diagnostics import host


@pytest.fixture
def daemon(tmp_path, monkeypatch):
    docker = tmp_path / "docker"
    docker.write_text("""#!/bin/sh
case "$1" in
  ps)
    case "$5" in "name=^/nova-proof-replay-"*"-reader$") ;; *) exit 5 ;; esac
    case "$DOCKER_STATE" in unavailable) exit 3 ;; surviving) echo reader ;; esac ;;
  rm) exit 0 ;;
  *) exit 6 ;;
esac
""")
    docker.chmod(0o700)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    output = tmp_path / "output"
    output.mkdir()
    return output


@pytest.mark.parametrize("cleaned", [True, False, None])
def test_hard_timeout_after_native_work_needs_verified_cleanup(daemon, cleaned):
    marker = daemon / "entered"
    command = [
        sys.executable, "-c",
        f"import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);"
        f"Path({str(marker)!r}).write_text('native reader is waiting');time.sleep(120)",
    ]
    assert host.supervise(command, daemon, work=0.8, grace=0.1, cleanup=lambda p, e: cleaned) == 124
    assert marker.is_file()
    record = json.loads(host.status_path(daemon).read_bytes())
    assert record["status"] == "timed-out" and record["dockerCleanup"] is cleaned and record["sealed"] is (cleaned is True)
    assert record["elapsedSeconds"] < 10
    if cleaned:
        with host.certified_output(daemon, successful=False) as received:
            assert received == record
    else:
        with pytest.raises(ValueError, match="did not certify"):
            with host.certified_output(daemon, successful=False):
                pytest.fail("uncertified output was opened")


def test_reuse_requires_a_complete_prior_host_receipt(daemon):
    marker = daemon / "should-not-start"
    path = host.status_path(daemon)
    path.write_text(json.dumps({"sealed": True}))
    with pytest.raises(ValueError, match="Invalid host receipt"):
        host.supervise([sys.executable, "-c", f"from pathlib import Path; Path({str(marker)!r}).touch()"],
                       daemon, work=5)
    assert not marker.exists()
    assert json.loads(path.read_text()) == {"sealed": True}


@pytest.mark.parametrize("state", ["unavailable", "surviving"])
def test_even_a_failed_launcher_cannot_seal_until_docker_confirms_the_reader_gone(daemon, monkeypatch, state):
    # The seal would quarantine this benign non-file entry. It must never even inspect the tree here.
    (daemon / "unsealed-link").symlink_to("fixture")
    monkeypatch.setenv("DOCKER_STATE", state)
    assert host.supervise([sys.executable, "-c", "raise SystemExit(9)"], daemon, work=5) == 9
    assert (daemon / "unsealed-link").is_symlink()
    assert json.loads(host.status_path(daemon).read_bytes())["sealed"] is False
    with pytest.raises(ValueError, match="did not certify"):
        with host.certified_output(daemon, successful=False):
            pytest.fail("uncertified output was opened")


def test_signal_to_only_the_host_and_ordinary_completion_have_distinct_receipts(daemon):
    child = subprocess.Popen(
        [sys.executable, "-c", """
from proof.diagnostics.host import supervise
from pathlib import Path
import sys
command=[sys.executable,'-u','-c',"import time;print('entered');time.sleep(120)"]
sys.exit(supervise(command,Path(sys.argv[1]),work=60,grace=.1,cleanup=lambda p,e: True))
""", str(daemon)], stdout=subprocess.PIPE, text=True,
    )
    try:
        assert child.stdout.readline().strip() == "entered"
        child.send_signal(signal.SIGINT)
        assert child.wait(timeout=8) == 130
    finally:
        child.kill()
        child.wait()
        child.stdout.close()
    with host.certified_output(daemon, successful=False) as received:
        assert received["status"] == "interrupted"
        with pytest.raises(BlockingIOError):
            host.supervise([sys.executable, "-c", "pass"], daemon, work=10)
    assert host.supervise([sys.executable, "-c", "pass"], daemon, work=10) == 0
    with host.certified_output(daemon, successful=True) as receipt:
        assert receipt["status"] == "finished" and receipt["dockerCleanup"] is None
