"""Snapshots carry exactly what the lane's runs kept, round-trip byte for byte, and the gate reads them back whole.

Contract (``proof.store.pack``, ``proof.store.reader``): a snapshot packed
from a run's outputs holds every part, document and transcript the run's
workers kept, every check's evidence on a document whose records the run
kept as a judgment under its key, and each group's outcome; merging it
(alone, with itself, or with an absent snapshot) writes the same bytes, and
a pull request's delta over it holds only the entries it adds, with every
blob they name, so it reads whole beside a later snapshot of main. Two
sources holding different values under one key keep neither, and an entry
naming a blob no source holds is a miss, never a failed merge. A package
group's outcome is kept only from a run in the environment the queue keys it
under. The gate's reader gives back the evidence each cached group's checks
wrote, and refuses a group the store cannot give whole.

The plausible failures: a snapshot whose bytes depend on the order its
sources were read in (so two equal stores make two cache entries), a merge
that keeps one of two differing records, a delta that repeats what main
holds or leans on a blob only main's snapshot of the day holds (every merge
of it failing once main's moves on), a package outcome kept from a run with
HQ's speed seams off standing for one with them on, and a reader that skips
a judgment it lacks, leaving the register nothing to hold.
"""

from __future__ import annotations

import json
import shutil
import stat
from types import SimpleNamespace

import pytest

from proof.lane import blocks as lane_blocks
from proof.observe.record import part_key
from proof.store import disk, keys, pack, reader, runtime
from proof.store.conftest import (
    LANE_RUN_ENVIRONMENT,
    document_of,
    observe_into,
    records_of,
    write_block,
    write_serve,
)
from proof.store.test_runtime import _environ, _transcript

DIFFERENCES = [
    {
        "artifact": "app.json",
        "path": "/modules/0/unique_id",
        "at": "/modules/0/unique_id",
        "kind": "changed",
        "before": "a",
        "after": "b",
    }
]


def _run(output, corpus, *, value="observed", outcome="passed"):
    """One lane run's output: each document observed through the store, its block's manifest and evidence."""
    for identifier in ("one", "two"):
        document = document_of(corpus, identifier)
        observe_into(runtime.session_store(document, _environ(output)), document, records_of(document, value=value))
        store = runtime.session_store(document, _environ(output))
    store.transcripts.put(_transcript())
    groups = {f"corpus:{i}": {f"proof/checks/test_bar.py::test_bar[{i}]": outcome} for i in ("one", "two")}
    evidence = {(check, f"corpus:{i}"): DIFFERENCES for check in ("bar", "proof2") for i in ("one", "two")}
    write_block(output, groups, evidence)
    return output


def _files(root):
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def test_every_file_the_store_writes_is_readable_by_another_user(tmp_path):
    """A CI shard's container writes its run's store as its own user, and the runner uploads it as another, so a
    file only its owner may read (``tempfile.mkstemp``'s 0600) fails the upload."""
    digest = disk.write_blob(tmp_path / "store", b"evidence")
    assert disk.write_whole(tmp_path / "store" / "index.json", b"{}", replace=False)
    for written in (disk.blob_path(tmp_path / "store", digest), tmp_path / "store" / "index.json"):
        assert stat.S_IMODE(written.stat().st_mode) & 0o044 == 0o044, written


def test_a_snapshot_packed_from_a_run_round_trips_byte_for_byte(tmp_path, corpus):
    output = _run(tmp_path / "out", corpus)
    first = pack.write(pack.gather([output, tmp_path / "absent"]), tmp_path / "first")
    index = json.loads((first / "index.json").read_text())
    assert {kind: len(index[kind]) for kind in disk.KINDS} == {
        "parts": 6,
        "documents": 2,
        "judgments": 4,
        "transcripts": 1,
        "groups": 2,
        # The Android stage's answers, which a run of the shards alone holds none of (proof/android/test_stage.py
        # packs a stage's output).
        "android": 0,
    }
    # Each judgment is the evidence its check wrote, as canonical JSON.
    written = {path.read_bytes() for path in (tmp_path / "out" / "blocks").glob("*/checks/*/*.json")}
    assert {disk.read_blob(first, found) for found in index["judgments"].values()} == {
        disk.canonical(json.loads(content)) for content in written
    }

    for sources in ([first], [first, first], [tmp_path / "absent", first], [first, tmp_path / "empty"]):
        (tmp_path / "empty").mkdir(exist_ok=True)
        again = tmp_path / f"again-{len(list(tmp_path.glob('again-*')))}"
        pack.write(pack.merged(sources), again, sources=sources)
        assert _files(again) == _files(first)
    # Packed again from the same output, in another order: the same bytes.
    second = pack.write(pack.gather([tmp_path / "absent", output]), tmp_path / "second")
    assert _files(second) == _files(first)
    # A snapshot is written over one of its sources, or into a directory that holds nothing else.
    with pytest.raises(pack.PackError, match="already holds files"):
        pack.write(pack.merged([first]), second)
    pack.write(pack.merged([first, second]), second, sources=[first, second])
    assert _files(second) == _files(first)


