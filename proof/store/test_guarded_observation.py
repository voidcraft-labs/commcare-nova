"""A corpus document and a control observed as the lane observes them with the store on: each part reads only what
its key names, and the store keeps what the queue builder reads them by.

Contract (``proof.observe.unit`` with ``proof.store.guard``): the store a lane
worker observes with (``proof.store.runtime.session_store``) installs the
guard, and the observation opens a scope around each part and around what
each part is observed over, so a real document's observation, with every
observation hook it runs (intent, manifest and proof 4, where they exist),
completes without one refused read, each part inside a scope of its own and
the derivation of its keys in another (``guard.KEYS``). And a part's reads
pass through its scope: with the part's own inputs left out of its scope,
and every other part read from the store, its observation is refused at its
first read of one of them, naming the file and the part (for
each part that always reads its own inputs: ``a`` its create, ``b`` its
republish, ``b_edit`` its update, ``local`` its archives; ``b_aligned``
reads its local archive only where A's sessions leave a trace). A control,
which keeps no ``inputs.json``, is guarded by the input files its own files
give (``proof.store.guard.input_files``), and its observation writes its
document entry, from which the queue builder finds it judged.

The plausible failures: a step of an observation moved outside every scope,
where a read no key names goes unseen and a stored part stands for an
observation that read something else; a scope that names too little, so
every lane run with the store is refused; a hook that reads a file it
does not declare; and a control observed afresh on every run, its records
never kept.

The document is the corpus's cheapest edited one (by the lane's timings),
the control the smallest that keeps an edit and a local archive, each in its
first configuration, observed with HQ, the Core runner and the editor driver
as the lane runs them.
"""

from __future__ import annotations

import dataclasses
import json
import os

import pytest

from proof.checks import sharding
from proof.observe import unit
from proof.store import guard, pack, queue, runtime
from proof.store.conftest import INSTALL, smallest_control
from proof.store.test_runtime import FINGERPRINTS


def _cheapest_edited():
    from proof.checks import cases

    estimate = sharding.estimate(sharding.load_timings())
    edited = [document for document in cases.load_corpus().emitted if document.edit is not None]
    assert edited, "The corpus holds no edited document, so no observation of every part can be guarded."
    return min(edited, key=lambda document: (estimate(document.group), document.id)).id


def _document(kind, identifier):
    """The document or control as a fresh load reads it: none of its files read yet, as in a lane worker."""
    from proof.checks import corpus

    if kind == "control":
        return next(control for control in corpus.load_controls() if control.id == identifier)
    return corpus.load(corpus.corpus_root()).document(identifier)


def _subject(kind):
    return _cheapest_edited() if kind == "corpus" else smallest_control().id


def _environ(out, store=None):
    environ = {
        "PROOF_FINGERPRINTS": json.dumps(FINGERPRINTS),
        "PROOF_OUT": str(out / "blocks" / ("0" * 64)),
        "PYTHONHASHSEED": os.environ.get("PYTHONHASHSEED", "0"),
        "TZ": os.environ.get("TZ", "UTC"),
    }
    if store is not None:
        environ["PROOF_STORE"] = str(store)
    return environ


def _own_inputs(document, configuration, part):
    """The corpus files a part reads as its own (not its parents'), by its roles (``guard.input_files``)."""
    files = guard.input_files(document)
    if part == "local":
        roles = files["local"]
    elif part == "b_aligned":
        roles = {"local": files["local"]["local"]}
    else:
        roles = files["configurations"][configuration][part]
    return {os.path.abspath(document.root / path) for path in roles.values()}


def _without_own_inputs(narrowed_part):
    """``guard.part_scope``, with one part's own inputs left out of its scope."""
    part_scope = guard.part_scope

    def scope(document, configuration, part, hooks=None):
        found = part_scope(document, configuration, part, hooks)
        if found is None or part != narrowed_part:
            return found
        return dataclasses.replace(found, paths=found.paths - _own_inputs(document, configuration, part))

    return scope


@pytest.mark.parametrize("kind", ["corpus", "control"])
def test_an_observation_reads_only_what_each_parts_key_names_and_each_part_is_guarded(
    kind, tmp_path, monkeypatch, hq, core_runner, editor_driver
):
    identifier = _subject(kind)
    document = _document(kind, identifier)
    configuration = sorted(document.exports)[0]
    # The guard is installed for real, and a process keeps an audit hook to its end: whether it opens scopes is
    # restored when the test ends, so nothing after it in this process is guarded unless it installs the guard.
    monkeypatch.setattr(guard, "_installed", guard._installed)
    monkeypatch.setattr(guard, "install", INSTALL)
    store = runtime.session_store(document, _environ(tmp_path / "first"))
    assert isinstance(store, runtime.Store)
    opened = []
    part_scope = guard.part_scope

    def scope(document, configuration, part, hooks=None):
        opened.append(part)
        return part_scope(document, configuration, part, hooks)

    monkeypatch.setattr(guard, "part_scope", scope)
    found = unit.observe_document(
        document,
        core_runner=core_runner,
        editor_driver=editor_driver,
        store=store,
        configurations={configuration},
        same_as=runtime.same_as(store),
    )
    monkeypatch.setattr(guard, "part_scope", part_scope)
    observed = [entry.rpartition("/")[2] for entry in found.observed]
    assert {"a", "b", "b_aligned", "local"} <= set(observed), found.observed
    assert set(observed) | {"configuration", guard.KEYS} == set(opened), opened
    # The store keeps the document entry its parts are read by (``observations.records_for``), and the queue
    # builder finds every part it names held: the document is judged, observed no more.
    runtime.recorded(store, document, found)
    entry = store.delta.get("documents", store.document_key(document))
    assert entry["group"] == document.group and set(entry["parts"]) >= {f"{configuration}/a", "local"}, entry
    snapshot = pack.write(pack.gather([tmp_path / "first"]), tmp_path / "snapshot")
    builder = queue.Builder([snapshot], FINGERPRINTS, sharding.load_timings())
    assert builder.document(document.group, document.root).status == "judged"
    keys = {**found.configurations[configuration].keys, "local": found.local_key}

    refusals = {}
    for part in (part for part in observed if part != "b_aligned"):
        document = _document(kind, identifier)
        later = runtime.session_store(document, _environ(tmp_path / part, snapshot))
        held = later.lookup

        def lookup(key, *, hidden=keys[part], held=held):
            return None if key == hidden else held(key)

        with monkeypatch.context() as patched:
            patched.setattr(later, "lookup", lookup)
            patched.setattr(guard, "part_scope", _without_own_inputs(part))
            try:
                unit.observe_document(
                    document,
                    core_runner=core_runner,
                    editor_driver=editor_driver,
                    store=later,
                    configurations={configuration},
                    same_as=runtime.same_as(later),
                )
            except guard.UndeclaredRead as refusal:
                refusals[part] = str(refusal)
            else:
                refusals[part] = None
    for part, message in refusals.items():
        label = f"{document.group} " + ("local" if part == "local" else f"{configuration}/{part}")
        assert message is not None, f"{label} was observed with its own inputs out of its scope, and none was refused."
        assert f"While observing {label}," in message, message
        assert any(path in message for path in _own_inputs(document, configuration, part)), message
