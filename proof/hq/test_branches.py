"""A unit's marks and restores give exactly the state a fresh database gives.

Contract: one unit per (document, configuration), branched by marks
(``proof.hq.branch``), observes what the harness observed with a fresh
database per observation: A, then B over it, and A again, then B-edit over
it. Each observation here is a step of its unit (``unit.operation``), so the
same steps under the same root key draw the same entropy and read the same
clock (``proof.hq.determinism``) whichever mechanism holds the state; any
byte that differs is state the branch failed to put back.

The plausible failures: a sequence a restore leaves advanced (Postgres
sequences are not transactional, and B's app document carries the blob
metadata ids they allocate), a Couch document a branch changed in place
(HQ's wrappers write through to the dictionary they wrap), a blob B put that
B-edit still sees, a cache that carries B's reads into B-edit, a change feed
entry, and a worker database a previous unit left dirty. Each is caught by
comparing, at A, B and B-edit, the app JSON HQ holds, every file HQ builds
(and its ``validate_app`` errors), every Couch document, every blob, every
row of every table in the database ordered by its primary key (a superset of
what the write detector sees, which misses foreign-key cascades and
triggers), the change feed and the key, in both orders of the branches (B
first, B-edit first). The fresh side is the per-check mechanism the harness
used before units: a database cloned for the observation, every statement
committed as it ran (``open_unit(transactional=False)``).

The documents cover lookups, media, locations, case search, several
modules, several languages and Connect, under both of their configurations.
``PROOF_BRANCH_DOCUMENTS`` names others (comma-separated ids), or ``all``
for every document the run checks that carries an edit. Each document's two
items run in that document's own lane group (``corpus:<id>``,
``proof.checks.sharding.item_group``), so the shards share them as they
share the checks; a named document the run's sample leaves out has no group
of its own, and its items stay in this package's, as every item does where
no corpus is named (``PROOF_CORPUS``).

The other contracts here: a restore puts back every sequence a fresh state
starts from (``test_a_restore_puts_every_sequence_back``), and takes away
every cache entry, change, Couch document and blob a branch added; each guard
and refusal (a new connection, ``on_commit``, an aborted transaction, an
unscoped write, a mark inside a scope, a request's label on an operation, an
operation or request inside a request, a second unit, a closed unit)
refuses, paired with the path it lets through; a row that breaks a deferred
constraint is refused at the step where production's commit fails, and
accepted where production's is; a write on any channel (SQL by its text, a
database function that changed rows, Couch, blobs, a published change) moves
the key and a read never does; and soft assertions are kept per operation
and request.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from dataclasses import dataclass
from types import SimpleNamespace
from unittest import mock

import pytest

from proof.checks import sharding
from proof.checks.cases import load_corpus
from proof.hq import branch, database, determinism, operations
from proof.hq.branch import (
    AbortedTransaction,
    DeferredConstraintViolated,
    NewConnectionRefused,
    OnCommitRefused,
    UnitRefused,
    UnscopedWrite,
    derive,
)
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.seams import build_seams, formplayer_validation
from proof.hq.state import hq_state, hq_unit, open_unit

# One document per kind of state the branches must put back.
DOCUMENTS = (
    "lookup-app",  # a lookup table uploaded before the create (Postgres rows, cascades)
    "media-rich",  # mapped media (Couch multimedia documents read through _all_docs)
    "location-multirung",  # locations
    "search-parent",  # case search on (CaseSearchConfig), two modules
    "nested-menu-registration-children",  # three modules
    "localization-bilingual",  # two languages
    "connect-deliver-custom",  # Connect
)
CONFIGURATIONS = ("minimum", "maximum")


@dataclass(frozen=True)
class Branched:
    """A document whose branches are held, and the lane group its items run in (None for this package's)."""

    id: str
    group: str | None


def _collected_corpus():
    """The corpus as the checks read it when they are collected, or None where none is named: the lane names one
    (``PROOF_CORPUS``), and collecting this module alone emits none."""
    return load_corpus() if os.environ.get("PROOF_CORPUS") else None


def _documents(corpus=None, named=None):
    corpus = _collected_corpus() if corpus is None else corpus
    named = os.environ.get("PROOF_BRANCH_DOCUMENTS", "") if named is None else named
    if named == "all":
        # B's and B-edit's branches are what this compares, under each configuration, so a document written with
        # no edit, or without one of them, has none to hold. Those the run's sample leaves out are left out here.
        ids = [
            document.id
            for document in (load_corpus() if corpus is None else corpus).documents
            if document.edit is not None
            and all(name in document.exports and name in document.edit.exports for name in CONFIGURATIONS)
        ]
    else:
        ids = [name.strip() for name in named.split(",") if name.strip()] or list(DOCUMENTS)
    # Only a document the run checks has a group a queue holds; one its sample leaves out is read by this package.
    groups = {} if corpus is None else {document.id: document.group for document in corpus.documents}
    return [pytest.param(Branched(identifier, groups.get(identifier)), id=identifier) for identifier in ids]


@pytest.fixture(autouse=True)
def seeded(monkeypatch):
    """The comparisons are byte for byte, so they hold whatever ``PROOF_HQ_DETERMINISM`` the process booted with."""
    monkeypatch.setattr(determinism, "ENABLED", True)


@pytest.fixture(scope="module")
def corpus():
    return load_corpus()


def _sha(*parts: bytes) -> bytes:
    hasher = hashlib.sha256()
    for part in parts:
        hasher.update(len(part).to_bytes(8, "big"))
        hasher.update(part)
    return hasher.digest()


def _root(*names: str) -> bytes:
    return hashlib.sha256("|".join(("proof/hq/test_branches", *names)).encode()).digest()


# The steps, each one operation of its unit ----------------------------------------------


def _captured_digest(captured):
    lookups = captured.lookups.body_path.read_bytes() if captured.lookups is not None else b""
    return _sha(captured.body_path.read_bytes(), lookups)


def _upload_lookups(unit, captured):
    if captured.lookups is not None:
        result = operations.upload_lookup_workbook(unit, captured.lookups.workbook(), replace=True)
        assert result.errors == [], result.errors


def _create(unit, export):
    with unit.operation("create", _captured_digest(export.create)):
        _upload_lookups(unit, export.create)
        result = operations.apply_upload(unit, export.create.upload())
        assert 200 <= result.status < 300 and result.response.get("success"), result.response
        return result.response["app_id"]


def _publish_over(unit, app_id, captured, label):
    with unit.operation(label, _captured_digest(captured)):
        served = operations.app_source(unit, app_id).get("profile")
        assert served == captured.assumed_source_profile, "HQ serves A with a profile the capture was not built over"
        _upload_lookups(unit, captured)
        result = operations.apply_upload(unit, operations.with_app_id(captured.upload(), app_id))
        assert 200 <= result.status < 300 and result.response.get("success"), result.response


def _build(unit, app_id, label, previous):
    """HQ's build as the observation makes it (``proof.observe.build.build_state``), which holds what a step
    raised and excuses a form ``validate_app`` reports an error for, as some corpus documents' builds do; and
    the build HQ would keep, None where HQ wrote no files."""
    from proof.observe.build import build_state

    with unit.operation(label, b""):
        with build_seams(previous=previous):
            outcome, hq_build = build_state(operations.held_app(unit, app_id), unit.record, label)
        return outcome, hq_build.saved_build() if hq_build is not None else None


# What a state is ------------------------------------------------------------------------------

_DUMP_SQL = None


def _dump_sql(cursor):
    """One query that reads every table, each as JSON ordered by its primary key (by the whole row without one)."""
    global _DUMP_SQL
    if _DUMP_SQL is None:
        cursor.execute(
            """
            SELECT c.oid::regclass::text, coalesce((
                SELECT string_agg(format('x.%I', a.attname), ', ' ORDER BY array_position(i.indkey::int2[], a.attnum))
                FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE i.indrelid = c.oid AND i.indisprimary), 'x::text')
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg_toast%%'
            ORDER BY 1
            """
        )
        tables = cursor.fetchall()
        parts = [
            f"SELECT %s, (SELECT coalesce(json_agg(x ORDER BY {order}), '[]'::json)::text FROM {name} x)"
            for name, order in tables
        ]
        _DUMP_SQL = (" UNION ALL ".join(parts), [name for name, _ in tables])
    return _DUMP_SQL


def _rows():
    from django.db import connection

    with connection.cursor() as cursor:
        sql, names = _dump_sql(cursor)
        cursor.execute(sql, names)
        return dict(cursor.fetchall())


def _canonical(value):
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def _file_digests(files):
    if files is None:
        return None
    return {
        path: hashlib.sha256(content if isinstance(content, bytes) else content.encode()).hexdigest()
        for path, content in sorted(files.items())
    }


def _observe(unit, app_id, built):
    return {
        "key": unit.key.hex(),
        "depth": unit.depth,
        "writes": unit.writes,
        "app": _canonical(operations.held_app(unit, app_id).to_json()),
        "build": {
            "errors": _canonical(built.errors),
            "raised": _canonical(built.raised),
            "files": _file_digests(built.files),
            "profiles": {profile: _file_digests(files) for profile, files in sorted(built.profile_files.items())},
        },
        "couch": _canonical(unit.couch.mock_docs),
        "blobs": {
            path: hashlib.sha256(content).hexdigest() for path, content in sorted(unit.blob_db.snapshot().items())
        },
        "sql": _rows(),
        "changes": _canonical(unit.changes),
    }


def _differences(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        found = []
        for key in sorted(set(a) | set(b), key=str):
            found += _differences(a.get(key), b.get(key), f"{path}/{key}")
        return found
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return [d for i, (x, y) in enumerate(zip(a, b, strict=True)) for d in _differences(x, y, f"{path}/{i}")]
    if a == b:
        return []
    if path.startswith("/sql/") and isinstance(a, str) and isinstance(b, str):
        return _differences(json.loads(a), json.loads(b), path)
    return [f"{path}: {json.dumps(a, default=str)[:160]} != {json.dumps(b, default=str)[:160]}"]


def _assert_same(fresh, branched, what):
    differences = _differences(fresh, branched)
    assert not differences, f"{what} differs from the fresh state at {len(differences)} paths:\n" + "\n".join(
        differences[:40]
    )


# The comparison -----------------------------------------------------------------------------------


def _fresh(configuration, root, export, validate, update=None):
    """A then B (or B-edit, given D''s update) in a database cloned for it, every statement committed as it ran."""
    with database.fresh_database():
        with open_unit(configuration, root_key=root, validate=validate, transactional=False) as unit:
            app_id = _create(unit, export)
            built_a, saved_a = _build(unit, app_id, "build-a", None)
            a = _observe(unit, app_id, built_a)
            if update is None:
                _publish_over(unit, app_id, export.republish, "republish")
            else:
                _publish_over(unit, app_id, update, "update")
            built_b, _ = _build(unit, app_id, "build-b", saved_a)
            return a, _observe(unit, app_id, built_b)


def _branched(configuration, root, export, update, validate, order):
    """A, a mark, then B and B-edit over it in ``order``, each restored to A after."""
    observed = {}
    with hq_unit(configuration, root_key=root, validate=validate) as unit:
        app_id = _create(unit, export)
        built_a, saved_a = _build(unit, app_id, "build-a", None)
        observed["A"] = _observe(unit, app_id, built_a)
        at_a = unit.mark()
        for name in order:
            if name == "B":
                _publish_over(unit, app_id, export.republish, "republish")
            else:
                _publish_over(unit, app_id, update, "update")
            built, _ = _build(unit, app_id, "build-b", saved_a)
            observed[name] = _observe(unit, app_id, built)
            unit.restore(at_a)
            _assert_same(observed["A"], _observe(unit, app_id, built_a), f"A restored after {name}")
    return observed


@pytest.mark.parametrize("configuration_name", CONFIGURATIONS)
@pytest.mark.parametrize("branched", _documents())
def test_branches_of_one_unit_equal_fresh_states(hq, core_runner, corpus, branched, configuration_name):
    document_id = branched.id
    document = corpus.document(document_id)
    if configuration_name not in document.exports or document.edit is None:
        pytest.fail(f"{document_id} has no {configuration_name} export with an edit, which this proof compares.")
    export = document.exports[configuration_name]
    update = document.edit.exports[configuration_name].update
    configuration = export.configuration.hq()
    root = _root(document_id, configuration_name)
    validate = formplayer_validation

    fresh_a, fresh_b = _fresh(configuration, root, export, validate)
    fresh_edit_a, fresh_edit = _fresh(configuration, root, export, validate, update)
    _assert_same(fresh_a, fresh_edit_a, "A in the edit's fresh state")
    assert fresh_b["key"] != fresh_edit["key"]

    for order in (("B", "B-edit"), ("B-edit", "B")):
        states = _branched(configuration, root, export, update, validate, order)
        _assert_same(fresh_a, states["A"], f"A ({' then '.join(order)})")
        _assert_same(fresh_b, states["B"], f"B ({' then '.join(order)})")
        _assert_same(fresh_edit, states["B-edit"], f"B-edit ({' then '.join(order)})")


def test_each_documents_branches_run_in_its_own_group_unless_the_sample_leaves_it_out(monkeypatch):
    def document(identifier, configurations=CONFIGURATIONS, edit=True):
        exports = dict.fromkeys(configurations)
        return SimpleNamespace(
            id=identifier,
            group=f"corpus:{identifier}",
            exports=exports,
            edit=SimpleNamespace(exports=exports) if edit else None,
        )

    kept, left_out = document("kept"), document("left-out")
    unedited, partial = document("unedited", edit=False), document("partial", ("minimum",))
    corpus = SimpleNamespace(documents=(kept, unedited, partial), emitted=(kept, unedited, partial, left_out))

    def groups(named):
        found = {}
        for param in _documents(corpus, named):
            (branched,) = param.values
            item = SimpleNamespace(callspec=SimpleNamespace(params={"branched": branched}), path=__file__)
            found[branched.id] = sharding.item_group(item)
        return found

    assert groups("all") == {"kept": "corpus:kept"}
    assert groups("left-out, kept") == {"left-out": "proof/hq", "kept": "corpus:kept"}
    assert [param.id for param in _documents(corpus, "")] == list(DOCUMENTS)
    monkeypatch.delenv("PROOF_CORPUS")
    assert {param.values[0].group for param in _documents(named="kept")} == {None}


# Sequences ------------------------------------------------------------------------------------


def _put_blob(unit):
    from corehq.blobs import CODES

    with unit.operation("put", b"proof blob"):
        meta = unit.blob_db.put(io.BytesIO(b"proof"), domain=unit.domain, parent_id="proof", type_code=CODES.tempfile)
    return meta.id, meta.key


def test_a_restore_puts_every_sequence_back(hq, core_runner, monkeypatch):
    """A blob's metadata id after a restore is the one a fresh state gives, and only because the restore set the
    sequence back: a savepoint rollback alone leaves it where the rolled-back put moved it."""
    configuration = Configuration()
    root = _root("sequences")
    with (
        database.fresh_database(),
        open_unit(configuration, root_key=root, validate=None, transactional=False) as fresh,
    ):
        expected = _put_blob(fresh)

    with hq_unit(configuration, root_key=root) as unit:
        at_seed = unit.mark()
        assert _put_blob(unit) == expected
        unit.restore(at_seed)
        assert _put_blob(unit) == expected

        with monkeypatch.context() as patch:
            patch.setattr(branch, "reset_sequences", lambda cursor, values: 0)
            unit.restore(at_seed)
        blob_id, blob_key = _put_blob(unit)
        assert blob_key == expected[1] and blob_id != expected[0]

        unit.restore(at_seed)
        assert _put_blob(unit) == expected


def test_a_mark_reads_the_sequences_and_couch_again_only_where_a_write_could_have_moved_them(
    hq, core_runner, monkeypatch
):
    """Sequences and the Couch text are read at a mark, and put back at a restore, only where an SQL statement
    that may write, or a Couch write, happened since they were last read or put back; where one did, the restore
    puts back exactly what it moved."""
    monkeypatch.setattr(branch, "VERIFY_MEMOS", False)
    reads, snapshots = [], []
    real_read = database.read_sequences
    monkeypatch.setattr(database, "read_sequences", lambda cursor: reads.append(1) or real_read(cursor))
    with hq_unit(Configuration(), root_key=_root("counted marks")) as unit:
        real_snapshot = unit.couch.snapshot
        monkeypatch.setattr(unit.couch, "snapshot", lambda: snapshots.append(1) or real_snapshot())
        first = unit.mark()
        counted = len(reads), len(snapshots)
        unit.mark()
        unit.restore(first)
        assert (len(reads), len(snapshots)) == counted  # nothing written: nothing read or put back
        expected = _put_blob(unit)  # an SQL write: a BlobMeta row, its id from a sequence
        unit.mark()
        assert (len(reads), len(snapshots)) == (counted[0] + 1, counted[1])
        with unit.operation("seed", b"proof counted"):
            unit.couch.seed({"_id": "proof-counted", "doc_type": "ProofDocument"})
        unit.mark()
        assert (len(reads), len(snapshots)) == (counted[0] + 1, counted[1] + 1)
        unit.restore(first)
        assert "proof-counted" not in unit.couch.mock_docs
        assert _put_blob(unit) == expected  # the sequence the put moved was set back


def test_a_write_outside_every_scope_of_a_lenient_unit_is_seen_by_the_next_mark_and_restore(hq, monkeypatch):
    """``hq_check`` and ``hq_state`` allow writes outside every operation and request, and take marks. A Couch
    document seeded and a blob put outside every scope each count as a write: the next mark takes the Couch
    snapshot or reads the sequences afresh, and a restore to a mark before the write takes the document away and
    sets the put's sequence back."""
    from corehq.blobs import CODES

    monkeypatch.setattr(branch, "VERIFY_MEMOS", False)
    reads, snapshots = [], []
    real_read = database.read_sequences
    monkeypatch.setattr(database, "read_sequences", lambda cursor: reads.append(1) or real_read(cursor))

    def put(unit):
        meta = unit.blob_db.put(io.BytesIO(b"proof"), domain=unit.domain, parent_id="proof", type_code=CODES.tempfile)
        return meta.id

    with hq_state(Configuration()) as unit:
        real_snapshot = unit.couch.snapshot
        monkeypatch.setattr(unit.couch, "snapshot", lambda: snapshots.append(1) or real_snapshot())
        first = unit.mark()
        counted = len(reads), len(snapshots)
        unit.couch.seed({"_id": "proof-unscoped", "doc_type": "ProofDocument"})
        seeded = unit.mark()
        assert len(snapshots) == counted[1] + 1 and "proof-unscoped" in seeded.couch
        unit.restore(first)
        assert "proof-unscoped" not in unit.couch.mock_docs
        assert "proof-unscoped" not in unit.mark().couch

        expected = put(unit)
        unit.mark()
        assert len(reads) == counted[0] + 1
        unit.restore(first)
        assert put(unit) == expected  # the sequence the put moved was set back


# A function that moves a sequence and then fails: its nextval is not undone with the statement.
_TAKE_AND_FAIL = (
    "CREATE FUNCTION proof_take_and_fail() RETURNS bigint LANGUAGE plpgsql AS"
    " $$ BEGIN PERFORM nextval('auth_user_id_seq'); RAISE EXCEPTION 'proof: taken, then failed'; END $$"
)


def _user_sequence():
    """``auth_user_id_seq`` as Postgres holds it: its last value and whether it was called."""
    from django.db import connection

    with connection.connection.cursor() as cursor:
        cursor.execute("SELECT last_value, is_called FROM auth_user_id_seq")
        return cursor.fetchone()


def test_every_call_of_a_function_that_may_move_a_sequence_is_counted_so_marks_and_restores_see_it(hq, monkeypatch):
    """A call of one of the database's functions may move a sequence, which a savepoint rollback does not set
    back. The unit counts it every way it runs one: measured in a scope that has not written yet (also where the
    call raised after moving it), unmeasured in a scope that has, and through a named cursor (whose call runs as
    its rows are fetched). After each, the next mark reads the moved sequence, and a restore to the mark before
    the call sets it back; a count missed would leave the mark holding the old value and the sequence where the
    call moved it."""
    from django.db import connection

    monkeypatch.setattr(branch, "VERIFY_MEMOS", False)
    functions = database.template_functions()
    monkeypatch.setattr(
        database, "template_functions", lambda: functions | {"proof_take_a_number", "proof_take_and_fail"}
    )

    def measured(unit):
        with unit.request(b"measured") as scope, connection.cursor() as cursor:
            cursor.execute("SELECT proof_take_a_number()")
        assert scope.wrote is True

    def measured_and_raised(unit):
        from django.db import InternalError

        with unit.request(b"measured, raised") as scope:
            # A savepoint the unit does not see, so the failed call leaves the transaction usable.
            with connection.connection.cursor() as raw:
                raw.execute("SAVEPOINT proof_failed_call")
            with pytest.raises(InternalError, match="taken, then failed"), connection.cursor() as cursor:
                cursor.execute("SELECT proof_take_and_fail()")
            with connection.connection.cursor() as raw:
                raw.execute("ROLLBACK TO SAVEPOINT proof_failed_call")
        assert scope.wrote is False  # the measured call raised: no change was seen to make it a write

    def unmeasured(unit):
        with unit.operation("wrote, then called", b"unmeasured") as scope:
            unit.couch.seed({"_id": "proof-unmeasured", "doc_type": "ProofDocument"})
            with connection.cursor() as cursor:
                cursor.execute("SELECT proof_take_a_number()")
        assert scope.wrote is True

    def named(unit):
        with unit.request(b"named cursor") as scope:
            cursor = connection._cursor(name="proof_named_cursor")
            try:
                cursor.execute("SELECT proof_take_a_number()")
                cursor.fetchall()
            finally:
                cursor.close()
        assert scope.wrote is True

    with hq_unit(Configuration(), root_key=_root("counted calls"), validate=None) as unit:
        with unit.operation("functions", b"take a number"), connection.cursor() as cursor:
            cursor.execute(_TAKE_A_NUMBER)
            cursor.execute(_TAKE_AND_FAIL)
        before = unit.mark()
        at_mark = _user_sequence()
        assert unit.mark().sequences == before.sequences
        for call in (measured, measured_and_raised, unmeasured, named):
            call(unit)
            moved = _user_sequence()
            assert moved != at_mark, call.__name__
            after = unit.mark()
            assert after.sequences != before.sequences, f"{call.__name__}: the mark kept the old sequences"
            unit.restore(before)
            assert _user_sequence() == at_mark, f"{call.__name__}: the restore left the sequence moved"


def test_verified_marks_and_restores_refuse_a_sequence_or_couch_document_moved_past_the_unit(hq, monkeypatch):
    """With ``PROOF_VERIFY_MEMOS=1`` a mark reads the sequences and the Couch store even where the unit saw no
    write, and refuses one that moved past it (a statement on the raw connection, a document put in the store's
    dictionary itself); so does a restore that finds a sequence moved."""
    from django.db import connection

    from proof.hq import couch
    from proof.hq.seams import MemoMismatch

    monkeypatch.setattr(branch, "VERIFY_MEMOS", True)
    monkeypatch.setattr(couch, "VERIFY_MEMOS", True)
    with hq_unit(Configuration(), root_key=_root("verified marks"), validate=None) as unit:
        first = unit.mark()
        unit.mark()  # nothing moved: the verified reads agree
        with connection.connection.cursor() as raw:
            raw.execute("SELECT nextval('auth_user_id_seq')")
        with pytest.raises(MemoMismatch, match="sequence moved"):
            unit.mark()
        with pytest.raises(MemoMismatch, match="sequences moved after a mark"):
            unit.restore(first)

    with hq_unit(Configuration(), root_key=_root("verified couch"), validate=None) as unit:
        unit.mark()
        unit.couch.mock_docs["proof-unseen"] = {"_id": "proof-unseen", "doc_type": "ProofDocument"}
        with pytest.raises(MemoMismatch, match="Couch changed"):
            unit.mark()


# Identical starts -------------------------------------------------------------------------------


def _seeded_state(unit):
    return {
        "key": unit.key.hex(),
        "depth": unit.depth,
        "couch": unit.couch.snapshot(),
        "blobs": unit.blob_db.snapshot(),
        "sql": _rows(),
    }


def test_a_restore_empties_the_caches_and_puts_the_change_feed_back(hq, core_runner):
    """What a branch cached, published for HQ's pillows, or added to Couch and the blob store ends with it. The
    control for each is the branch itself: inside it, HQ's cached read returns the branch's document, the feed
    holds its change, and the new document and blob are stored."""
    from corehq.apps.builds.models import CommCareBuildConfig
    from corehq.blobs import CODES

    from proof.hq.boot import clear_caches
    from proof.hq.state import build_config_document

    configuration = Configuration(privileges={"LOCATIONS"})
    with hq_unit(configuration, root_key=_root("caches")) as unit:
        assert CommCareBuildConfig.fetch().get_default().version == configuration.commcare_version
        changes = list(unit.changes)
        assert "proof-branch-document" not in unit.couch.mock_docs
        files = unit.blob_db.snapshot()
        with unit.fork():
            with unit.operation("another build", b"9.9.9"):
                clear_caches()
                unit.couch.seed(build_config_document(Configuration(commcare_version="9.9.9")))
                operations.seed_location(unit, "Delhi", "delhi")
                # A document and a blob under names absent at the mark.
                unit.couch.seed({"_id": "proof-branch-document", "doc_type": "ProofDocument"})
                meta = unit.blob_db.put(
                    io.BytesIO(b"proof"), domain=unit.domain, parent_id="proof-branch", type_code=CODES.tempfile
                )
            # HQ reads the branch's configuration and caches it (quickcache); saving a location published a change.
            assert CommCareBuildConfig.fetch().get_default().version == "9.9.9"
            assert len(unit.changes) > len(changes)
            assert "proof-branch-document" in unit.couch.mock_docs
            assert unit.blob_db.snapshot().keys() > files.keys()
            assert unit.blob_db.get(meta=meta).read() == b"proof"
        assert CommCareBuildConfig.fetch().get_default().version == configuration.commcare_version
        assert unit.changes == changes
        assert "proof-branch-document" not in unit.couch.mock_docs
        assert unit.blob_db.snapshot() == files


def test_units_with_one_configuration_and_root_key_start_from_one_state(hq, core_runner):
    """A unit that wrote (an app, its build, its saved build's blobs and rows) leaves the worker's database as the
    next unit with the same configuration and root key found it."""
    configuration = Configuration(privileges={"CLOUDCARE"}, case_search_enabled=True)
    root = _root("starts")
    with hq_unit(configuration, root_key=root) as unit:
        first = _seeded_state(unit)
        with unit.operation("publish", b"suite"):
            app_id, _ = operations.publish(unit, [nova_shaped_upload(hq_test_app(), "Suite")])
        _build(unit, app_id, "build", None)
    with hq_unit(configuration, root_key=root) as unit:
        _assert_same(first, _seeded_state(unit), "The second unit's start")


# Guards ------------------------------------------------------------------------------------------


def _connect():
    from django.db import connections

    connection = database._maintenance_connection(connections["default"].settings_dict)
    connection.close()


def test_a_new_connection_is_refused_while_a_unit_is_open(hq, core_runner):
    from corehq.sql_db.connections import connection_manager

    _connect()
    with hq_check(Configuration()) as (unit, _):
        with pytest.raises(NewConnectionRefused, match="new connection"):
            _connect()
        # SQLAlchemy's engines (HQ's connection manager) connect the same way.
        with pytest.raises(NewConnectionRefused):
            connection_manager.get_engine("default").connect()
        # The unit's own connection goes on.
        from corehq.apps.domain.models import Domain

        assert Domain.get_by_name(unit.domain).name == unit.domain
    _connect()


def _save_case_type(domain):
    from corehq.apps.data_dictionary.models import CaseType

    CaseType.objects.create(domain=domain, name="proof-case-type")


def test_on_commit_is_refused_while_a_unit_is_open(hq, core_runner):
    """HQ's ``project_db/signals.py::_sync_domain`` asks for ``on_commit`` when a data dictionary case type is
    saved under ``PROJECT_DB``: refused inside a unit, whose transaction never commits. Without the flag the same
    save asks for nothing, and outside a unit Django runs the function at once."""
    from django.db import transaction

    with hq_check(Configuration(flags={"PROJECT_DB"})) as (unit, _):
        with pytest.raises(OnCommitRefused, match="schedule_project_db_sync|_sync_domain"):
            _save_case_type(unit.domain)
        with pytest.raises(OnCommitRefused):
            transaction.on_commit(lambda: None)
    with hq_check(Configuration()) as (unit, _):
        _save_case_type(unit.domain)
    ran = []
    transaction.on_commit(lambda: ran.append(True))
    assert ran == [True]


def _failing_statement(own_savepoint=False):
    """A statement that fails, its error caught as an HQ path catches its own: around an atomic block of its own
    (which rolls back to that block's savepoint), or around the bare statement."""
    from django.db import connection, transaction
    from django.db.utils import ProgrammingError

    try:
        with transaction.atomic() if own_savepoint else contextlib.nullcontext():
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM proof_no_such_table")
    except ProgrammingError:
        pass


def test_an_operation_or_request_that_leaves_the_transaction_aborted_is_refused(hq, core_runner):
    with hq_unit(Configuration(), root_key=_root("aborted")) as unit:
        # A failure inside an atomic block of its own is rolled back to that block's savepoint: the unit goes on.
        with unit.operation("own savepoint", b""):
            _failing_statement(own_savepoint=True)
            assert branch.transaction_problem() is None
        at = unit.mark()
        with pytest.raises(AbortedTransaction, match="aborted transaction"):
            with unit.operation("caught outside a savepoint", b""):
                _failing_statement()
        unit.restore(at)
        assert branch.transaction_problem() is None
        with pytest.raises(AbortedTransaction, match="request"):
            with unit.request(b"a request"):
                _failing_statement()
        unit.restore(at)
        # A fork restores whatever its body left.
        with pytest.raises(AbortedTransaction):
            with unit.fork(), unit.operation("in a fork", b""):
                _failing_statement()
        assert branch.transaction_problem() is None


def test_a_write_outside_every_scope_is_refused_in_a_unit_named_by_its_key(hq, core_runner):
    from django.contrib.auth.models import User

    with hq_unit(Configuration(), root_key=_root("unscoped")) as unit:
        with pytest.raises(UnscopedWrite, match="SQL statement"):
            User.objects.create(username="proof-unscoped")
        with pytest.raises(UnscopedWrite, match="Couch write"):
            unit.couch.seed({"_id": "proof-unscoped", "doc_type": "ProofDocument"})
        with pytest.raises(UnscopedWrite, match="blob write"):
            unit.blob_db.put(io.BytesIO(b"x"), domain=unit.domain, parent_id="proof", type_code=0)
        # Nothing reached the state, and reads are free.
        assert not User.objects.filter(username="proof-unscoped").exists()
        assert "proof-unscoped" not in unit.couch.mock_docs
        with unit.operation("user", b""):
            User.objects.create(username="proof-unscoped")
    # A check's unit, which predates keys, lets it through.
    with hq_check(Configuration()) as (unit, _):
        User.objects.create(username="proof-unscoped")


def test_marks_restores_and_forks_happen_between_scopes_on_marks_the_unit_holds(hq, core_runner):
    from django.db import transaction

    with hq_unit(Configuration(), root_key=_root("marks")) as unit:
        first = unit.mark()
        with unit.operation("inside", b""):
            with pytest.raises(UnitRefused, match="inside its operation"):
                unit.mark()
            with pytest.raises(UnitRefused, match="inside its operation"):
                unit.restore(first)
        second = unit.mark()
        with transaction.atomic():
            with pytest.raises(UnitRefused, match="atomic block opened after the mark"):
                unit.restore(second)
        unit.restore(first)
        with pytest.raises(UnitRefused, match="does not hold"):
            unit.restore(second)
        with unit.fork() as forked:
            pass
        with pytest.raises(UnitRefused, match="does not hold"):
            unit.restore(forked)
        unit.restore(first)
        with pytest.raises(UnitRefused, match="label"):
            with unit.operation("a|b", b""):
                pass
        # A request's labels would give an operation a request's key.
        for label in ("request", "write"):
            with pytest.raises(UnitRefused, match="label a request's keys"):
                with unit.operation(label, b"save"):
                    pass
        # A request answers one call: an operation or another request inside it would move a read's key.
        with unit.request(b"read") as read:
            with pytest.raises(UnitRefused, match="inside its request"):
                with unit.operation("inner", b""):
                    pass
            with pytest.raises(UnitRefused, match="inside its request"):
                with unit.request(b"inner"):
                    pass
        assert read.wrote is False
        assert (unit.key, unit.depth) == (first.key, first.depth)
        with unit.operation("save", b"save"):
            pass
        assert unit.key == derive(first.key, b"save", b"save")
        unit.restore(first)
        # One unit at a time: a second one is refused before it touches the first one's state.
        with pytest.raises(UnitRefused, match="another was open"):
            with hq_unit(Configuration(), root_key=_root("nested")):
                pass
        from corehq.apps.domain.models import Domain

        assert Domain.get_by_name(unit.domain).name == unit.domain
        assert unit.couch.snapshot() == first.couch
        with unit.fork():
            pass
    # A unit is asked for nothing after it closes.
    for ask in (
        lambda: unit.operation("late", b"").__enter__(),
        lambda: unit.request(b"late").__enter__(),
        unit.mark,
    ):
        with pytest.raises(UnitRefused, match="after it closed"):
            ask()
    with pytest.raises(UnitRefused, match="sha256"):
        with hq_unit(Configuration(), root_key=b"short"):
            pass
    with (
        database.fresh_database(),
        open_unit(Configuration(), root_key=_root("marks"), validate=None, transactional=False) as fresh,
    ):
        with pytest.raises(UnitRefused, match="autocommit"):
            fresh.mark()


# Deferred constraints ---------------------------------------------------------------------------------

# A content type no row holds: a permission that names it breaks auth_permission's deferred foreign key.
_MISSING = 987654321
_PERMISSION_CONTENT_TYPE = "auth_permission_content_type_id_2f476e4b_fk_django_co"


def _permission(content_type_id, codename):
    from django.contrib.auth.models import Permission

    Permission.objects.create(content_type_id=content_type_id, name=codename, codename=codename)


def _content_type(content_type_id):
    from django.contrib.contenttypes.models import ContentType

    ContentType.objects.create(id=content_type_id, app_label="proof", model=f"model{content_type_id}")


def _in_atomic(*steps):
    def run():
        from django.db import transaction

        with transaction.atomic():
            for step in steps:
                step()

    return run


# Each case is one operation's steps; production may commit at the end of each (autocommit, or the close of an
# outermost atomic block), and the step where its commit fails is where the unit must refuse.
_COMMIT_CASES = {
    "orphan": ([lambda: _permission(_MISSING, "orphan")], 0),
    "orphan in an atomic block": ([_in_atomic(lambda: _permission(_MISSING, "orphan"))], 0),
    "child then parent": ([lambda: _permission(900001, "child"), lambda: _content_type(900001)], 0),
    "child then parent in an atomic block": (
        [_in_atomic(lambda: _permission(900002, "child"), lambda: _content_type(900002))],
        None,
    ),
    "parent then child": ([lambda: _content_type(900003), lambda: _permission(900003, "child")], None),
}


def _refused_at(unit, name, steps, refusal):
    """The index of the step whose commit was refused (``refusal``) and the error, or (None, None)."""
    done = []
    try:
        with unit.operation(name, b""):
            for step in steps:
                step()
                done.append(step)
    except refusal as error:
        return len(done), error
    return None, None


def _constraint(error):
    """The constraint Postgres named, from the psycopg2 error behind Django's or the unit's."""
    return error.__cause__.diag.constraint_name


def test_a_row_that_breaks_a_deferred_constraint_is_refused_where_production_commits_it(hq):
    """Every foreign key HQ's schema makes is deferred to the commit, which production's autocommit makes as each
    statement outside an atomic block ends and as each outermost atomic block closes. The unit's transaction never
    commits; it refuses at the same step a fresh database's commit fails, naming the same constraint, and accepts
    what that commit accepts: a child saved before its parent inside one atomic block, a parent before its
    child. After a refusal the unit goes on. The check defers every constraint again after it runs, which is the
    state a transaction starts in only while the template's every deferrable constraint is initially deferred."""
    from django.db import IntegrityError, connection

    configuration = Configuration()
    fresh_outcomes = {}
    with (
        database.fresh_database(),
        open_unit(configuration, root_key=_root("deferred"), validate=None, transactional=False) as fresh,
    ):
        for name, (steps, _) in _COMMIT_CASES.items():
            fresh_outcomes[name] = _refused_at(fresh, name, steps, IntegrityError)

    with hq_unit(configuration, root_key=_root("deferred"), validate=None) as unit:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FILTER (WHERE NOT condeferred), count(*) FROM pg_constraint WHERE condeferrable"
            )
            initially_immediate, deferrable = cursor.fetchone()
        assert initially_immediate == 0 and deferrable > 0
        for name, (steps, expected) in _COMMIT_CASES.items():
            with unit.fork():
                step, refusal = _refused_at(unit, name, steps, DeferredConstraintViolated)
            fresh_step, error = fresh_outcomes[name]
            assert step == fresh_step == expected, name
            if expected is not None:
                assert _constraint(refusal) == _constraint(error) == _PERMISSION_CONTENT_TYPE
                assert f"in its operation {name}" in str(refusal) and "breaks a deferred constraint" in str(refusal)
            assert branch.transaction_problem() is None


def _unseen_permission(content_type_id):
    """A permission inserted past Django's cursor, where the unit sees no statement."""
    from django.db import connection

    with connection.connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO auth_permission (name, content_type_id, codename) VALUES ('unseen', %s, 'unseen')",
            [content_type_id],
        )


