"""The Android stage reads each archive once, judges what was read, and writes an output the gate can hold.

Contracts (``proof.android.stage``, ``proof.android.records``, ``proof.store.queue``'s Android queue, and the
gate's reading of them): every request the stage makes names the archives and restore it reads, so an answer
made once is read from the store by every later run and never made again, while one changed entry of one
archive makes exactly the requests that read that archive; the stage's output is an output like a shard's, so
the gate holds every Android block to exactly once and the stage's evidence to the register's entries of its
own stage, beside the shards' evidence of the same check on the same document; and a request the reader itself
could not answer fails the group and keeps no answer.

The plausible failures: a key that misses an input (an answer of one archive read for another), or names
something that is not one (every run makes every answer again); the stage's evidence of proof 3 colliding with
the shards' own, or an Android entry failing the shards' check that can never show it; a block of the Android
queue no shard of the stage ran passing the gate; a reader's failure kept as an answer.

The reader here is a stand-in that answers from the bytes of the archive it is handed, so these tests hold the
stage's own logic wherever the lane runs; commcare-android's own code answers in ``selfcheck.py``, where the
reader runs.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from proof.android import records, stage
from proof.checks import registers, sharding
from proof.lane import blocks as lane_blocks
from proof.lane import gate
from proof.store import disk, keys, pack
from proof.store import queue as store_queue

PROOF_DIR = Path(__file__).resolve().parents[1]
CONTROL = "targeted-survey-menu"
FINGERPRINTS = {
    "observation": "o" * 64,
    "browser": "b" * 64,
    "judge": "j" * 64,
    "harness": "h" * 64,
    "image": "sha256:" + "1" * 64,
    "postgres": "sha256:" + "2" * 64,
    "arch": "arm64",
}


class Reader:
    """Answers from the archive's own bytes: its profile's text is the one reader's answer."""

    def __init__(self, fail=()):
        self.requests = []
        self.fail = set(fail)

    def _profile(self, path):
        with zipfile.ZipFile(path) as zipped:
            return zipped.read("profile.ccpr").decode()

    def request(self, op, **arguments):
        from proof.android.client import AndroidReaderError

        self.requests.append(
            (op, {name: Path(str(value)).name for name, value in arguments.items() if name != "answers"})
        )
        if op in self.fail:
            raise AndroidReaderError(f"The reader could not answer the {op} request.", log="the JVM's output")
        if op == "app":
            return {
                "install": "Installed",
                "profile": {"app": {}, "readers": {"Profile.text": self._profile(arguments["archive"])}},
                "restore": Path(arguments["restore"]).read_text() if "restore" in arguments else None,
                "walks": {},
            }
        if op == "installs":
            return {"installs": [{"install": "Installed", "installedApps": ["a"]} for _ in arguments["archives"]]}
        return {
            "install": "Installed",
            "staged": "UpdateStaged",
            "updated": "Installed",
            "workerSettings": sorted(arguments.get("preferences") or {}),
            "before": {
                "app": {"uniqueId": "a", "versionNumber": 1},
                "stored": dict(arguments.get("preferences") or {}),
            },
            "after": {"app": {"uniqueId": "a", "versionNumber": 2}, "stored": dict(arguments.get("preferences") or {})},
        }


