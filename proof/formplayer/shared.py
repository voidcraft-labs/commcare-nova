"""One Formplayer that answers HQ's form validation for every worker of a lane server.

HQ asks Formplayer to validate each form it builds (``proof.hq.seams.form_validation``). Formplayer answers
that request statelessly: ``UtilController.validateForm`` parses the posted form with a new ``XFormParser``
and reports through a new ``JSONReporter``, behind a security chain that creates no session
(``WebSecurityConfig``: ``SessionCreationPolicy.STATELESS``; ``HmacAuthFilter`` digests the body with the
shared key and reads a form session only for a JSON body naming one). So one Formplayer answers every
worker's validation, as production's answers every HQ process's, concurrently on its own web server's
threads, and no worker starts a JVM of its own for it.

The lane's server (``proof.lane.serve``) starts the ``Host`` before it boots HQ, so the JVM starts while HQ
boots and the workers set up, and names the host's ready file to every worker it forks as
``PROOF_FORMPLAYER_VALIDATION``. The host is a process of its own that owns the runner
(``FormplayerRunner``, whose reader threads never live in the server, which forks with one thread) and writes
its web server's address to that file once Formplayer is up. A worker's ``Validator`` reads the address at
its first validation, waiting for it if the host is still starting, and posts HQ's request straight to
Formplayer's web server, the request ``FormplayerRunner.validate_form`` sends through the runner. The host
ends when its stdin closes, which only the server holds open.

    python -m proof.formplayer.shared --ready FILE
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.client
import json
import os
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path

from proof.formplayer.client import AUTH_KEY, VALIDATE_FORM, FormplayerRunner, FormplayerRunnerError

# The ready file of the lane server's validation Formplayer, named to every worker it forks.
ENVIRONMENT = "PROOF_FORMPLAYER_VALIDATION"
# Formplayer's start (Flyway's migrations, Hibernate's validation, its web server), as FormplayerRunner allows.
START_SECONDS = 300.0
# How often a worker looks for the ready file while the host starts.
POLL_SECONDS = 0.1


def read_ready(path: Path) -> dict | None:
    """What the host wrote to its ready file (its address and start seconds, or its error), or None before."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


class Validator:
    """A worker's client of the server's validation Formplayer: HQ's form validation request, posted to it."""

    takes_hq_headers = True
    pure_form_validation = True

    def __init__(self, ready: Path | str):
        self.ready = Path(ready)
        self.host: str | None = None
        self.port: int | None = None

    def _address(self) -> tuple[str, int]:
        """The host's address, waiting for its ready file while it starts; admitted by HQ's network guard."""
        if self.host is not None and self.port is not None:
            return self.host, self.port
        # perf_counter and sleep, which HQ's frozen clock leaves running.
        started = time.perf_counter()
        said = read_ready(self.ready)
        while said is None and time.perf_counter() - started < START_SECONDS:
            time.sleep(POLL_SECONDS)
            said = read_ready(self.ready)
        log = self.ready.with_suffix(".log")
        if said is None or not isinstance(said.get("address"), str):
            reason = f"it wrote {said['error']!r}" if said else f"it wrote nothing within {START_SECONDS:.0f} s"
            raise FormplayerRunnerError(
                f"The lane's validation Formplayer did not start ({reason}), so HQ's form validation has no answer"
                f" in this worker. Its host's log is {log}.",
                kind="start",
            )
        host, _, port = said["address"].rpartition(":")
        from proof.hq.boot import GUARD

        # A service the harness started for HQ on a loopback address, as HQ's Redis and Elasticsearch are.
        GUARD.admit(host, int(port))
        self.host, self.port = host, int(port)
        return self.host, self.port

    def validate_form(self, xml: bytes, *, headers: Sequence[tuple[str, str]] | None = None, deadline=60.0) -> str:
        """Formplayer's own answer to HQ's form validation request for these form bytes, as
        ``FormplayerRunner.validate_form`` gives it: the body of its 200, the request signed as HQ signs it
        where ``headers`` does not give HQ's own. Any other answer raises."""
        if headers is None:
            signature = base64.b64encode(hmac.new(AUTH_KEY.encode("utf-8"), xml, hashlib.sha256).digest())
            headers = (("Content-Type", "application/xml"), ("X-MAC-DIGEST", signature.decode("ascii")))
        host, port = self._address()
        # The socket's own timeout, kept in C.
        connection = http.client.HTTPConnection(host, port, timeout=deadline)
        try:
            connection.request("POST", VALIDATE_FORM, body=xml, headers=dict(headers))
            answer = connection.getresponse()
            status, body = answer.status, answer.read()
        except OSError as error:
            raise FormplayerRunnerError(
                f"The lane's validation Formplayer at {host}:{port} did not answer HQ's form validation request"
                f" ({error}), where it answers every worker's while the lane runs. Its JVM's stderr is in"
                f" {self.ready.with_suffix('.log')}.",
                kind="validation",
            ) from error
        finally:
            connection.close()
        if status != 200:
            raise FormplayerRunnerError(
                f"Formplayer answered HQ's form validation request with HTTP {status} ({body[:600]!r}), where it"
                " answers a form it can read with 200 and its report. Its own log is not kept on this path: validate"
                " the same bytes through FormplayerRunner.validate_form, which returns it"
                " (proof/formplayer/test_validation.py does), to read what its security chain or controller said.",
                kind="validation",
            )
        return body.decode("utf-8")

    def close(self) -> None:
        """Nothing: the server's host owns the Formplayer."""


