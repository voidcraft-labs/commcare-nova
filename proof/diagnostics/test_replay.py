"""Interruption leaves an independent status file. No incomplete operation can become a release result."""

import json
import os
import select
import subprocess
import sys
from pathlib import Path

import pytest

from proof.diagnostics import replay

ROOT = Path(__file__).resolve().parents[2]


def test_process_loss_then_a_focused_retry_can_only_complete_the_original_input(tmp_path):
    # Use a real process and actual signal delivery. It publishes a start marker, then waits inside its
    # operation. Kill it without letting its exception handler, finalization or parent process run.
    child = """
import os, sys, signal
from pathlib import Path
from proof.diagnostics import replay, stages
from proof.observe.record import Blobs
from types import SimpleNamespace
mode, directory, key = sys.argv[1:]
def run():
    token = stages._context.set(SimpleNamespace(key="captured state"))
    try:
        archive = "edited archive" if mode == "fresh" else "original archive"
        with stages.operation("B app phone", "android/phone", lambda: {"archive": archive}):
            print("entered", flush=True)
            if mode in {"kill", "expire"}: signal.pause()
            return {"observed": archive}, Blobs()
    finally:
        stages._context.reset(token)
replay.execute(dict(document="tiny", configuration="minimum", stage="android/phone", inputSha256=key,
                    mode="fresh" if mode == "fresh" else "reproduce", seconds=1 if mode == "expire" else 30), Path(directory), run)
"""
    from proof.diagnostics import stages
    from proof.observe.record import canonical

    key = stages.digest(canonical(["captured state", "android/phone", {"archive": "original archive"}]))

    def args(mode, expected=key):
        return [sys.executable, "-B", "-c", child, mode, str(tmp_path / mode), expected]

    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    with subprocess.Popen(args("kill"), cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True) as interrupted:
        try:
            assert select.select([interrupted.stdout], [], [], 8)[0]
            assert interrupted.stdout.readline().strip() == "entered"
        finally:
            interrupted.kill()
            interrupted.wait(timeout=10)
    read = lambda mode: json.loads((tmp_path / mode / "stage.json").read_bytes())
    assert read("kill")["status"] == "running" and read("kill")["phase"] == "native" and read("kill")["observedInputSha256"] == key and not (tmp_path / "kill/native.json").exists()
    for mode, status, expected in [("expire", "timed-out", key), ("different", "failed", "0" * 64),
                                   ("retry", "observed", key), ("reference", "observed", key), ("fresh", "observed", key)]:
        done = subprocess.run(args(mode, expected), cwd=ROOT, env=env, capture_output=True, text=True, timeout=10)
        assert (done.returncode == 0) == (status == "observed"), done.stderr
        assert read(mode)["status"] == status
    assert read("different")["phase"] == "input-mismatch" and read("different")["observedInputSha256"] == key
    assert read("expire")["phase"] == "native"
    assert (tmp_path / "retry/native.json").read_bytes() == (tmp_path / "reference/native.json").read_bytes()
    assert read("retry")["outputSha256"] == read("reference")["outputSha256"]
    assert read("fresh")["inputMatchesReference"] is False
    assert read("fresh")["observedInputSha256"] != key
    assert read("fresh")["outputSha256"] != read("reference")["outputSha256"]


@pytest.mark.parametrize("invalid", [{"stage": "Vellum"}, {"seconds": True}, {"seconds": 1201}, {"inputSha256": "unbound"}])
def test_rejects_an_unbound_selector_or_deadline(invalid):
    valid = dict(document="tiny", configuration="minimum", stage="vellum/1.0", inputSha256="f" * 64, seconds=30)
    assert replay.parse_request(json.dumps(valid)) == valid
    with pytest.raises(ValueError):
        replay.parse_request(json.dumps(valid | invalid))


def test_hosted_input_receipts_require_an_addressable_seeded_corpus_group(monkeypatch):
    from types import SimpleNamespace

    from proof.diagnostics import stages

    doc = SimpleNamespace(kind="corpus", group="corpus:tiny")
    store = SimpleNamespace(seeded=True, scope="pinned")
    monkeypatch.setenv("PROOF_CHECKPOINT_PARTS", "1")
    monkeypatch.setenv("PROOF_IMAGE_ID", "pinned")
    monkeypatch.setenv("PROOF_GROUP", "corpus:tiny@minimum~2of2")
    assert stages.wants_receipts(doc, store)
    monkeypatch.setenv("PROOF_GROUP", "proof/formplayer")
    assert not stages.wants_receipts(doc, store)
    monkeypatch.setenv("PROOF_GROUP", doc.group)
    assert not stages.wants_receipts(doc, SimpleNamespace(seeded=False, scope="pinned"))
    assert not stages.wants_receipts(doc, SimpleNamespace())
    monkeypatch.delenv("PROOF_IMAGE_ID")
    assert not stages.wants_receipts(doc, store)
