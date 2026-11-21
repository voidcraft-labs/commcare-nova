"""One freshly republished HQ app through Formplayer's ordinary B and the interrupted diagnostic."""

import json
import os

import pytest

DOCUMENTS = ("hq-plain",)


@pytest.mark.reader("formplayer")
@pytest.mark.under_determinism
def test_focused_b_formplayer_matches_the_ordinary_native_result_after_an_interruption(
    hq, core_runner, editor_driver, tmp_path, monkeypatch
):
    from proof.checks import cases
    from proof.diagnostics import replay
    from proof.lane import progress, readers
    from proof.observe import served, unit
    from proof.store import runtime

    # This is a Formplayer integration test in either of the lane profiles that runs it.
    monkeypatch.setenv(readers.VARIABLE, "formplayer")
    monkeypatch.setenv("PROOF_CHECKPOINT_PARTS", "1")
    document = cases.load_corpus().document(DOCUMENTS[0])
    env = dict(os.environ, PROOF_OUT=str(tmp_path / "observer"), PROOF_CHECKPOINT_PARTS="0")
    env.pop("PROOF_STORE", None)
    inputs = dict(core_runner=core_runner, editor_driver=editor_driver, store=runtime.session_store(document, env))
    monkeypatch.setenv("PROOF_GROUP", document.group)
    sent = []

    def checkpoint(message):
        if message.get("finished_input"):
            sent.append((message["finished_input"]["scope"], message["finished_input"]["sha256"]))

    class OriginalComplete(BaseException):
        pass

    native_call = served.Serving.formplayer
    reference = []

    def take_baseline(serving, *args, **kwargs):
        side, trace = native_call(serving, *args, **kwargs)
        if kwargs.get("baseline"):
            reference.append((side, serving.blobs.named_by(side)))
            raise OriginalComplete()
        return side, trace

    # Enter through the ordinary document group, including A and its own reader, the actual B key and
    # hooks before its editor. Only stop after the original B native call has delivered its complete bytes.
    with monkeypatch.context() as patch, progress.reporting(checkpoint), pytest.raises(OriginalComplete):
        patch.setattr(served.Serving, "formplayer", take_baseline)
        unit.observe_document(document, configurations=["minimum"], **inputs)
    [(expected, expected_bytes)] = reference
    [(label, key)] = sent
    assert label == "formplayer"
    request = dict(document=document.id, configuration="minimum", stage="formplayer", inputSha256=key, seconds=120)

    def capture():
        with replay.prepared(document, "minimum", **inputs) as ctx:
            return replay._selected(ctx, "formplayer"), ctx.blobs

    def interrupt(message):
        # The real pinned service has started an actual worker walk, past the point at which its archive
        # and reader inputs were checked. The underlying HQ fork, reader session and request all unwind.
        if any(str(label).startswith("walk ") for label in message.get("path", ())):
            raise KeyboardInterrupt()

    with progress.reporting(interrupt), pytest.raises(KeyboardInterrupt):
        replay.execute(request, tmp_path / "interrupted", capture)
    assert json.loads((tmp_path / "interrupted/stage.json").read_bytes())["status"] == "interrupted"
    assert not (tmp_path / "interrupted/native.json").exists()
    assert replay.execute(request, tmp_path / "retry", capture) == expected
    assert expected_bytes.refs()
    for ref in expected_bytes.refs():
        assert (tmp_path / "retry/blobs" / ref.split(":")[1]).read_bytes() == expected_bytes.get(ref)


@pytest.mark.reader("formplayer")
@pytest.mark.under_determinism
def test_a_single_saved_release_replays_the_actual_formplayer_call_from_its_vellum_pair(
    hq, core_runner, editor_driver, tmp_path, monkeypatch
):
    from proof.checks import cases
    from proof.diagnostics import replay, stages
    from proof.lane import progress, readers
    from proof.observe import proof4
    from proof.store import runtime

    document = cases.load_corpus().document(DOCUMENTS[0])
    monkeypatch.setenv(readers.VARIABLE, "formplayer")
    monkeypatch.setenv("PROOF_GROUP", document.group)
    monkeypatch.setenv("PROOF_CHECKPOINT_PARTS", "1")
    scope = "vellum/0.0/first/formplayer"
    checkpoints = {}

    def save(message):
        finished = message.get("finished_input")
        if finished:
            checkpoints[finished["scope"]] = finished["sha256"]

    def inputs(directory):
        env = dict(os.environ, PROOF_OUT=str(directory), PROOF_CHECKPOINT_PARTS="0")
        env.pop("PROOF_STORE", None)
        return dict(core_runner=core_runner, editor_driver=editor_driver, store=runtime.session_store(document, env))

    # A reused emission must still contain the bytes its declared keys describe. A wrong digest refuses
    # before HQ opens or any native runtime is needed.
    import shutil
    from dataclasses import replace

    mixed = replace(document, root=tmp_path / "mixed" / document.id)
    shutil.copytree(document.root, mixed.root)
    body = mixed.root / "export" / "minimum" / "republish.body"
    body.write_bytes(body.read_bytes() + b" ")
    with pytest.raises(ValueError, match="input digests disagree"):
        with replay.prepared(mixed, "minimum", **inputs(tmp_path / "refused")):
            pytest.fail("An emission with mixed inputs reached HQ.")

    with replay.prepared(document, "minimum", **inputs(tmp_path / "ordinary")) as ctx:
        with stages.baseline(ctx), progress.reporting(save):
            observed = proof4._Observation(ctx, proof4.hq_order).observe(
                views=lambda *_: False, forms=lambda position: position == [0, 0]
            )
        expected = observed["vellum"][0]["runs"][0]["served"]["formplayer"]
        expected_bytes = ctx.blobs.named_by(expected)

    request = dict(document=document.id, configuration="minimum", stage=scope, inputSha256=checkpoints[scope], seconds=180)
    native_stages = []

    def capture():
        # The original release, its Formplayer script and the one changed saved form are prerequisites. A second
        # Vellum save, other forms and native clients never run on this diagnostic.
        with replay.prepared(document, "minimum", **inputs(tmp_path / "isolated")) as ctx:
            return replay._selected(ctx, scope), ctx.blobs

    def count(message):
        current = message.get("input")
        if current:
            native_stages.append(current["scope"])

    with progress.reporting(count):
        assert replay.execute(request, tmp_path / "selected", capture) == expected
    assert set(native_stages) == {"formplayer", "vellum/0.0", scope}
    assert expected_bytes.refs()
    for ref in expected_bytes.refs():
        assert (tmp_path / "selected/blobs" / ref.split(":")[1]).read_bytes() == expected_bytes.get(ref)