def test_a_row_the_unit_did_not_see_at_a_commit_is_refused_as_its_scope_or_the_unit_ends(hq, core_runner, monkeypatch):
    """A statement run past Django's cursor is no commit point the unit sees: a row it leaves that breaks a deferred
    constraint is refused as its operation ends, or, outside every operation, as the unit ends; with its parent
    saved first, it is accepted. A check's unit, which lets writes outside its operations through, refuses an
    orphan HQ saves there at the statement, as production's autocommit does."""
    # The unseen statement moves a sequence, which a verified restore reads and reports first; this is the
    # constraint's refusal, on the path that trusts the unit's write count.
    monkeypatch.setattr(branch, "VERIFY_MEMOS", False)
    with hq_unit(Configuration(), root_key=_root("unseen"), validate=None) as unit:
        with unit.fork():
            with pytest.raises(DeferredConstraintViolated, match="HQ's operation unseen left"):
                with unit.operation("unseen", b""):
                    _unseen_permission(_MISSING)
        with unit.operation("unseen with its parent", b""):
            _content_type(900004)
            _unseen_permission(900004)
    with hq_check(Configuration()) as (unit, _):
        at = unit.mark()
        with pytest.raises(DeferredConstraintViolated, match="run outside every operation and request"):
            _permission(_MISSING, "orphan")
        unit.restore(at)
        _content_type(900005)
        _permission(900005, "child")
    with pytest.raises(DeferredConstraintViolated, match="checked as the unit ended"):
        with hq_state(Configuration()):
            _unseen_permission(_MISSING)