class Host:
    """The lane server's validation Formplayer: a process of its own that owns the runner, writing its address
    to ``<directory>/validation-formplayer.json`` and its log beside it."""

    def __init__(self, directory: Path):
        self.ready = Path(directory) / "validation-formplayer.json"
        self.log = self.ready.with_suffix(".log")
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        self.ready.unlink(missing_ok=True)
        with self.log.open("ab") as output:
            self.process = subprocess.Popen(
                [sys.executable, "-m", "proof.formplayer.shared", "--ready", str(self.ready)],
                stdin=subprocess.PIPE,
                stdout=output,
                stderr=subprocess.STDOUT,
            )

    def fds(self) -> list[int]:
        """The descriptor a forked worker closes, so only the server holds the host's stdin open."""
        process = self.process
        return [process.stdin.fileno()] if process is not None and process.stdin is not None else []

    def close(self) -> dict | None:
        """Closes the host's stdin, which ends its Formplayer, and reaps it; what its ready file said."""
        process = self.process
        if process is None:
            return None
        self.process = None
        if process.stdin is not None:
            try:
                process.stdin.close()
            except OSError:
                pass
        try:
            process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        return read_ready(self.ready)


def _write_ready(path: Path, value: dict) -> None:
    """The ready file, whole or not at all: a worker never reads half of it."""
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(value), encoding="utf-8")
    os.replace(partial, path)


def host(ready: Path) -> int:
    """Starts the runner, writes its web server's address to ``ready``, and serves until stdin closes."""
    started = time.perf_counter()
    runner = FormplayerRunner()
    try:
        runner.start()
        assert runner.ready is not None
        address = f"127.0.0.1:{runner.ready['port']}"
        _write_ready(ready, {"address": address, "seconds": round(time.perf_counter() - started, 3)})
        print(f"The validation Formplayer answers at {address}.", flush=True)
        while os.read(sys.stdin.fileno(), 4096):
            pass
        return 0
    except BaseException as error:  # noqa: BLE001 - written where the workers look, and to the log
        print(f"The validation Formplayer did not start: {error}", flush=True)
        _write_ready(ready, {"error": str(error)})
        return 1
    finally:
        # The JVM's stderr, which the runner keeps, into the host's log.
        print(runner.stderr, flush=True)
        runner.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m proof.formplayer.shared", description=__doc__.split("\n")[0])
    parser.add_argument("--ready", type=Path, required=True, help="where to write the address once Formplayer is up")
    sys.exit(host(parser.parse_args().ready))
