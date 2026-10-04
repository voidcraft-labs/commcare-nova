"""A lane worker's store reuses a part only as it was kept, keeps no two records under one key, and audits fresh parts.

Contract (``proof.store.runtime``): ``session_store`` gives a document's
observation the store only when every key could be named (``PROOF_STORE`` not
``off``, fingerprints given, the document's ``inputs.json`` present, or the
document a control, whose input files its own files give, an output to write
into). A part kept by one worker of a run is a hit for every
later lookup of its key in that run, with exactly the blobs its record names,
and a snapshot's parts are hits too; a part is a hit only while its record
and every blob it names are held whole. A part kept under a key the run
already holds another record under fails, with both records written under
``<output>/audit/``; a fresh group observes every part and holds each to what
the snapshot and the run's delta hold under its key. Transcripts are kept and
replaced under their keys (a view's by its spec and first answer, a Vellum
run's by its spec alone, as proof 4 looks them up, each under the code and
environment it was recorded with), and a fresh group reads only the
snapshot's.

The plausible failures: a lookup that returns a record without the blobs it
names (a judge reading a build that is not there), a second record kept
silently over the first, an audit that compares only one of the delta and
the snapshot, and a store that turns on without fingerprints, so its keys
name nothing of the code.
"""

from __future__ import annotations

import json

import pytest

from proof.editors.transcripts import Transcript
from proof.observe.record import NULL_STORE, Blobs
from proof.store import audit, disk, pack, runtime
from proof.store.conftest import copied_control, document_of, observe_into, records_of

FINGERPRINTS = {
    "observation": "o" * 64,
    "browser": "b" * 64,
    "judge": "j" * 64,
    "harness": "h" * 64,
    "image": "sha256:" + "a" * 64,
    "postgres": "sha256:" + "c" * 64,
    "arch": "arm64",
}


def _environ(output, *, store=None, fresh=False, **extra):
    environ = {
        "PROOF_FINGERPRINTS": json.dumps(FINGERPRINTS),
        "PROOF_OUT": str(output / "blocks" / ("0" * 64)),
        "PYTHONHASHSEED": "0",
        "TZ": "UTC",
        **extra,
    }
    if store is not None:
        environ["PROOF_STORE"] = str(store)
    if fresh:
        environ["PROOF_GROUP_FRESH"] = "1"
    return environ


def test_the_store_is_off_unless_every_key_can_name_what_made_its_record(tmp_path, corpus):
    one = document_of(corpus, "one")
    output = tmp_path / "out"
    assert isinstance(runtime.session_store(one, _environ(output)), runtime.Store)
    assert runtime.session_store(one, _environ(output, PROOF_STORE="off")) is NULL_STORE
    assert runtime.session_store(one, {**_environ(output), "PROOF_FINGERPRINTS": "{}"}) is NULL_STORE
    unnamed = {key: value for key, value in _environ(output).items() if key != "PROOF_OUT"}
    assert runtime.session_store(one, unnamed) is NULL_STORE
    (corpus / "two" / "inputs.json").unlink()
    assert runtime.session_store(document_of(corpus, "two"), _environ(output)) is NULL_STORE
    # A control keeps no inputs.json, and is stored as a document is: its keys and scopes are its files'.
    control = copied_control(tmp_path / "controls")
    assert isinstance(runtime.session_store(control, _environ(output)), runtime.Store)
    # The run's delta is beside its blocks and workers, whichever directory PROOF_OUT names.
    store = runtime.session_store(one, _environ(output))
    assert store.delta.root == output / "store" and store.audit_directory == output / "audit"
    worker = runtime.session_store(one, {**_environ(output), "PROOF_OUT": str(output / "workers" / "w2")})
    assert worker.delta.root == output / "store"


def test_a_part_kept_by_one_worker_is_a_hit_for_another_with_exactly_its_blobs(tmp_path, corpus):
    one = document_of(corpus, "one")
    records = records_of(one)
    first = runtime.session_store(one, _environ(tmp_path / "out"))
    a_key = records.configurations["minimum"].keys["a"]
    assert first.lookup(a_key) is None and first.blobs(a_key).refs() == []
    observe_into(first, one, records)

    second = runtime.session_store(one, _environ(tmp_path / "out"))
    assert second.lookup(a_key) == records.configurations["minimum"].a
    assert second.blobs(a_key).refs() == records.blobs.named_by(records.configurations["minimum"].a).refs()
    assert second.lookup(records.local_key) == records.local
    # The run's document entry names each part's key and record digest.
    entry = second.delta.get("documents", second.document_key(one))
    assert set(entry["parts"]) == {"minimum/a", "minimum/b", "minimum/b_edit", "local"}
    # B-edit recorded as B's is read as B's record, kept under B's key: as a fresh run, observing it apart, keeps it.
    assert entry["parts"]["minimum/b_edit"] == entry["parts"]["minimum/b"]
    fresh = runtime.session_store(one, _environ(tmp_path / "out", fresh=True))
    apart = records_of(one)
    apart.configurations["minimum"].b_edit = dict(apart.configurations["minimum"].b)
    fresh.recorded(one, apart)

    # A part whose named blob is gone is no hit: its record could not be read whole.
    for name in records.blobs.refs():
        disk.blob_path(second.delta.root, name).unlink()
    assert second.lookup(a_key) is None
    assert second.lookup(records.configurations["minimum"].keys["b"]) is not None


