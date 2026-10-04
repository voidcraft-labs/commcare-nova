"""The HQ unit contract the editors run against, over one check's HQ state.

The editors take a unit of HQ state with two operations: ``request(digest)``
answers one page request inside it and reports whether the request wrote
(``scope.wrote``), and ``fork()`` marks the state and restores it on exit,
always. ``proof.hq``'s units are the lane's; ``CheckUnit`` gives the same two
operations over an ``hq_check`` state, for the editors' own tests:

- the unit has a state key and a depth. ``request(digest)`` runs its block as
  one HQ operation (``proof.hq.determinism.operation``) keyed by
  ``sha256(key | "request" | digest)`` at the unit's depth, so HQ's entropy
  and clock are those of the state and the request alone; a request that
  wrote advances the key to ``sha256(key | "write" | digest)`` and the depth
  by one, and one that only read leaves both, whatever order reads arrive in;
- it watches what the request does: an SQL statement other than a SELECT on
  HQ's connection (``connection.execute_wrapper``, each statement classified
  by sqlparse, which ships with Django), a Couch save or delete, a blob put or
  delete. Transaction control (savepoints) is not a write;
- ``fork()`` is a transaction (a savepoint when nested) that is always rolled
  back, every Postgres sequence's value (sequences are not transactional:
  without this a row inserted after a fork takes another id than the same
  row inserted before it, and HQ's app document carries the blob metadata's
  ids), a deep copy of the in-memory Couch's documents, a copy of the blob
  store's files, the change feed's length and the key and depth, all put back
  on every exit, an error's included, and HQ's caches emptied.
"""

from __future__ import annotations

import copy
import hashlib
import shutil
import tempfile
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path

# Statements that control a transaction rather than change data.
_TRANSACTION_CONTROL = frozenset({"SAVEPOINT", "RELEASE", "ROLLBACK", "BEGIN", "COMMIT", "SET", "SHOW"})


@dataclass
class RequestScope:
    """What one request did to the unit: whether it wrote."""

    wrote: bool = False


def is_write(sql: str) -> bool:
    """Whether an SQL statement changes data: anything but a SELECT or transaction control."""
    import sqlparse

    for statement in sqlparse.parse(sql):
        kind = statement.get_type()
        if kind == "SELECT":
            continue
        if kind == "UNKNOWN":
            first = statement.token_first(skip_cm=True, skip_ws=True)
            if first is not None and first.normalized.upper() in _TRANSACTION_CONTROL:
                continue
        if str(statement).strip():
            return True
    return False


class CheckUnit:
    """``request`` and ``fork`` over one ``hq_check`` state; every other attribute is the state's."""

    def __init__(self, state, root_key: bytes = b"proof-editors-check-unit"):
        self.state = state
        self.key = hashlib.sha256(root_key).digest()
        self.depth = 0
        self.writes = 0

    def __getattr__(self, name):
        return getattr(self.state, name)

    @contextmanager
    def request(self, digest: bytes):
        from django.db import connection

        from proof.hq import determinism

        scope = RequestScope()
        with determinism.operation(hashlib.sha256(self.key + b"|request|" + digest).digest(), self.depth):
            with self._watching(scope, connection):
                yield scope
        if scope.wrote:
            self.key = hashlib.sha256(self.key + b"|write|" + digest).digest()
            self.depth += 1
            self.writes += 1

    @contextmanager
    def _watching(self, scope, connection):

        def watch_sql(execute, sql, params, many, context):
            if not scope.wrote and is_write(sql):
                scope.wrote = True
            return execute(sql, params, many, context)

        with ExitStack() as stack:
            stack.enter_context(connection.execute_wrapper(watch_sql))
            for owner, names in (
                (self.state.couch, ("save_doc", "save_docs", "bulk_save", "delete_doc")),
                (self.state.blob_db, ("put", "delete", "bulk_delete")),
            ):
                for name in names:
                    stack.enter_context(_watched(owner, name, scope))
            yield scope

    @contextmanager
    def fork(self):
        from django.db import connection, transaction

        from proof.hq.boot import clear_caches

        sequences = _sequences(connection)
        couch = self.state.couch
        documents = copy.deepcopy(couch.mock_docs)
        changes = len(self.state.changes)
        key, depth, writes = self.key, self.depth, self.writes
        blobs = tempfile.mkdtemp(prefix="proof-editors-fork-")
        rootdir = Path(self.state.blob_db.rootdir)
        shutil.copytree(rootdir, blobs, dirs_exist_ok=True)
        try:
            try:
                with transaction.atomic():
                    try:
                        yield self
                    finally:
                        transaction.set_rollback(True)
            finally:
                # After the rollback, on every exit: a fork left with an error
                # advanced its sequences as much as one left cleanly.
                _reset_sequences(connection, sequences)
        finally:
            couch.mock_docs.clear()
            couch.mock_docs.update(documents)
            del self.state.changes[changes:]
            shutil.rmtree(rootdir)
            shutil.copytree(blobs, rootdir)
            shutil.rmtree(blobs)
            self.key, self.depth, self.writes = key, depth, writes
            clear_caches()


_SEQUENCES = "SELECT format('%I.%I', schemaname, sequencename), last_value FROM pg_sequences"


def _sequences(connection) -> dict:
    """Every sequence's last value (None for one never used), by its quoted name."""
    with connection.cursor() as cursor:
        cursor.execute(_SEQUENCES)
        return dict(cursor.fetchall())


def _reset_sequences(connection, values: dict) -> None:
    """Puts every sequence that moved back to its value in ``values``."""
    with connection.cursor() as cursor:
        for name, value in _sequences(connection).items():
            if values.get(name, value) == value and name in values:
                continue
            was = values.get(name)
            if was is None:
                cursor.execute("SELECT setval(%s::regclass, 1, false)", [name])
            else:
                cursor.execute("SELECT setval(%s::regclass, %s, true)", [name, was])


@contextmanager
def _watched(owner, name, scope):
    """``owner.name`` marking ``scope`` as written whenever it is called, for the duration."""
    original = getattr(owner, name)
    own = name in vars(owner)

    def watched(*args, **kwargs):
        scope.wrote = True
        return original(*args, **kwargs)

    setattr(owner, name, watched)
    try:
        yield
    finally:
        if own:
            setattr(owner, name, original)
        else:
            delattr(owner, name)
