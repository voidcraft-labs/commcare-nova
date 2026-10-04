"""HQ's migrated database: the session's template, and each worker's own clone of it.

HQ's state lives in the database HQ's own migrations create. The image ships
it as a plain SQL dump (``PROOF_HQ_SCHEMA``, made by running every app's
migrations in ``proof/image/hq-schema/migrate.py``), so every table,
function, trigger, constraint and row those migrations create exists exactly
as they leave it, and a path that reaches a table the dump lacks fails in
Postgres with "relation ... does not exist".

- ``restore_template()`` restores the dump with ``psql`` into the session's
  template database, in one transaction, reads every sequence's value there
  (``template_sequences()``) and the name of every function it defines
  outside ``pg_catalog`` and ``information_schema``
  (``template_functions()``, HQ's PL/pgSQL), then marks it a template that
  allows no connections (Postgres clones a database only while nothing is
  connected to it). It runs once per session, in the process that boots HQ:
  under the lane's fork server, the parent, before it forks its workers. A
  failed restore fails every unit of the session with the same message,
  naming the dump; it is not retried.
- ``worker_database()`` is the database every unit of this process runs in
  (``proof.hq.state``): cloned once from the template
  (``CREATE DATABASE <unit> TEMPLATE <template>``) the first time a unit
  needs it, and HQ's ``default`` connection pointed at it. A unit is one
  transaction that is always rolled back, and its exit sets every sequence
  back to the template's value, so the next unit starts from the template's
  state again (``proof.hq.branch``).
- ``fresh_database()`` clones a database of its own for one block and drops
  it at exit, whether the block passed or failed: the per-check database the
  harness gave each check before units, kept as the reference the branch
  proofs compare units with (``proof/hq/test_branches.py``).

A lane's workers share one Postgres, so every name a process gives a
database carries its worker (``PROOF_WORKER=w/k``, read when the database is
made; worker 1 when unset; ``database_names``): ``proof_hq_w<w>_template``,
``proof_hq_w<w>_unit`` and ``proof_hq_w<w>_check_<id>``, under the namespace
``proof_hq_w<w>_``, which no other worker's names start with. A forked worker
sets ``PROOF_WORKER`` before its first unit; it clones the template its
parent restored. Before making its database, a process drops what an earlier
session of the same worker left behind under its names, except a fresh
database open now; restoring the template also drops the worker's leftover
template and clones. Other workers' databases are never touched.
``drop_template()`` drops what this process made: its worker database, and
the template if this process restored it.
"""

import os
import shutil
import subprocess
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from proof.checks.sharding import parse_shard

SCHEMA_DUMP = Path(os.environ.get("PROOF_HQ_SCHEMA", "/opt/hq-schema/hq.sql"))


@dataclass(frozen=True)
class DatabaseNames:
    """The names one worker gives its databases."""

    template: str
    unit: str
    check_prefix: str


def database_names(worker: int) -> DatabaseNames:
    """Worker ``worker``'s names, all under ``proof_hq_w<worker>_``: the trailing ``_`` keeps worker 1's
    names from being a prefix of worker 10's."""
    namespace = f"proof_hq_w{worker}_"
    return DatabaseNames(template=f"{namespace}template", unit=f"{namespace}unit", check_prefix=f"{namespace}check_")


def session_worker(environment=None) -> int:
    """This process's worker in the lane, from ``PROOF_WORKER=w/k`` (1 when unset), read as the shards read it."""
    value = (os.environ if environment is None else environment).get("PROOF_WORKER", "")
    return parse_shard(value, "PROOF_WORKER")[0] if value else 1


# A restore takes under a second; this bounds a psql that never finishes. It
# runs outside every HQ operation, whose frozen clock would stall the timeout.
RESTORE_TIMEOUT_SECONDS = 300

# What the databases cost, in seconds: the session's restore of the dump,
# each clone (the worker's, and each fresh one) and each drop, in order.
RESTORE_SECONDS: list[float] = []
CLONE_SECONDS: list[float] = []
DROP_SECONDS: list[float] = []

# Every sequence's value as the template holds it: ``last_value`` (None for a
# sequence never used) and ``start_value``, by its quoted qualified name.
SEQUENCES_SQL = "SELECT format('%I.%I', schemaname, sequencename), last_value, start_value FROM pg_sequences"
# The name of every function the database defines beyond Postgres's own.
FUNCTIONS_SQL = (
    "SELECT DISTINCT proname FROM pg_proc "
    "WHERE pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)"
)


class SchemaRestoreFailed(RuntimeError):
    """HQ's migrated database could not be restored, so no unit has HQ's state."""


@dataclass(frozen=True)
class ClonedDatabase:
    """A database the harness cloned from the template."""

    name: str


@dataclass
class _Template:
    names: DatabaseNames | None = None
    # The process that restored it, the only one that drops it.
    owner: int | None = None
    sequences: dict = field(default_factory=dict)
    functions: frozenset = frozenset()
    # The message of a failed restore, raised again for every later unit.
    failure: str | None = None


@dataclass
class _Worker:
    database: ClonedDatabase | None = None
    owner: int | None = None


