"""The audits fail on every difference they exist to catch, and pass where the runs agree.

Contract (``proof.store.audit``, ``python3 -m proof.store.audit compare``):
held to a store (the nightly audit), a fresh run fails where it made another
record, document entry, judgment or outcome under a key the store holds,
and where two of its own shards made different ones under one key, writing
what each side holds under ``--mismatches``; it passes against an absent or
empty store and against one that holds what it made. Held to another run
(the weekly comparisons), every part is paired by its document and name and
every evidence record by its check and document; one only one run holds, or
that differs, fails, and with ``--masked`` only the evidence is compared, the
right run's held to the left's but for the values each drew.

The plausible failures: an audit that reads the run through ``gather``,
which drops a key two shards hold differently, and so passes the very
observation that is not a function of its key; a masked comparison that
also masks a real difference; and a comparison that names nothing when one
run lacks what the other holds.

Every case runs the command line over lane outputs written through the real
store (``proof.store.runtime.Store``) and block manifests.
"""

from __future__ import annotations

import json

from proof.store import audit, pack, runtime
from proof.store.conftest import document_of, observe_into, records_of, write_block
from proof.store.test_runtime import _environ

PASSED = {"corpus:one": {"proof/checks/test_bar.py::test_bar[one]": "passed"}}


def _shard(output, corpus, *, value="observed", evidence=None):
    """One fresh shard's output: document one observed through the store, its block and its evidence."""
    one = document_of(corpus, "one")
    observe_into(runtime.session_store(one, _environ(output, fresh=True)), one, records_of(one, value=value))
    write_block(output, PASSED, {("bar", "corpus:one"): evidence if evidence is not None else []})
    return output


def _compare(*arguments):
    return audit.main(["compare", *map(str, arguments)])


def test_a_fresh_run_held_to_the_store_fails_where_it_made_another_record_and_passes_where_it_agrees(
    tmp_path, corpus, capsys
):
    fresh = _shard(tmp_path / "fresh", corpus)
    assert _compare("--store", tmp_path / "absent", "--mismatches", tmp_path / "m0", fresh) == 0
    (tmp_path / "empty").mkdir()
    assert _compare("--store", tmp_path / "empty", "--mismatches", tmp_path / "m1", fresh) == 0
    same = pack.write(pack.gather([_shard(tmp_path / "earlier", corpus)]), tmp_path / "same")
    assert _compare("--store", same, "--mismatches", tmp_path / "m2", fresh) == 0
    assert "Everything compared is alike." in capsys.readouterr().out

    differing = pack.write(pack.gather([_shard(tmp_path / "other", corpus, value="differs")]), tmp_path / "differs")
    mismatches = tmp_path / "m3"
    assert _compare("--store", differing, "--mismatches", mismatches, fresh) == 1
    printed = capsys.readouterr().out
    assert "The store holds another part under" in printed
    part = next((mismatches / "parts").iterdir())
    assert json.loads((part / "held.json").read_text())["value"] == "differs"
    assert json.loads((part / "fresh.json").read_text())["value"] == "observed"


def test_two_shards_of_one_run_that_kept_different_records_under_one_key_fail_with_both_written(
    tmp_path, corpus, capsys
):
    first = _shard(tmp_path / "s1", corpus)
    second = _shard(tmp_path / "s2", corpus, value="differs")
    for store in (tmp_path / "absent", pack.write(pack.gather([first]), tmp_path / "held")):
        mismatches = tmp_path / f"mismatches-{store.name}"
        assert _compare("--store", store, "--mismatches", mismatches, first, second) == 1
        printed = capsys.readouterr().out
        assert "The run's shards kept 2 different parts entries under" in printed
        part = next(path for path in (mismatches / "parts").iterdir() if (path / "fresh-2.json").is_file())
        values = {json.loads((part / f"fresh-{n}.json").read_text())["value"] for n in (1, 2)}
        assert values == {"observed", "differs"}
        assert (part / "held.json").is_file() is (store.name == "held")
    # Held to another run, a run whose own shards differ fails too.
    assert _compare("--left", first, second, "--right", second, first) == 1
    assert "In the left run: The run's shards kept 2 different parts entries" in capsys.readouterr().out


def test_two_runs_held_to_each_other_pair_parts_and_evidence_and_masked_compares_evidence_up_to_drawn_ids(
    tmp_path, corpus, capsys
):
    drawn = [{"artifact": "app.json", "path": "/_id", "before": "a" * 32, "after": "b" * 32, "kind": "changed"}]
    redrawn = [{"artifact": "app.json", "path": "/_id", "before": "c" * 32, "after": "d" * 32, "kind": "changed"}]
    collapsed = [{"artifact": "app.json", "path": "/_id", "before": "c" * 32, "after": "c" * 32, "kind": "changed"}]
    left = _shard(tmp_path / "left", corpus, evidence=drawn)
    assert _compare("--left", left, "--right", _shard(tmp_path / "same", corpus, evidence=drawn)) == 0

    # Evidence differing only in the ids each run drew: alike masked, different unmasked.
    redrawn_run = _shard(tmp_path / "redrawn", corpus, evidence=redrawn)
    assert _compare("--masked", "--left", left, "--right", redrawn_run) == 0
    assert _compare("--left", left, "--right", redrawn_run) == 1
    assert "bar's evidence on corpus:one differs between the runs." in capsys.readouterr().out
    # Two ids the right run drew where the left holds one are alike: a seeded run draws one id for two states of
    # one key. One id of the right run's standing where the left holds two is a real difference, and so is an
    # id where a time was.
    collapsed_run = _shard(tmp_path / "collapsed", corpus, evidence=collapsed)
    assert _compare("--masked", "--left", collapsed_run, "--right", left) == 0
    assert _compare("--masked", "--left", left, "--right", collapsed_run) == 1
    assert "once their drawn values are masked" in capsys.readouterr().out
    timed = [{**drawn[0], "after": "2026-10-04T10:44:43Z"}]
    assert _compare("--masked", "--left", left, "--right", _shard(tmp_path / "timed", corpus, evidence=timed)) == 1
    # Anything else of the evidence is a real difference, masked or not.
    moved = [{**drawn[0], "path": "/modules/0/unique_id"}]
    assert _compare("--masked", "--left", left, "--right", _shard(tmp_path / "moved", corpus, evidence=moved)) == 1
    capsys.readouterr()
    # A record that differs is named by its document and part.
    assert (
        _compare("--left", left, "--right", _shard(tmp_path / "differs", corpus, value="differs", evidence=drawn)) == 1
    )
    assert "The runs kept different records for corpus:one minimum/a." in capsys.readouterr().out

    # What only one run holds is named.
    bare = tmp_path / "bare"
    write_block(bare, PASSED)
    assert _compare("--left", left, "--right", bare) == 1
    printed = capsys.readouterr().out
    assert "Only the left run kept the record corpus:one minimum/a." in printed
    assert "Only the left run wrote bar's evidence on corpus:one." in printed