# Writes and keys ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("sql", "writes"),
    [
        ('SELECT "a"."b" FROM "a" WHERE "a"."id" = %s', False),
        ('SELECT "a"."b" FROM "a" WHERE "a"."id" = %s FOR UPDATE', False),
        ("WITH x AS (SELECT 1) SELECT * FROM x", False),
        ('(SELECT "a"."id" FROM "a") UNION (SELECT "b"."id" FROM "b")', False),
        ('SAVEPOINT "s1_x1"', False),
        ('RELEASE SAVEPOINT "s1_x1"', False),
        ('ROLLBACK TO SAVEPOINT "s1_x1"', False),
        ("SET CONSTRAINTS ALL IMMEDIATE", False),
        ("SHOW TIME ZONE", False),
        ('INSERT INTO "t" ("a") VALUES (%s) RETURNING "t"."id"', True),
        ('UPDATE "t" SET "a" = %s WHERE "t"."id" = %s', True),
        ('DELETE FROM "t" WHERE "t"."id" IN (%s)', True),
        ('WITH x AS (SELECT 1) INSERT INTO "t" SELECT * FROM x', True),
        ('(SELECT "a"."id" FROM "a") UNION (SELECT 1 FROM "b")', False),
        ('TRUNCATE "t"', True),
        ("DROP TABLE t CASCADE", True),
        ("SELECT nextval('t_id_seq')", True),
        ("SELECT setval(%s::regclass, %s, true)", True),
        ("SELECT pg_catalog.setval('t_id_seq', 1, false)", True),
        ('SELECT "t"."setval", "t"."nextval" FROM "t"', False),
        ("COPY t FROM STDIN", True),
        ('SELECT "a"."id" INTO "copy" FROM "a"', True),
        ('SELECT "a"."id" FROM "a" WHERE "a"."id" = %s FOR UPDATE', False),
        ('SELECT "a"."id" FROM "a" FOR NO KEY UPDATE OF "a" SKIP LOCKED', False),
        ('SELECT "a"."id" FROM "a" FOR SHARE', False),
        ('WITH gone AS (DELETE FROM "t" RETURNING "t"."id") SELECT * FROM gone', True),
        ("SELECT 1; INSERT INTO t VALUES (1)", True),
        ("", False),
        # Past sqlparse's grouping limit of 10,000 tokens.
        ('INSERT INTO "t" ("a", "b") VALUES ' + ", ".join(["(%s, %s)"] * 3000), True),
        ('SELECT "t"."id" FROM "t" WHERE "t"."id" IN (' + ", ".join(["%s"] * 6000) + ")", False),
    ],
    ids=lambda value: value[:60] if isinstance(value, str) else str(value),
)
def test_sql_is_a_write_unless_it_only_reads(sql, writes):
    assert branch.sql_effect(sql).writes is writes


