"""Connect, ready to run: its source at the pin, its services, and its database as its own migrations leave it.

``ConnectRuntime`` owns one directory and everything in it:

- Connect's source, fetched at its pin (``proof.connect.checkout``);
- a Postgres 15 cluster with PostGIS and a Redis, the two services
  Connect's ``docker-compose.yml`` starts beside it, each a process of the
  harness's own (``proof.processes``), stopped and reaped with the runtime.
  Postgres listens on a socket in the runtime's directory and on no port;
  Redis on a loopback port of the runtime's own. Connect needs both: its
  models hold PostGIS geometry, and its receiver takes a Redis lock while it
  recomputes what a worker has earned
  (``opportunity/visit_import.py::update_payment_accrued_for_user``) and
  sends its Celery broker the tasks a submission schedules;
- Connect's database, made once by Connect's own ``manage.py migrate`` and
  kept as a template; each scenario runs in a clone of it, over an emptied
  Redis, so no scenario reads what another left.

Every Connect process runs on Connect's interpreter and virtualenv
(``PROOF_CONNECT_VENV``, from Connect's own lock at the pin) with Connect's
own test settings (``config.settings.test``, which change nothing the
receiver reads: the password hasher, the template debug flag, the static
files storage and the Redis database). Nothing here imports Connect or
Django: the harness's process is HQ's.

``ConnectRuntime.run`` runs one scenario's steps to their end in one such
process. ``ConnectRuntime.session`` is Connect as a deployment runs it, for
as long as an opportunity is observed (``ConnectSession``): Connect's own
WSGI application answering on a loopback address of this process's own,
where HQ's Connect repeater posts each form over a real connection, and the
driver's steps taken one at a time. A session keeps named copies of its
database (``checkpoint``) and goes back to one (``restore``), so each run of
a walk meets the opportunity as it stood, as each run meets HQ as it stood.

Postgres refuses to run as root, which the lane's container is, so there its
processes run as the ``postgres`` user the package made and the cluster's
directory is that user's.
"""

from __future__ import annotations

import base64
import json
import os
import select
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from proof import processes
from proof.connect import checkout as connect_checkout

DRIVER = Path(__file__).with_name("driver.py")
SETTINGS = "config.settings.test"
ROLE = "proof"
TEMPLATE = "connect_template"
START_TIMEOUT_SECONDS = 60
MIGRATE_TIMEOUT_SECONDS = 600
SCENARIO_TIMEOUT_SECONDS = 300
COMMAND_TIMEOUT_SECONDS = 60
# Redis's loopback ports, one per runtime: this process's id picks one of 20000 above the registered range.
REDIS_PORT_BASE = 20000
REDIS_PORTS = 20000
# Where a session's Connect answers HTTP: a loopback address this process's id names (127.2.<a>.<b>, apart from
# the addresses HQ's and Formplayer's Redis take, proof.hq.redis), on the port a web server answers at.
HTTP_PORT = 80
SESSION_START_SECONDS = 120
STEP_SECONDS = 300


class ConnectRuntimeMissing(RuntimeError):
    """The image holds no Connect runtime."""


class ConnectRuntimeFailed(RuntimeError):
    """A Connect service, its migrations or a scenario's process did not run."""


def _required(variable):
    value = os.environ.get(variable)
    if not value or not Path(value).exists():
        raise ConnectRuntimeMissing(
            f"The Connect proofs run Connect on its own interpreter, Postgres and Redis, which the harness image"
            f" holds and names in {variable}; here it names {value!r}. The image this run uses was built before the"
            " recipe held the Connect runtime (proof/image/Dockerfile, the `full` stage): build the image from this"
            ' checkout\'s recipe and run with it (proof/README.md, "Building the image"), or record the rebuilt'
            " image in proof/image.lock."
        )
    return Path(value)


