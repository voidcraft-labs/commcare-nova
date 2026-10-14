"""One HQ unit's state: its key, its marks and restores, what writes to it, and the guards that keep it exact.

A unit (``proof.hq.state.hq_unit``) holds HQ's whole state for one
(document, configuration): Postgres (one transaction on the worker's database,
``proof.hq.database``, always rolled back), the in-memory Couch
(``proof.hq.couch``), HQ's temporary filesystem blob store, the change feed
and HQ's caches. ``Unit`` is that state with its key.

Keys. A unit starts at ``root_key`` (the 32 bytes of a sha256) and depth 0.
``operation(label, digest)`` moves the key to ``sha256(key | label | digest)``
and the depth up by one, then runs its block as one HQ operation under that
key and depth (``proof.hq.determinism.operation``: entropy seeded by the key,
the clock frozen at ``EPOCH`` + depth seconds). ``request(digest)`` answers
one of a page's requests under ``sha256(key | "request" | digest)`` at the
current depth without moving the key; a request that wrote moves it to
``sha256(key | "write" | digest)`` and the depth up by one. A read never moves
the key, so a page's concurrent reads can be answered in any order. Each
scope yields what it did: whether it wrote, and every soft assertion HQ
noted inside it (``proof.hq.boot.soft_assertions``). A label is text without
``|``, so the bytes a key is derived from name one (key, label, digest), and
never ``request`` or ``write``, the labels a request's keys are derived
under, so no operation shares a key with a request.

Writes. A write is any of:

- a Couch save, bulk save, delete or seed;
- a blob put, delete, bulk delete or copy;
- a change HQ publishes for its pillows (``Unit.publish``; the change feed is
  state too);
- an SQL statement on HQ's connection (``connection.execute_wrapper``) that
  is not a read by its text (``sql_effect``, on sqlparse's lexer and
  ``Statement.get_type()``): anything but a SELECT and transaction control
  (``SAVEPOINT``, ``RELEASE``, ``ROLLBACK``, ``COMMIT``, ``BEGIN``, ``SET``,
  ``SHOW``), and a SELECT that holds another statement keyword, makes a
  table (``SELECT ... INTO``) or calls ``nextval`` or ``setval``. A statement
  sqlparse cannot type is a write;
- a SELECT that calls a function the template defines outside ``pg_catalog``
  and ``information_schema`` (``proof.hq.database.template_functions``: HQ's
  own PL/pgSQL, some of which write, such as ``soft_delete_cases``, and some
  of which read, such as ``get_case_ids_in_domain``), when it changed a row
  or a sequence: the statement runs between two reads of the transaction's
  inserted, updated and deleted row counts (``pg_stat_xact_user_tables``)
  and every sequence's value, inside a transaction of its own when the
  connection is in autocommit outside one, and it wrote when either moved.
  Such a call through a named (server-side) cursor runs as its rows are
  fetched, after the statement returns, so it counts as a write unread. What
  the counts cannot see is a function that only truncates a table or changes
  the schema; none of the template's does. A call is measured only where a
  write would change what the unit records: inside a scope that has not
  written yet, or outside every scope of a unit that refuses unscoped
  writes.

Triggers and foreign-key cascades run only under a statement that writes.
A write marks every open scope of the unit. In a unit ``hq_unit`` opens, a
write outside every scope is refused (``UnscopedWrite``): the key would no
longer name the state. ``hq_check`` allows it, for the checks that predate
units.

Marks. ``mark()`` takes a savepoint, every sequence's value (sequences are
not transactional), the Couch store's documents as JSON texts, the blob
store's files, the change feed's length, and the key, depth and write count.
``restore(mark)`` rolls back to the savepoint, sets back every sequence that
moved (``setval(seq, value, true)``, or ``setval(seq, start, false)`` for
one never used), puts Couch, the blobs and the change feed back, empties
HQ's caches, and puts the key, depth and write count back; the savepoint
stays, so the mark can be restored again, and every mark taken after it is
gone. The unit counts every SQL statement that may have written or moved a
sequence (each the write watch above sees: one that writes by its text, a
measured call of the template's functions that changed something or raised,
and every call it did not measure) and every Couch write, inside a scope or
outside every one (which ``hq_check`` allows), so the sequences and the
Couch texts are read again only where one of those happened since they were
last read or put back, and a restore sets back only what such a write could
have moved (``PROOF_VERIFY_MEMOS=1`` reads and compares them every time).
``fork()`` marks on entry and restores and releases on exit, always. Marks,
restores and forks happen between scopes, never inside an operation or a
request: a scope's entropy is drawn as its block runs, and a restore cannot
put it back.

Guards, each a ``HarnessRefusal`` that ends the check loudly:

- a new Postgres connection (``psycopg2.connect``, which SQLAlchemy's engines
  call too) while the unit is open: it would neither see nor roll back the
  unit's transaction (``NewConnectionRefused``);
- ``transaction.on_commit`` in a rollback unit: its transaction never
  commits, so the function would never run (``OnCommitRefused``). Native
  callbacks run only in the existing nonrollback mode over a fresh database
  whose owner drops it at exit; a reusable worker database still refuses
  them. Inside ``Unit.committing()`` a rollback unit runs them itself, where
  production's commit runs them (below);
- after every operation and request, and when the unit ends without an
  error, a connection that is closed, marked for rollback or in an aborted
  transaction (``AbortedTransaction``). HQ's production requests run in
  autocommit (HQ sets no ``ATOMIC_REQUESTS``), where a statement that fails
  outside HQ's own atomic blocks leaves the next one free to run; inside the
  unit's transaction it aborts the transaction, and Django's
  ``mark_for_rollback_on_error`` marks it for rollback, so every later
  statement fails (HQ's own cleanup after the error included). What follows
  is not what production does, so the unit stops there;
- a row that breaks a deferred constraint, where production would have
  committed it (``DeferredConstraintViolated``). Every foreign key HQ's
  schema makes is ``DEFERRABLE INITIALLY DEFERRED`` (Django's
  ``deferrable_sql``), so Postgres checks it when the transaction commits:
  in production's autocommit, as each statement HQ runs outside its atomic
  blocks ends, and as each outermost atomic block closes, where the commit
  fails with ``IntegrityError``. The unit's transaction never commits, so
  it checks them at those same points (``SET CONSTRAINTS ALL IMMEDIATE``,
  then ``ALL DEFERRED``, the start state of a schema whose every deferrable
  constraint is initially deferred, inside a savepoint of its own that a
  violation rolls back): after each statement that writes or calls one of
  the template's functions at the unit's own atomic depth, and as each
  atomic block HQ opened at that depth closes without an error. What the
  unit does not see there (a statement run past Django's cursor) is checked
  as each operation and request ends without an error, and as the unit
  ends.

Commit callbacks. HQ's receiver saves a submission's form and cases in one
atomic block and writes what follows from it (the form's attachments, the
changes its pillows read) in functions it asks Django to run when that
block commits (``transaction.on_commit``). Inside ``Unit.committing()`` the
unit runs each such function exactly where production's commit runs it:
Django keeps them as it always does (``BaseDatabaseWrapper.on_commit``
appends to ``run_on_commit`` inside an atomic block, and a savepoint's
rollback drops the ones registered under it), and the unit runs and clears
them, as ``run_and_clear_commit_hooks`` does, each time HQ's work reaches
the unit's own atomic depth without an error: as HQ's outermost atomic
block closes, as a statement outside every atomic block of HQ's ends, and
at once for a function registered there (production's autocommit, where
Django calls it immediately). A function that raises propagates unless HQ
registered it ``robust``, as in production. They run inside the scope that
registered them, so what they write is that operation's or request's.

The unit refuses what it cannot keep exact (``UnitRefused``): a second unit
opened in the process while one is open (a unit's state is the process's one
transaction, Couch and blob store), any scope or mark asked of a unit after
it closed, a key that is not a sha256 digest, a label as above, an operation
or request opened inside a request (a request answers one call a page makes,
and moves the key only when it writes), and a mark, restore or fork inside a
scope, on a mark it no longer holds, or across an atomic block opened after
the mark.

DDL inside a unit is rolled back with it; ``CREATE INDEX CONCURRENTLY``
cannot run inside a transaction and fails loudly.
"""