@pytest.mark.parametrize(
    ("sql", "calls"),
    [
        ("SELECT soft_delete_cases(%s, %s, %s, %s, %s) as deleted_count", {"soft_delete_cases"}),
        ("SELECT * from get_cases_by_id(%s)", {"get_cases_by_id"}),
        ('SELECT 1 FROM "public"."Delete_Blob_Meta"(%s)', {"Delete_Blob_Meta"}),
        ("SELECT case_id FROM PUBLIC.GET_CASE_IDS_IN_DOMAIN(%s, %s)", {"get_case_ids_in_domain"}),
        ('SELECT "a"."id" FROM "a" WHERE "a"."domain" = %s', set()),
        # A keyword before a parenthesis (IN, ON) calls nothing.
        ('SELECT COUNT(*) AS "__count" FROM "a" WHERE "a"."id" IN (%s, %s)', {"count"}),
        ('SELECT "a"."id" FROM "a" INNER JOIN "b" ON ("a"."id" = "b"."a_id") WHERE "a"."x" IN (SELECT 1)', set()),
    ],
    ids=lambda value: value[:50] if isinstance(value, str) else None,
)
def test_a_read_names_every_function_it_calls(sql, calls):
    """The functions a read calls, by the name Postgres stores, and nothing else, are what the unit measures
    (``test_a_database_function_that_changes_rows_is_a_write_and_one_that_reads_is_not``)."""
    effect = branch.sql_effect(sql)
    assert effect.writes is False and effect.calls == calls


