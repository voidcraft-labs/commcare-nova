"""The live location of a lane worker, for its job log and hosted diagnostic checkpoints.

A worker sends bounded, harness-authored labels via its existing control socket,
outside pytest's output capture. The server samples them on its poll loop, even
when the current native call has stopped answering. Proof observations and judgments never consume progress.
"""

from __future__ import annotations

import re
import time
from collections import Counter
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
_input: ContextVar[dict | None] = ContextVar("proof_progress_input", default=None)
_send: ContextVar[Callable | None] = ContextVar("proof_progress_send", default=None)


def walk_label(name, ordinal):
    return name if isinstance(name, str) and _WEB_WALK.fullmatch(name) else f"walk {ordinal}"


def is_reporting():
    return _send.get() is not None


@contextmanager
def reporting(send):
    sender = _send.set(send)
    path = _path.set(())
    scope = _input.set(None)
    try:
        yield
    finally:
        _input.reset(scope)
        _path.reset(path)
        _send.reset(sender)


@contextmanager
def activity(label: str, *, count=None, input_sha256=None, input_scope=None):
    """Enter a harness stage. Its optional work counter advances only on a normal return."""
    send = _send.get()
    if send is None:
        yield
        return
    outer = _path.get()
    path = (*outer, label)
    started = time.perf_counter()
    parent = _input.get()
    own = {"scope": input_scope, "sha256": input_sha256, "path": path} if input_sha256 else None
    current = own or parent
    send({"t": "progress", "path": path, "input": current})
    token = _path.set(path)
    scope = _input.set(current)
    completed = False
    try:
        yield
        completed = True
    finally:
        _input.reset(scope)
        _path.reset(token)
        send(
            {
                "t": "progress",
                "path": outer,
                "completed": count if completed else None,
                "input": parent,
                "finished_input": own if completed else None,
                "seconds": int(time.perf_counter() - started),
            }
        )


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
    last_native_seconds: int = 0
    last_part_seconds: int = 0
    current_input: dict | None = None
    last_input: dict | None = None
    last_input_seconds: int = 0

    @classmethod
    def begin(cls, group, now):
        return cls(group, now, now, now)

    def update(self, message, now):
        if message.get("completed") == "part":
            self.parts += 1
            self.last_part = self.path
            self.last_part_seconds = message.get("seconds", 0)
        elif message.get("completed") == "native":
            self.native += 1
            self.last_native = self.path
            self.last_native_seconds = message.get("seconds", 0)
        self.path = " / ".join(message["path"])
        self.stage_started = now
        self.current_input = message.get("input")
        if completed := message.get("finished_input"):
            self.last_input = completed
            self.last_input_seconds = message["seconds"]

    def checkpoint(self, now):
        return {
            "stage": self.path[:512],
            "elapsed": int(now - self.started),
            "stageSeconds": int(now - self.stage_started),
            "native": self.native,
            "parts": self.parts,
            "lastNative": self.last_native[:512],
            "lastNativeSeconds": self.last_native_seconds,
            "lastPart": self.last_part[:512],
            "lastPartSeconds": self.last_part_seconds,
            **(
                {
                    "inputSha256": self.current_input["sha256"],
                    "inputStage": " / ".join(self.current_input["path"])[:512],
                    "inputScope": self.current_input["scope"],
                }
                if self.current_input
                else {}
            ),
            **(
                {
                    "lastInputSha256": self.last_input["sha256"],
                    "lastInputStage": " / ".join(self.last_input["path"])[:512],
                    "lastInputScope": self.last_input["scope"],
                    "lastInputSeconds": self.last_input_seconds,
                }
                if self.last_input
                else {}
            ),
        }

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


def checkpoint(broker, workers, history, stop=None):
    """Cumulative diagnostic progress inside open blocks. The broker only marks a group finished on acknowledgment."""
    active_workers = {worker.sequence: worker.active for worker in workers.values()}
    now = time.monotonic()
    finished, active, lost = [], [], []
    for phase, info in broker.phases.items():
        for block, run in info.runs.items():
            for group, state in run.groups.items():
                row = {"phase": phase, "block": block, "group": group}
                if state.status == "finished":
                    finished.append(
                        {
                            **row,
                            "outcomes": dict(Counter(state.record["outcomes"].values())),
                            **history.get((phase, group), {}),
                        }
                    )
                elif state.status == "failed" and state.worker is not None:
                    lost.append({**row, **history.get((phase, group), {})})
                elif state.status == "running" and (activity := active_workers.get(state.worker)):
                    if activity.group == group:
                        active.append({**row, **activity.checkpoint(now)})
    return {"finished": finished, "active": active, "workerLost": lost, "stop": stop}
