"""The lane's workers share one Postgres; each clones its own database once and drops only its own.

Contract: a session restores the template once, and each worker process
clones the worker database every unit of that process runs in
(``worker_database``), named for its worker (``PROOF_WORKER=w/k``, read when
it is made, through ``database_names``); a process starts by dropping what an
earlier session of its worker left behind under its names. The plausible
failures: a session dropping another worker's template or in-flight
database, which fails that worker's units mid-run (worker 1's names a prefix
of worker 10's, or names that do not carry the worker at all); a worker
cloning a database per unit, or one that is not the session's template's
clone; a forked worker naming its database as its parent's; a worker
database made inside a fresh database's block dropping that fresh database
with the leftovers; and two readers
of ``PROOF_WORKER`` disagreeing, so a process the lane places as one worker
names its databases as another's, or fails to start. Each Postgres test
pairs what a process drops (its own worker's leftovers) with what it must
keep (other workers' databases), on the lane's real Postgres, with the names
production gives.
"""

from __future__ import annotations

import pytest

from proof.checks import sharding
from proof.hq import database
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.database import database_names, session_worker

# Workers no lane runs, whose names share digits: 901's must not reach 9010's.
MINE = 901
OTHERS = (9010, 90, 902)


def _names(cursor):
    cursor.execute("SELECT datname FROM pg_database WHERE starts_with(datname, 'proof_hq_w90')")
    return {name for (name,) in cursor.fetchall()}


def _drop(cursor, name):
    cursor.execute("SELECT datistemplate FROM pg_database WHERE datname = %s", [name])
    row = cursor.fetchone()
    if row is None:
        return
    if row[0]:
        cursor.execute(f'ALTER DATABASE "{name}" WITH IS_TEMPLATE false')
    cursor.execute(f'DROP DATABASE "{name}" WITH (FORCE)')


def _maintenance():
    from django.db import connections

    return database._maintenance_connection(connections["default"].settings_dict)


def _current_database():
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute("SELECT current_database()")
        return cursor.fetchone()[0]


def test_no_workers_names_reach_another_workers():
    workers = (1, 2, 10, 11, 19, 100, MINE, *OTHERS)
    for worker in workers:
        names = database_names(worker)
        for name in (names.template, names.unit, names.check_prefix):
            assert name.startswith(f"proof_hq_w{worker}_")
        assert not names.template.startswith(names.check_prefix)
        assert not names.unit.startswith(names.check_prefix)
        assert len({names.template, names.unit}) == 2
        for other in workers:
            if other == worker:
                continue
            theirs = database_names(other)
            for name in (names.template, names.unit, f"{names.check_prefix}0123abcd"):
                assert name not in (theirs.template, theirs.unit), (worker, other)
                assert not name.startswith(theirs.check_prefix), (worker, other)


def test_a_session_drops_its_own_workers_leftovers_and_keeps_every_other_workers(hq):
    mine, others = database_names(MINE), [database_names(worker) for worker in OTHERS]
    left_behind = [mine.template, mine.unit, f"{mine.check_prefix}leftover"]
    in_flight = [name for names in others for name in (names.template, names.unit, f"{names.check_prefix}running")]
    maintenance = _maintenance()
    try:
        with maintenance.cursor() as cursor:
            for name in left_behind + in_flight:
                cursor.execute(f'CREATE DATABASE "{name}"')
            for template in [mine.template, *(names.template for names in others)]:
                cursor.execute(f'ALTER DATABASE "{template}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false')
            assert _names(cursor) == set(left_behind + in_flight)

            # A forked worker clears its own clones and keeps the template its parent restored.
            database._drop_clones_in(cursor, mine)
            assert _names(cursor) == {mine.template, *in_flight}

            database._drop_left_behind(cursor, mine)
            assert _names(cursor) == set(in_flight)
    finally:
        with maintenance.cursor() as cursor:
            for name in left_behind + in_flight:
                _drop(cursor, name)
        maintenance.close()


def test_every_unit_of_a_worker_runs_in_its_one_clone_of_the_sessions_template(hq, core_runner):
    """Each unit of a worker runs in the worker's one database, cloned from the template the session restored. Under
    the lane's fork server the server restored that template under its own first position's names before it forked,
    so only the worker database carries this worker's names (``PROOF_WORKER``); the template carries the server's."""
    names = database_names(session_worker())
    template = database.restore_template()
    first = database.worker_database()
    assert first.name == names.unit
    clones = len(database.CLONE_SECONDS)
    for _ in range(2):
        with hq_check(Configuration(), validate=core_runner.validate_form) as (unit, _):
            assert unit.database == names.unit == _current_database()
    # No unit cloned a database of its own.
    assert len(database.CLONE_SECONDS) == clones
    assert database.worker_database() is first

    maintenance = _maintenance()
    try:
        with maintenance.cursor() as cursor:
            cursor.execute("SELECT datistemplate, datallowconn FROM pg_database WHERE datname = %s", [template])
            assert cursor.fetchone() == (True, False)
    finally:
        maintenance.close()