from __future__ import annotations

import hashlib
import os
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field

from proof.hq.boot import HarnessRefusal, SoftAssertNote, clear_caches, soft_assertions
from proof.hq.seams import VERIFY_MEMOS, MemoMismatch

KEY_BYTES = 32


class UnitRefused(HarnessRefusal):
    """The unit was asked for something it cannot keep exact: a key, a label, a mark or a restore."""


class UnscopedWrite(HarnessRefusal):
    """HQ's state was written outside every operation and request of a unit that names its state by key."""


class NewConnectionRefused(HarnessRefusal):
    """A new Postgres connection was asked for while a unit was open."""


class OnCommitRefused(HarnessRefusal):
    """HQ asked for a commit callback outside a fresh-database nonrollback unit."""


class AbortedTransaction(HarnessRefusal):
    """An operation or request left the unit's connection unusable."""


class DeferredConstraintViolated(HarnessRefusal):
    """HQ left a row that breaks a deferred constraint where production would have committed it."""


def derive(key: bytes, label: bytes, digest: bytes) -> bytes:
    """``sha256(key | label | digest)``, the key after one step."""
    return hashlib.sha256(key + b"|" + label + b"|" + digest).digest()


def _check_key(root_key):
    if not isinstance(root_key, (bytes, bytearray)) or len(root_key) != KEY_BYTES:
        raise UnitRefused(
            f"A unit's root key is the {KEY_BYTES} bytes of a sha256 digest, so every key derived from it names one "
            f"history; this one is {root_key!r}. Pass hashlib.sha256(...).digest() of what the unit's state is made "
            "from."
        )
    return bytes(root_key)


# The labels a request's scope and its write derive keys under.
REQUEST_LABELS = frozenset({"request", "write"})


def _check_label(label):
    if not isinstance(label, str) or not label or "|" in label:
        raise UnitRefused(
            f"An operation's label is non-empty text without '|', which separates the parts a key is derived from; "
            f"this one is {label!r}."
        )
    if label in REQUEST_LABELS:
        raise UnitRefused(
            f"An operation was labelled {label!r}, the label a request's keys are derived under, so it would share "
            "its key with a request over the same digest though the two histories differ. Name the operation for "
            "the step it runs."
        )
    return label.encode()


def _check_digest(digest):
    if not isinstance(digest, (bytes, bytearray)):
        raise UnitRefused(
            f"An operation's or request's digest is the bytes of a digest of its input; this one is {digest!r}."
        )
    return bytes(digest)


# SQL -------------------------------------------------------------------------


# Statements whose first keyword controls a transaction or reads a setting.
_CONTROL = frozenset({"SAVEPOINT", "RELEASE", "BEGIN", "START", "COMMIT", "END", "ROLLBACK", "SET", "SHOW"})
_SEQUENCE_FUNCTIONS = frozenset({"nextval", "setval"})


@dataclass(frozen=True)
class SqlEffect:
    """What an SQL text does to the state, as far as its text says.

    ``writes``: it writes by what it says. ``calls``: for a text that only
    reads, every function its SELECTs call, by the name Postgres stores
    (unquoted names folded to lower case), which may write when the database
    defines them (``Unit``'s measured calls).
    """

    writes: bool
    calls: frozenset[str] = frozenset()


# Each distinct SQL text is classified once per process (sqlparse takes
# milliseconds on a long statement, and HQ repeats its statements' texts).
_EFFECTS: dict[str, SqlEffect] = {}
_EFFECTS_LIMIT = 50_000


