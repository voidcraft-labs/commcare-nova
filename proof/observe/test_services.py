"""The session's services end together.

Contract (``proof.observe.services.session``): when the session ends, every service it started is closed,
whatever another's close raises, and the session has ended, so the process can open another. Plausible failure:
one service's close raising (the Android reader that cannot remove its work directory, a browser already gone)
leaves the services after it running, a Formplayer JVM, a Chromium, Connect's Postgres and Redis, and the session
marked open, so the next ``session()`` in that process raises that one is already open. The observation is the
session's own end over five services that record their close, one of which raises, each of the five in turn.

The lane's own session (``proof/conftest.py::lane_services``) holds the module's state while a test here runs,
so each test sets it aside and it is put back after.
"""

from __future__ import annotations

import pytest

from proof.observe import services


class _Service:
    """A started service that records its close, and raises there where it is told to."""

    seconds = ()
    cpu_seconds = ()

    def __init__(self, name: str, closed: list[str], failing: bool):
        self.name, self.closed, self.failing = name, closed, failing

    def close(self) -> None:
        self.closed.append(self.name)
        if self.failing:
            raise OSError(f"{self.name} could not close")


@pytest.fixture
def no_session(monkeypatch):
    """The module with no session open and none of the lane's services in it, each put back after the test."""
    for name, value in dict(services._SESSION).items():
        monkeypatch.setitem(services._SESSION, name, value)
    monkeypatch.setitem(services._SESSION, "open", False)
    monkeypatch.setattr(services, "ANDROID_SECONDS", [])
    monkeypatch.setattr(services, "ANDROID_CPU_SECONDS", [])


@pytest.mark.parametrize("failing", services._SERVICES)
def test_every_service_is_closed_and_the_session_ended_whatever_one_close_raises(no_session, failing):
    closed: list[str] = []
    with pytest.raises(OSError, match=f"{failing} could not close"):
        with services.session():
            for name in services._SERVICES:
                services._SESSION[name] = _Service(name, closed, failing=name == failing)
    assert sorted(closed) == sorted(services._SERVICES)
    assert services._SESSION["open"] is False
    assert [services._SESSION[name] for name in services._SERVICES] == [None] * len(services._SERVICES)
    # The process can open another session, which starts with none of the last one's services.
    with services.session():
        assert services._SESSION["open"] is True
    assert closed.count(failing) == 1


def test_a_session_that_started_nothing_closes_nothing_and_keeps_what_its_devices_cost(no_session):
    closed: list[str] = []
    with services.session():
        pass
    assert services._SESSION["open"] is False
    with services.session():
        reader = _Service("android", closed, failing=False)
        reader.seconds, reader.cpu_seconds = [12.5, 30.0], [20.0, 41.5]
        services._SESSION["android"] = reader
    assert closed == ["android"]
    assert (services.ANDROID_SECONDS, services.ANDROID_CPU_SECONDS) == ([12.5, 30.0], [20.0, 41.5])
