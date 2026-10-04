"""Synthetic checkouts, corpora and lane outputs for the evidence store's tests.

A checkout here is a directory without git, which the fingerprints read by
walking it (``proof.store.fingerprints.walked_files``), holding one file of
each partition and one outside them all; a corpus holds documents in the
layout ``proof/corpus/emit.ts`` writes, each with the ``inputs.json``
``proof/corpus/inputs.ts`` writes; a lane output holds what a run's workers
write through the real store (``proof.store.runtime.Store``) and the block
manifests and evidence the lane writes beside it.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from proof.checks.corpus import Document, load_controls
from proof.lane import blocks as lane_blocks
from proof.observe import unit
from proof.observe.record import Blobs, ConfigurationRecords, DocumentRecords, part_key
from proof.store import guard, keys

IMAGE = "sha256:" + "a" * 64
POSTGRES = "sha256:" + "b" * 64

CHECKOUT_FILES = {
    "proof/image.lock": json.dumps({"image": f"ghcr.io/example/proof@{IMAGE}"}),
    "proof/compose.yaml": f"services:\n  postgres:\n    image: mirror/postgres:14@{POSTGRES}\n  harness:\n    x: 1\n",
    "proof/run.mjs": "// starts the lane\n",
    "proof/observe/unit.py": '"""observation"""\n',
    "proof/checks/compare/trace.py": '"""the trace comparator, which observation runs"""\n',
    "proof/checks/bar.py": '"""a judge"""\n',
    "proof/checks/test_bar.py": "def test_bar():\n    pass\n",
    "proof/editors/pages.py": '"""editor pages"""\n',
    "proof/editors/test_view_equivalence.py": 'CORPUS_SAMPLE = ("two",)\n\n\ndef test_views():\n    pass\n',
    "proof/editors/driver/driver.mjs": "// the driver\n",
    "proof/rules/__init__.py": '"""spelling rules"""\n',
    "proof/core/test_core.py": "def test_core():\n    pass\n",
    "proof/surface/test_surface.py": "def test_surface():\n    pass\n",
    "proof/known-defects.json": "[]\n",
    "proof/identity-moves.json": "[]\n",
    "lib/commcare/surface/surface.json": "{}\n",
    "lib/commcare/surface/entries/gates.json": "[]\n",
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    ".nvmrc": "24\n",
    "app/page.tsx": "export default function Page() {}\n",
}


def write_files(root: Path, files: dict) -> Path:
    for relative, content in files.items():
        path = Path(root, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
    return Path(root)


def _digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def write_inputs(root: Path) -> dict:
    """The document's ``inputs.json``, as ``proof/corpus/inputs.ts`` writes it, from its files."""
    root = Path(root)

    def role(relative):
        return {"path": relative, "digest": _digest(root / relative)}

    configurations = {}
    for directory in sorted(path for path in (root / "export").iterdir() if path.is_dir()):
        name = directory.name
        a = {key: role(key) for key in ("configurations.json", "document.json", "verdict.json")}
        a = {"configurations": a["configurations.json"], "document": a["document.json"], "verdict": a["verdict.json"]}
        a["create.request.body"] = role(f"export/{name}/create.body")
        a["create.request.json"] = role(f"export/{name}/create.json")
        b = {
            "request.body": role(f"export/{name}/republish.body"),
            "request.json": role(f"export/{name}/republish.json"),
        }
        configurations[name] = {"a": a, "b": b}
        if (root / "edit" / "export" / name / "update.body").exists():
            configurations[name]["b_edit"] = {
                "request.body": role(f"edit/export/{name}/update.body"),
                "request.json": role(f"edit/export/{name}/update.json"),
                "document": role("edit/document.json"),
                "verdict": role("edit/verdict.json"),
            }
    local = {"local": role("local.ccz")} if (root / "local.ccz").exists() else {}
    manifest = {"version": 1, "document": root.name, "configurations": configurations, "local": local}
    (root / "inputs.json").write_text(json.dumps(manifest, indent="\t") + "\n")
    return manifest


def write_document(corpus: Path, identifier: str, *, create: str = "create", republish: str = "republish") -> Path:
    root = Path(corpus) / identifier
    write_files(
        root,
        {
            "configurations.json": json.dumps({"minimum": {}, "maximum": {}, "singleFlag": {}}),
            "document.json": json.dumps({"doc": {"name": identifier}}),
            "verdict.json": "{}",
            "export/minimum/create.body": create,
            "export/minimum/create.json": "{}",
            "export/minimum/republish.body": republish,
            "export/minimum/republish.json": "{}",
            "edit/document.json": json.dumps({"doc": {"name": f"{identifier} edited"}}),
            "edit/verdict.json": "{}",
            "edit/export/minimum/update.body": f"{create} edited",
            "edit/export/minimum/update.json": "{}",
            # An empty archive whose comment is the document's id, so each document's local part is its own.
            "local.ccz": b"PK\x05\x06" + bytes(16) + len(identifier).to_bytes(2, "little") + identifier.encode(),
        },
    )
    write_inputs(root)
    return root


def write_corpus(corpus: Path, documents: dict) -> Path:
    """A corpus of ``documents`` ({id: {create, republish}}), with its index."""
    corpus = Path(corpus)
    for identifier, bodies in documents.items():
        write_document(corpus, identifier, **bodies)
    index = {"seed": 1, "sample": 0, "documents": [{"id": identifier} for identifier in documents]}
    write_files(corpus, {"index.json": json.dumps(index, indent="\t"), "timings.json": '{"emit": 1.0}'})
    return corpus