def test_a_write_moves_the_key_and_a_read_never_does(hq, core_runner):
    """Reads answered in either order leave the key where it was; a request that saves moves it to
    ``sha256(key | write | digest)`` and the depth up by one, and each channel (SQL, Couch, blobs) counts."""
    from django.contrib.auth.models import User

    with hq_unit(Configuration(privileges={"CLOUDCARE"}), root_key=_root("writes")) as unit:
        with unit.operation("publish", b"suite"):
            app_id, _ = operations.publish(unit, [nova_shaped_upload(hq_test_app(), "Suite")])
        key, depth, writes = unit.key, unit.depth, unit.writes
        assert writes == 2  # the seed and the publish

        answers = {}
        for digest in (b"source", b"source again", b"source"):
            with unit.request(digest) as scope:
                answers.setdefault(digest, []).append(json.dumps(operations.app_source(unit, app_id), sort_keys=True))
            assert scope.wrote is False and scope.kind == "request"
            assert (unit.key, unit.depth, unit.writes) == (key, depth, writes)
        assert len(set(answers[b"source"])) == 1

        update = nova_shaped_upload(hq_test_app(), "Suite, renamed", app_id="captured")
        with unit.request(b"save") as scope:
            operations.apply_upload(unit, operations.with_app_id(update, app_id))
        assert scope.wrote is True and scope.key == derive(key, b"request", b"save")
        assert (unit.key, unit.depth, unit.writes) == (derive(key, b"write", b"save"), depth + 1, writes + 1)

        for name, write in (
            ("sql", lambda: User.objects.create(username="proof-channel")),
            ("couch", lambda: unit.couch.seed({"_id": "proof-channel", "doc_type": "ProofDocument"})),
            # A copy writes the blob's file alone: no metadata row.
            ("blob", lambda: unit.blob_db.copy_blob(io.BytesIO(b"x"), key="proof-channel")),
        ):
            with unit.request(name.encode()) as scope:
                write()
            assert scope.wrote is True, name
        with unit.request(b"nothing") as scope:
            User.objects.filter(username="proof-channel").exists()
        assert scope.wrote is False


