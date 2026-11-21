"""Live worker diagnostics use the control channel while observations keep their original results."""

from contextlib import nullcontext
from socket import socketpair
from types import SimpleNamespace

import pytest

from proof.android import observe as android
from proof.android.hq import BASE, RUN
from proof.formplayer import hq
from proof.hq import redis as hq_redis
from proof.lane import progress
from proof.lane.plugin import Channel
from proof.lane.serve import Server
from proof.observe import services
from proof.observe.record import Blobs
from proof.observe.served import reading
from proof.observe.sessions import run_sessions


def test_live_walks_reach_the_server_without_logging_private_scripts(monkeypatch):
    names = []
    monkeypatch.setattr(hq, "_redis_of", lambda runner: None)
    monkeypatch.setattr(hq_redis, "flush", lambda: None)
    monkeypatch.setattr(hq, "sign_in", lambda *args: SimpleNamespace(session=1))
    served = hq.Served(
        SimpleNamespace(fork=nullcontext),
        None,
        SimpleNamespace(username="worker"),
        "app",
        "build",
        1,
        SimpleNamespace(begin=lambda label, session: names.append(label)),
        {},
    )
    private = '{"route":"private menu","answer":"private value"}'
    active = progress.ActiveGroup.begin("corpus:starter-agriculture", 0)
    worker_socket, server_socket = socketpair()
    with worker_socket, server_socket:
        server = Server.__new__(Server)
        worker = SimpleNamespace(sock=server_socket, inbox=b"", active=active)
        channel = Channel(worker_socket)

        def transmit(message):
            channel.send(message)
            server._read_channel(worker)

        with progress.reporting(transmit), progress.activity("minimum/a", count="part"), reading("formplayer"):
            with served.run(private):
                assert active.path == "minimum/a / formplayer / walk 1"
                assert names[-1] == private.encode()
            with reading("webapps"), served.run("webapps-small-whole-3"):
                assert active.path.endswith("webapps / webapps-small-whole-3")
            with reading("webapps"), served.run("webapps-preview-home " + private):
                assert active.path.endswith("webapps / walk 3")

            def device_request(op, *, peer, commands, **arguments):
                assert commands == [private]
                prefix = "android / A app delivered tablet"
                peer.control(RUN, private)
                assert active.path.endswith(f"{prefix} / walk 1")
                peer.control(BASE, "base")
                assert active.path.endswith(prefix)
                peer.control(RUN, private)
                assert active.path.endswith(f"{prefix} / walk 2")
                return {"value": private}

            monkeypatch.setattr(services, "android", lambda: SimpleNamespace(request=device_request))
            monkeypatch.setattr(android, "worker", lambda served: {"username": "private worker"})
            blobs = Blobs()
            with reading("android"):
                found = android._read(
                    served,
                    blobs,
                    "A:" + private,
                    "app",
                    {"archive": b"archive"},
                    {"device": "tablet", "commands": [private]},
                    delivered=True,
                )
            assert blobs.get_json(found["answer"]) == {"value": private}
            assert "private" not in active.describe(active.stage_started)
    assert (active.parts, active.native, active.path) == (1, 4, "")
    assert active.last_part == "minimum/a"


def test_native_exceptions_and_returned_records_survive_reporting(tmp_path):
    released = []
    trace = {"runs": [{"answer": "a private value"}]}
    runner = SimpleNamespace(
        admit=lambda *args, **kwargs: {"app": 4, "admitted": True},
        session=lambda *args, **kwargs: trace,
        holds=lambda app: True,
        release=released.append,
    )

    def observe():
        return run_sessions(runner, "A", tmp_path, b"private restore", script=["private script"])

    original = observe()
    events = []
    failure = RuntimeError("reader stopped")

    def stopped(*args, **kwargs):
        raise failure

    with progress.reporting(events.append):
        with progress.activity("minimum/a", count="part"):
            assert observe() == original
        runner.session = stopped
        with pytest.raises(RuntimeError) as caught, progress.activity("minimum/b", count="part"):
            observe()
    assert caught.value is failure
    assert released == [4, 4, 4]
    assert "private" not in str(events)
    assert [e["completed"] for e in events if e.get("completed")] == ["native", "part"]
    assert events[-1]["path"] == ()


def test_heartbeat_uses_wall_time_even_when_native_calls_stop_reporting():
    active = progress.ActiveGroup.begin("corpus:starter-agriculture", 10)
    active.update({"path": ["minimum/a"]}, 11)
    for visit in range(2000):
        active.update({"path": ["minimum/a", f"walk {visit}"]}, 12)
        active.update({"path": ["minimum/a"], "completed": "native"}, 12)
    active.update({"path": [], "completed": "part"}, 15)
    active.update({"path": ["maximum/b", "HQ view_form 0.4", "save form settings", "android", "save app phone"]}, 30)
    assert active.heartbeat(129) is None
    line = active.heartbeat(130)
    assert "corpus:starter-agriculture active 120s" in line
    assert "save app phone (100s)" in line
    assert (
        "Completed native operations: 2000 (last minimum/a / walk 1999). Observation parts: 1 (last minimum/a)" in line
    )
    assert active.heartbeat(131) is None
    assert "save app phone (220s)" in active.heartbeat(250)

def test_nested_replay_returns_to_its_parent_and_keeps_only_confirmed_completion():
    active = progress.ActiveGroup.begin("corpus:starter-agriculture", 0)

    def receive(message):
        active.update(message, active.stage_started + 1)

    with progress.reporting(receive), progress.activity("minimum/b"):
        with progress.activity("HQ view_form 0.1", input_sha256="a" * 64, input_scope="page/view_form/0.1"):
            with progress.activity("open opportunity"):
                assert active.checkpoint(10)["inputScope"] == "page/view_form/0.1"
            with progress.activity("B app phone", input_sha256="b" * 64, input_scope="android/phone"):
                assert active.checkpoint(10)["inputScope"] == "android/phone"
            completed = active.checkpoint(10)
            assert completed["inputScope"] == "page/view_form/0.1"
            assert (completed["lastInputScope"], completed["lastInputSha256"]) == ("android/phone", "b" * 64)
            with (
                pytest.raises(RuntimeError),
                progress.activity("webapps", input_sha256="c" * 64, input_scope="webapps"),
            ):
                raise RuntimeError("child did not finish")
            assert active.checkpoint(10)["lastInputScope"] == "android/phone"
        assert "inputSha256" not in active.checkpoint(15)
        assert active.checkpoint(15)["lastInputScope"] == "page/view_form/0.1"