def sql_effect(sql: str) -> SqlEffect:
    """What ``sql`` does to the state by its text, classified by sqlparse (never by pattern)."""
    found = _EFFECTS.get(sql)
    if found is None:
        if len(_EFFECTS) >= _EFFECTS_LIMIT:
            _EFFECTS.clear()
        found = _EFFECTS[sql] = _classify(sql)
    return found


def _classify(sql):
    from sqlparse.engine import FilterStack

    # sqlparse's lexer and statement splitter without its grouping step, which
    # refuses a statement of more than 10,000 tokens (a bulk INSERT) and is
    # where its time goes.
    calls = set()
    for statement in FilterStack().run(sql):
        called = _read_calls(statement)
        if called is None:
            return SqlEffect(writes=True)
        calls |= called
    return SqlEffect(writes=False, calls=frozenset(calls))


def _called_name(significant, index):
    """The function the token at ``index`` names when a '(' follows it (a call), else None."""
    from sqlparse import tokens

    token = significant[index]
    if index + 1 >= len(significant) or not significant[index + 1].match(tokens.Punctuation, "("):
        return None
    if token.ttype in tokens.Name:
        return token.value.lower()
    if token.ttype in tokens.Literal.String.Symbol and len(token.value) > 1:
        # A quoted name keeps its case.
        return token.value[1:-1].replace('""', '"')
    return None


def _read_calls(statement):
    """For one ungrouped statement that leaves the state as it was (empty, transaction control, or a read), the
    functions it calls; None for a statement that writes."""
    from sqlparse import tokens

    significant = [token for token in statement.tokens if not token.is_whitespace and token.ttype not in tokens.Comment]
    if not significant:
        return set()
    kind = statement.get_type()
    first = significant[0]
    if kind in ("COMMIT", "ROLLBACK"):
        return set()
    if kind == "UNKNOWN":
        if first.ttype in tokens.Keyword.CTE or first.match(tokens.Punctuation, "("):
            # get_type() reads neither a WITH statement nor a compound whose
            # parts are parenthesized ("(SELECT ...) UNION (SELECT ...)", as
            # Django writes them for Postgres) on ungrouped tokens.
            kind = "SELECT"
        elif first.normalized.upper() in _CONTROL:
            return set()
    if kind != "SELECT":
        return None
    # A read holds no other statement keyword (a WITH may hold a DELETE that
    # returns the rows its SELECT reads), makes no table (SELECT ... INTO)
    # and calls no sequence function.
    calls = set()
    for index, token in enumerate(significant):
        if token.ttype in tokens.Keyword.DML or token.ttype in tokens.Keyword.DDL:
            if token.normalized == "SELECT" or _locks_rows(significant, index):
                continue
            return None
        if token.ttype in tokens.Keyword and token.normalized == "INTO":
            return None
        name = _called_name(significant, index)
        if name in _SEQUENCE_FUNCTIONS:
            return None
        if name is not None:
            calls.add(name)
    return calls


def _locks_rows(significant, index):
    """Whether the UPDATE at ``index`` ends a row-locking clause (``FOR UPDATE``, ``FOR NO KEY UPDATE``)."""
    from sqlparse import tokens

    if significant[index].normalized != "UPDATE" or index == 0:
        return False
    before = significant[index - 1]
    return before.ttype in tokens.Keyword and before.normalized in ("FOR", "KEY")


def _sql_text(sql, context):
    if isinstance(sql, str):
        return sql
    as_string = getattr(sql, "as_string", None)
    if as_string is not None:
        try:
            return as_string(context["cursor"].cursor)
        except Exception:
            return None
    return None


# What a statement that calls one of the database's functions changed: the
# transaction's inserted, updated and deleted row counts across every user
# table (``pg_stat_xact_user_tables``, which counts each attempt, a
# rolled-back savepoint's included), and every sequence's value.
_MOVED_SQL = (
    "SELECT (SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) FROM pg_stat_xact_user_tables), "
    "(SELECT array_agg(last_value ORDER BY schemaname, sequencename) FROM pg_sequences)"
)


def _measured(execute, sql, params, many, context):
    """Run one statement between two reads of what it can change; returns its result and whether it changed it.

    The counts are the transaction's, so both reads and the statement share
    one: the connection's own, or, for a connection in autocommit outside a
    transaction (where Postgres sends a finished transaction's counts away
    between statements), one opened around the three that ends as the
    statement's own would.
    """
    import psycopg2.extensions

    raw = context["connection"].connection
    if raw is None or raw.get_transaction_status() == psycopg2.extensions.TRANSACTION_STATUS_INERROR:
        # No connection, or an aborted transaction: the statement fails as any statement would there.
        return execute(sql, params, many, context), False
    own = raw.autocommit and raw.get_transaction_status() == psycopg2.extensions.TRANSACTION_STATUS_IDLE
    with raw.cursor() as cursor:
        if own:
            cursor.execute("BEGIN")
        cursor.execute(_MOVED_SQL)
        before = cursor.fetchone()
    try:
        result = execute(sql, params, many, context)
    except BaseException:
        if own:
            with raw.cursor() as cursor:
                cursor.execute("ROLLBACK")
        raise
    with raw.cursor() as cursor:
        cursor.execute(_MOVED_SQL)
        after = cursor.fetchone()
        if own:
            cursor.execute("COMMIT")
    return result, after != before


# A commit's check of the deferred constraints, in one round trip: every
# pending check runs now, and the constraints are deferred again, as a new
# transaction starts them. The savepoint keeps a violation from aborting the
# unit's transaction (rolled back, it also puts the checks back to pending).
_DEFERRED_SAVEPOINT = "proof_deferred_check"
_CHECK_DEFERRED_SQL = (
    f"SAVEPOINT {_DEFERRED_SAVEPOINT}; SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; "
    f"RELEASE SAVEPOINT {_DEFERRED_SAVEPOINT}"
)
_UNDO_DEFERRED_CHECK_SQL = f"ROLLBACK TO SAVEPOINT {_DEFERRED_SAVEPOINT}; RELEASE SAVEPOINT {_DEFERRED_SAVEPOINT}"