def _save_case(domain, case_id):
    from datetime import datetime, timezone

    from corehq.form_processor.models import CommCareCase

    now = datetime(2026, 9, 30, 10, tzinfo=timezone.utc)
    CommCareCase(
        case_id=case_id,
        domain=domain,
        type="person",
        name=case_id,
        owner_id="u-1",
        modified_on=now,
        server_modified_on=now,
        modified_by="u-1",
    ).save()


# A function of the kind no HQ function is at the pin, which changes a sequence and no row.
_TAKE_A_NUMBER = (
    "CREATE FUNCTION proof_take_a_number() RETURNS bigint LANGUAGE sql AS $$ SELECT nextval('auth_user_id_seq') $$"
)
# Whether the call runs inside a transaction block that began before its statement: now() is the transaction's
# start, which in a statement's own implicit transaction is the statement's start.
_IN_BLOCK = (
    "CREATE FUNCTION proof_in_block() RETURNS boolean LANGUAGE sql AS $$ SELECT now() < statement_timestamp() $$"
)


@pytest.mark.parametrize("transactional", [True, False], ids=["unit", "autocommit"])
def test_a_database_function_that_changes_rows_is_a_write_and_one_that_reads_is_not(hq, transactional, monkeypatch):
    """HQ writes through PL/pgSQL functions of its own, called as SELECTs (``hard_delete_cases``,
    ``soft_delete_cases``; ``form_processor/models/cases.py``), and reads through others
    (``get_case_ids_in_domain``). A call of one is measured: it is a write when it changed rows or a sequence, in
    a unit's transaction and in a fresh database's autocommit alike, and a read leaves the key where it was.

    The counts the measurement compares are the backend's own, which one idle outside a transaction sends away
    (and zeroes) every 500 ms (``PGSTAT_STAT_INTERVAL``); in autocommit, the measurement opens a transaction of its
    own around the call, so nothing is sent away between its reads. A function that compares its transaction's
    start with its statement's shows the call runs inside that transaction. A change HQ publishes for its pillows
    is a write on its own (``publish_deleted_cases`` writes no row)."""
    from corehq.form_processor.models import CommCareCase
    from django.db import connection

    functions = database.template_functions()
    assert {"hard_delete_cases", "soft_delete_cases", "get_case_ids_in_domain"} <= functions
    monkeypatch.setattr(database, "template_functions", lambda: functions | {"proof_take_a_number", "proof_in_block"})
    with contextlib.ExitStack() as stack:
        if not transactional:
            stack.enter_context(database.fresh_database())
        unit = stack.enter_context(
            open_unit(Configuration(), root_key=_root("functions"), validate=None, transactional=transactional)
        )
        with unit.operation("cases", b"c-1 c-2"):
            for case_id in ("c-1", "c-2"):
                _save_case(unit.domain, case_id)
            with connection.cursor() as cursor:
                cursor.execute(_TAKE_A_NUMBER)
                cursor.execute(_IN_BLOCK)
        key, depth = unit.key, unit.depth

        with unit.request(b"ids") as scope:
            assert sorted(CommCareCase.objects.get_case_ids_in_domain(unit.domain)) == ["c-1", "c-2"]
        assert scope.wrote is False and (unit.key, unit.depth) == (key, depth)
        with unit.request(b"in block") as scope, connection.cursor() as cursor:
            cursor.execute("SELECT proof_in_block()")
            assert cursor.fetchone() == (True,)
        assert scope.wrote is False and (unit.key, unit.depth) == (key, depth)

        with unit.request(b"hard delete") as scope:
            assert CommCareCase.objects.hard_delete_cases(unit.domain, ["c-1"], publish_changes=False) == 1
        assert scope.wrote is True and (unit.key, unit.depth) == (derive(key, b"write", b"hard delete"), depth + 1)
        assert CommCareCase.objects.get_case_ids_in_domain(unit.domain) == ["c-2"]
        # The same call over a case that is gone deletes nothing, so it wrote nothing.
        with unit.request(b"hard delete again") as scope:
            assert CommCareCase.objects.hard_delete_cases(unit.domain, ["c-1"], publish_changes=False) == 0
        assert scope.wrote is False

        changes = len(unit.changes)
        with unit.request(b"publish") as scope:
            CommCareCase.objects.publish_deleted_cases(unit.domain, ["c-2"])
        assert scope.wrote is True and len(unit.changes) == changes + 1
        assert unit.changes[-1][1]["document_id"] == "c-2"

        with unit.request(b"soft delete") as scope:
            with mock.patch.object(type(CommCareCase.objects), "publish_deleted_cases"):
                assert CommCareCase.objects.soft_delete_cases(unit.domain, ["c-2"]) == 1
        assert scope.wrote is True and CommCareCase.objects.get_case("c-2", unit.domain).deleted is True
        assert len(unit.changes) == changes + 1

        with unit.request(b"take a number") as scope, connection.cursor() as cursor:
            cursor.execute("SELECT proof_take_a_number()")
        assert scope.wrote is True
    # Outside every scope of a unit named by its key, a function call that changed rows and a published change
    # are refused, as any write is; a function call that only read is not.
    with hq_unit(Configuration(), root_key=_root("functions"), validate=None) as unit:
        with unit.operation("case", b"c-3"):
            _save_case(unit.domain, "c-3")
        assert CommCareCase.objects.get_case_ids_in_domain(unit.domain) == ["c-3"]
        with pytest.raises(UnscopedWrite, match="hard_delete_cases changed rows"):
            CommCareCase.objects.hard_delete_cases(unit.domain, ["c-3"], publish_changes=False)
        with pytest.raises(UnscopedWrite, match="change feed"):
            CommCareCase.objects.publish_deleted_cases(unit.domain, ["c-3"])
        assert unit.changes == []