class ConnectRuntime:
    """Connect's source, services and migrated database, for the life of one ``with`` block."""

    def __init__(self, log_directory: Path, checkout: connect_checkout.Checkout | None = None):
        self.logs = log_directory
        self.timings: dict[str, float] = {}
        self._given_checkout = checkout
        self.checkout: connect_checkout.Checkout | None = None
        self._root: Path | None = None
        self._groups: list[processes.ProcessGroup] = []
        self._files = []
        self._scenarios = 0

    # Lifetime ------------------------------------------------------------------------------------------------

    def __enter__(self):
        try:
            self._start()
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def close(self):
        for group in reversed(self._groups):
            group.stop()
        self._groups.clear()
        for file in self._files:
            file.close()
        self._files.clear()
        if self._root is not None:
            shutil.rmtree(self._root, ignore_errors=True)
            self._root = None

    def _start(self):
        self._python = _required("PROOF_CONNECT_VENV") / "bin" / "python"
        self._postgres_bin = _required("PROOF_CONNECT_POSTGRES")
        self.logs.mkdir(parents=True, exist_ok=True)
        self._root = Path(tempfile.mkdtemp(prefix="proof-connect-"))
        # Postgres's own user reaches its cluster and socket through this directory.
        self._root.chmod(0o755)
        self._as_postgres = (
            ["setpriv", "--reuid=postgres", "--regid=postgres", "--init-groups"] if os.geteuid() == 0 else []
        )
        with self._timed("fetch"):
            self.checkout = self._given_checkout or connect_checkout.fetch(
                self._root / "commcare-connect", self.logs / "commcare-connect.fetch.log"
            )
        with self._timed("services"):
            self._start_postgres()
            self._start_redis()
        with self._timed("migrate"):
            self._migrate()

    @contextmanager
    def _timed(self, name):
        started = time.perf_counter()
        try:
            yield
        finally:
            self.timings[name] = round(time.perf_counter() - started, 3)

    # Services ------------------------------------------------------------------------------------------------

    def _command(self, name, command, *, timeout=COMMAND_TIMEOUT_SECONDS, env=None, cwd=None):
        """Run one command to its end, its output in the runtime's log of that name; raise unless it exits 0."""
        log = self.logs / f"connect.{name}.log"
        with log.open("ab") as output:
            try:
                status = processes.run(
                    command, timeout=timeout, env=env, cwd=cwd, stdout=output, stderr=subprocess.STDOUT
                )
            except processes.TimedOut as late:
                raise ConnectRuntimeFailed(f"{late} Its output is in {log}.") from None
        if status != 0:
            raise ConnectRuntimeFailed(
                f"The Connect runtime's {name} step exited with status {status}. Its output ({log}) ends:\n"
                f"{log.read_text(errors='replace')[-3000:]}"
            )

    def _service(self, name, command):
        log = (self.logs / f"connect.{name}.log").open("ab")
        self._files.append(log)
        group = processes.ProcessGroup(command, stdout=log, stderr=subprocess.STDOUT)
        self._groups.append(group)
        return group

    def _await(self, name, group, probe):
        """Wait until ``probe`` (a command that exits 0 once the service answers) succeeds, the service's own exit
        ending the wait at once."""
        deadline = time.perf_counter() + START_TIMEOUT_SECONDS
        while True:
            if (
                processes.run(
                    probe, timeout=COMMAND_TIMEOUT_SECONDS, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                == 0
            ):
                return
            if group.wait(0.1) or time.perf_counter() > deadline:
                log = self.logs / f"connect.{name}.log"
                raise ConnectRuntimeFailed(
                    f"Connect's {name} did not come up within {START_TIMEOUT_SECONDS} s. Its output ({log}) ends:\n"
                    f"{log.read_text(errors='replace')[-3000:]}"
                )

    def _start_postgres(self):
        cluster = self._root / "postgres"
        self._sockets = self._root / "sockets"
        for directory in (cluster, self._sockets):
            directory.mkdir()
            if self._as_postgres:
                shutil.chown(directory, "postgres", "postgres")
        self._command(
            "initdb",
            [
                *self._as_postgres,
                str(self._postgres_bin / "initdb"),
                "--pgdata",
                str(cluster),
                "--username",
                ROLE,
                "--auth",
                "trust",
                "--encoding",
                "UTF8",
                "--locale",
                "C.UTF-8",
            ],
        )
        group = self._service(
            "postgres",
            [
                *self._as_postgres,
                str(self._postgres_bin / "postgres"),
                "-D",
                str(cluster),
                "-k",
                str(self._sockets),
                "-c",
                "listen_addresses=",
                # Nothing outlives the runtime, so nothing is made durable.
                "-c",
                "fsync=off",
                "-c",
                "synchronous_commit=off",
                "-c",
                "full_page_writes=off",
                # The slim image keeps no LLVM (proof/image/Dockerfile, `pruned`), which Postgres's JIT loads on
                # a costly query; no query here is one, and a plan never changes a result.
                "-c",
                "jit=off",
            ],
        )
        self._await("postgres", group, [str(self._postgres_bin / "pg_isready"), "-h", str(self._sockets), "-q"])
        self._sql("postgres", f'CREATE DATABASE "{TEMPLATE}"')

    def _start_redis(self):
        self._redis_port = REDIS_PORT_BASE + os.getpid() % REDIS_PORTS
        directory = self._root / "redis"
        directory.mkdir()
        group = self._service(
            "redis",
            [
                "redis-server",
                "--bind",
                "127.0.0.1",
                "--port",
                str(self._redis_port),
                "--dir",
                str(directory),
                "--save",
                "",
                "--appendonly",
                "no",
            ],
        )
        self._await("redis", group, ["redis-cli", "-h", "127.0.0.1", "-p", str(self._redis_port), "ping"])

    def _sql(self, database, statement):
        self._command(
            "psql",
            [
                str(self._postgres_bin / "psql"),
                "-h",
                str(self._sockets),
                "-U",
                ROLE,
                "-d",
                database,
                "-v",
                "ON_ERROR_STOP=1",
                "-q",
                "-c",
                statement,
            ],
        )

    # Connect's processes -------------------------------------------------------------------------------------

    def _environment(self, database):
        redis = f"redis://127.0.0.1:{self._redis_port}/0"
        return {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TZ": "UTC",
            "HOME": str(self._root),
            "DJANGO_SETTINGS_MODULE": SETTINGS,
            # django-environ reads a path in the host's place as the socket's directory.
            "DATABASE_URL": f"postgres:///{self._sockets}/{database}",
            "PGUSER": ROLE,
            "REDIS_URL": redis,
            "CELERY_BROKER_URL": redis,
            # Connect's test settings move its cache to another Redis database; one database holds both here.
            "TEST_REDIS_DB": "0",
            "PYTHONHASHSEED": "0",
        }

    def _migrate(self):
        self._command(
            "migrate",
            [str(self._python), "manage.py", "migrate", "--noinput"],
            timeout=MIGRATE_TIMEOUT_SECONDS,
            env=self._environment(TEMPLATE),
            cwd=self.checkout.path,
        )

    def run(self, scenario: dict) -> list:
        """One scenario (``proof/connect/driver.py``) in a database and a Redis of its own: each step's result."""
        self._scenarios += 1
        name = f"scenario_{self._scenarios}"
        directory = self._root / name
        directory.mkdir()
        spec, result = directory / "scenario.json", directory / "result.json"
        spec.write_text(json.dumps(scenario))
        self._sql("postgres", f'CREATE DATABASE "{name}" TEMPLATE "{TEMPLATE}"')
        self._command("redis-flush", ["redis-cli", "-h", "127.0.0.1", "-p", str(self._redis_port), "flushall"])
        log = self.logs / f"connect.{name}.log"
        started = time.perf_counter()
        try:
            with log.open("wb") as output:
                processes.run(
                    [str(self._python), str(DRIVER), str(self.checkout.path), str(spec), str(result)],
                    timeout=SCENARIO_TIMEOUT_SECONDS,
                    env=self._environment(name),
                    cwd=self.checkout.path,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                )
        except processes.TimedOut as late:
            raise ConnectRuntimeFailed(f"{late} Its output is in {log}.") from None
        finally:
            self.timings[name] = round(time.perf_counter() - started, 3)
        if not result.is_file():
            raise ConnectRuntimeFailed(
                f"Connect's driver wrote no result for {name}. Its output ({log}) ends:\n"
                f"{log.read_text(errors='replace')[-3000:]}"
            )
        outcome = json.loads(result.read_text())
        self._sql("postgres", f'DROP DATABASE "{name}"')
        if "failed" in outcome:
            raise ConnectRuntimeFailed(f"Connect's driver failed in {name}:\n{outcome['failed']}")
        return outcome["steps"]

    # Connect, served -----------------------------------------------------------------------------------------

    def session(self, answer_hq) -> ConnectSession:
        """Connect served on an address of its own, in a database of its own (a clone of the migrated one) over
        an emptied Redis; ``answer_hq(method, url, headers, body) -> (status, headers, body)`` answers each
        request Connect makes of its HQ server. The caller closes it."""
        self._scenarios += 1
        session = ConnectSession(self, f"session_{self._scenarios}", answer_hq)
        try:
            session.start()
        except BaseException:
            session.close()
            raise
        return session


class ConnectSession:
    """One served Connect (``proof/connect/driver.py serve``): its address, its steps and its database's copies."""

    def __init__(self, runtime, name, answer_hq):
        self._runtime, self.name, self._answer_hq = runtime, name, answer_hq
        self._group = None
        self._log = None
        self._to_driver = self._from_driver = None
        self._buffer = b""
        self._databases = []
        self._database = None
        self._copies = 0
        slot = os.getpid() % 40000
        self.host = f"127.2.{slot // 200 + 1}.{slot % 200 + 2}"
        self.port = HTTP_PORT
        self.seconds = 0.0

    @property
    def url(self) -> str:
        return f"http://{self.host}" if self.port == 80 else f"http://{self.host}:{self.port}"

    def start(self):
        runtime = self._runtime
        self._database = self._copy(TEMPLATE)
        runtime._command("redis-flush", ["redis-cli", "-h", "127.0.0.1", "-p", str(runtime._redis_port), "flushall"])
        self._log = (runtime.logs / f"connect.{self.name}.log").open("wb")
        to_driver_read, self._to_driver = os.pipe()
        self._from_driver, from_driver_write = os.pipe()
        try:
            self._group = processes.ProcessGroup(
                [str(runtime._python), str(DRIVER), "serve", str(runtime.checkout.path), self.host, str(self.port)],
                env=runtime._environment(self._database),
                cwd=runtime.checkout.path,
                stdin=to_driver_read,
                stdout=from_driver_write,
                stderr=self._log,
            )
        finally:
            os.close(to_driver_read)
            os.close(from_driver_write)
        ready = self._read(SESSION_START_SECONDS)
        if "ready" not in ready:
            raise ConnectRuntimeFailed(f"Connect's driver did not start serving: {ready}")

    def _fail(self, what):
        log = self._runtime.logs / f"connect.{self.name}.log"
        return ConnectRuntimeFailed(f"{what} Its output ({log}) ends:\n{log.read_text(errors='replace')[-3000:]}")

    def _read(self, timeout):
        """The driver's next line, waited for on its pipe and on its exit."""
        deadline = time.perf_counter() + timeout
        while b"\n" not in self._buffer:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                raise self._fail(f"Connect's driver ({self.name}) did not answer within {timeout} s.")
            readable, _, _ = select.select([self._from_driver, self._group.fileno()], [], [], remaining)
            if self._from_driver in readable:
                chunk = os.read(self._from_driver, 1 << 16)
                if not chunk:
                    raise self._fail(f"Connect's driver ({self.name}) closed its output.")
                self._buffer += chunk
            elif readable:
                raise self._fail(f"Connect's driver ({self.name}) exited.")
        line, self._buffer = self._buffer.split(b"\n", 1)
        return json.loads(line)

    def _write(self, message):
        os.write(self._to_driver, json.dumps(message).encode("utf-8") + b"\n")

    def step(self, do, **fields):
        """One step of the driver, each request Connect makes of HQ meanwhile answered by ``answer_hq``."""
        started = time.perf_counter()
        try:
            self._write({"do": do, **fields})
            while True:
                message = self._read(STEP_SECONDS)
                if "ask" in message:
                    ask = message["ask"]
                    status, headers, body = self._answer_hq(
                        ask["method"], ask["url"], ask["headers"], base64.b64decode(ask["body"])
                    )
                    self._write(
                        {
                            "answer": {
                                "status": status,
                                "headers": [list(header) for header in headers],
                                "body": base64.b64encode(body).decode("ascii"),
                            }
                        }
                    )
                    continue
                if "failed" in message:
                    raise ConnectRuntimeFailed(f"Connect's driver failed its {do} step:\n{message['failed']}")
                return message["result"]
        finally:
            self.seconds += time.perf_counter() - started

    # The database's copies -----------------------------------------------------------------------------------

    def _copy(self, source):
        self._copies += 1
        name = f"{self.name}_{self._copies}"
        self._runtime._sql("postgres", f'CREATE DATABASE "{name}" TEMPLATE "{source}"')
        self._databases.append(name)
        return name

    def _drop(self, name):
        self._runtime._sql("postgres", f'DROP DATABASE IF EXISTS "{name}"')
        if name in self._databases:
            self._databases.remove(name)

    def checkpoint(self) -> str:
        """A copy of Connect's database as it stands, by name, which ``restore`` goes back to."""
        started = time.perf_counter()
        self.step("release")
        name = self._copy(self._database)
        self.step("use", database=self._database)
        self.seconds += time.perf_counter() - started
        return name

    def restore(self, checkpoint: str):
        """Connect's database is a fresh copy of ``checkpoint`` from here on; the one it left is dropped."""
        started = time.perf_counter()
        self.step("release")
        left, self._database = self._database, self._copy(checkpoint)
        self.step("use", database=self._database)
        self._drop(left)
        self.seconds += time.perf_counter() - started

    def close(self):
        if self._group is not None:
            self._group.stop()
            self._group = None
        for descriptor in (self._to_driver, self._from_driver):
            if descriptor is not None:
                os.close(descriptor)
        self._to_driver = self._from_driver = None
        if self._log is not None:
            self._log.close()
            self._log = None
        for name in list(self._databases):
            try:
                self._drop(name)
            except ConnectRuntimeFailed:
                pass
