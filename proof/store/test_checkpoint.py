"""An interrupted worker hands off only completed, content-verified native parts of a curated corpus app."""

import json
import os
import shutil
import signal
import subprocess
import sys
import zipfile

import pytest

from proof.store import audit, checkpoint, disk, runtime


def test_a_killed_worker_leaves_a_reusable_ordinary_part_without_a_completed_group(tmp_path, monkeypatch):
    from proof.checks import cases, corpus

    # Use the actual emitted files, configuration and hook inputs of the same synthetic HQ document as the lane.
    source = cases.load_corpus().document("hq-plain")
    root = tmp_path / "corpus"
    shutil.copytree(source.root, root / source.id)
    (root / "index.json").write_bytes(disk.canonical({"documents": [{"id": source.id, "source": source.source}]}))
    doc = corpus.load(root).document(source.id)
    block = "b" * 64
    found = {
        "observation": "1" * 64,
        "browser": "2" * 64,
        "harness": "3" * 64,
        "judge": "4" * 64,
        "arch": "amd64",
        "image": "sha256:" + "5" * 64,
        "postgres": "sha256:" + "6" * 64,
    }
    out = tmp_path / "out"
    for name, value in {
        "PROOF_FINGERPRINTS": json.dumps(found),
        "PROOF_GROUP": doc.group,
        "PROOF_BLOCK": block,
        "PROOF_OUT": str(out),
        "PROOF_CORPUS": str(root),
        "PROOF_CHECKPOINT_PARTS": "1",
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("PROOF_STORE", raising=False)
    monkeypatch.delenv("PROOF_HQ_DETERMINISM", raising=False)
    raw = next(key for key, kind in checkpoint.current_parts(doc, doc.group).items() if kind == "local")
    archive = doc.local_ccz.read_bytes()
    key = bytes.fromhex(raw)

    child = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import os, signal, sys
from pathlib import Path
from proof.checks.corpus import load
from proof.observe.record import Blobs
from proof.store import runtime
doc = load(Path(os.environ["PROOF_CORPUS"])).document("hq-plain")
store = runtime.session_store(doc)
blobs = Blobs()
archive = blobs.put(doc.local_ccz.read_bytes())
store.put(bytes.fromhex(sys.argv[1]), {"kind": "local", "archive": archive}, blobs)
store.put_fragment(b"x"*32, {"notAnOrdinaryPart": True}, Blobs())
os.kill(os.getpid(), signal.SIGKILL)
""",
            raw,
        ],
        check=False,
    )
    assert child.returncode == -signal.SIGKILL
    [capsule] = list(out.glob(".reader-part-*.bin"))
    data = capsule.read_bytes()
    header, _ = checkpoint.decoded(data)
    inspect = [sys.executable, "-m", "proof.store.checkpoint", "inspect"]
    shown = subprocess.run(inspect, input=data, capture_output=True, check=True)
    assert json.loads(shown.stdout) == {k: header[k] for k in ("block", "group", "part", "stored", "profile", "record")}
    changed = bytearray(data)
    changed[-1] ^= 1
    invalid = subprocess.run(inspect, input=changed, capture_output=True, check=False)
    assert invalid.returncode == 1 and invalid.stdout == b"" and invalid.stderr == b"Invalid completed proof part.\n"

    sha = checkpoint.sha(data)
    assert capsule.name == f".reader-part-{sha}.bin"
    assert not (out / "serve.json").exists()
    assert not list((out / "store/entries/documents").glob("*.json"))
    assert len(list((out / "store/entries/fragments").glob("*.json"))) == 1

    # The host publishes the source- and queue-bound receipt beside the immutable part.
    source = {
        "run": "17",
        "attempt": "2",
        "commit": "7" * 40,
        "shard": "3",
        "image": "sha256:" + "8" * 64,
        "fingerprints": checkpoint.sha(f"PROOF_FINGERPRINTS={os.environ['PROOF_FINGERPRINTS']}".encode()),
    }
    name = f"proof-part-3-2-{sha}.bin"
    queue = disk.canonical({"blocks": [{"id": block, "groups": [{"group": doc.group}]}]})
    row = {k: header[k] for k in ("group", "block", "part", "stored", "profile", "record")}
    row.update(artifact=name, sha256=sha, phase="main", bytes=len(data))
    identity = {
        "kind": "reader-part",
        "version": 1,
        "source": source,
        "queues": {"main": checkpoint.sha(queue)},
        "part": row,
    }
    received = tmp_path / "artifact"
    received.mkdir()
    (received / "identity.json").write_bytes(disk.canonical(identity))
    shutil.copyfile(capsule, received / name)
    output = tmp_path / "restored"
    args = {
        "run": "17",
        "attempt": "2",
        "commit": source["commit"],
        "image": source["image"],
        "environ": os.environ,
        "corpus_root": root,
        "queue": queue,
    }
    assert checkpoint.restore([received], output, **args) == 1
    resumed = runtime.session_store(
        doc, {**os.environ, "PROOF_STORE": str(output), "PROOF_OUT": str(tmp_path / "new-out")}
    )
    assert resumed.lookup(key) == {"kind": "local", "archive": disk.digest_of(archive)}
    assert resumed.blobs(key).get(disk.digest_of(archive)) == archive
    assert resumed.lookup_current(key) is None
    assert resumed.lookup_current(b"x" * 32, fragment=True) is None
    assert all(not resumed.snapshot.index[family] for family in ("groups", "documents", "judgments", "transcripts"))
    with pytest.raises(audit.StoreMismatch):
        resumed.audit(key, {"kind": "local", "different": True})

    refused = tmp_path / "refused"
    for changes in (
        {"commit": "9" * 40},
        {"run": "18"},
        {"queue": queue + b" "},
        {"environ": {**os.environ, "PROOF_HQ_SPEED": "0"}},
    ):
        with pytest.raises(ValueError):
            checkpoint.restore([received], refused, **{**args, **changes})
        assert not refused.exists()
    (received / name).write_bytes(data[:-1])
    with pytest.raises(ValueError, match="differs from the receipt"):
        checkpoint.restore([received], refused, **args)
    assert not refused.exists()
    (received / name).write_bytes(data)
    # A valid new archive under its newly computed manifest also misses the recovered local key.
    with zipfile.ZipFile(doc.local_ccz, "a") as archive_file:
        archive_file.writestr("changed-input.txt", b"changed native input")
    with pytest.raises(ValueError, match="actual files"):
        checkpoint.restore([received], refused, **args)
    assert not refused.exists()
    from proof.observe import unit

    manifest = json.loads((doc.root / "inputs.json").read_bytes())
    manifest["local"]["local"]["digest"] = unit.computed_inputs(doc)["local"]["local"]
    (doc.root / "inputs.json").write_bytes(disk.canonical(manifest))
    with pytest.raises(ValueError, match="Changed document or reader inputs"):
        checkpoint.restore([received], refused, **args)
    assert not refused.exists()


def test_size_omissions_name_the_complete_part_and_keep_its_ordinary_store_entry(tmp_path, monkeypatch):
    delta = disk.Delta(tmp_path / "store")
    key, stored = b"k" * 32, "6" * 64
    content = disk.canonical({"kind": "a"})
    blob = delta.put_blob(content)
    delta.put("parts", stored, {"record": blob, "blobs": []})
    stager = checkpoint.Stager(delta, "corpus:hq-plain", "b" * 64, {}, {})
    monkeypatch.setattr(checkpoint, "MAX_BYTES", 8)
    stager.settled(key, stored)
    stager.settled(key, stored)
    assert not list(tmp_path.glob(".reader-part-*.bin"))
    omitted = json.loads((tmp_path / checkpoint.OMISSIONS).read_bytes())
    [row] = omitted["parts"]
    assert omitted["additional"] == 0
    assert (row["reason"], row["part"], row["stored"], row["record"], row["blobCount"]) == (
        "part-bytes",
        key.hex(),
        stored,
        blob,
        1,
    )
    assert row["bytes"] > len(content) and delta.blob(blob) == content

    monkeypatch.setattr(checkpoint, "MAX_BYTES", 1024)
    monkeypatch.setattr(checkpoint, "JOB_COUNT", 0)
    stager.settled(key, stored)
    assert json.loads((tmp_path / checkpoint.OMISSIONS).read_bytes())["parts"][-1]["reason"] == "job-count"
