"""The outer host stops a hung reader even when neither its process group nor native teardown honors TERM."""

import json
import signal
import subprocess
import sys

from proof.diagnostics import host


def test_hard_timeout_bounds_unresponsive_native_work_and_keeps_its_receipt(tmp_path):
    marker = tmp_path / "entered"
    command = [
        sys.executable,
        "-c",
        (
            f"import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);"
            f"Path({str(marker)!r}).write_text('native reader is waiting');time.sleep(120)"
        ),
    ]
    cleanups = []

    def cleanup(project, env):
        cleanups.append(project)
        return False

    assert host.supervise(command, tmp_path, work=0.8, grace=0.1, cleanup=cleanup) == 124
    assert marker.is_file() and len(cleanups) == 1 and cleanups[0].startswith("nova-proof-replay-")
    record = json.loads((tmp_path / "host-status.json").read_bytes())
    assert record["status"] == "timed-out" and record["dockerCleanup"] is False
    assert record["elapsedSeconds"] < 10


def test_signal_to_only_the_host_and_ordinary_completion_have_distinct_receipts(tmp_path):
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            """
from proof.diagnostics.host import supervise
from pathlib import Path
import sys
command=[sys.executable,'-u','-c',"import time;print('entered');time.sleep(120)"]
sys.exit(supervise(command,Path(sys.argv[1]),work=60,grace=.1,cleanup=lambda p,e: True))
""",
            str(tmp_path),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout.readline().strip() == "entered"
        child.send_signal(signal.SIGINT)
        assert child.wait(timeout=8) == 130
    finally:
        child.kill()
        child.wait()
        child.stdout.close()
    assert json.loads((tmp_path / "host-status.json").read_bytes())["status"] == "interrupted"
    assert host.supervise([sys.executable, "-c", "pass"], tmp_path, work=10) == 0
    receipt = json.loads((tmp_path / "host-status.json").read_bytes())
    assert receipt["status"] == "finished" and receipt["dockerCleanup"] is None
