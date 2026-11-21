"""A hosted diagnostic binds the exact native operation to the original source and finalized inputs."""

import hashlib
import io
import json
import tarfile

import pytest

from proof.ci import replay


@pytest.fixture
def sample():
    group = "corpus:starter-agriculture@minimum~2of2"
    queue = json.dumps({
        "blocks": [{"id": "b" * 64, "groups": [{"group": group}]}],
        "selection": {"documents": ["starter-agriculture"]},
        "environment": {"PROOF_HQ_DETERMINISM": "on", "PROOF_HQ_SPEED": "on", "PROOF_READERS": "all",
                        "PYTHONHASHSEED": "0", "TZ": "UTC"},
        "fingerprints": {"arch": "amd64"},
    }).encode()
    row = {"phase": "main", "group": group, "block": "b" * 64,
           "inputScope": "android/phone", "inputStage": ["minimum/b", "android"], "inputSha256": "a" * 64,
           "lastInputScope": "vellum/1.0/first/formplayer", "lastInputStage": ["minimum/b"], "lastInputSha256": "e" * 64}
    source = {"run": "13", "attempt": "2", "shard": "audit-shard-3", "commit": "c" * 40}
    record = {"kind": "reader-progress", "version": 1, "source": source, "queues": {"main": hashlib.sha256(queue).hexdigest()},
              "workerLost": [row], "finished": [], "active": []}
    emission = {"documents": [{"id": "starter-agriculture", "configurations": ["minimum"]}]}
    args = dict(**source, group=group, configuration="minimum", stage="android/phone", operation="active", seconds=300)
    return record, queue, emission, args


def test_lost_workers_live_and_previously_completed_inputs_remain_independently_replayable(sample):
    record, queue, emission, args = sample
    current = replay.selection(record, queue, emission, **args)
    args.update(operation="last-completed", stage="vellum/1.0/first/formplayer")
    previous = replay.selection(record, queue, emission, **args)
    assert current["request"]["inputSha256"] == "a" * 64
    assert previous["request"]["inputSha256"] == "e" * 64
    with pytest.raises(ValueError, match="matching B operation"):
        replay.selection(record, queue, emission, **dict(args, operation="active"))
    with pytest.raises(ValueError, match="main queue differs"):
        replay.selection(record, queue + b" ", emission, **args)
    with pytest.raises(ValueError, match="piece belongs"):
        replay.selection(record, queue, emission, **dict(args, configuration="maximum"))
    with pytest.raises(ValueError, match="another run"):
        replay.selection(record, queue, emission, **dict(args, attempt="1"))


def test_an_ordinary_unsampled_queue_uses_the_named_blocks_membership(sample):
    record, raw, emission, args = sample
    queue = json.loads(raw)
    del queue["selection"]
    raw = json.dumps(queue).encode()
    record["queues"]["main"] = hashlib.sha256(raw).hexdigest()
    assert replay.selection(record, raw, emission, **args)["group"] == args["group"]
    queue["blocks"][0]["groups"] = []
    raw = json.dumps(queue).encode()
    record["queues"]["main"] = hashlib.sha256(raw).hexdigest()
    with pytest.raises(ValueError, match="absent from its recorded block"):
        replay.selection(record, raw, emission, **args)


def test_artifact_names_and_source_cover_pr_and_reusable_lanes():
    assert replay.artifact_names("proof-progress-shard-1-2-19.json", "2") == (
        "shard-1", "proof-queue-2.json", "proof-corpus-2.tar.zst")
    assert replay.artifact_names("proof-progress-mechanics-shard-3-2-19.json", "2") == (
        "mechanics-shard-3", "proof-queue-mechanics-2.json", "proof-corpus-mechanics-2.tar.zst")
    with pytest.raises(ValueError):
        replay.artifact_names("proof-progress-other-2-1.json", "2")
    repo = "owner/repo"
    run = {"repository": {"full_name": repo}, "head_repository": {"full_name": repo}, "path": ".github/workflows/ci.yml",
           "head_sha": "a" * 40, "referenced_workflows": [
        {"path": repo + "/.github/workflows/proof-lane.yml@refs/pull/42/merge", "sha": "b" * 40},
        {"path": "elsewhere/repo/.github/workflows/proof-lane.yml@trunk", "sha": "e" * 40},
    ]}
    assert replay.recorded_commit(run, repo, "a" * 40, "shard-3")
    assert replay.recorded_commit(run, repo, "b" * 40, "shard-3")
    assert replay.recorded_commit(run, repo, "b" * 40, "sample-shard-3")
    assert not replay.recorded_commit(run, repo, "e" * 40, "sample-shard-3")
    unrelated = dict(run, path=".github/workflows/elsewhere.yml", referenced_workflows=[])
    assert not replay.recorded_commit(unrelated, repo, "a" * 40, "shard-3")
    assert not replay.recorded_commit(unrelated, repo, "a" * 40, "sample-shard-3")
    assert not replay.recorded_commit(dict(run, head_repository={"full_name": "elsewhere/repo"}), repo, "a" * 40, "shard-3")
    jobs = [dict(id=20, name="Proof 3/8", runner_name="vm1"), dict(id=21, name="Sample / Shard 3/4 (sample)", runner_name="vm2")]
    assert replay.source_job(jobs, "shard-3")["id"] == 20
    assert replay.source_job(jobs, "sample-shard-3")["id"] == 21
    with pytest.raises(ValueError, match="matching original shard"):
        replay.source_job(jobs, "other-shard-3")


