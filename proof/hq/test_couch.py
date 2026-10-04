"""The in-memory Couch hands out and keeps exactly what a JSON copy of the stored documents gives.

Contract: every read (``get``, ``open_doc``, ``_all_docs`` rows) is the
stored document copied through JSON (``json.loads(json.dumps(doc))``), and
``restore_snapshot(snapshot())`` gives back exactly the store the snapshot
was taken of, in order, while each document's JSON text is written once, as
it is stored, and parsed on every read (``proof.hq.couch``). The plausible
failures: a text kept past a change to the document it was written from (the
store's dictionary given another object for an id, a document deleted or
saved again), a restore keeping an object whose text is not the snapshot's,
and a stored document changed in place, which only the verified path can see.
"""

from __future__ import annotations

import json

import pytest
from couchdbkit.exceptions import ResourceNotFound

from proof.hq import couch
from proof.hq.couch import ComputedViewCouch
from proof.hq.seams import MemoMismatch


def _copy(value):
    return json.loads(json.dumps(value))


def _store():
    store = ComputedViewCouch()
    for index in range(3):
        store.save_doc({"_id": f"doc-{index}", "doc_type": "ProofDocument", "n": index, "items": [index, {"k": "v"}]})
    return store


def test_a_read_is_the_stored_document_copied_through_json_from_the_text_kept_as_it_was_stored(monkeypatch):
    store = _store()
    expected = _copy(store.mock_docs["doc-1"])
    written = []
    real_dumps = json.dumps
    with monkeypatch.context() as patch:
        patch.setattr(couch.json, "dumps", lambda value, **kw: written.append(1) or real_dumps(value, **kw))
        first = store.get("doc-1")
        opened = store.open_doc("doc-1")
        (row,) = store.all_docs_rows(["doc-1"], include_docs=True)["rows"]
    assert not written  # every read parsed the text kept as the document was stored
    assert first == opened == row["doc"] == expected
    assert first is not store.mock_docs["doc-1"] and opened is not first
    # A read is the caller's own: changing it changes neither the store nor the next read.
    first["items"][1]["k"] = "changed"
    assert store.get("doc-1")["items"][1]["k"] == "v" == store.mock_docs["doc-1"]["items"][1]["k"]

    # Saved again, the document is read as saved; given another object for its id, it is written out afresh.
    again = store.get("doc-1")
    again["n"] = 10
    store.save_doc(again)
    assert store.get("doc-1")["n"] == 10
    store.mock_docs["doc-1"] = {"_id": "doc-1", "doc_type": "ProofDocument", "n": 11}
    assert store.get("doc-1") == {"_id": "doc-1", "doc_type": "ProofDocument", "n": 11}
    store.delete_doc("doc-1")
    with pytest.raises(ResourceNotFound):
        store.get("doc-1")
    assert store.open_doc("doc-1") is None


def test_a_restore_gives_back_exactly_the_snapshots_store_keeping_only_documents_whose_text_is_the_snapshots():
    store = _store()
    whole = json.dumps(store.mock_docs)
    snapshot = store.snapshot()
    unchanged = store.mock_docs["doc-0"]
    changed = store.get("doc-1")
    changed["n"] = 100
    store.save_doc(changed)
    store.delete_doc("doc-2")
    store.save_doc({"_id": "doc-3", "doc_type": "ProofDocument"})
    store.mock_docs["doc-0"] = dict(unchanged)  # the same content, another object

    store.restore_snapshot(snapshot)
    assert json.dumps(store.mock_docs) == whole  # every document, its content and the store's order
    assert list(store.mock_docs) == ["doc-0", "doc-1", "doc-2"]
    assert store.get("doc-1")["n"] == 1 and store.get("doc-2")["n"] == 2
    # Restored again with nothing changed since, every document stays the object it is.
    held = dict(store.mock_docs)
    store.restore_snapshot(snapshot)
    assert all(store.mock_docs[docid] is held[docid] for docid in held)
    assert store.snapshot() == snapshot


def test_a_document_changed_in_place_is_refused_where_its_kept_text_is_verified(monkeypatch):
    """No read or save hands a stored document out, so nothing changes one in place; ``PROOF_VERIFY_MEMOS=1``
    writes each document out again wherever its kept text is used, so a change made in place is seen."""
    monkeypatch.setattr(couch, "VERIFY_MEMOS", True)
    store = _store()
    snapshot = store.snapshot()
    assert store.get("doc-0")["n"] == 0
    store.mock_docs["doc-0"]["n"] = 5
    with pytest.raises(MemoMismatch, match="doc-0"):
        store.get("doc-0")
    with pytest.raises(MemoMismatch, match="doc-0"):
        store.restore_snapshot(snapshot)
