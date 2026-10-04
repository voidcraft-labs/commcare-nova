"""A fork of the check's HQ state puts everything back on every exit, an error's included.

Contract (``proof.editors.units.CheckUnit.fork``): whatever the block did,
and however it ended, HQ's state after the fork is the state before it: its
Postgres rows and sequences, its Couch documents and its key and depth.
Sequences are not transactional, so the rollback alone leaves them advanced.
The plausible failure: a fork left with an error (a section's fork when the
replay finds a mismatch, ``transcripts.replay``; a view the driver could not
finish, ``pages.run_view``) keeping its sequences advanced, so the next row
HQ inserts takes another id than it would have.
"""

from __future__ import annotations

import pytest

from proof.editors.units import CheckUnit
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration


class _SectionFailed(Exception):
    pass


def _sequence(connection):
    with connection.cursor() as cursor:
        cursor.execute("SELECT format('%I.%I', schemaname, sequencename) FROM pg_sequences ORDER BY 1 LIMIT 1")
        return cursor.fetchone()[0]


def _last_value(connection, name):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT last_value FROM pg_sequences WHERE format('%%I.%%I', schemaname, sequencename) = %s", [name]
        )
        return cursor.fetchone()[0]


def _advance(connection, name):
    with connection.cursor() as cursor:
        cursor.execute("SELECT nextval(%s::regclass)", [name])


def test_a_fork_puts_sequences_and_documents_back_on_a_clean_exit_and_on_an_error(hq, core_runner):
    from django.db import connection

    with hq_check(Configuration(), validate=core_runner.validate_form) as (state, _):
        unit = CheckUnit(state)
        name = _sequence(connection)
        before = (_last_value(connection, name), dict(state.couch.mock_docs), unit.key, unit.depth)

        with unit.fork():
            _advance(connection, name)
            state.couch.mock_docs["proof-fork-document"] = {"_id": "proof-fork-document"}
            unit.key, unit.depth = b"written", 1
        assert (_last_value(connection, name), dict(state.couch.mock_docs), unit.key, unit.depth) == before

        with pytest.raises(_SectionFailed), unit.fork():
            _advance(connection, name)
            _advance(connection, name)
            state.couch.mock_docs["proof-fork-document"] = {"_id": "proof-fork-document"}
            unit.key, unit.depth = b"written", 2
            raise _SectionFailed("a section's fork left with an error")
        assert (_last_value(connection, name), dict(state.couch.mock_docs), unit.key, unit.depth) == before
