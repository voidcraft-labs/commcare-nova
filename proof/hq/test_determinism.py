"""An HQ operation's bytes are a function of its key: ``proof.hq.determinism``.

Contract: inside ``operation(key, depth)`` every random draw HQ makes comes
from a DRBG seeded by ``key``, and every clock reads ``EPOCH`` + ``depth``
seconds; outside, entropy is the system's and the clock is real; a nested
operation leaves the outer one exactly as it found it. So the same operations
over the same state give byte-identical apps, builds, Couch documents and
blobs, in one process or a fresh one, and different keys give different ones.

The plausible failures: an entropy reader the seeding misses (``uuid1``'s node
read from the host, or its timestamp guard carried from one operation into the
next; a CSRF mask drawn through ``secrets``; fakecouch's revisions), a scope
that leaks (the global ``random`` state), a nested operation that consumes the
outer one's draws, a draw on a harness thread that shifts HQ's, and a value of
the process itself (a pid, an address, the hash seed, the MAC address) that
reaches what HQ stores, which only a fresh process shows. Each comparison is
paired with its control: the same sequence under keys of its own must differ.

These tests switch the seeding on themselves, so they hold whatever
``PROOF_HQ_DETERMINISM`` the process booted with; the switch's own contract
(off: the system's entropy and clock, operations still opened and refused as
with it on) has its own test.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import random
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import pytest

from proof.hq import determinism, operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.determinism import ConcurrentOperation, operation
from proof.hq.seams import build_seams

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})


@pytest.fixture(autouse=True)
def seeded(monkeypatch):
    monkeypatch.setattr(determinism, "ENABLED", True)


def _key(label: str) -> bytes:
    return hashlib.sha256(f"proof determinism test|{label}".encode()).digest()


def _draws():
    """One of each draw HQ makes, as HQ makes it."""
    from django.middleware.csrf import get_token
    from django.test import RequestFactory

    from proof.hq.couch import ComputedViewCouch

    couch = ComputedViewCouch()
    document = {"doc_type": "ProofDocument"}
    couch.save_doc(document)
    with tempfile.NamedTemporaryFile(prefix="proof-") as named:
        temporary_name = os.path.basename(named.name)
    return {
        "uuid4": uuid.uuid4().hex,
        "urandom": os.urandom(16).hex(),
        "secrets": secrets.token_hex(8),
        "csrf": get_token(RequestFactory().get("/")),
        "couch_id": document["_id"],
        "couch_rev": document["_rev"],
        "uuid1": [uuid.uuid1().hex for _ in range(2)],
        "random": random.random(),
        "temporary_name": temporary_name,
        "time": time.time(),
        "now": dt.datetime.now(dt.UTC).isoformat(),
        "today": dt.date.today().isoformat(),
    }


def _moment(depth):
    return determinism.EPOCH + dt.timedelta(seconds=depth)


def test_the_same_key_gives_the_same_draws_at_the_same_instant(hq):
    with operation(_key("a"), 3):
        first = _draws()
    with operation(_key("a"), 3):
        second = _draws()
    assert first == second
    assert first["time"] == _moment(3).timestamp()
    assert first["now"] == _moment(3).isoformat()
    assert first["today"] == _moment(3).date().isoformat()
    # uuid1 keeps its own guard: two at one frozen instant still differ.
    assert first["uuid1"][0] != first["uuid1"][1]


def test_different_keys_give_different_draws_and_depths_different_instants(hq):
    with operation(_key("a"), 3):
        a = _draws()
    with operation(_key("b"), 3):
        b = _draws()
    with operation(_key("a"), 4):
        later = _draws()
    seeded = ("uuid4", "urandom", "secrets", "csrf", "couch_id", "couch_rev", "random", "temporary_name")
    assert all(a[name] != b[name] for name in seeded), {n: (a[n], b[n]) for n in seeded if a[n] == b[n]}
    assert a["uuid1"][0] != b["uuid1"][0]  # the node and clock sequence are the key's
    assert a["time"] == b["time"]
    assert later["time"] == a["time"] + 1


def test_outside_every_operation_entropy_and_the_clock_are_the_systems(hq):
    with operation(_key("a"), 3):
        seeded = _draws()
    first, second = _draws(), _draws()
    for name in ("uuid4", "urandom", "secrets", "couch_id", "random"):
        assert len({first[name], second[name], seeded[name]}) == 3, name
    # The real clock: what the kernel stamps on a file written now.
    with tempfile.NamedTemporaryFile() as stamped:
        assert abs(os.stat(stamped.name).st_mtime - time.time()) < 5
    assert time.time() > _moment(0).timestamp()


def test_a_nested_operation_leaves_the_outer_one_as_it_found_it(hq):
    def outer_sequence(interrupt):
        with operation(_key("outer"), 2):
            before = (uuid.uuid4().hex, random.random(), uuid.uuid1().hex)
            if interrupt:
                with operation(_key("inner"), 9):
                    inner = (uuid.uuid4().hex, random.random(), uuid.uuid1().hex, time.time())
            after = (uuid.uuid4().hex, random.random(), uuid.uuid1().hex, time.time())
        return before, after, inner if interrupt else None

    plain_before, plain_after, _ = outer_sequence(interrupt=False)
    before, after, inner = outer_sequence(interrupt=True)
    assert (before, after) == (plain_before, plain_after)
    assert inner[3] == _moment(9).timestamp()
    assert after[3] == _moment(2).timestamp()
    with operation(_key("inner"), 9):
        alone = (uuid.uuid4().hex, random.random(), uuid.uuid1().hex, time.time())
    assert inner == alone


def _on_a_thread(target):
    seen = {}
    worker = threading.Thread(target=target, args=(seen,))
    worker.start()
    worker.join()
    return seen


def _process_wide_draws():
    with tempfile.NamedTemporaryFile(prefix="proof-") as named:
        temporary_name = os.path.basename(named.name)
    return (random.random(), uuid.uuid1().hex, temporary_name)


def test_another_threads_draws_are_the_systems_and_it_cannot_open_an_operation(hq):
    """The readers that answer by thread give another thread the system's entropy and leave the block's alone."""

    def draw_and_try(out):
        out["urandom"] = os.urandom(16)
        out["secrets"] = secrets.token_bytes(16)
        out["node"] = uuid.getnode()
        try:
            with operation(_key("thread"), 1):
                out["opened"] = True
        except ConcurrentOperation as refused:
            out["refused"] = refused

    def block(interrupt):
        with operation(_key("main"), 1):
            before = (os.urandom(16), secrets.token_bytes(16), uuid.getnode())
            seen = _on_a_thread(draw_and_try) if interrupt else None
            after = (os.urandom(16), secrets.token_bytes(16), uuid.getnode())
        return before, after, seen

    system_node = uuid.getnode()
    undisturbed_before, undisturbed_after, _ = block(interrupt=False)
    before, after, seen = block(interrupt=True)
    assert (before, after) == (undisturbed_before, undisturbed_after)
    assert seen["urandom"] not in (before[0], after[0]) and seen["secrets"] not in (before[1], after[1])
    assert seen["node"] == system_node != before[2]
    assert isinstance(seen.get("refused"), ConcurrentOperation)

    # With no operation open on the main thread, the thread opens its own.
    assert _on_a_thread(draw_and_try).get("opened") is True


def test_the_process_wide_states_are_the_open_operations_on_every_thread(hq):
    """What the module says of the global random state, temporary names and uuid1's guard: a harness thread
    that drew from them while an operation was open would shift the operation's sequence."""

    def draw(out):
        out["draws"] = _process_wide_draws()

    with operation(_key("process wide"), 1):
        alone = (_process_wide_draws(), _process_wide_draws())
    with operation(_key("process wide"), 1):
        first = _process_wide_draws()
        on_the_thread = _on_a_thread(draw)["draws"]
        shifted = _process_wide_draws()
    assert first == alone[0]
    assert on_the_thread[0] == alone[1][0] and on_the_thread[2] == alone[1][2]
    assert shifted != alone[1]