def _ccz(path: Path, profile: str, tag: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zipped:
        zipped.writestr("profile.ccpr", profile)
        zipped.writestr("suite.xml", f"<suite of='{tag}'/>")
    return path


def _lane(tmp_path: Path, *, local="plain", a="plain", b="plain", saved="plain", group="corpus:doc"):
    """A lane run's output holding one document's records, and its corpus: Nova's two local exports, and one
    configuration's A, B and one editor save, each archive a profile of the named text and a suite of its own
    (so no two archives are one)."""
    output = tmp_path / "lane-out"
    delta = disk.Delta(output / disk.DELTA)
    suites = iter(("A", "B", "save"))

    def archive(profile):
        suite = f"<suite of='{next(suites)}'/>".encode()
        return {"entries": {"profile.ccpr": delta.put_blob(profile.encode()), "suite.xml": delta.put_blob(suite)}}

    restore = delta.put_blob(b"<restore/>")
    parts = {
        "minimum/a": {"kind": "a", "state": {"archive": archive(a)}, "restoreA": {"restore": restore}},
        "minimum/b": {
            "kind": "b",
            "state": {"archive": archive(b)},
            "proof4": {
                "restore": restore,
                "views": [
                    {"scope": [None, None], "sections": [{"section": "app settings", "archive": archive(saved)}]}
                ],
                "vellum": [],
            },
        },
        "minimum/b_aligned": {"kind": "b_aligned", "sessions": {"restoreLocal": restore}},
    }
    document = keys.hashed("test-document", group)
    delta.put(
        "documents",
        document,
        {
            "group": group,
            "parts": {
                name: [keys.hashed("part", name), delta.put_blob(disk.canonical(record))]
                for name, record in parts.items()
            },
        },
    )
    kind, _, identifier = group.partition(":")
    corpus = tmp_path / "corpus"
    if kind == "corpus":
        _ccz(corpus / identifier / "local.ccz", local, "local")
        _ccz(corpus / identifier / "local-again.ccz", local, "local again")
    return output, corpus, document


def _queue(tmp_path: Path, groups: dict[str, str], *, fresh=False) -> Path:
    """An Android queue of ``groups`` (each group's document key), a block each, for the reader here."""
    reader = records.fingerprint(records.host_platform())
    queued = []
    for name, document in sorted(groups.items()):
        group = store_queue.Group(f"{lane_blocks.ANDROID}{name}", 10.0, fresh=fresh)
        group.key = keys.hashed("android-group", keys.VERSION, document, reader, FINGERPRINTS["judge"])
        group.document = document
        queued.append(group)
    value = store_queue.queue_value(queued, {**FINGERPRINTS, "android": reader}, dedupe=False)
    path = tmp_path / "android-queue.json"
    store_queue.write_queue(path, value)
    return path


def _register(tmp_path: Path, monkeypatch, entries) -> None:
    path = tmp_path / "register.json"
    path.write_text(json.dumps(entries), encoding="utf-8")
    monkeypatch.setenv("PROOF_KNOWN_DEFECTS", str(path))


def _entry(identifier, check, artifact, path, *, document="doc", control=CONTROL):
    return {
        "id": identifier,
        "defect": 7,
        "part": "a planted difference",
        "check": check,
        "artifact": artifact,
        "path": path,
        "document": document,
        "control": control,
    }


def _run(tmp_path, name, queue, corpus, outputs, *, reader=None, store=None, bin_=None):
    run = stage.Run(
        queue_path=queue,
        out=tmp_path / name,
        corpus=corpus,
        outputs=outputs,
        store=store,
        jobs=2,
        bin_=bin_,
        write_records=True,
        reader=reader or Reader(),
    )
    return run, run.run()


def _outcomes(out: Path) -> dict:
    return {
        name.rsplit("::", 1)[1]: outcome
        for _, manifest in lane_blocks.read_manifests(out)
        for group in manifest["groups"]
        for name, outcome in group["outcomes"].items()
    }


def _evidence(out: Path, check: str) -> dict:
    (path,) = out.glob(f"blocks/*/checks/{check}/*.json")
    return json.loads(path.read_text(encoding="utf-8"))


def test_every_archive_is_read_once_and_a_later_run_reads_every_answer_from_the_store(tmp_path, monkeypatch):
    _register(tmp_path, monkeypatch, [])
    lane, corpus, document = _lane(tmp_path)
    queue = _queue(tmp_path, {"corpus:doc": document})
    reader = Reader()
    run, code = _run(tmp_path, "first", queue, corpus, [lane], reader=reader)
    assert code == 0
    # Nova's local archive, A, B and the one save, each once; the two install pairs; and three updates (the
    # local pair, A to B with every incomplete form, B to the save is none: its profile is B's).
    assert sorted(op for op, _ in reader.requests) == ["app"] * 4 + ["installs"] * 2 + ["update"] * 2
    assert run.counts == {"requests": 8, "read": 0, "made": 8, "failed": 0}
    assert _outcomes(tmp_path / "first") == {
        "records": "passed",
        "proof1": "passed",
        "proof3": "passed",
        "proof4": "passed",
    }
    assert _evidence(tmp_path / "first", "proof3") == {
        "check": "proof3",
        "document": "doc",
        "kind": "corpus",
        "stage": "android",
        "differences": [],
    }

    # Packed with the queue, the store holds each answer under its key, and the group under the queue's.
    snapshot = tmp_path / "snapshot"
    gathered = pack.gather([tmp_path / "first"], [queue])
    pack.write(gathered, snapshot)
    assert len(disk.Snapshot(snapshot).index["android"]) == 8
    again = Reader()
    run, code = _run(tmp_path, "second", queue, corpus, [lane], reader=again, store=snapshot)
    assert code == 0 and again.requests == []
    assert run.counts == {"requests": 8, "read": 8, "made": 0, "failed": 0}
    first = {path.name: path.read_bytes() for path in (tmp_path / "first").glob("blocks/*/checks/*/*.json")}
    second = {path.name: path.read_bytes() for path in (tmp_path / "second").glob("blocks/*/checks/*/*.json")}
    assert first == second


def test_one_changed_archive_is_read_again_and_no_other(tmp_path, monkeypatch):
    _register(
        tmp_path, monkeypatch, [_entry("save", "proof4", "android@app settings@*", "/profile/readers/Profile.text")]
    )
    lane, corpus, document = _lane(tmp_path)
    queue = _queue(tmp_path, {"corpus:doc": document})
    _run(tmp_path, "first", queue, corpus, [lane])
    snapshot = tmp_path / "snapshot"
    pack.write(pack.gather([tmp_path / "first"], [queue]), snapshot)

    changed = tmp_path / "changed"
    lane, corpus, document = _lane(changed, saved="forced")
    queue = _queue(changed, {"corpus:doc": document})
    reader = Reader()
    run, code = _run(changed, "out", queue, corpus, [lane], reader=reader, store=snapshot)
    assert code == 0
    # The save's own app, and the device that updates to it from B, now that its profile is another.
    assert sorted(op for op, _ in reader.requests) == ["app", "update"]
    assert run.counts["read"] == 8 - 1 and run.counts["made"] == 2
    found = _evidence(changed / "out", "proof4")["differences"]
    assert [(d["artifact"], d["path"], d["before"], d["after"]) for d in found] == [
        ("android@app settings@B@minimum", "/profile/readers/Profile.text", "plain", "forced")
    ]
    assert _outcomes(changed / "out")["proof4"] == "passed"


def test_a_planted_difference_fails_its_check_until_an_android_entry_holds_it(tmp_path, monkeypatch):
    lane, corpus, document = _lane(tmp_path, local="another")
    queue = _queue(tmp_path, {"corpus:doc": document})
    _register(tmp_path, monkeypatch, [])
    _run(tmp_path, "unregistered", queue, corpus, [lane])
    assert _outcomes(tmp_path / "unregistered") == {
        "records": "passed",
        "proof1": "passed",
        "proof3": "failed",
        "proof4": "passed",
    }
    failures = next((tmp_path / "unregistered").glob("blocks/*/android/corpus-doc.failures.txt")).read_text()
    assert "no known-defect entry names" in failures and "android@local.ccz /profile/readers/Profile.text" in failures

    entry = _entry("local", "proof3", "android@local.ccz", "/profile/readers/Profile.text")
    _register(tmp_path, monkeypatch, [entry])
    _run(tmp_path, "registered", queue, corpus, [lane])
    assert _outcomes(tmp_path / "registered")["proof3"] == "passed"

    # The entry left listed once the difference is gone fails the check that no longer shows it.
    fixed = tmp_path / "fixed"
    lane, corpus, document = _lane(fixed)
    _run(fixed, "out", _queue(fixed, {"corpus:doc": document}), corpus, [lane])
    assert _outcomes(fixed / "out")["proof3"] == "failed"


def test_a_control_is_judged_by_the_checks_whose_android_entries_name_it(tmp_path, monkeypatch):
    entry = _entry("save", "proof4", "android@app settings@*", "/profile/readers/Profile.text")
    # The shards' own entry names the same control for proof 3, which is theirs to show there and no check of
    # the stage's.
    theirs = _entry("lane", "proof3", "trace@local.ccz", "/runs/*/trace")
    _register(tmp_path, monkeypatch, [entry, theirs])
    lane, corpus, document = _lane(tmp_path, saved="forced", group=f"control:{CONTROL}")
    queue = _queue(tmp_path, {f"control:{CONTROL}": document})
    _run(tmp_path, "shown", queue, corpus, [lane])
    assert _outcomes(tmp_path / "shown") == {"records": "passed", "proof4": "passed"}

    gone = tmp_path / "gone"
    lane, corpus, document = _lane(gone, group=f"control:{CONTROL}")
    _run(gone, "out", _queue(gone, {f"control:{CONTROL}": document}), corpus, [lane])
    assert _outcomes(gone / "out") == {"records": "passed", "proof4": "failed"}


def test_a_request_the_reader_cannot_answer_fails_the_group_and_keeps_no_answer(tmp_path, monkeypatch):
    _register(tmp_path, monkeypatch, [])
    lane, corpus, document = _lane(tmp_path)
    queue = _queue(tmp_path, {"corpus:doc": document})
    run, code = _run(tmp_path, "out", queue, corpus, [lane], reader=Reader(fail={"installs"}))
    assert code == 0
    assert _outcomes(tmp_path / "out")["records"] == "failed"
    assert run.counts == {"requests": 8, "read": 0, "made": 6, "failed": 2}
    assert len(disk.Delta(tmp_path / "out" / disk.DELTA).entries("android")) == 6


def test_a_fresh_answer_that_is_not_the_stored_one_fails_the_group(tmp_path, monkeypatch):
    """The audit: a group the queue marks fresh makes every answer again and holds it to the store's."""
    _register(tmp_path, monkeypatch, [])
    lane, corpus, document = _lane(tmp_path)
    queue = _queue(tmp_path, {"corpus:doc": document})
    _run(tmp_path, "first", queue, corpus, [lane])
    snapshot = tmp_path / "snapshot"
    pack.write(pack.gather([tmp_path / "first"], [queue]), snapshot)

    class Moved(Reader):
        def request(self, op, **arguments):
            answer = super().request(op, **arguments)
            if op == "installs":
                answer["installs"][0]["install"] = "UnknownFailure"
            return answer

    fresh = tmp_path / "fresh"
    fresh.mkdir()
    queue = _queue(fresh, {"corpus:doc": document}, fresh=True)
    run, _ = _run(fresh, "same", queue, corpus, [lane], store=snapshot)
    assert run.counts["made"] == 8 and _outcomes(fresh / "same")["records"] == "passed"
    run, _ = _run(fresh, "moved", queue, corpus, [lane], reader=Moved(), store=snapshot)
    assert _outcomes(fresh / "moved")["records"] == "failed"
    assert len(list((fresh / "moved" / "audit").glob("*/fresh.json"))) == 2


def test_the_stages_shards_run_disjoint_bins_that_cover_the_queue(tmp_path, monkeypatch):
    _register(tmp_path, monkeypatch, [])
    groups, outputs = {}, []
    corpus = None
    for name in ("one", "two", "three"):
        lane, corpus_root, document = _lane(tmp_path / name, group=f"corpus:{name}")
        groups[f"corpus:{name}"] = document
        outputs.append(lane)
        corpus = corpus or tmp_path / "corpus"
        (corpus / name).parent.mkdir(parents=True, exist_ok=True)
        (corpus_root / name).rename(corpus / name)
    queue = _queue(tmp_path, groups)
    ran = []
    for index in (1, 2):
        _run(tmp_path, f"shard-{index}", queue, corpus, outputs, bin_=f"{index}/2")
        ran.append(
            {
                group["group"]
                for _, m in lane_blocks.read_manifests(tmp_path / f"shard-{index}")
                for group in m["groups"]
            }
        )
    assert ran[0].isdisjoint(ran[1])
    assert ran[0] | ran[1] == {f"android:corpus:{name}" for name in ("one", "two", "three")}
    verdict = sharding.verify(
        [("android", lane_blocks.load_queue(queue))], [tmp_path / "shard-1", tmp_path / "shard-2"]
    )
    assert verdict.problems == []
    # One shard alone leaves the other's blocks unrun, which the verify names.
    alone = sharding.verify([("android", lane_blocks.load_queue(queue))], [tmp_path / "shard-1"])
    assert any("No shard's output holds block" in problem for problem in alone.problems)


def _shard_evidence(tmp_path: Path, differences) -> Path:
    """A proof shard's block holding the shards' own proof 3 evidence on the document."""
    directory = tmp_path / "shard-out" / "blocks" / "x"
    path = directory / "checks" / "proof3" / "corpus-doc.json"
    path.parent.mkdir(parents=True)
    record = {"check": "proof3", "document": "doc", "kind": "corpus", "differences": differences}
    path.write_text(json.dumps(record), encoding="utf-8")
    return directory


def test_the_register_holds_the_stages_evidence_beside_the_shards_own_each_to_its_own_entries(tmp_path, monkeypatch):
    lane, corpus, document = _lane(tmp_path, local="another")
    queue = _queue(tmp_path, {"corpus:doc": document})
    android_entry = _entry("android", "proof3", "android@local.ccz", "/profile/readers/Profile.text")
    lane_entry = _entry("lane", "proof3", "trace@local.ccz", "/runs/*/trace")
    _register(tmp_path, monkeypatch, [android_entry, lane_entry])
    _run(tmp_path, "android-out", queue, corpus, [lane])
    (android_block,) = (tmp_path / "android-out" / "blocks").iterdir()
    theirs = {
        "check": "proof3",
        "document": "doc",
        "artifact": "trace@local.ccz",
        "path": "/runs/*/trace",
        "at": "/runs/0/trace",
        "kind": "changed",
        "before": 1,
        "after": 2,
    }
    shard_block = _shard_evidence(tmp_path, [theirs])
    entries = registers.load_known_defects()
    assert [entry.stage for entry in entries] == [registers.ANDROID, registers.LANE]

    def problems(directories):
        # Each entry's control is not among these outputs, which each entry's own problem then says.
        return [p for p in registers.verify_evidence(directories, entries) if "retains its control" not in p]

    assert problems([shard_block, android_block]) == []
    # The shards' evidence alone: the Android entry was never shown, and is named as the stage's.
    alone = problems([shard_block])
    assert len(alone) == 1 and "the Android stage never ran proof3 on doc" in alone[0]
    # The stage's evidence alone: the shards' entry was never shown.
    alone = problems([android_block])
    assert len(alone) == 1 and "no shard ran proof3 on doc" in alone[0]


def test_the_shards_own_check_holds_only_the_shards_entries_and_still_runs_a_control_an_android_entry_names(
    tmp_path, monkeypatch
):
    """``proof.checks.cases.hold`` is the shards' side of the same split: an Android entry on the document must
    not fail the shards' check, which can never show it, and a control only Android entries name is run for
    its records and holds nothing there; a shards' entry is still held on both."""
    from proof.checks import cases
    from proof.checks.corpus import Document
    from proof.checks.differences import Difference

    monkeypatch.setenv("PROOF_OUT", str(tmp_path / "out"))
    _register(
        tmp_path,
        monkeypatch,
        [
            _entry("android", "proof3", "android@local.ccz", "/profile/readers/Profile.text"),
            _entry("lane", "proof3", "trace@local.ccz", "/runs/*/trace"),
        ],
    )
    entries = registers.load_known_defects()
    theirs = Difference("proof3", "doc", "trace@local.ccz", "/runs/*/trace", "/runs/0/trace", "changed", 1, 2)
    document = Document(id="doc", source="targeted", root=tmp_path)
    cases.hold("proof3", document, [theirs], entries)
    with pytest.raises(AssertionError, match="no longer shows it there"):
        cases.hold("proof3", document, [], entries)
    control = Document(id=CONTROL, source="control", root=tmp_path, kind="control")
    cases.hold("proof3", control, [theirs], entries)
    with pytest.raises(AssertionError, match="no longer shows the symptom"):
        cases.hold("proof3", control, [], entries)
    android_only = [entry for entry in entries if entry.stage == registers.ANDROID]
    cases.hold("proof3", control, [], android_only)
    # A control no entry names for the check at all is still refused: nothing could show there.
    with pytest.raises(AssertionError, match="no longer shows the symptom"):
        cases.hold("proof3", control, [], ())


def test_the_gate_holds_the_android_queue_to_exactly_once_and_reads_a_cached_group_from_the_store(
    tmp_path, monkeypatch
):
    _register(tmp_path, monkeypatch, [])
    lane, corpus, document = _lane(tmp_path)
    queue = _queue(tmp_path, {"corpus:doc": document})
    _run(tmp_path, "android-out", queue, corpus, [lane])
    surface = tmp_path / "surface.json"
    surface.write_text("{}", encoding="utf-8")
    queues = [("android", lane_blocks.load_queue(queue))]
    result = gate.gate([tmp_path / "android-out"], queues, committed=surface)
    assert result["sections"]["exactlyOnce"]["holds"] and result["sections"]["tests"]["holds"]
    assert result["sections"]["register"]["holds"]
    # No output: the queue's one block ran nowhere.
    empty = tmp_path / "empty"
    empty.mkdir()
    lane_blocks.write_json(empty / lane_blocks.SERVE, {"phases": []})
    assert not gate.gate([empty], queues, committed=surface)["sections"]["exactlyOnce"]["holds"]

    # A later queue built over the packed store reads the group, and the gate its evidence, from the store.
    snapshot = tmp_path / "snapshot"
    pack.write(pack.gather([tmp_path / "android-out"], [queue]), snapshot)
    value = json.loads(queue.read_text(encoding="utf-8"))
    key = value["blocks"][0]["groups"][0]["key"]
    outcome = disk.Snapshot(snapshot).index["groups"][key]
    assert sorted(outcome["judgments"]) == ["proof1", "proof3", "proof4"]
    cached = lane_blocks.Queue(
        (),
        (lane_blocks.CachedGroup("android:corpus:doc", {**outcome["judgments"], "outcome": key}),),
        value["fingerprints"],
    )
    result = gate.gate([empty], [("android", cached)], store=snapshot, committed=surface)
    assert result["sections"]["exactlyOnce"]["holds"] and result["sections"]["register"]["holds"]
    assert result["sections"]["register"]["cached"] == 1


def test_the_android_queue_holds_each_document_and_each_control_an_android_entry_names(tmp_path):
    corpus = tmp_path / "corpus"
    (corpus / "doc").mkdir(parents=True)
    (corpus / "doc" / "document.json").write_text("{}", encoding="utf-8")
    (corpus / "index.json").write_text(json.dumps({"documents": [{"id": "doc"}]}), encoding="utf-8")
    proof = tmp_path / "proof"
    (proof / "controls" / "kept").mkdir(parents=True)
    (proof / "controls" / "kept" / "document.json").write_text("{}", encoding="utf-8")
    (proof / "controls" / "unnamed").mkdir()
    (proof / "known-defects.json").write_text(
        json.dumps(
            [
                {"artifact": "android@local.ccz", "control": "kept"},
                {"artifact": "trace@local.ccz", "control": "unnamed"},
            ]
        ),
        encoding="utf-8",
    )
    builder = store_queue.Builder([], FINGERPRINTS, {}, fresh=False)
    groups = store_queue.android_groups(builder, corpus, "reader-1", proof)
    assert [group.name for group in groups] == ["android:control:kept", "android:corpus:doc"]
    assert all(group.status == "observed" and group.key and group.document for group in groups)
    # Another reader is another key, so a store's outcome for one is no hit for the other.
    other = store_queue.android_groups(builder, corpus, "reader-2", proof)
    assert {group.key for group in groups}.isdisjoint({group.key for group in other})
    assert [group.document for group in groups] == [group.document for group in other]
    for name in ("android:corpus:doc", "android:control:kept"):
        assert lane_blocks.group_problem(name) is None
    for name in ("android:doc", "android:corpus:", "android:corpus:doc@minimum", "android:proof/hq"):
        assert lane_blocks.group_problem(name) is not None


def test_an_android_group_names_its_documents_key_under_the_environment_the_shards_run_in(tmp_path):
    """A lane run with a lane-env that changes what the shards record (HQ's determinism or speed seams off) keeps
    each document's records under a key naming it; the stage finds them by the key its group names, so the queue
    must be built under the same environment, and a variable that changes nothing recorded changes no key."""
    corpus = tmp_path / "corpus"
    (corpus / "doc").mkdir(parents=True)
    (corpus / "doc" / "document.json").write_text("{}", encoding="utf-8")
    (corpus / "index.json").write_text(json.dumps({"documents": [{"id": "doc"}]}), encoding="utf-8")
    proof = tmp_path / "proof"
    proof.mkdir()

    def document(environ):
        builder = store_queue.Builder([], FINGERPRINTS, {}, fresh=True, environ=environ)
        (group,) = store_queue.android_groups(builder, corpus, "reader-1", proof)
        return group.document

    unseeded = {"PROOF_HQ_DETERMINISM": "0"}
    shard_scope = keys.document_scope(FINGERPRINTS, {**keys.LANE_ENVIRONMENT, **unseeded})
    assert document(unseeded) == keys.document_key(shard_scope, "corpus:doc", keys.files_digest(corpus / "doc"))
    assert document(unseeded) != document({})
    assert document({"PROOF_VERIFY_MEMOS": "1", "PROOF_BRANCH_DOCUMENTS": "all"}) == document({})


def test_a_queue_built_for_another_reader_is_refused(tmp_path, monkeypatch):
    _register(tmp_path, monkeypatch, [])
    lane, corpus, document = _lane(tmp_path)
    queue = _queue(tmp_path, {"corpus:doc": document})
    value = json.loads(queue.read_text(encoding="utf-8"))
    value["fingerprints"]["android"] = "another-reader"
    queue.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(stage.StageError, match="built for the reader"):
        stage.Run(
            queue_path=queue,
            out=tmp_path / "out",
            corpus=corpus,
            outputs=[lane],
            store=None,
            jobs=1,
            bin_=None,
            write_records=False,
            reader=Reader(),
        )