def test_another_record_kept_under_a_held_key_fails_with_both_written(tmp_path, corpus):
    one = document_of(corpus, "one")
    store = runtime.session_store(one, _environ(tmp_path / "out"))
    key = records_of(one).configurations["minimum"].keys["a"]
    store.put(key, {"kind": "a", "value": 1}, Blobs())
    store.put(key, {"kind": "a", "value": 1}, Blobs())
    with pytest.raises(audit.StoreMismatch, match="this run already kept another record") as failure:
        store.put(key, {"kind": "a", "value": 2}, Blobs())
    written = tmp_path / "out" / "audit" / store.storage_key(key)
    assert json.loads((written / "held.json").read_text()) == {"kind": "a", "value": 1}
    assert json.loads((written / "fresh.json").read_text()) == {"kind": "a", "value": 2}
    assert str(written) in str(failure.value)


def test_a_fresh_group_observes_every_part_and_holds_it_to_the_snapshot_and_the_runs_delta(tmp_path, corpus):
    one = document_of(corpus, "one")
    records = records_of(one)
    observe_into(runtime.session_store(one, _environ(tmp_path / "earlier")), one, records)
    snapshot = tmp_path / "snapshot"
    pack.write(pack.gather([tmp_path / "earlier"]), snapshot)

    fresh = runtime.session_store(one, _environ(tmp_path / "out", store=snapshot, fresh=True))
    assert fresh.fresh and not fresh.same_as
    a_key = records.configurations["minimum"].keys["a"]
    fresh.audit(a_key, records.configurations["minimum"].a)
    with pytest.raises(audit.StoreMismatch, match="the store holds another"):
        fresh.audit(a_key, {"kind": "a", "value": "differs"})
    # The run's own delta is held too: a part this run kept differently fails though the snapshot agrees.
    b_key = records.configurations["minimum"].keys["b"]
    fresh.put(b_key, {"kind": "b", "value": "this run"}, Blobs())
    with pytest.raises(audit.StoreMismatch, match="this run kept another record"):
        fresh.audit(b_key, records.configurations["minimum"].b)


def _transcript(answer="answer", kind="view"):
    return Transcript.from_json(
        {
            "format": 1,
            "spec": {"kind": kind, "url": "/a/domain/apps/view/app/", "seed": "s"},
            "first": "1" * 64,
            "exchanges": [
                {"phase": "load", "method": "GET", "url": "/a/", "headers": {}, "body": None, "response": "1" * 64},
                {
                    "phase": "section:0",
                    "method": "POST",
                    "url": "/s/",
                    "headers": {},
                    "body": "eA==",
                    "response": answer,
                },
            ],
            "outputs": {"sections": []},
        }
    )


def test_transcripts_are_kept_by_spec_and_first_answer_and_a_fresh_group_reads_only_the_snapshots(tmp_path, corpus):
    one = document_of(corpus, "one")
    store = runtime.session_store(one, _environ(tmp_path / "out"))
    transcript = _transcript()
    assert store.transcripts.get(transcript.spec_digest, transcript.first) is None
    store.transcripts.put(transcript)
    held = store.transcripts.get(transcript.spec_digest, transcript.first)
    assert held is not None and held.canonical() == transcript.canonical()
    assert store.transcripts.get(transcript.spec_digest, "2" * 64) is None
    # A newer transcript of the same start replaces the older: either is replayed only where HQ answers alike.
    newer = _transcript("9" * 64)
    store.transcripts.put(newer)
    assert store.transcripts.get(newer.spec_digest, newer.first).canonical() == newer.canonical()

    # A Vellum run is looked up by its spec alone: nothing is answered before Vellum asks.
    vellum = _transcript(kind="vellum")
    store.transcripts.put(vellum)
    assert store.transcripts.get(vellum.spec_digest, None).canonical() == vellum.canonical()
    assert store.transcripts.get(vellum.spec_digest, vellum.first) is None

    fresh = runtime.session_store(one, _environ(tmp_path / "out", fresh=True))
    assert fresh.transcripts.get(newer.spec_digest, newer.first) is None
    snapshot = tmp_path / "snapshot"
    pack.write(pack.gather([tmp_path / "out"]), snapshot)
    reading = runtime.session_store(one, _environ(tmp_path / "next", store=snapshot, fresh=True))
    assert reading.transcripts.get(newer.spec_digest, newer.first).canonical() == newer.canonical()
    # Kept under the code that started the browser and recorded what it did, and the environment it ran in: a run
    # of other observation code, or in another zone, replays none of them.
    observation = {"PROOF_FINGERPRINTS": json.dumps({**FINGERPRINTS, "observation": "p" * 64})}
    for name, changed in (("observation", observation), ("zone", {"TZ": "Asia/Kolkata"})):
        other = runtime.session_store(one, {**_environ(tmp_path / name, store=snapshot), **changed})
        assert other.transcripts.get(newer.spec_digest, newer.first) is None, name
        assert other.transcripts.get(vellum.spec_digest, None) is None, name
    # One run's workers write one delta under one set of fingerprints.
    with pytest.raises(disk.DeltaMixed, match="one lane environment"):
        runtime.session_store(one, {**_environ(tmp_path / "out"), **observation})
