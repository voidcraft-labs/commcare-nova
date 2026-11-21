"""The live location of a lane worker. Only the fork server's job log consumes it.

A worker sends bounded, harness-authored labels via its existing control socket,
outside pytest's output capture. The server samples them on its poll loop, even
when the current native call has stopped answering. No progress enters a record.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

# This is the closed shape of a Web Apps replay name, including its viewport.
# Formplayer uses the entire JSON script for its session name. Only its ordinal
# is suitable for a log. Neither an answer nor a route is copied from that name.
_WEB_WALK = re.compile(r"webapps-(?:places-)?(?:desktop|small|preview)(?:-whole)?-(?:home|[0-9]{1,7})")
_INTERVAL = 120
_path: ContextVar[tuple[str, ...]] = ContextVar("proof_progress_path", default=())
_send: ContextVar[Callable | None] = ContextVar("proof_progress_send", default=None)


def walk_label(name, ordinal):
    return name if isinstance(name, str) and _WEB_WALK.fullmatch(name) else f"walk {ordinal}"


@contextmanager
def reporting(send):
    sender = _send.set(send)
    path = _path.set(())
    try:
        yield
    finally:
        _path.reset(path)
        _send.reset(sender)


@contextmanager
def activity(label: str, *, count=None):
    """Enter a harness stage. Its optional work counter advances only on a normal return."""
    send = _send.get()
    if send is None:
        yield
        return
    outer = _path.get()
    path = (*outer, label)
    send({"t": "progress", "path": path})
    token = _path.set(path)
    completed = None
    try:
        yield
        completed = count
    finally:
        _path.reset(token)
        send({"t": "progress", "path": outer, "completed": completed})


@dataclass
class ActiveGroup:
    group: str
    started: float
    reported: float
    stage_started: float
    path: str = ""
    parts: int = 0
    native: int = 0
    last_part: str = ""
    last_native: str = ""

    @classmethod
    def begin(cls, group, now):
        return cls(group, now, now, now)

    def update(self, message, now):
        if message.get("completed") == "part":
            self.parts += 1
            self.last_part = self.path
        elif message.get("completed") == "native":
            self.native += 1
            self.last_native = self.path
        self.path = " / ".join(message["path"])
        self.stage_started = now

    def heartbeat(self, now):
        if now - self.reported < _INTERVAL:
            return None
        self.reported = now
        return self.describe(now)

    def describe(self, now):
        stage = self.path or "group checks or fixture setup"
        last_native = f" (last {self.last_native})" if self.last_native else ""
        last_part = f" (last {self.last_part})" if self.last_part else ""
        return (
            f"{self.group} active {int(now - self.started)}s: {stage} ({int(now - self.stage_started)}s)."
            f" Completed native operations: {self.native}{last_native}. Observation parts: {self.parts}{last_part}."
        )