def _violated_deferred_constraint(raw):
    """Check every deferred constraint on ``raw`` as a commit would; the error Postgres raised for the first one
    that fails, or None. The transaction stays usable either way."""
    import psycopg2

    try:
        with raw.cursor() as cursor:
            cursor.execute(_CHECK_DEFERRED_SQL)
    except psycopg2.IntegrityError as error:
        with raw.cursor() as cursor:
            cursor.execute(_UNDO_DEFERRED_CHECK_SQL)
        return error
    return None


# Sequences -------------------------------------------------------------------


def reset_sequences(cursor, values: dict) -> int:
    """Set every sequence whose value moved back to ``values`` (``proof.hq.database.read_sequences``); returns
    how many moved."""
    from proof.hq.database import read_sequences

    now = read_sequences(cursor)
    moved = []
    for name, (last, start) in values.items():
        current = now.get(name)
        if current is None or current[0] == last:
            continue
        moved.append((name, start if last is None else last, last is not None))
    if moved:
        rows = ", ".join(["(%s, %s::bigint, %s::boolean)"] * len(moved))
        cursor.execute(
            f"SELECT setval(v.name::regclass, v.value, v.called) FROM (VALUES {rows}) AS v(name, value, called)",
            [part for row in moved for part in row],
        )
    return len(moved)


# The blob store ----------------------------------------------------------------


_BLOB_DB_CLASS = None


def blob_db():
    """HQ's ``TemporaryFilesystemBlobDB``, telling its listeners of every write and mirroring its files in memory."""
    global _BLOB_DB_CLASS
    if _BLOB_DB_CLASS is None:
        _BLOB_DB_CLASS = _make_blob_db_class()
    return _BLOB_DB_CLASS()


def _make_blob_db_class():
    from corehq.blobs.tests.util import TemporaryFilesystemBlobDB

    class UnitBlobDB(TemporaryFilesystemBlobDB):
        """HQ's temporary filesystem blob store, its files mirrored by path (``files``) for marks.

        Every put, delete, bulk delete and copy calls each of
        ``write_listeners`` first, and the mirror reads back what it wrote.
        A snapshot checks the mirror against the directory's listing first
        and reads the files again if anything else changed them.
        """

        def __init__(self):
            super().__init__()
            self.write_listeners = []
            self.files: dict[str, bytes] = {}

        def _root(self):
            return os.path.realpath(self.rootdir)

        def _writing(self):
            for listener in self.write_listeners:
                listener()

        def _wrote(self, keys):
            root = self._root()
            for key in keys:
                path = self.get_path(key)
                relative = os.path.relpath(path, root)
                if os.path.isfile(path):
                    with open(path, "rb") as stream:
                        self.files[relative] = stream.read()
                else:
                    self.files.pop(relative, None)

        def put(self, content, **blob_meta_args):
            self._writing()
            meta = super().put(content, **blob_meta_args)
            self._wrote([meta.key])
            return meta

        def delete(self, key):
            self._writing()
            try:
                return super().delete(key)
            finally:
                self._wrote([key])

        def bulk_delete(self, metas):
            self._writing()
            try:
                return super().bulk_delete(metas)
            finally:
                self._wrote([meta.key for meta in metas])

        def copy_blob(self, content, key):
            self._writing()
            try:
                return super().copy_blob(content, key)
            finally:
                self._wrote([key])

        def _listing(self):
            root = self._root()
            found = {}
            for directory, _, names in os.walk(root):
                for name in names:
                    path = os.path.join(directory, name)
                    found[os.path.relpath(path, root)] = os.path.getsize(path)
            return found

        def _in_step(self):
            listing = self._listing()
            if listing.keys() != self.files.keys() or any(
                len(self.files[path]) != size for path, size in listing.items()
            ):
                root = self._root()
                files = {}
                for path in listing:
                    with open(os.path.join(root, path), "rb") as stream:
                        files[path] = stream.read()
                self.files = files

        def snapshot(self) -> dict:
            """Every file the store holds, by its path under the store's root."""
            self._in_step()
            return dict(self.files)

        def restore_snapshot(self, files: dict):
            """Make the store hold exactly ``files``."""
            self._in_step()
            root = self._root()
            for path in self.files.keys() - files.keys():
                os.remove(os.path.join(root, path))
            for path, content in files.items():
                held = self.files.get(path)
                if held is content or held == content:
                    continue
                target = os.path.join(root, path)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as stream:
                    stream.write(content)
            self.files = dict(files)

    return UnitBlobDB


# The unit ------------------------------------------------------------------------


@dataclass
class Scope:
    """One operation or request of a unit: the key and depth its entropy and clock come from, and what it did."""

    kind: str  # "operation" or "request"
    # The operation's label, or the start of the request's digest in hex.
    label: str
    key: bytes
    depth: int
    wrote: bool = False
    # Every soft assertion HQ noted inside the scope, as production notes it.
    soft_assertions: list[SoftAssertNote] = field(default_factory=list)


@dataclass(eq=False)
class Mark:
    """A point a unit can be put back to (``Unit.restore``)."""

    savepoint: str
    atomic_depth: int
    sequences: dict
    couch: dict
    files: dict
    changes: int
    key: bytes
    depth: int
    writes: int
    # How many SQL and Couch writes the unit had seen when the mark was taken (``Unit._sql_writes``,
    # ``Unit._couch_writes``).
    sql_writes: int = 0
    couch_writes: int = 0
    # What the unit's Elasticsearch indexes held (``proof.hq.elasticsearch.UnitIndexes.mark``), or None.
    indexes: tuple | None = None
    live: bool = True