_TEMPLATE = _Template()
_WORKER = _Worker()
# The fresh databases open now, innermost last.
_FRESH: list[str] = []


def _settings():
    from django.db import connections

    return connections["default"].settings_dict


def _maintenance_connection(settings_dict, dbname=None):
    import psycopg2

    connection = psycopg2.connect(
        dbname=dbname or settings_dict["TEST"]["NAME"],
        user=settings_dict["USER"],
        password=settings_dict["PASSWORD"],
        host=settings_dict["HOST"],
        port=settings_dict["PORT"],
    )
    connection.autocommit = True
    return connection


def _drop_template_in(cursor, names: DatabaseNames):
    cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", [names.template])
    if cursor.fetchone() is None:
        return
    # Postgres refuses to drop a database marked as a template.
    cursor.execute(f'ALTER DATABASE "{names.template}" WITH IS_TEMPLATE false')
    cursor.execute(f'DROP DATABASE "{names.template}" WITH (FORCE)')


def _drop_clones_in(cursor, names: DatabaseNames, keep=()):
    """Drop the worker's own unit database and every fresh clone it never dropped, except those in ``keep``."""
    cursor.execute(
        "SELECT datname FROM pg_database WHERE datname = %s OR starts_with(datname, %s)",
        [names.unit, names.check_prefix],
    )
    for (name,) in cursor.fetchall():
        if name not in keep:
            cursor.execute(f'DROP DATABASE "{name}" WITH (FORCE)')


def _drop_left_behind(cursor, names: DatabaseNames):
    """Drop what an earlier session of this worker left: its template, its unit database and its clones."""
    _drop_template_in(cursor, names)
    _drop_clones_in(cursor, names)


def _restore_failed(what_happened, template):
    return SchemaRestoreFailed(
        f"The proof harness could not restore HQ's migrated database from {SCHEMA_DUMP} "
        f"(PROOF_HQ_SCHEMA) into the template database {template}, so no unit has HQ's "
        f"state.\n{what_happened}\nThe image builds that dump from HQ's migrations "
        "(proof/image/hq-schema): check that the image was built whole, and that the lane's "
        "Postgres is version 14, as the image's is."
    )