def test_a_key_two_sources_hold_differently_is_kept_by_neither_and_a_delta_holds_only_what_main_lacks(tmp_path, corpus):
    main = pack.write(pack.gather([_run(tmp_path / "main-run", corpus)]), tmp_path / "main")
    differing = pack.gather([_run(tmp_path / "other-run", corpus, value="differs")])
    combined = pack.merged([main, differing])
    assert combined.notes and all(note.startswith("Dropped the ") for note in combined.notes)
    # Written over a copy of main, the snapshot keeps no blob of what it dropped.
    over = tmp_path / "over"
    shutil.copytree(main, over)
    pack.write(pack.merged([over, differing]), over, sources=[over])
    written = json.loads((over / "index.json").read_text())
    assert {"sha256:" + path.name for path in (over / "blobs").glob("*/*")} == disk.reached_blobs(written)
    assert len(written["parts"]) < len(json.loads((main / "index.json").read_text())["parts"])
    held = disk.Snapshot(main)
    for kind in ("parts", "documents"):
        assert all(
            key not in combined.index[kind]
            for key, value in held.index[kind].items()
            if differing.index[kind].get(key) not in (None, value)
        )

    # The pull request's delta over main: nothing, when its run kept what main holds.
    same = pack.beyond(pack.merged([tmp_path / "no-scope", pack.gather([tmp_path / "main-run"])]), held)
    assert all(not same.index[kind] for kind in disk.KINDS)
    # A run that adds a document: the delta holds its entries and the blobs main lacks, and with main it reads whole.
    corpus_three = corpus.parent / "corpus"
    from proof.store.conftest import write_document

    write_document(corpus_three, "three", create="three")
    three = document_of(corpus_three, "three")
    observe_into(runtime.session_store(three, _environ(tmp_path / "three-run")), three, records_of(three))
    delta = pack.write(
        pack.beyond(pack.merged([tmp_path / "no-scope", pack.gather([tmp_path / "three-run"])]), held),
        tmp_path / "delta",
    )
    delta_index = json.loads((delta / "index.json").read_text())
    assert len(delta_index["documents"]) == 1 and len(delta_index["parts"]) == 3
    # The delta carries every blob its entries name, so it reads whole without main's snapshot.
    assert all(disk.blob_path(delta, found).is_file() for found in disk.reached_blobs(delta_index))
    read = pack.write(pack.merged([main, delta]), tmp_path / "read")
    store = runtime.session_store(three, _environ(tmp_path / "next", store=read))
    records = records_of(three)
    assert store.lookup(records.configurations["minimum"].keys["a"]) == records.configurations["minimum"].a
    assert store.blobs(records.configurations["minimum"].keys["a"]).refs() == records.blobs.refs()


def _cached(index, judge, group):
    document = next(key for key, entry in index["documents"].items() if entry["group"] == group)
    parts = index["documents"][document]["parts"]
    judged = keys.group_key(document, judge, {name: held for name, (_, held) in parts.items()})
    outcome = index["groups"][judged]
    return SimpleNamespace(group=group, judgments={**outcome["judgments"], "outcome": judged})


def test_the_gate_reads_each_cached_groups_evidence_and_refuses_a_group_the_store_cannot_give_whole(tmp_path, corpus):
    snapshot = pack.write(pack.gather([_run(tmp_path / "out", corpus)]), tmp_path / "snapshot")
    index = json.loads((snapshot / "index.json").read_text())
    judge = json.loads((tmp_path / "out" / "store" / "fingerprints.json").read_text())["fingerprints"]["judge"]
    cached = [_cached(index, judge, f"corpus:{i}") for i in ("one", "two")]
    found = reader.cached_evidence(cached, snapshot)
    assert sorted((record["check"], record["document"]) for record in found) == [
        ("bar", "one"),
        ("bar", "two"),
        ("proof2", "one"),
        ("proof2", "two"),
    ]
    missing = SimpleNamespace(group="corpus:one", judgments={"bar": "0" * 64})
    with pytest.raises(reader.StoreIncomplete, match="no judgment of bar on corpus:one"):
        reader.cached_evidence([missing], snapshot)
    misnamed = SimpleNamespace(group="corpus:two", judgments={"bar": cached[0].judgments["bar"]})
    with pytest.raises(reader.StoreIncomplete, match="is not bar's on corpus:two"):
        reader.cached_evidence([misnamed], snapshot)

    failed = pack.write(pack.gather([_run(tmp_path / "failed", corpus, outcome="failed")]), tmp_path / "failed-store")
    failed_index = json.loads((failed / "index.json").read_text())
    with pytest.raises(reader.StoreIncomplete, match="did not pass"):
        reader.cached_evidence([_cached(failed_index, judge, "corpus:one")], failed)