def transaction_problem():
    """What makes HQ's connection unusable for the rest of a unit, or None."""
    import psycopg2.extensions
    from django.db import connection

    raw = connection.connection
    if raw is None or raw.closed:
        return "closed, so the unit's transaction is gone"
    if connection.needs_rollback:
        return "marked for rollback, after an error inside an atomic block that had no savepoint of its own"
    if raw.get_transaction_status() == psycopg2.extensions.TRANSACTION_STATUS_INERROR:
        return "in an aborted transaction, after a statement failed outside any savepoint HQ took"
    return None


# The unit open in this process, if any.
_OPEN: list[Unit] = []


def refuse_another_unit():
    """Refuse to open a unit while another is open in this process (``proof.hq.state.open_unit`` asks first,
    before it touches the process's Couch, blob store or caches)."""
    if _OPEN:
        raise UnitRefused(
            "An HQ unit was opened while another was open in this process. A unit's state is the process's "
            "one database transaction, Couch and blob store; open one unit at a time."
        )


class Unit:
    """HQ's state for one (document, configuration), with its key (``proof.hq.state.hq_unit``).

    ``configuration``, ``domain``, ``couch``, ``blob_db``, ``web_user``,
    ``changes`` (what HQ published for its pillows, through ``publish``) and
    ``database`` are the state; ``record`` is the seams' ``SeamRecord`` (None
    for a unit opened without seams). ``key`` and ``depth`` name the state;
    ``writes`` counts the operations and requests that wrote, along the
    state's history (a restore puts all three back).
    """

    def __init__(self, configuration, root_key, *, couch, blob_db, changes, database, transactional, strict):
        self.configuration = configuration
        self.couch = couch
        self.blob_db = blob_db
        self.changes = changes
        self.database = database
        self.web_user = None
        self.record = None
        # HQ's Elasticsearch as the unit holds it (``proof.hq.elasticsearch.UnitIndexes``), where seams are open.
        self.indexes = None
        self.key = _check_key(root_key)
        self.depth = 0
        self.writes = 0
        self._transactional = transactional
        self._strict = strict
        self._scopes: list[Scope] = []
        self._marks: list[Mark] = []
        self._internal = 0
        # Every SQL statement that may have written (or moved a sequence) and every Couch write the unit has
        # seen, counted for as long as it lives; and the sequences, and the Couch snapshot (each document's JSON
        # text), known to hold at a count.
        self._sql_writes = 0
        self._couch_writes = 0
        self._known_sequences: tuple[int, dict] | None = None
        self._known_couch: tuple[int, dict] | None = None
        self._open = False
        # The functions the template defines outside pg_catalog and information_schema.
        self._functions: frozenset[str] = frozenset()
        # HQ's connection, and the atomic depth of the unit's own transaction: production's autocommit.
        self._connection = None
        self._base_atomic = 0
        # How many ``committing()`` blocks are open: inside one, the unit runs HQ's commit callbacks itself.
        self._committing = 0
        couch.write_listeners.append(self._couch_write)
        blob_db.write_listeners.append(self._blob_write)

    @property
    def domain(self):
        return self.configuration.domain

    # Lifetime ----------------------------------------------------------------

    @contextmanager
    def opened(self):
        """The unit's lifetime: the guards and the write watch on, the state in one transaction rolled back at
        exit (when transactional), and at exit every sequence set back to the template's value."""
        from django.db import DEFAULT_DB_ALIAS, connection, connections

        from proof.hq import database

        refuse_another_unit()
        self._functions = database.template_functions()
        connection.ensure_connection()
        self._connection = connections[DEFAULT_DB_ALIAS]
        _OPEN.append(self)
        try:
            with ExitStack() as stack:
                stack.enter_context(_refusing_new_connections())
                if self._transactional or not database.is_fresh_database(self.database):
                    stack.enter_context(_refusing_on_commit(connection, rollback=self._transactional, unit=self))
                stack.enter_context(connection.execute_wrapper(self._watch_sql))
                if self._transactional:
                    stack.enter_context(_rolled_back())
                    self._base_atomic = len(connection.atomic_blocks)
                    stack.enter_context(_checking_commits(self))
                self._open = True
                try:
                    yield self
                    problem = transaction_problem()
                    if problem is not None:
                        raise AbortedTransaction(
                            f"The unit ended with its database connection {problem}. HQ's production requests run "
                            "in autocommit, where a failed statement leaves the next one free to run; inside a "
                            "unit's transaction every later statement fails instead, so what the unit observed "
                            "after that point is not what production does. The error HQ raised or caught is the "
                            "place to look."
                        )
                    self._check_deferred(lambda: "HQ's work in the unit, checked as the unit ended,")
                finally:
                    self._open = False
                    for mark in self._marks:
                        mark.live = False
                    self._marks.clear()
        finally:
            _OPEN.remove(self)
            if self._transactional:
                with connection.cursor() as cursor:
                    reset_sequences(cursor, database.template_sequences())

    def _require_open(self, what):
        if not self._open:
            raise UnitRefused(f"The unit was asked for {what} after it closed; open a unit (hq_unit) for it.")

    def _require_branchable(self, what):
        self._require_open(what)
        if not self._transactional:
            raise UnitRefused(
                f"The unit was asked to {what}, but it runs in autocommit (a fresh database, every statement "
                "committed as it ran), so there is no transaction to branch."
            )
        if self._scopes:
            scope = self._scopes[-1]
            raise UnitRefused(
                f"The unit was asked to {what} inside its {scope.kind} {scope.label}. That scope's entropy is "
                "drawn as its block runs and a restore cannot put it back, so marks, restores and forks happen "
                "between scopes."
            )

    # Writes --------------------------------------------------------------------

    def _wrote(self, what):
        if self._internal or not self._open:
            return
        if self._scopes:
            for scope in self._scopes:
                scope.wrote = True
        elif self._strict:
            raise UnscopedWrite(
                f"HQ's state took {what} outside every operation and request of its unit, so the unit's key "
                "would no longer name its state. Run the step that wrote inside unit.operation(label, digest), "
                "or a page's request inside unit.request(digest)."
            )

    def _write_would_count(self):
        """Whether a write now would change what the unit records: the innermost open scope has not written yet
        (a write marks every open scope at once), or, with no scope open, the unit refuses unscoped writes."""
        if self._scopes:
            return not self._scopes[-1].wrote
        return self._strict

    def _couch_write(self):
        self._couch_writes += 1
        self._wrote("a Couch write")

    def _blob_write(self):
        self._wrote("a blob write")

    def publish(self, topic, change):
        """Keep a change HQ published for its pillows (``ChangeProducer.send_change``), as a write."""
        self._wrote(f"a change published to HQ's change feed ({topic})")
        self.changes.append((topic, change))

    def _watch_sql(self, execute, sql, params, many, context):
        if self._internal or not self._open:
            return execute(sql, params, many, context)
        text = _sql_text(sql, context)
        effect = SqlEffect(writes=True) if text is None else sql_effect(text)
        called = effect.calls & self._functions
        shown = (text or repr(sql))[:200]
        if effect.writes:
            self._sql_writes += 1
            self._wrote(f"the SQL statement {shown!r}")
            result = execute(sql, params, many, context)
        elif not called:
            return execute(sql, params, many, context)
        elif not self._write_would_count():
            # Unmeasured, so counted as one that may have written.
            self._sql_writes += 1
            result = execute(sql, params, many, context)
        elif getattr(context["cursor"].cursor, "name", None):
            self._sql_writes += 1
            self._wrote(f"the SQL statement {shown!r}, which calls {', '.join(sorted(called))} through a named cursor")
            result = execute(sql, params, many, context)
        else:
            # The measuring reads run on the raw connection, past every execute wrapper.
            try:
                result, moved = _measured(execute, sql, params, many, context)
            except BaseException:
                # A call that raised may have moved a sequence before it did (nextval is not undone), unmeasured.
                self._sql_writes += 1
                raise
            if moved:
                self._sql_writes += 1
                self._wrote(
                    f"the SQL statement {shown!r}, whose call of {', '.join(sorted(called))} changed rows or a sequence"
                )
        # Outside HQ's atomic blocks, production commits the statement as it ends.
        self._at_commit(self._connection, lambda: f"HQ's SQL statement {shown!r}, run {self._where()},")
        return result

    # Deferred constraints --------------------------------------------------------

    def _where(self):
        if not self._scopes:
            return "outside every operation and request"
        scope = self._scopes[-1]
        return f"in its {scope.kind} {scope.label}"

    def _at_commit(self, connection, describe):
        """Where production would commit, at the unit's own atomic depth, check the deferred constraints, and
        inside ``committing()`` run the functions HQ asked to run on that commit."""
        if (
            connection is self._connection
            and len(connection.atomic_blocks) == self._base_atomic
            and transaction_problem() is None
        ):
            self._check_deferred(describe)
            self._run_commit_callbacks()

    @contextmanager
    def committing(self):
        """Inside the block, a function HQ asks to run when its transaction commits (``transaction.on_commit``)
        runs where production's commit would run it, in place of being refused (the module's "Commit
        callbacks"). Only a rollback unit takes it: any other already runs or refuses them itself."""
        self._require_open("commit callbacks")
        if not self._transactional:
            raise UnitRefused(
                "Only a rollback unit runs HQ's commit callbacks itself; a unit over a fresh database commits and"
                " Django runs them, and a unit over a reusable worker database refuses them."
            )
        self._committing += 1
        try:
            yield self
        finally:
            self._committing -= 1

    def _registered_on_commit(self, original, func, robust):
        """``transaction.on_commit`` inside ``committing()``: kept by Django itself, and run at once where HQ is
        outside every atomic block of its own, as production's autocommit runs it."""
        original(func, robust)
        if len(self._connection.atomic_blocks) == self._base_atomic:
            self._run_commit_callbacks()

    def _run_commit_callbacks(self):
        """Run and clear the commit callbacks Django holds, as ``BaseDatabaseWrapper.run_and_clear_commit_hooks``
        does once a transaction commits: in the order registered, one that raises propagating unless it was
        registered ``robust``, which Django logs and passes over."""
        if not self._committing or self._internal or not self._open:
            return
        import logging

        connection = self._connection
        pending, connection.run_on_commit = connection.run_on_commit, []
        while pending:
            _, func, robust = pending.pop(0)
            if robust:
                try:
                    func()
                except Exception as error:  # noqa: BLE001 - Django's own handling of a robust callback
                    logging.getLogger("django.db.backends.base").error(
                        "Error calling %s in on_commit() (%s).", getattr(func, "__qualname__", func), error
                    )
            else:
                func()

    def _check_deferred(self, describe):
        """Check every deferred constraint as a commit would; a violation is refused, naming ``describe()``."""
        if self._internal or not self._open or not self._transactional:
            return
        error = _violated_deferred_constraint(self._connection.connection)
        if error is None:
            return
        raise DeferredConstraintViolated(
            f"{describe()} left a row that breaks a deferred constraint: {str(error).strip()}\n"
            "Production checks the deferred constraints (every foreign key HQ's schema makes) as HQ's work "
            "commits: in its autocommit, as each statement HQ runs outside its atomic blocks ends, and as each "
            "outermost atomic block closes, and the commit fails there with IntegrityError. The unit's "
            "transaction never commits, so the unit checks them at those points, and as each operation, request "
            "and the unit itself ends, and stops at the first that fails. The constraint and the key Postgres "
            "names are the place to look."
        ) from error

    @contextmanager
    def _internal_sql(self):
        self._internal += 1
        try:
            yield
        finally:
            self._internal -= 1

    # Scopes ----------------------------------------------------------------------

    @contextmanager
    def _scoped(self, scope, after):
        from proof.hq import determinism

        self._scopes.append(scope)
        finished = False
        try:
            with soft_assertions(scope.soft_assertions), determinism.operation(scope.key, scope.depth):
                yield scope
                # What a pillow does behind the scope's writes, done before the next scope reads them, under the
                # scope's own key and clock (proof.hq.elasticsearch).
                if self.indexes is not None:
                    self.indexes.settle()
            finished = True
        finally:
            if not self._scopes or self._scopes[-1] is not scope:
                raise RuntimeError("A unit's operations and requests closed out of order; nest them as blocks.")
            self._scopes.pop()
            after(scope)
            problem = transaction_problem()
            if problem is not None:
                raise AbortedTransaction(
                    f"HQ's {scope.kind} {scope.label} left the unit's database connection {problem}. Every "
                    "later statement of the unit would fail, so the unit stops here. The error HQ raised or "
                    "caught inside it, chained below when it raised, is the place to look."
                )
            if finished:
                self._check_deferred(lambda: f"HQ's {scope.kind} {scope.label}")

    def _refuse_inside_request(self, what):
        request = next((scope for scope in self._scopes if scope.kind == "request"), None)
        if request is not None:
            raise UnitRefused(
                f"The unit was asked for {what} inside its request {request.label}. A request answers one call a "
                "page makes and moves the key only when it writes, so a page's reads can be answered in any "
                "order; an operation or a request inside it would move the key of a read, or move it twice. Open "
                "it before or after the request."
            )

    @contextmanager
    def operation(self, label: str, digest: bytes):
        """One step of the unit: the key moves to ``sha256(key | label | digest)``, the depth up by one, and the
        block runs as one HQ operation under them. Yields the ``Scope``."""
        name = _check_label(label)
        digest = _check_digest(digest)
        self._require_open(f"the operation {label!r}")
        self._refuse_inside_request(f"the operation {label!r}")
        self.key = derive(self.key, name, digest)
        self.depth += 1

        def after(scope):
            if scope.wrote:
                self.writes += 1

        with self._scoped(Scope("operation", label, self.key, self.depth), after) as scope:
            yield scope

    @contextmanager
    def request(self, digest: bytes):
        """One HQ request a page makes, as an operation keyed by ``sha256(key | "request" | digest)`` at the
        current depth. Yields the ``Scope``; when the request wrote (``scope.wrote``), the key moves to
        ``sha256(key | "write" | digest)`` and the depth up by one."""
        digest = _check_digest(digest)
        self._require_open("a request")
        self._refuse_inside_request("another request")

        def after(scope):
            if scope.wrote:
                self.key = derive(self.key, b"write", digest)
                self.depth += 1
                self.writes += 1

        scope = Scope("request", digest.hex()[:16], derive(self.key, b"request", digest), self.depth)
        with self._scoped(scope, after):
            yield scope

    # Marks -------------------------------------------------------------------------

    def mark(self) -> Mark:
        """A point the unit can be put back to: everything ``restore`` puts back, as it is now."""
        from django.db import connection, transaction

        self._require_branchable("take a mark")
        problem = transaction_problem()
        if problem is not None:
            raise AbortedTransaction(f"The unit was asked to take a mark while its database connection was {problem}.")
        indexes = None
        if self.indexes is not None:
            # A lenient unit may have written outside every scope; what follows from that is settled now, under
            # the unit's own key and clock.
            if self.indexes.unsettled():
                from proof.hq import determinism

                with determinism.operation(self.key, self.depth):
                    self.indexes.settle()
            indexes = self.indexes.mark()
        with self._internal_sql():
            savepoint = transaction.savepoint()
            sequences = self._sequences_now(connection)
        mark = Mark(
            savepoint=savepoint,
            atomic_depth=len(connection.atomic_blocks),
            sequences=sequences,
            couch=self._couch_now(),
            files=self.blob_db.snapshot(),
            changes=len(self.changes),
            key=self.key,
            depth=self.depth,
            writes=self.writes,
            sql_writes=self._sql_writes,
            couch_writes=self._couch_writes,
            indexes=indexes,
        )
        self._marks.append(mark)
        return mark

    def _sequences_now(self, connection):
        """Every sequence's value now: as last read or set where no SQL statement since could have moved one
        (every statement that writes, and every call of the template's functions that may, is counted in
        ``_sql_writes``), else read."""
        from proof.hq.database import read_sequences

        known = self._known_sequences
        if known is not None and known[0] == self._sql_writes and not VERIFY_MEMOS:
            return known[1]
        with connection.cursor() as cursor:
            sequences = read_sequences(cursor)
        if known is not None and known[0] == self._sql_writes and sequences != known[1]:
            raise MemoMismatch(
                "A sequence moved while no SQL statement the unit saw could have moved one, so the unit's write "
                "count misses a statement (one run past Django's cursor) and proof/hq/branch.py must read the "
                "sequences at every mark."
            )
        self._known_sequences = (self._sql_writes, sequences)
        return sequences

    def _couch_now(self):
        """The Couch store's snapshot (each document's JSON text): as last taken or put back where nothing has
        written to it since."""
        known = self._known_couch
        if known is not None and known[0] == self._couch_writes and not VERIFY_MEMOS:
            return known[1]
        snapshot = self.couch.snapshot()
        if known is not None and known[0] == self._couch_writes and snapshot != known[1]:
            raise MemoMismatch(
                "The in-memory Couch changed with no write the unit saw, so proof/hq/branch.py must take its "
                "snapshot at every mark."
            )
        self._known_couch = (self._couch_writes, snapshot)
        return snapshot

    def _live_index(self, mark, what):
        if not isinstance(mark, Mark) or not mark.live or not any(held is mark for held in self._marks):
            raise UnitRefused(
                f"The unit was asked to {what} a mark it does not hold: one taken in another unit, or one a "
                "restore to an earlier mark or the end of its fork released, so the state it named is gone."
            )
        return next(index for index, held in enumerate(self._marks) if held is mark)

    def restore(self, mark: Mark) -> None:
        """Put the unit back exactly to ``mark``; the mark stays, and every mark taken after it is gone."""
        from django.db import connection, transaction

        self._require_branchable("restore a mark")
        index = self._live_index(mark, "restore")
        if len(connection.atomic_blocks) != mark.atomic_depth:
            raise UnitRefused(
                "The unit was asked to restore a mark from inside an atomic block opened after the mark; the "
                "rollback would remove that block's savepoint under it. Restore after the block closes."
            )
        with self._internal_sql():
            # A savepoint rollback clears what made the transaction unusable (Django's own atomic exit does
            # the same before it rolls back to its savepoint).
            connection.needs_rollback = False
            transaction.savepoint_rollback(mark.savepoint)
            # Sequences are not transactional: set back each one that moved, unless no statement since the mark
            # could have moved one (``_sequences_now``).
            if self._sql_writes != mark.sql_writes or VERIFY_MEMOS:
                with connection.cursor() as cursor:
                    moved = reset_sequences(cursor, mark.sequences)
                if moved and self._sql_writes == mark.sql_writes:
                    raise MemoMismatch(
                        f"{moved} sequences moved after a mark while no SQL statement the unit saw could have moved"
                        " one, so the unit's write count misses a statement and proof/hq/branch.py must set the"
                        " sequences back at every restore."
                    )
        self._known_sequences = (self._sql_writes, mark.sequences)
        if self._couch_writes != mark.couch_writes or VERIFY_MEMOS:
            if self._couch_writes == mark.couch_writes and self.couch.snapshot() != mark.couch:
                raise MemoMismatch(
                    "The in-memory Couch changed after a mark with no write the unit saw, so proof/hq/branch.py "
                    "must put its snapshot back at every restore."
                )
            self.couch.restore_snapshot(mark.couch)
        self._known_couch = (self._couch_writes, mark.couch)
        self.blob_db.restore_snapshot(mark.files)
        del self.changes[mark.changes :]
        if self.indexes is not None and mark.indexes is not None:
            self.indexes.restore(mark.indexes)
        clear_caches()
        self.key, self.depth, self.writes = mark.key, mark.depth, mark.writes
        for later in self._marks[index + 1 :]:
            later.live = False
        del self._marks[index + 1 :]

    def _release(self, mark):
        from django.db import transaction

        index = self._live_index(mark, "release")
        with self._internal_sql():
            transaction.savepoint_commit(mark.savepoint)
        for released in self._marks[index:]:
            released.live = False
        del self._marks[index:]

    @contextmanager
    def fork(self):
        """A mark on entry, restored and released on exit, always. Yields the mark."""
        mark = self.mark()
        try:
            yield mark
        finally:
            self.restore(mark)
            self._release(mark)