def _run_psql(settings_dict, template):
    psql = shutil.which("psql")
    if psql is None:
        raise _restore_failed("psql is not on PATH; the proof image installs it (postgresql-client-14).", template)
    environment = {
        **os.environ,
        "PGHOST": settings_dict["HOST"],
        "PGPORT": str(settings_dict["PORT"]),
        "PGUSER": settings_dict["USER"],
        "PGPASSWORD": settings_dict["PASSWORD"],
        "PGDATABASE": template,
        "PGCONNECT_TIMEOUT": "10",
    }
    command = [psql, "--no-psqlrc", "--quiet", "--set=ON_ERROR_STOP=1", "--single-transaction", "--file", SCHEMA_DUMP]
    try:
        # The dump's own output (the results of its SELECTs) is discarded;
        # psql writes what went wrong to stderr.
        result = subprocess.run(
            command,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=RESTORE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise _restore_failed(
            f"psql did not finish within {RESTORE_TIMEOUT_SECONDS} s and was stopped.", template
        ) from None
    if result.returncode != 0:
        errors = result.stderr.strip() or "(psql wrote nothing to stderr)"
        raise _restore_failed(f"psql exited with status {result.returncode}:\n{errors}", template)


def read_sequences(cursor) -> dict:
    """Every sequence's ``(last_value, start_value)`` the cursor's database holds, by quoted qualified name."""
    cursor.execute(SEQUENCES_SQL)
    return {name: (last, start) for name, last, start in cursor.fetchall()}


def _restore_template(settings_dict, names: DatabaseNames):
    if not SCHEMA_DUMP.is_file():
        raise _restore_failed("There is no file at that path.", names.template)
    import psycopg2

    started = time.perf_counter()
    maintenance = _maintenance_connection(settings_dict)
    try:
        with maintenance.cursor() as cursor:
            _drop_left_behind(cursor, names)
            cursor.execute(f'CREATE DATABASE "{names.template}"')
        try:
            _run_psql(settings_dict, names.template)
            restored = _maintenance_connection(settings_dict, names.template)
            try:
                with restored.cursor() as cursor:
                    sequences = read_sequences(cursor)
                    cursor.execute(FUNCTIONS_SQL)
                    functions = frozenset(name for (name,) in cursor.fetchall())
            finally:
                restored.close()
        except (SchemaRestoreFailed, psycopg2.Error):
            # The restore ran in one transaction, so the template is empty.
            with maintenance.cursor() as cursor:
                _drop_template_in(cursor, names)
            raise
        with maintenance.cursor() as cursor:
            cursor.execute(f'ALTER DATABASE "{names.template}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false')
    except psycopg2.Error as error:
        raise _restore_failed(
            f"Postgres refused a step of the restore: {str(error).strip()}", names.template
        ) from error
    finally:
        maintenance.close()
    return round(time.perf_counter() - started, 3), sequences, functions


def restore_template() -> str:
    """Restore the session's template once, in the process that boots HQ; returns its name.

    A process forked after the restore shares it, and restores nothing.
    """
    if _TEMPLATE.failure is not None:
        raise SchemaRestoreFailed(_TEMPLATE.failure)
    if _TEMPLATE.names is not None:
        return _TEMPLATE.names.template
    names = database_names(session_worker())
    try:
        seconds, sequences, functions = _restore_template(_settings(), names)
    except SchemaRestoreFailed as failure:
        _TEMPLATE.failure = str(failure)
        raise
    RESTORE_SECONDS.append(seconds)
    _TEMPLATE.names, _TEMPLATE.owner = names, os.getpid()
    _TEMPLATE.sequences, _TEMPLATE.functions = sequences, functions
    return names.template


def template_sequences() -> dict:
    """Every sequence's ``(last_value, start_value)`` in the session's template, read once after its restore."""
    restore_template()
    return _TEMPLATE.sequences


def template_functions() -> frozenset:
    """The name of every function the session's template defines outside ``pg_catalog`` and
    ``information_schema``, read once after its restore."""
    restore_template()
    return _TEMPLATE.functions


def _clone(maintenance, name):
    started = time.perf_counter()
    with maintenance.cursor() as cursor:
        cursor.execute(f'CREATE DATABASE "{name}" TEMPLATE "{_TEMPLATE.names.template}"')
    seconds = round(time.perf_counter() - started, 3)
    CLONE_SECONDS.append(seconds)
    return ClonedDatabase(name)


def _drop(maintenance, name):
    started = time.perf_counter()
    with maintenance.cursor() as cursor:
        cursor.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    DROP_SECONDS.append(round(time.perf_counter() - started, 3))


def _point_default_at(name):
    """HQ's ``default`` connection names ``name`` from its next connection on."""
    from django.db import connections

    settings_dict = _settings()
    if settings_dict["NAME"] != name:
        connections.close_all()
        settings_dict["NAME"] = name


def worker_database() -> ClonedDatabase:
    """This process's worker database, cloned from the template the first time; HQ's ``default`` names it.

    Making it first drops what an earlier session of the worker left under
    its names, but never a ``fresh_database()`` open now. Inside such a
    block the connection keeps naming the fresh database, and this only
    makes sure the worker's exists.
    """
    if _WORKER.database is None or _WORKER.owner != os.getpid():
        restore_template()
        names = database_names(session_worker())
        maintenance = _maintenance_connection(_settings())
        try:
            with maintenance.cursor() as cursor:
                _drop_clones_in(cursor, names, keep=_FRESH)
            _WORKER.database, _WORKER.owner = _clone(maintenance, names.unit), os.getpid()
        finally:
            maintenance.close()
    if not _FRESH:
        _point_default_at(_WORKER.database.name)
    return _WORKER.database


def unit_database() -> str:
    """The database a unit opened now runs in: an open ``fresh_database()``'s, else the worker's."""
    if _FRESH:
        return _FRESH[-1]
    return worker_database().name


def is_fresh_database(name: str) -> bool:
    """Whether ``name`` is the fresh clone whose owner will drop it at this scope's exit."""
    return bool(_FRESH) and _FRESH[-1] == name


@contextmanager
def fresh_database():
    """A database of its own, cloned from the template for this block and dropped at exit.

    HQ's ``default`` connection names it inside the block, and names what it
    named before (the worker's database) after.
    """
    restore_template()
    settings_dict = _settings()
    before = settings_dict["NAME"]
    name = database_names(session_worker()).check_prefix + uuid.uuid4().hex[:16]
    maintenance = _maintenance_connection(settings_dict)
    try:
        created = _clone(maintenance, name)
        try:
            _FRESH.append(name)
            _point_default_at(name)
            yield created
        finally:
            _FRESH.remove(name)
            _point_default_at(before)
            _drop(maintenance, name)
    finally:
        maintenance.close()


def drop_worker_database():
    """Drop this process's worker database, if it made one."""
    if _WORKER.database is None or _WORKER.owner != os.getpid():
        return
    from django.db import connections

    settings_dict = _settings()
    connections.close_all()
    if settings_dict["NAME"] == _WORKER.database.name:
        settings_dict["NAME"] = settings_dict["TEST"]["NAME"]
    maintenance = _maintenance_connection(settings_dict)
    try:
        _drop(maintenance, _WORKER.database.name)
    finally:
        maintenance.close()
    _WORKER.database = _WORKER.owner = None


def drop_template():
    """Drop what this process made: its worker database, and the template if this process restored it."""
    drop_worker_database()
    if _TEMPLATE.names is None or _TEMPLATE.owner != os.getpid():
        return
    maintenance = _maintenance_connection(_settings())
    try:
        with maintenance.cursor() as cursor:
            _drop_template_in(cursor, _TEMPLATE.names)
    finally:
        maintenance.close()
    _TEMPLATE.names = _TEMPLATE.owner = None
    _TEMPLATE.sequences, _TEMPLATE.functions = {}, frozenset()