def document_of(corpus: Path, identifier: str, kind: str = "corpus"):
    """A corpus document as the store reads one: its id, kind, directory and group."""
    return SimpleNamespace(id=identifier, kind=kind, root=Path(corpus) / identifier, group=f"{kind}:{identifier}")


def smallest_control():
    """The checked-in control (``proof/controls``) of the fewest bytes that keeps an edit and a local archive, so it
    has every part, as the lane reads it (``load_controls``)."""
    held = [
        control
        for control in load_controls()
        if (control.root / "edit" / "batch.json").is_file() and (control.root / "local.ccz").is_file()
    ]
    assert held, "No control keeps an edit and a local archive, so no control's every part can be shown."
    return min(
        held, key=lambda control: (sum(p.stat().st_size for p in control.root.rglob("*") if p.is_file()), control.id)
    )


def copied_control(into: Path):
    """A copy of ``smallest_control`` at ``into/<id>``, read as a control."""
    source = smallest_control()
    root = Path(into) / source.id
    shutil.copytree(source.root, root)
    return Document(id=source.id, source="control", root=root, kind="control")


def records_of(document, *, value: str = "observed") -> DocumentRecords:
    """A document's (or control's) records, as an observation makes them, keyed by its input digests
    (``proof.observe.unit.document_inputs``): an ``a`` naming one blob, a ``b`` under it, a ``b_edit`` keyed as
    ``b`` and so recorded as the same (``proof.observe.unit.observe_configuration``), ``local``."""
    inputs = unit.document_inputs(document)
    found = DocumentRecords(document.id, document.kind)
    blob = found.blobs.put(f"{document.id} built {value}".encode())
    parts = inputs["configurations"]["minimum"]
    a = part_key("a", None, {"configuration": "minimum", "inputs": parts["a"]})
    b = part_key("b", a, {"inputs": parts["b"]})
    records = ConfigurationRecords("minimum", {"a": a, "b": b, "b_edit": b})
    records.a = {"kind": "a", "build": blob, "value": value}
    records.b = {"kind": "b", "value": value}
    records.b_edit = {"same_as": b.hex()}
    found.configurations["minimum"] = records
    found.local_key = part_key("local", None, {"archives": inputs["local"]})
    found.local = {"kind": "local", "value": value}
    return found


def observe_into(store, document, records: DocumentRecords) -> None:
    """Keep a document's records through ``store`` as the observation does: each part with the blobs it names."""
    for configuration in records.configurations.values():
        for part, key in configuration.keys.items():
            record = getattr(configuration, part)
            if "same_as" not in record and store.lookup(key) is None:
                store.put(key, record, records.blobs.named_by(record))
    if store.lookup(records.local_key) is None:
        store.put(records.local_key, records.local, Blobs())
    store.recorded(document, records)


# The environment a lane run in its containers records (proof/compose.yaml sets the first two).
LANE_RUN_ENVIRONMENT = {"PYTHONHASHSEED": "0", "TZ": "UTC"}


def write_serve(output: Path, *, pytest_arguments=(), addopts=None, environment=None) -> Path:
    """The run's ``serve.json``, recording what its server collected with and in (``proof.lane.serve``)."""
    recorded = {name: None for name in keys.SELECTION_ENVIRONMENT}
    recorded.update(LANE_RUN_ENVIRONMENT if environment is None else environment)
    selection = {"pytest": list(pytest_arguments), "addopts": addopts, "environment": recorded}
    lane_blocks.write_json(Path(output) / lane_blocks.SERVE, {"version": 1, "phases": [], "selection": selection})
    return Path(output)


def write_block(output: Path, groups: dict, evidence: dict | None = None) -> Path:
    """A block's run in ``output``: its manifest (``groups``: {group: {node id: outcome}}) and its evidence
    (``evidence``: {(check, group): differences, each without its check and document}), beside a ``serve.json``
    of the lane's own selection unless the output holds one."""
    if not (Path(output) / lane_blocks.SERVE).is_file():
        write_serve(output)
    names = sorted(groups)
    block = lane_blocks.Block(lane_blocks.block_id(names), 1.0, tuple(lane_blocks.QueuedGroup(n) for n in names))
    directory = lane_blocks.block_dir(output, block.id)
    records = [
        lane_blocks.group_record(group=name, fresh=False, collected=list(outcomes), outcomes=outcomes, seconds=1.0)
        for name, outcomes in groups.items()
    ]
    lane_blocks.write_json(
        directory / lane_blocks.MANIFEST, lane_blocks.manifest(block, phase="main", shard="s", groups=records)
    )
    for (check, group), differences in (evidence or {}).items():
        kind, _, identifier = group.partition(":")
        found = [{"check": check, "document": identifier, **difference} for difference in differences]
        record = {"check": check, "document": identifier, "kind": kind, "differences": found}
        path = directory / "checks" / check / f"{kind}-{identifier}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, indent="\t") + "\n")
    return directory


@pytest.fixture
def checkout(tmp_path):
    return write_files(tmp_path / "checkout", CHECKOUT_FILES)


@pytest.fixture
def corpus(tmp_path):
    return write_corpus(tmp_path / "corpus", {"one": {"create": "one"}, "two": {"create": "two"}})


@pytest.fixture(autouse=True)
def unguarded(monkeypatch):
    """The store's tests open stores in the test process, and an audit hook stays for the rest of a process, so
    ``guard.install`` is held off here. test_guard installs it in interpreters of its own; test_guarded_observation
    installs it in this one (``INSTALL``) and restores ``guard._installed`` afterwards, so the hook it leaves opens
    no scope for any later observation in the process, which is guarded only where its own store installs it."""
    monkeypatch.setattr(guard, "install", lambda: None)


# The guard's own install, kept before ``unguarded`` holds it off.
INSTALL = guard.install