def test_only_the_dispatch_ref_can_execute_in_either_mode():
    original, repair = "a" * 40, "b" * 40
    replay.verify_dispatch("reproduce", original, original, original)
    replay.verify_dispatch("fresh", repair, original, repair)
    with pytest.raises(ValueError, match="pointing at the checkpoint commit"):
        replay.verify_dispatch("reproduce", repair, original, repair)
    with pytest.raises(ValueError, match="commit GitHub dispatched"):
        replay.verify_dispatch("reproduce", repair, original, original)
    with pytest.raises(ValueError, match="commit GitHub dispatched"):
        replay.verify_dispatch("fresh", repair, original, original)


def test_the_host_returns_only_the_selected_native_bytes_and_refuses_changed_output(tmp_path, sample):
    record, queue, emission, args = sample
    receipt = replay.selection(record, queue, emission, **args)
    (tmp_path / "receipt.json").write_text(json.dumps(receipt))
    output = tmp_path / "output"
    stage = output / "blocks" / ("d" * 64) / "diagnostics" / "stage-1"
    (stage / "blobs").mkdir(parents=True)
    blob = b"native screenshot"
    (stage / "blobs" / hashlib.sha256(blob).hexdigest()).write_bytes(blob)
    native = b'{"held":true}'
    (stage / "native.json").write_bytes(native)
    status = dict(receipt["request"], status="observed", observedInputSha256="a" * 64, inputMatchesReference=True,
                  outputSha256=hashlib.sha256(native).hexdigest(), blobs=1)
    (stage / "stage.json").write_text(json.dumps(status))
    (stage / "accidental-extra-file").touch()
    replay.report(tmp_path, output, successful=True)
    kept = tmp_path / "report" / stage.name
    assert (kept / "native.json").read_bytes() == native
    assert not (kept / "accidental-extra-file").exists()
    again = tmp_path / "second"
    again.mkdir()
    (again / "receipt.json").write_text(json.dumps(receipt))
    (stage / "native.json").write_bytes(b"changed")
    with pytest.raises(ValueError, match="result digest differs"):
        replay.report(again, output, successful=True)
    (stage / "native.json").write_bytes(native)
    status.update(observedInputSha256="c" * 64, inputMatchesReference=False)
    (stage / "stage.json").write_text(json.dumps(status))
    strict = tmp_path / "strict"
    strict.mkdir()
    (strict / "receipt.json").write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match="different input"):
        replay.report(strict, output, successful=True)
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    receipt["request"]["mode"] = "fresh"
    (fresh / "receipt.json").write_text(json.dumps(receipt))
    (stage / "stage.json").write_text(json.dumps(dict(status, mode="fresh")))
    replay.report(fresh, output, successful=True)
    assert json.loads((fresh / "report" / "stage-1" / "stage.json").read_text())["inputMatchesReference"] is False


@pytest.mark.parametrize(("name", "kind"), [("../outside", tarfile.REGTYPE), ("linked", tarfile.SYMTYPE)])
def test_the_original_emission_cannot_supply_files_outside_the_diagnostic_corpus(tmp_path, name, kind):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        regular = tarfile.TarInfo("./doc/input.json")
        regular.size = 2
        archive.addfile(regular, io.BytesIO(b"{}"))
        entry = tarfile.TarInfo(name)
        entry.type = kind
        entry.linkname = "../outside" if kind == tarfile.SYMTYPE else ""
        archive.addfile(entry)
    stream.seek(0)
    corpus = tmp_path / "corpus"
    with pytest.raises(ValueError, match="Unexpected corpus path|plain files"):
        replay.extract_corpus(stream, corpus)
    assert (corpus / "doc/input.json").read_bytes() == b"{}"
    assert not (tmp_path / "outside").exists()