# Guards ------------------------------------------------------------------------------


@contextmanager
def _refusing_new_connections():
    import psycopg2

    original = psycopg2.connect

    def refuse(*args, **kwargs):
        raise NewConnectionRefused(
            "Something asked Postgres for a new connection while an HQ unit was open. A unit's state is one "
            "transaction on HQ's default connection, and a new connection (a reconnect, or an SQLAlchemy engine) "
            "would neither see it nor be rolled back with it. Open connections the harness needs (a fresh "
            "database's, say) before the unit; if HQ asked, the path needs a seam in proof/hq."
        )

    psycopg2.connect = refuse
    try:
        yield
    finally:
        psycopg2.connect = original


@contextmanager
def _refusing_on_commit(connection, *, rollback=True, unit=None):
    def refuse(func, robust=False):
        if rollback and unit is not None and unit._committing:
            # Django's own registration, on the connection itself (``connection`` is Django's proxy for it).
            wrapper = unit._connection
            return unit._registered_on_commit(lambda f, r: type(wrapper).on_commit(wrapper, f, r), func, robust)
        name = f"{getattr(func, '__module__', '?')}.{getattr(func, '__qualname__', repr(func))}"
        reason = (
            "The unit's transaction is always rolled back, so the function would never run, where production "
            "runs it once HQ's transaction commits."
            if rollback
            else "The unit uses a reusable worker database; commit callbacks require a fresh database its owner drops."
        )
        raise OnCommitRefused(
            f"HQ asked to run {name} when its transaction commits, while an HQ unit was open. {reason} "
            "Use the existing fresh-database nonrollback mode to execute the real callback, or run the step inside"
            " the rollback unit's committing() block, which runs it where production's commit would."
        )

    had = "on_commit" in vars(connection)
    original = vars(connection).get("on_commit")
    connection.on_commit = refuse
    try:
        yield
    finally:
        if had:
            connection.on_commit = original
        else:
            del connection.on_commit


@contextmanager
def _checking_commits(unit):
    """Every atomic block that closes without an error at the unit's own depth, where production commits it, has
    the deferred constraints checked (``Unit._at_commit``)."""
    from django.db import transaction

    original = transaction.Atomic.__exit__

    def exit_and_check(atomic, exc_type, exc_value, traceback):
        result = original(atomic, exc_type, exc_value, traceback)
        if exc_type is None and unit._open:
            unit._at_commit(
                transaction.get_connection(atomic.using), lambda: f"The atomic block HQ closed {unit._where()}"
            )
        return result

    transaction.Atomic.__exit__ = exit_and_check
    try:
        yield
    finally:
        transaction.Atomic.__exit__ = original


@contextmanager
def _rolled_back():
    from django.db import connection, transaction

    with transaction.atomic():
        try:
            yield
        finally:
            if connection.in_atomic_block:
                transaction.set_rollback(True)
