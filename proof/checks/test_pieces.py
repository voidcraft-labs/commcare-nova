"""A document observed in pieces is read from the run's store by its own group, which observes nothing.

Contracts:

- ``proof.observe.unit.observe_document(held_only=True)``, which a group that
  follows pieces reads its document with
  (``proof.checks.observations.records_for``): every part comes from the
  store, nothing is observed, and a part an observation of the document keeps
  that the store does not hold raises ``PartsNotHeld`` naming it. A
  configuration whose ``a`` holds no app (HQ refused its create) keeps no
  other part, and reads whole.
- ``proof.checks.observations.observe_piece``: a piece observes one
  configuration the document is exported under, and where a lane's queue
  names pieces it refuses a run that keeps no store.
- ``proof.checks.cases.piece_params``, the items of ``proof/checks/pieces.py``:
  where a queue is named, one item for each piece it names and no other, a
  piece the corpus does not hold refused; with none, every configuration of
  every document and control. Each item's id is the one
  ``proof.checks.sharding.piece_item`` writes from its group's name.

- ``proof.checks.cases.evidence``: the same records write the same evidence
  bytes whether they were just observed or read back from the store, which
  keeps a record as canonical JSON and so hands a judge each object's keys in
  sorted order.

The plausible failures: a document's group that finds a part missing and
observes the document whole in its pieces' place (the hours on one worker the
pieces exist to divide, and a second observation of every part the pieces
did keep); one that fails over the parts a refused create never has, on every
such document; a piece observing into no store while its document waits on
it; a shard collecting a piece no queue runs (the gate then fails the lane
for an item nobody ran); a failed piece's rerun line naming no item; and a
document's evidence differing in its bytes by whether its own group or its
pieces observed it.

The exactness of the whole (a document in pieces judged from the same
records, byte for byte, as one observed whole) is held over real documents by
``proof/lane/test_forkserver.py``.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from proof.checks import cases, observations, sharding
from proof.checks.differences import Difference
from proof.lane import blocks as lane_blocks
from proof.observe import unit
from proof.observe.record import NULL_STORE, Blobs
from proof.store import disk, runtime
from proof.store.test_runtime import FINGERPRINTS, _environ


def _store(out):
    """A store over a delta of its own, as a lane worker's, without the read guard (a process keeps that hook)."""
    environ = _environ(out)
    return runtime.Store(
        disk.Snapshot(None), disk.Delta(out / disk.DELTA), FINGERPRINTS, environ, fresh=False, audit_directory=out
    )


def _two_configurations():
    """The corpus's cheapest document exported under two configurations, by the lane's timings."""
    estimate = sharding.estimate(sharding.load_timings())
    held = [document for document in cases.load_corpus().documents if len(document.exports) == 2]
    assert held, "The corpus holds no document exported under two configurations, so none can be read in pieces."
    return min(held, key=lambda document: (estimate(document.group), document.id))


def _keys(document):
    inputs, databases, hooks = unit.document_inputs(document), unit.case_databases(document), unit.hook_inputs(document)
    found = {}
    for name in sorted(document.exports):
        keys = unit.part_keys(inputs, name, databases, hooks)
        if document.edit is None or name not in document.edit.exports:
            keys.pop("b_edit", None)
        found[name] = keys
    return found, unit.local_key(inputs, hooks)


@pytest.fixture
def unobserved(monkeypatch):
    """Fails the test if anything opens an HQ unit: a reading from the store alone observes nothing."""
    from proof.hq import state

    def refuse(*arguments, **named):
        raise AssertionError("An HQ unit was opened: the document was observed, where it was to be read alone.")

    monkeypatch.setattr(state, "hq_unit", refuse)