def test_a_forked_worker_clones_the_parents_template_under_its_own_names(hq, monkeypatch):
    """A worker forked after the restore inherits the restored template and no worker database: its first unit
    clones the parent's template under the worker its PROOF_WORKER names, and the parent's stays."""
    parent = database.worker_database()
    template = database.restore_template()
    restores = len(database.RESTORE_SECONDS)
    theirs = database_names(MINE)
    monkeypatch.setattr(database, "_WORKER", database._Worker())
    monkeypatch.setenv("PROOF_WORKER", f"{MINE}/{MINE}")
    try:
        forked = database.worker_database()
        assert forked.name == theirs.unit and _current_database() == theirs.unit
        assert database.restore_template() == template and len(database.RESTORE_SECONDS) == restores
        maintenance = _maintenance()
        try:
            with maintenance.cursor() as cursor:
                assert _names(cursor) >= {theirs.unit}
                cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", [parent.name])
                assert cursor.fetchone() == (1,)
        finally:
            maintenance.close()
    finally:
        database.drop_worker_database()
        monkeypatch.undo()
        database.worker_database()
    assert _current_database() == parent.name


def test_a_fresh_database_is_its_own_clone_and_is_dropped_at_exit(hq):
    names = database_names(session_worker())
    worker = database.worker_database()
    with database.fresh_database() as fresh:
        assert fresh.name.startswith(names.check_prefix)
        assert database.unit_database() == fresh.name == _current_database()
    assert _current_database() == worker.name
    maintenance = _maintenance()
    try:
        with maintenance.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", [fresh.name])
            assert cursor.fetchone() is None
    finally:
        maintenance.close()


def test_a_worker_database_made_inside_a_fresh_block_drops_the_leftovers_and_keeps_the_fresh_database(hq, monkeypatch):
    """A process whose first unit database is made while a fresh database is open (its first state a fresh one)
    drops what an earlier session of its worker left, and keeps the fresh database, which HQ's connection goes on
    naming until the block ends."""
    theirs = database_names(MINE)
    leftover = f"{theirs.check_prefix}leftover"
    parent = database.worker_database()
    monkeypatch.setattr(database, "_WORKER", database._Worker())
    monkeypatch.setenv("PROOF_WORKER", f"{MINE}/{MINE}")
    maintenance = _maintenance()
    try:
        with maintenance.cursor() as cursor:
            cursor.execute(f'CREATE DATABASE "{leftover}"')
        try:
            with database.fresh_database() as fresh:
                assert fresh.name.startswith(theirs.check_prefix)
                assert database.worker_database().name == theirs.unit
                assert _current_database() == fresh.name
                with maintenance.cursor() as cursor:
                    mine = {name for name in _names(cursor) if name.startswith(f"proof_hq_w{MINE}_")}
                assert mine == {theirs.unit, fresh.name}
        finally:
            database.drop_worker_database()
    finally:
        with maintenance.cursor() as cursor:
            for name in (leftover, theirs.unit):
                _drop(cursor, name)
        maintenance.close()
        monkeypatch.undo()
        database.worker_database()
    assert _current_database() == parent.name


@pytest.mark.parametrize(
    ("value", "worker"),
    [("", 1), ("2/3", 2), ("10/12", 10), ("0/3", None), ("4/3", None), ("2", None), ("a/b", None), ("2/", None)]
    + [("+1/2", None), (" 1/2", None), ("1_0/20", None), ("٢/3", None)],
)
def test_a_worker_is_read_as_the_lane_writes_it_and_anything_else_is_refused(value, worker):
    """``PROOF_WORKER`` is read as the lane's one reader of a position reads it (``sharding.parse_shard``, which the
    server that sets it uses too): a position in ASCII digits, or worker 1 when unset; any other value is refused,
    naming the variable, before a database is named for it."""
    environment = {"PROOF_WORKER": value} if value else {}
    if worker is None:
        with pytest.raises(sharding.ShardError, match="PROOF_WORKER"):
            session_worker(environment)
        return
    assert session_worker(environment) == worker
    assert database_names(session_worker(environment)).unit == f"proof_hq_w{worker}_unit"