def test_with_the_switch_off_an_operation_seeds_nothing_and_still_opens_as_with_it_on(hq, monkeypatch):
    """``PROOF_HQ_DETERMINISM=0``: the system's entropy and the real clock, the operation's bookkeeping unchanged."""
    from proof.hq.boot import ForkRefused, prepare_for_fork

    monkeypatch.setattr(determinism, "ENABLED", False)

    def try_to_open(out):
        try:
            with operation(_key("thread"), 1):
                out["opened"] = True
        except ConcurrentOperation as refused:
            out["refused"] = refused

    with operation(_key("a"), 3):
        first = _draws()
        refused_thread = _on_a_thread(try_to_open)
        with pytest.raises(ForkRefused, match="inside an HQ operation"):
            prepare_for_fork()
    with operation(_key("a"), 3):
        second = _draws()
    for name in ("uuid4", "urandom", "secrets", "csrf", "couch_id", "couch_rev", "random", "temporary_name"):
        assert first[name] != second[name], name
    real = time.time()
    assert abs(first["time"] - real) < 600 and first["time"] > _moment(3).timestamp() + 60
    assert isinstance(refused_thread.get("refused"), ConcurrentOperation)
    assert determinism._STACK == []


def test_inside_an_operation_monotonic_is_frozen_and_perf_counter_runs(hq):
    """The root of the waiting rule harness code follows: a deadline kept with ``time.monotonic`` never arrives."""
    with operation(_key("waits"), 1):
        frozen, started = time.monotonic(), time.perf_counter_ns()
        hashlib.sha256(bytes(1 << 20)).digest()
        assert time.monotonic() == frozen
        assert time.perf_counter_ns() > started
    assert time.monotonic() != frozen