def test_the_surface_and_a_package_are_kept_under_the_key_their_queue_names(tmp_path):
    output = tmp_path / "out"
    directory = write_block(output, {"surface": {"proof/surface/test_x.py::test_x": "passed"}})
    (directory / "surface").mkdir()
    (directory / "surface" / "surface.json").write_text('{"items": []}\n')
    write_block(output, {"proof/core": {"proof/core/test_core.py::test_core": "passed"}})
    queue = tmp_path / "queue.json"
    queue.write_text(
        json.dumps(
            {
                "blocks": [
                    {"groups": [{"group": "surface", "key": "5" * 64}]},
                    {"groups": [{"group": "proof/core", "key": "6" * 64}]},
                ]
            }
        )
    )
    unqueued = pack.gather([output])
    assert unqueued.index["groups"] == {}
    snapshot = pack.write(pack.gather([output], [queue]), tmp_path / "snapshot")
    assert reader.surface_extraction(snapshot, "5" * 64) == b'{"items": []}\n'
    assert reader.surface_extraction(snapshot, None) is None
    assert reader.surface_extraction(snapshot, "6" * 64) is None
    assert (
        reader.cached_evidence([SimpleNamespace(group="proof/core", judgments={"outcome": "6" * 64})], snapshot) == []
    )


def test_a_pull_requests_delta_reads_whole_beside_a_later_main_and_a_blob_no_source_holds_is_a_miss(tmp_path, corpus):
    one = document_of(corpus, "one")
    observe_into(runtime.session_store(one, _environ(tmp_path / "m1-run")), one, records_of(one))
    m1 = pack.write(pack.gather([tmp_path / "m1-run"]), tmp_path / "m1")
    # The pull request edits one's update: its b_edit is a part of its own whose record names A's build, which
    # main's snapshot holds too.
    records = records_of(one)
    configuration = records.configurations["minimum"]
    edited = part_key("b", configuration.keys["a"], {"inputs": {"request.body": "sha256:" + "9" * 64}})
    record = {"kind": "b", "value": "edited", "build": configuration.a["build"]}
    pull = runtime.session_store(one, _environ(tmp_path / "pr-run", store=m1))
    pull.put(edited, record, records.blobs.named_by(record))
    scope = tmp_path / "scope"
    assert (
        pack.main(
            [
                "delta",
                "--base",
                str(m1),
                "--scope",
                str(tmp_path / "no-scope"),
                "--out",
                str(scope),
                str(tmp_path / "pr-run"),
            ]
        )
        == 0
    )
    # Main moves on: its next snapshot is of a changed document one, without that build.
    observe_into(runtime.session_store(one, _environ(tmp_path / "m2-run")), one, records_of(one, value="moved"))
    m2 = pack.write(pack.gather([tmp_path / "m2-run"]), tmp_path / "m2")
    assert not disk.Snapshot(m2).has_blob(configuration.a["build"])
    assert pack.main(["merge", "--into", str(tmp_path / "read"), str(m2), str(scope)]) == 0
    reading = runtime.session_store(one, _environ(tmp_path / "next", store=tmp_path / "read"))
    assert reading.lookup(edited) == record
    assert reading.blobs(edited).refs() == [configuration.a["build"]]
    assert pack.main(["delta", "--base", str(m2), "--scope", str(scope), "--out", str(tmp_path / "next-scope")]) == 0

    # A scope cut short (a blob gone): its entry is dropped and named, and read as a miss; the rest reads.
    disk.blob_path(scope, configuration.a["build"]).unlink()
    gathered = pack.merged([m2, scope])
    assert any(
        note.startswith("Dropped the parts entry") and configuration.a["build"] in note for note in gathered.notes
    )
    assert pack.main(["merge", "--into", str(tmp_path / "short"), str(m2), str(scope)]) == 0
    short = runtime.session_store(one, _environ(tmp_path / "after", store=tmp_path / "short"))
    assert short.lookup(edited) is None
    assert short.lookup(records_of(one, value="moved").configurations["minimum"].keys["a"]) is not None
    assert pack.main(["delta", "--base", str(m2), "--scope", str(scope), "--out", str(tmp_path / "short-scope")]) == 0
    # Every blob the written snapshot keeps is one its index names.
    index = json.loads((tmp_path / "short" / "index.json").read_text())
    kept = {"sha256:" + path.name for path in (tmp_path / "short" / "blobs").glob("*/*")}
    assert kept == disk.reached_blobs(index)
    # A blob damaged in its source is kept as it is, unread, and is a miss where it is read against its name.
    moved = records_of(one, value="moved").configurations["minimum"]
    damaged = disk.Snapshot(m2).get("parts", short.storage_key(moved.keys["a"]))["record"]
    disk.blob_path(m2, damaged).write_bytes(b"damaged")
    assert pack.main(["merge", "--into", str(tmp_path / "damaged"), str(m2)]) == 0
    reading = runtime.session_store(one, _environ(tmp_path / "later", store=tmp_path / "damaged"))
    assert reading.lookup(moved.keys["a"]) is None
    assert reading.lookup(moved.keys["b"]) is not None


