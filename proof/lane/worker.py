"""What a forked lane worker does, from the fork to its exit.

The server forks a worker from its booted, warmed and frozen process
(``proof.hq.boot.prepare_for_fork``), so the worker starts with HQ booted,
the template restored, the Core runner compiled and the lane's test modules
imported. The worker then:

1. leads a process group of its own (so the server can stop it and every
   process it started at once), puts back the default signal handlers, and
   closes every file of the server's it inherited;
2. writes its standard output and error into the pipe the server reads,
   which prefixes each line and keeps it in ``workers/w<n>.log``;
3. takes its lane position, ``PROOF_WORKER=<w>/<k>``, which names its HQ
   databases (``proof.hq.database``: it clones its own database from the
   template its server restored the first time a unit needs one), and its
   own output directory, ``workers/w<n>/``, as ``PROOF_OUT`` outside its
   groups;
4. runs one pytest session over the phase's selection with
   ``proof.lane.plugin.LanePlugin``, whose session services (its Core runner
   JVM, its editor driver) are its own;
5. joins its HQ children (the XPath validator's node,
   ``proof.hq.speed.stop_children``) and ends with ``os._exit`` and pytest's
   exit code, running none of the handlers the server registered.

Anything that escapes the session ends the worker with ``EXIT_ESCAPED``
after printing it; the server then fails the group the worker was running.
"""

from __future__ import annotations

import os
import signal
import sys
import traceback
from pathlib import Path

# A worker whose session raised past pytest (sysexits' EX_SOFTWARE).
EXIT_ESCAPED = 70


def run(
    *,
    channel,
    output_fd: int,
    close_fds,
    sequence: int,
    position: str,
    workers: int,
    out: Path,
    label: str,
    pytest_args,
):
    """Run the worker's session and end the process; never returns."""
    code = EXIT_ESCAPED
    try:
        os.setpgid(0, 0)
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.default_int_handler)
        for fd in close_fds:
            try:
                os.close(fd)
            except OSError:
                pass
        os.dup2(output_fd, 1)
        os.dup2(output_fd, 2)
        os.close(output_fd)
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)

        # The template's restore is the server's, recorded in its serve.json, not this worker's cost.
        from proof.hq import database

        database.RESTORE_SECONDS.clear()

        worker_out = Path(out) / "workers" / f"w{sequence}"
        worker_out.mkdir(parents=True, exist_ok=True)
        os.environ["PROOF_WORKER"] = position
        os.environ["PROOF_OUT"] = str(worker_out)

        import pytest

        from proof.lane.plugin import Channel, LanePlugin

        plugin = LanePlugin(
            Channel(channel),
            output=Path(out),
            worker=sequence,
            workers=workers,
            timings_path=Path(out) / "timings" / f"{label}-w{sequence}.json",
        )
        code = int(pytest.main(list(pytest_args), plugins=[plugin]))
    except BaseException:
        traceback.print_exc()
        code = EXIT_ESCAPED
    finally:
        try:
            from proof.hq import speed

            speed.stop_children()
        except BaseException:
            traceback.print_exc()
            code = EXIT_ESCAPED
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        finally:
            os._exit(code)