# EPOCH -----------------------------------------------------------------------------------------------------
#
# Contract: EPOCH is the HQ pin's commit time, read from the time the image
# records (/opt/hq-pin-time), else from HQ's history, else the time this
# module records for its pin only. The plausible failures: a time without a
# UTC offset read as local time, a malformed file read as some other instant,
# the recorded time used for another pin, which would date HQ's behavior by
# the wrong commit, and a checkout with history but no git to read it (the
# image's schema stage) failing the import instead of falling back.

PIN_TIME = "2026-09-25T23:11:53+01:00"
# The one commit of a history made for the test, and its committer time.
HISTORY_IDENTITY = {
    **{f"GIT_{who}_NAME": "proof" for who in ("AUTHOR", "COMMITTER")},
    **{f"GIT_{who}_EMAIL": "proof@example.com" for who in ("AUTHOR", "COMMITTER")},
    **{f"GIT_{who}_DATE": "2026-09-20T08:00:00+02:00" for who in ("AUTHOR", "COMMITTER")},
}


@pytest.fixture
def pin(monkeypatch, tmp_path):
    """Where ``_resolve_epoch`` looks, pointed into ``tmp_path``: ``pin(recorded_time=, history=, pinned=)``."""

    def place(*, recorded_time=None, history=False, git=True, pinned=determinism._RECORDED_PIN):
        recorded = tmp_path / "hq-pin-time"
        if recorded_time is not None:
            recorded.write_text(recorded_time)
        hq_root = tmp_path / "hq"
        hq_root.mkdir(exist_ok=True)
        if history:
            subprocess.run(["git", "-C", str(hq_root), "init", "-q"], check=True)
            subprocess.run(
                ["git", "-C", str(hq_root), "commit", "-q", "--allow-empty", "-m", "pin"],
                check=True,
                env={**os.environ, **HISTORY_IDENTITY},
            )
        pins = tmp_path / "pins.json"
        pins.write_text(json.dumps({"commcare-hq": {"commit": pinned}}))
        monkeypatch.setattr(determinism, "PIN_TIME_FILE", recorded)
        monkeypatch.setattr(determinism, "HQ_ROOT", hq_root)
        monkeypatch.setattr(determinism, "PINS_FILE", pins)
        with monkeypatch.context() as scoped:
            if not git:
                # A PATH that names no git, as in a stage that installs none.
                (tmp_path / "no-git").mkdir(exist_ok=True)
                scoped.setenv("PATH", str(tmp_path / "no-git"))
            return determinism._resolve_epoch()

    return place