def test_a_package_outcome_is_kept_only_from_a_run_in_the_environment_its_queue_keys_it_under(tmp_path, corpus):
    queue = tmp_path / "queue.json"
    queue.write_text(json.dumps({"blocks": [{"groups": [{"group": "proof/core", "key": "6" * 64}]}]}))
    for name, environment, kept in (
        ("lane", None, True),
        ("unseamed", {**LANE_RUN_ENVIRONMENT, "PROOF_HQ_SPEED": "0"}, False),
        ("all branches", {**LANE_RUN_ENVIRONMENT, "PROOF_BRANCH_DOCUMENTS": "all"}, True),
        ("one branch", {**LANE_RUN_ENVIRONMENT, "PROOF_BRANCH_DOCUMENTS": "tile"}, False),
        ("unrecorded", {}, False),
    ):
        output = tmp_path / name
        write_serve(output, environment=environment)
        if name == "unrecorded":
            serve = json.loads((output / lane_blocks.SERVE).read_text())
            del serve["selection"]["environment"]
            (output / lane_blocks.SERVE).write_text(json.dumps(serve))
        _run(output, corpus)
        write_block(output, {"proof/core": {"proof/core/test_core.py::test_core": "passed"}})
        gathered = pack.gather([output], [queue])
        assert ("6" * 64 in gathered.index["groups"]) is kept, name
        # A document's outcome is keyed by the environment its run recorded, so it is kept all the same, but from
        # a run whose branch proof named its own documents: a document's group holds that proof's items of it.
        documents = [g for g in gathered.index["groups"].values() if g["group"].startswith("corpus:")]
        assert len(documents) == (0 if name in ("one branch", "unrecorded") else 2), name


def test_a_run_of_another_selection_keeps_its_records_and_no_outcome_or_judgment(tmp_path, corpus):
    for name, selection in (("arguments", {"pytest_arguments": ["-k", "bar"]}), ("addopts", {"addopts": "-k bar"})):
        output = tmp_path / name
        write_serve(output, **selection)
        gathered = pack.gather([_run(output, corpus)])
        assert len(gathered.index["parts"]) == 6 and len(gathered.index["documents"]) == 2
        assert gathered.index["groups"] == {} and gathered.index["judgments"] == {}
        assert any("does not record the lane's own selection" in note for note in gathered.notes)


def test_the_gate_holds_a_cached_groups_stored_evidence_to_the_register_beside_what_ran(tmp_path, corpus):
    from proof.lane import gate

    snapshot = pack.write(pack.gather([_run(tmp_path / "earlier", corpus)]), tmp_path / "snapshot")
    index = json.loads((snapshot / "index.json").read_text())
    judge = json.loads((tmp_path / "earlier" / "store" / "fingerprints.json").read_text())["fingerprints"]["judge"]
    cached = _cached(index, judge, "corpus:one")
    # This run ran corpus:two and read corpus:one from the store.
    output = tmp_path / "out"
    write_block(output, {"corpus:two": {"t::two": "passed"}}, {("bar", "corpus:two"): []})
    queue = {
        "version": 1,
        "fingerprints": {},
        "blocks": [
            {
                "id": lane_blocks.block_id(["corpus:two"]),
                "estimate": 1.0,
                "groups": [{"group": "corpus:two", "fresh": False}],
            }
        ],
        "cached": [{"group": "corpus:one", "judgments": cached.judgments}],
    }
    queues = [("main", lane_blocks.parse_queue(queue))]
    held = gate.gate([output], queues, store=snapshot, committed=tmp_path / "absent-surface.json")
    # corpus:one's stored differences are not in the (empty) register, so the register fails on them by name.
    assert held["sections"]["exactlyOnce"]["holds"] and held["sections"]["tests"]["holds"]
    problems = "\n".join(held["sections"]["register"]["problems"])
    assert "one" in problems and "/modules/0/unique_id" in problems
    # Without the store, the cached group cannot be held at all, and the gate says so.
    unheld = gate.gate([output], queues, store=None, committed=tmp_path / "absent-surface.json")
    assert any("no store directory" in problem for problem in unheld["sections"]["register"]["problems"])
