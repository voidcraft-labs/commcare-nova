"""A hosted timeout keeps completed receipts, and a partial group still fails the gate and store."""

import json
import signal
import time

import pytest

from proof.checks import sharding
from proof.lane import blocks, serve
from proof.store import queue


@pytest.mark.parametrize(("stopping", "reason", "receipt"), [
    (signal.SIGALRM, "work deadline", "work-deadline"), (signal.SIGINT, "SIGINT", "SIGINT"),
])
def test_interruption_seals_passed_and_unfinished_groups_before_teardown(tmp_path, monkeypatch, stopping, reason, receipt):
    server = serve.Server(serve.parse_arguments(["--out", str(tmp_path), "--deadline-at", str(int(time.time()) + 60)]))
    names = ("corpus:completed", "corpus:unfinished")
    block = blocks.Block(blocks.block_id(names), 2, tuple(blocks.QueuedGroup(name) for name in names))
    item = {name: f"test_document.py::test_document[{name}]" for name in names}

    def run_groups():
        # The server owns the real broker and block writer. Only the expensive HQ boot and workers are omitted.
        server.phases["main"] = serve.PhaseInfo("main", [], by_group={name: [item[name]] for name in names})
        server.broker.add_phase("main", static=True)
        server.broker.offer("main", [block])
        for worker in (1, 2):
            assignment = server.broker.next_for("main", worker)
            server.broker.started(assignment)
            if assignment.group == names[0]:
                server.broker.ended(assignment, {"outcomes": {item[names[0]]: "passed"}, "seconds": 1.0})
        assert 0 < signal.getitimer(signal.ITIMER_REAL)[0] <= 60
        signal.raise_signal(stopping)

    def assert_snapshot():
        diagnostic = json.loads((tmp_path / ".reader-progress.json").read_text())
        assert diagnostic["stop"] == receipt
        assert [row["group"] for row in diagnostic["finished"]] == [names[0]]
        record = json.loads((tmp_path / blocks.SERVE).read_text())
        assert record["exit"] == serve.EXIT_INTERRUPTED
        assert any(reason in problem for problem in record["problems"])
        [(_, manifest)] = blocks.read_manifests(tmp_path)
        complete, partial = manifest["groups"]
        assert complete["outcomes"] == {item[names[0]]: "passed"}
        assert complete["failure"] is None
        assert reason in partial["failure"]
        assert queue._passed({"items": complete["outcomes"], "failure": complete["failure"]})
        assert not queue._passed({"items": {item[names[1]]: "passed"}, "failure": partial["failure"]})
        verdict = sharding.verify([("main", blocks.Queue((block,)))], [tmp_path])
        assert any(reason in problem for problem in verdict.problems)

    shutdown = server._shutdown

    def stop():
        assert_snapshot()
        assert signal.getitimer(signal.ITIMER_REAL)[0] == 0
        shutdown()

    monkeypatch.setattr(server, "_refuse_environment", lambda: None)
    monkeypatch.setattr(server, "_prepare", lambda: None)
    monkeypatch.setattr(server, "_plan", lambda: None)
    monkeypatch.setattr(server, "_loop", run_groups)
    monkeypatch.setattr(server, "_shutdown", stop)
    monkeypatch.setattr(serve, "reap_strays", lambda known: 0)
    handlers = {kind: signal.getsignal(kind) for kind in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM)}
    try:
        assert server.run() == serve.EXIT_INTERRUPTED
    finally:
        for kind, handler in handlers.items():
            signal.signal(kind, handler)
    assert_snapshot()


@pytest.mark.parametrize("stamp", ["0", "1.5"])
def test_hosted_server_refuses_invalid_deadline(stamp):
    with pytest.raises(SystemExit):
        serve.parse_arguments(["--out", "/out", "--deadline-at", stamp])


def test_hosted_server_refuses_a_deadline_past_six_hours(monkeypatch):
    now = 1_800_000_000
    monkeypatch.setattr(time, "time", lambda: now)
    limit = now + 6 * 3600
    assert serve.parse_arguments(["--out", "/out", "--deadline-at", str(limit)]).deadline_at == limit
    with pytest.raises(SystemExit):
        serve.parse_arguments(["--out", "/out", "--deadline-at", str(limit + 1)])