def test_epoch_is_the_time_the_image_recorded_for_the_pin(pin):
    moment, source = pin(recorded_time=PIN_TIME + "\n", history=True)
    assert moment == dt.datetime(2026, 9, 25, 22, 11, 53, tzinfo=dt.UTC)
    assert moment.tzinfo is dt.UTC and source.endswith("hq-pin-time")


def test_without_a_recorded_time_epoch_is_the_pins_commit_time_from_its_history(pin):
    moment, source = pin(history=True)
    assert moment == dt.datetime(2026, 9, 20, 6, 0, 0, tzinfo=dt.UTC)
    assert source.startswith("git log in ")


def test_without_a_recorded_time_or_history_epoch_is_the_time_recorded_for_this_pin_only(pin):
    moment, source = pin()
    assert moment == dt.datetime.fromisoformat(determinism._RECORDED_PIN_TIME).astimezone(dt.UTC)
    assert source == f"recorded for HQ {determinism._RECORDED_PIN[:12]}"
    with pytest.raises(RuntimeError, match="is for f57e85e02913"):
        pin(pinned="0" * 40)


def test_a_history_with_no_git_to_read_it_falls_back_as_no_history_does(pin):
    moment, source = pin(history=True, git=False)
    assert moment == dt.datetime.fromisoformat(determinism._RECORDED_PIN_TIME).astimezone(dt.UTC)
    assert source == f"recorded for HQ {determinism._RECORDED_PIN[:12]}"
    with pytest.raises(RuntimeError, match="with a git to read it"):
        pin(history=True, git=False, pinned="0" * 40)
    # The recorded file needs no git.
    moment, _ = pin(recorded_time=PIN_TIME, history=True, git=False)
    assert moment == dt.datetime(2026, 9, 25, 22, 11, 53, tzinfo=dt.UTC)


@pytest.mark.parametrize("written", ["yesterday", "2026-09-25T23:11:53"], ids=["malformed", "no offset"])
def test_a_recorded_time_that_names_no_instant_is_refused(pin, written):
    with pytest.raises(RuntimeError, match="pin time"):
        pin(recorded_time=written, history=True)


# Publish and build ---------------------------------------------------------------


def _sequence(state, record, *, keyed: bool):
    """Nova's create, HQ's build, the saved build, the next publish and its build: each one operation."""
    labels = iter(range(1, 100))

    def step(label):
        depth = next(labels)
        if keyed:
            return operation(_key(f"sequence|{label}"), depth)
        return operation(os.urandom(32), depth)

    # The state's own seeding (proof.hq.state) runs outside these operations,
    # so the documents it seeded are compared only where the sequence changed them.
    seeded = json.loads(json.dumps(state.couch.mock_docs))
    app = hq_test_app()
    with step("create"):
        app_id, _ = operations.publish(state, [nova_shaped_upload(app, "Suite app")])
    with step("build a"), build_seams():
        build_a = operations.build(operations.held_app(state, app_id), record)
    with step("saved a"):
        saved_a = build_a.saved_build()
    with step("update"):
        update = nova_shaped_upload(hq_test_app(), "Suite app", app_id="captured")
        operations.apply_upload(state, operations.with_app_id(update, app_id))
    with step("build b"), build_seams(previous=saved_a):
        build_b = operations.build(operations.held_app(state, app_id), record)
    return _snapshot(state, {"a": build_a, "b": build_b}, seeded)


def _snapshot(state, builds, seeded):
    blobs = {}
    root = Path(state.blob_db.rootdir)
    for path in sorted(root.rglob("*")):
        if path.is_file():
            blobs[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "couch": {
            doc_id: json.loads(json.dumps(doc, sort_keys=True)) if seeded.get(doc_id) != doc else "as seeded"
            for doc_id, doc in state.couch.mock_docs.items()
        },
        "files": {
            name: {
                path: hashlib.sha256(content if isinstance(content, bytes) else content.encode()).hexdigest()
                for path, content in sorted(build.files.items())
            }
            for name, build in builds.items()
        },
        "app": json.loads(json.dumps(builds["b"].app.to_json(), sort_keys=True)),
        "blobs": blobs,
    }