def _submission(case_id, date_modified):
    return f"""<?xml version='1.0' ?>
<data xmlns="http://example.com/proof/branches" name="Visit">
  <case xmlns="http://commcarehq.org/case/transaction/v2" case_id="{case_id}" date_modified="{date_modified}"
        user_id="u-1"><create><case_type>person</case_type><case_name>A</case_name><owner_id>u-1</owner_id>
  </create></case>
  <meta xmlns="http://openrosa.org/jr/xforms"><instanceID>form-1</instanceID><userID>u-1</userID>
    <timeStart>2026-09-30T10:00:00Z</timeStart><timeEnd>2026-09-30T10:00:01Z</timeEnd></meta>
</data>""".encode()


def test_each_operation_and_request_keeps_the_soft_assertions_hq_noted_inside_it(hq, core_runner):
    """HQ notes a soft assertion for an empty ``date_modified``
    (``casexml/apps/case/util.py::validate_phone_datetime``) and goes on, as production does, to its own refusal
    of the empty case id; the scope it was noted in keeps it, and so does the unit's record. A valid submission
    notes nothing."""
    from casexml.apps.case.exceptions import IllegalCaseId

    with hq_unit(Configuration(), root_key=_root("soft")) as unit:
        with unit.operation("valid", b"") as valid:
            accepted = operations.process_case_blocks(unit, _submission("c-1", "2026-09-30T10:00:00.000000Z"))
        with unit.request(b"empty") as empty:
            refused = operations.process_case_blocks(unit, _submission("", ""))
    assert accepted.refusal is None and valid.soft_assertions == []
    assert isinstance(refused.refusal, IllegalCaseId)
    assert {(note.message, note.where) for note in empty.soft_assertions} == {
        (
            "phone datetime should never be empty",
            "corehq/ex-submodules/casexml/apps/case/util.py::validate_phone_datetime",
        )
    }
    assert unit.record.soft_assertions == empty.soft_assertions