def test_a_document_read_from_the_store_alone_observes_nothing_and_names_each_part_no_piece_kept(
    tmp_path, hq, unobserved, monkeypatch
):
    # What the reading writes beside a block's evidence goes to this test's own directory.
    monkeypatch.setenv("PROOF_OUT", str(tmp_path / "out"))
    document = _two_configurations()
    first, second = sorted(document.exports)
    keys, local = _keys(document)

    def read(store):
        return unit.observe_document(document, core_runner=None, editor_driver=None, store=store, held_only=True)

    # Nothing kept: the first configuration's every part is named, and nothing is observed in their place.
    empty = _store(tmp_path / "empty")
    with pytest.raises(unit.PartsNotHeld) as unkept:
        read(empty)
    assert unkept.value.parts == [f"{first}/{part}" for part in unit.PARTS if part in keys[first]]
    assert f"{document.group} was read from the evidence store alone" in str(unkept.value)
    assert not (tmp_path / "empty" / disk.DELTA / disk.ENTRIES / "parts").exists()

    # Each configuration's ``a`` held with no app in it (HQ refused its create), and the local part: an
    # observation keeps nothing more of such a configuration, so the document reads whole.
    refused = {"kind": "a", "create": {"refused": {"status": 400, "response": "no"}, "lookups": None}}
    held = _store(tmp_path / "held")
    for name in (first, second):
        held.put(keys[name]["a"], {**refused, "configuration": name}, Blobs())
    with pytest.raises(unit.PartsNotHeld) as unkept:
        read(held)
    assert unkept.value.parts == [unit.LOCAL]
    held.put(local, {"kind": "local", "admissions": {}, "stackValues": {}, "hole": unit.HOLE}, Blobs())
    found = read(held)
    assert found.observed == [] and found.local["kind"] == "local" and found.local_key == local
    assert found.configurations[first].a == {**refused, "configuration": first}
    assert found.configurations[second].b is None and found.configurations[second].b_aligned is None

    # An ``a`` that holds an app keeps its other parts too: each one the store lacks is named, ``a`` is not.
    with_app = _store(tmp_path / "with-app")
    with_app.put(keys[first]["a"], {"kind": "a", "create": refused["create"], "state": {"doc": "x"}}, Blobs())
    with pytest.raises(unit.PartsNotHeld) as unkept:
        read(with_app)
    same = "b_edit" in keys[first] and keys[first]["b_edit"] == keys[first]["b"]
    expected = [part for part in unit.PARTS if part in keys[first] and part != "a" and not (same and part == "b_edit")]
    assert unkept.value.parts == [f"{first}/{part}" for part in expected] and expected[0] == "b"

    # A group that follows pieces reads so: its checks' records come from the store or fail, never observed here.
    monkeypatch.setenv(runtime.PIECES_ENVIRONMENT, f"{document.group}@{first},{document.group}@{second}")
    assert runtime.pieces() == (f"{document.group}@{first}", f"{document.group}@{second}")
    monkeypatch.setattr(observations, "_CACHE", {})
    with pytest.raises(unit.PartsNotHeld):
        observations.records_for(document, None, store=_store(tmp_path / "group"))
    observations._CACHE.clear()
    assert observations.records_for(document, None, store=held).observed == []
    observations._CACHE.clear()
    monkeypatch.delenv(runtime.PIECES_ENVIRONMENT)
    assert runtime.pieces() == ()


def test_a_piece_names_a_configuration_of_its_document_and_refuses_a_lane_that_keeps_no_store(
    hq, unobserved, monkeypatch
):
    document = _two_configurations()
    first = sorted(document.exports)[0]
    with pytest.raises(AssertionError, match=f"names a configuration {document.group} is not exported under"):
        observations.observe_piece(document, "no-such-configuration", None, store=NULL_STORE)
    # In a lane whose queue names pieces, a piece that would observe into no store is refused before it observes.
    monkeypatch.setenv(sharding.PIECES_ENVIRONMENT, "/the/lane/queue.json")
    with pytest.raises(AssertionError, match="observes into the run's evidence store.* and this run keeps none"):
        observations.observe_piece(document, first, None, store=NULL_STORE)


def _documents():
    def document(kind, identifier, *configurations):
        return SimpleNamespace(
            kind=kind, id=identifier, group=f"{kind}:{identifier}", exports=dict.fromkeys(configurations)
        )

    return (
        [document("corpus", "a", "maximum", "minimum"), document("corpus", "b", "minimum")],
        [document("control", "a", "CASE_LIST_TILE", "minimum")],
    )