def _digest(snapshot) -> str:
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()


def _differences(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        found = []
        for key in sorted(set(a) | set(b), key=str):
            found += _differences(a.get(key), b.get(key), f"{path}/{key}")
        return found
    return [] if a == b else [f"{path}: {str(a)[:120]} != {str(b)[:120]}"]


def _run_sequence(validate, *, keyed=True):
    with hq_check(CONFIGURATION, validate=validate) as (state, record):
        snapshot = _sequence(state, record, keyed=keyed)
        validations = {
            hashlib.sha256(v.xml).hexdigest(): json.dumps(v.response, sort_keys=True) for v in record.form_validations
        }
    return snapshot, validations


def test_the_same_publish_and_build_sequence_is_byte_identical_under_the_same_keys(hq, core_runner, tmp_path):
    assert hq.python_hash_seed == "0", (
        "The lane runs HQ with PYTHONHASHSEED=0 (proof/compose.yaml), so string hashing and set order are the "
        f"same in every process; this process runs with {hq.python_hash_seed!r}, so a fresh process could order "
        "HQ's output differently. Run the lane as `npm run proof` runs it."
    )
    first, validations = _run_sequence(core_runner.validate_form)
    second, _ = _run_sequence(core_runner.validate_form)
    assert _differences(first, second) == []
    assert first["blobs"] and first["files"]["a"] and len(first["couch"]) > 3

    # The control: the same sequence under keys of its own differs.
    unkeyed, _ = _run_sequence(core_runner.validate_form, keyed=False)
    assert unkeyed["app"]["_id"] != first["app"]["_id"]
    assert unkeyed["files"]["a"]["profile.xml"] != first["files"]["a"]["profile.xml"]

    # A fresh process, its database under a worker name no lane worker holds,
    # Core's answers replayed by the bytes this process sent.
    workers = _workers()
    answers = tmp_path / "validations.json"
    answers.write_text(json.dumps(validations))
    result = tmp_path / "fresh.json"
    completed = subprocess.run(
        [sys.executable, "-c", "from proof.hq.test_determinism import fresh_process; fresh_process()"],
        env={
            **os.environ,
            "PROOF_WORKER": f"{workers + 1}/{workers + 1}",
            "PROOF_HQ_DETERMINISM": "1",
            "PROOF_DETERMINISM_ANSWERS": str(answers),
            "PROOF_DETERMINISM_RESULT": str(result),
        },
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr[-4000:]
    assert _differences(first, json.loads(result.read_text())) == []


def _workers() -> int:
    """How many workers the lane runs, from ``PROOF_WORKER=w/k`` as every reader of it parses it (1 when unset)."""
    from proof.checks.sharding import parse_shard

    value = os.environ.get("PROOF_WORKER", "")
    return parse_shard(value, "PROOF_WORKER")[1] if value else 1


class _ReplayedCore:
    """Core's answers from another process, by the sha256 of the form's bytes; other bytes are refused."""

    def __init__(self, answers):
        self._answers = answers

    def __call__(self, xml):
        digest = hashlib.sha256(xml).hexdigest()
        if digest not in self._answers:
            raise AssertionError(
                f"HQ sent Formplayer's validation a form (sha256 {digest}) the first process never sent, so the "
                "fresh process built different bytes."
            )
        return self._answers[digest]


def fresh_process():
    """The sequence in this process, written to ``PROOF_DETERMINISM_RESULT``; run by the test above."""
    from proof.hq import database
    from proof.hq.boot import boot

    boot()
    answers = json.loads(Path(os.environ["PROOF_DETERMINISM_ANSWERS"]).read_text())
    try:
        snapshot, _ = _run_sequence(_ReplayedCore(answers))
    finally:
        database.drop_template()
    Path(os.environ["PROOF_DETERMINISM_RESULT"]).write_text(json.dumps(snapshot))