def test_a_queue_names_the_pieces_collected_and_with_none_every_configuration_is_one(tmp_path, monkeypatch):
    documents, controls = _documents()
    every = cases.pieces(documents, controls, None)
    assert [piece.group for piece in every] == [
        "corpus:a@maximum",
        "corpus:a@minimum",
        "corpus:b@minimum",
        "control:a@CASE_LIST_TILE",
        "control:a@minimum",
    ]
    # Each item's id is the one a failed piece's rerun line is written with, from its group's name alone.
    for piece in every:
        assert sharding.piece_item(piece.group).endswith(f"::{sharding.PIECE_TEST}[{piece.id}]")
    named = frozenset({"corpus:a@minimum", "control:a@minimum", "corpus:gone@minimum"})
    assert [piece.group for piece in cases.pieces(documents, controls, named)] == [
        "corpus:a@minimum",
        "control:a@minimum",
    ]
    # The queue the lane's server names is read for its pieces, and no other of its groups.
    groups = (
        lane_blocks.QueuedGroup("corpus:a@maximum", True),
        lane_blocks.QueuedGroup("corpus:a@minimum", True),
        lane_blocks.QueuedGroup("corpus:a", False, ("corpus:a@maximum", "corpus:a@minimum")),
        lane_blocks.QueuedGroup("proof/hq"),
    )
    block = lane_blocks.Block(lane_blocks.block_id(group.group for group in groups), 1.0, groups)
    queue = tmp_path / "queue.json"
    queue.write_text(json.dumps(lane_blocks.queue_json(lane_blocks.Queue((block,)))))
    assert cases.queued_pieces({sharding.PIECES_ENVIRONMENT: str(queue)}) == {"corpus:a@maximum", "corpus:a@minimum"}
    assert cases.queued_pieces({}) is None


def test_a_queue_naming_a_piece_the_corpus_does_not_hold_fails_the_collection(tmp_path, monkeypatch):
    document = _two_configurations()
    groups = (
        lane_blocks.QueuedGroup(f"{document.group}@no-such-configuration", True),
        lane_blocks.QueuedGroup(document.group, False, (f"{document.group}@no-such-configuration",)),
    )
    block = lane_blocks.Block(lane_blocks.block_id(group.group for group in groups), 1.0, groups)
    queue = tmp_path / "queue.json"
    queue.write_text(json.dumps(lane_blocks.queue_json(lane_blocks.Queue((block,)))))
    monkeypatch.setenv(sharding.PIECES_ENVIRONMENT, str(queue))
    with pytest.raises(AssertionError, match="the corpus and the controls hold no such document under that"):
        cases.piece_params()
    # A piece the corpus holds is one item, under the id its group gives.
    first = sorted(document.exports)[0]
    groups = (
        lane_blocks.QueuedGroup(f"{document.group}@{first}", True),
        lane_blocks.QueuedGroup(document.group, False, (f"{document.group}@{first}",)),
    )
    block = lane_blocks.Block(lane_blocks.block_id(group.group for group in groups), 1.0, groups)
    queue.write_text(json.dumps(lane_blocks.queue_json(lane_blocks.Queue((block,)))))
    [param] = cases.piece_params()
    assert param.id == f"{document.id}@{first}" and param.values[0].group == f"{document.group}@{first}"


def test_the_same_records_write_the_same_evidence_whether_observed_or_read_back(tmp_path, monkeypatch):
    document = SimpleNamespace(id="a", kind="corpus")
    observed = {"type": "blank form", "form": {"unique_id": "u", "id": 0, "name": {"en": "F", "default": "F"}}}
    read_back = json.loads(json.dumps(observed, sort_keys=True))
    assert list(observed) != list(read_back) and observed == read_back
    written = {}
    for name, value in (("observed", observed), ("read", read_back)):
        monkeypatch.setenv("PROOF_OUT", str(tmp_path / name))
        difference = Difference("bar", "a", "validate_app@A", "/modules/*/x", "/modules/0/x", "error", None, value)
        cases.evidence("bar", document, [difference], saves=[{"at": "x", "stored": value}], configurations=["m"])
        written[name] = (tmp_path / name / "checks" / "bar" / "corpus-a.json").read_bytes()
    assert written["observed"] == written["read"]
    # The record and each difference keep the order they are read in; what they quote is what is ordered.
    record = json.loads(written["observed"])
    assert list(record) == ["check", "document", "kind", "saves", "configurations", "differences"]
    assert list(record["differences"][0]) == ["check", "document", "artifact", "path", "at", "kind", "before", "after"]
    assert list(record["differences"][0]["after"]) == ["form", "type"]
    assert list(record["saves"][0]["stored"]["form"]) == ["id", "name", "unique_id"]
