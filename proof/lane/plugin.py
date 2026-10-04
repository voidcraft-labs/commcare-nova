"""The pytest plugin a lane worker runs its session with: it runs the groups the server hands it.

``LanePlugin`` replaces pytest's run loop. After the session collects (the
same selection the server collected before forking; ``proof/conftest.py``
has put each group's items together), it tells the server what it collected
(a digest of every item and its group, which must equal the server's). Then
it asks for a group, runs that group's items in collection order, and asks
again, until the server answers that nothing is left.

pytest tears a fixture down by the item that runs next (``nextitem``): a
module's fixture when the next item is in another module, every fixture when
there is none. So before the last item of a group runs, the plugin asks the
server for the next group without waiting for one (``peek``), and the server
answers at once:

- with a group: the last item runs with that group's first item as its next;
- with ``later``, while a claim the server is waiting on may still bring a
  block: the last item runs with only the session as its next
  (``_SessionOnly``), so everything but the session is torn down after it,
  the group ends, and then the plugin waits for the server's answer (``next``);
- with nothing: the last item runs with no next, and the session ends.

No item waits on a claim, and the session's services stay up from the first
group to the last. When the session was kept up for a group that never came,
the plugin tears it down itself once the server says nothing is left, with
its time counted as the session's (``GroupTimings.session_teardown``); a
fixture that fails to stop then fails the worker, since no item is left to
carry the error.

While an item runs, ``PROOF_OUT`` names its block's directory
(``<output>/blocks/<id>``), so the evidence its checks write is the block's;
``PROOF_GROUP``, ``PROOF_BLOCK`` and ``PROOF_GROUP_FRESH`` (``1`` for a group
the store recomputes) name what runs. Outside the run loop ``PROOF_OUT`` is the
worker's own directory.

The plugin tells the server when a group starts and when it ends, with each
item's outcome (``passed``, ``failed``, ``error`` for a failed setup or
teardown, ``skipped``, ``xfailed``, ``xpassed``) and its seconds
(``proof.lane.timings``). A ``-x`` or ``--maxfail`` stop is passed on, so the
server hands out nothing more; a group the worker was handed for next and had
not started stays unstarted, and the server writes it as not run.
"""

from __future__ import annotations

import json
import os
import socket
from collections import deque
from pathlib import Path

import pytest

from proof.checks.sharding import item_group
from proof.lane.blocks import block_dir, collection_digest
from proof.lane.timings import GroupTimings

PLUGIN_NAME = "proof-lane"
# The server's answer to a peek while nothing is ready yet: a claim may still bring a block.
LATER = "later"


class Channel:
    """The worker's end of its socket to the server: one JSON object per line each way."""

    def __init__(self, sock: socket.socket):
        self._sock = sock
        self._buffer = b""

    def send(self, message: dict) -> None:
        self._sock.sendall(json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n")

    def receive(self) -> dict:
        while b"\n" not in self._buffer:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise ConnectionError("The lane's server closed its end of the worker's channel.")
            self._buffer += chunk
        line, self._buffer = self._buffer.split(b"\n", 1)
        return json.loads(line)

    def request(self, message: dict) -> dict:
        self.send(message)
        return self.receive()


class _SessionOnly:
    """The next item while the next group is not known yet: pytest keeps what it shares with it, the session alone.

    ``SetupState.teardown_exact`` (``_pytest/runner.py``) tears the stack down
    until it is a prefix of the next item's ``listchain()``; this one's chain
    is the session, so every module, class and package fixture ends, and the
    session's own fixtures (the worker's services) stay up for whichever group
    the server hands out next.
    """

    def __init__(self, session):
        self._session = session

    def listchain(self):
        return [self._session]


def _outcome(reports) -> str:
    """One item's outcome from its setup, call and teardown reports."""
    by_phase = {report.when: report for report in reports}
    setup, call, teardown = by_phase.get("setup"), by_phase.get("call"), by_phase.get("teardown")
    if setup is not None and setup.failed:
        return "error"
    if call is not None and call.failed:
        return "failed"
    if teardown is not None and teardown.failed:
        return "error"
    for report in (setup, call):
        if report is not None and report.skipped:
            return "xfailed" if hasattr(report, "wasxfail") else "skipped"
    if call is not None and hasattr(call, "wasxfail"):
        return "xpassed"
    return "passed"


class LanePlugin:
    """Runs the groups the server hands this worker; see the module's docstring."""

    def __init__(self, channel: Channel, *, output: Path, worker: int, workers: int, timings_path: Path):
        # pytest registers a plugin object under its __name__; proof/conftest.py finds this one by it.
        self.__name__ = PLUGIN_NAME
        self.channel = channel
        self._output = Path(output)
        self._worker_out = Path(os.environ.get("PROOF_OUT", str(self._output)))
        self._worker = worker
        self._workers = workers
        self._timings_path = Path(timings_path)
        self.groups: dict[str, str] = {}
        self._items_by_group: dict[str, list] = {}
        self._reports: dict[str, list] = {}
        self.timings: GroupTimings | None = None
        self._stopped = False

    # Collection -------------------------------------------------------------------

    @pytest.hookimpl(trylast=True)
    def pytest_collection_modifyitems(self, session, config, items):
        self.groups = {item.nodeid: item_group(item) for item in items}
        self._items_by_group = {}
        for item in items:
            self._items_by_group.setdefault(self.groups[item.nodeid], []).append(item)
        self.timings = GroupTimings(self.groups, self._timings_path, {"worker": self._worker, "workers": self._workers})
        config.pluginmanager.register(self.timings, "proof-group-timings")
        self.channel.send(
            {
                "t": "collected",
                "digest": collection_digest(self.groups),
                "count": len(items),
                "errors": session.testsfailed,
            }
        )

    # Running ----------------------------------------------------------------------

    def pytest_runtest_logreport(self, report):
        self._reports.setdefault(report.nodeid, []).append(report)

    def _fetch(self, *, wait: bool):
        """The next assignment the server hands out, with its items, or None when nothing is left for this worker.

        Without ``wait`` the server answers at once, ``LATER`` when nothing is
        ready yet but a claim may still bring a block.
        """
        while True:
            if self._stopped:
                return None
            answer = self.channel.request({"t": "next" if wait else "peek"})
            if answer.get("group") is None:
                return LATER if answer.get(LATER) else None
            items = self._items_by_group.get(answer["group"], [])
            if items:
                return answer, items
            # A group this worker collected nothing of: it ends at once, with nothing run.
            self.channel.send({"t": "started", "group": answer["group"], "block": answer["block"]})
            self._finish(answer, [])

    def _finish(self, assignment, items):
        seconds = self.timings.seconds.get(assignment["group"], 0.0) if self.timings is not None else 0.0
        self.channel.send(
            {
                "t": "finished",
                "group": assignment["group"],
                "block": assignment["block"],
                "outcomes": {item.nodeid: _outcome(self._reports.get(item.nodeid, [])) for item in items},
                "seconds": round(seconds, 3),
            }
        )

    def _enter(self, assignment):
        os.environ["PROOF_OUT"] = str(block_dir(self._output, assignment["block"]))
        os.environ["PROOF_GROUP"] = assignment["group"]
        os.environ["PROOF_BLOCK"] = assignment["block"]
        os.environ["PROOF_GROUP_FRESH"] = "1" if assignment.get("fresh") else "0"

    def _leave(self):
        os.environ["PROOF_OUT"] = str(self._worker_out)
        for name in ("PROOF_GROUP", "PROOF_BLOCK", "PROOF_GROUP_FRESH"):
            os.environ.pop(name, None)

    @pytest.hookimpl(tryfirst=True)
    def pytest_runtestloop(self, session):
        if session.testsfailed and not session.config.option.continue_on_collection_errors:
            raise session.Interrupted(
                f"{session.testsfailed} error{'s' if session.testsfailed != 1 else ''} during collection"
            )
        if session.config.option.collectonly:
            return True
        # Each entry: (item, its assignment, whether it is its group's last item, its group's items).
        pending: deque = deque()

        def take(fetched):
            assignment, items = fetched
            self.channel.send({"t": "started", "group": assignment["group"], "block": assignment["block"]})
            pending.extend((item, assignment, index == len(items) - 1, items) for index, item in enumerate(items))

        fetched = self._fetch(wait=True)
        if fetched is not None:
            take(fetched)
        try:
            while pending:
                item, assignment, last, items = pending.popleft()
                upcoming = None
                if not pending:
                    upcoming = self._fetch(wait=False)
                if pending:
                    nextitem = pending[0][0]
                elif upcoming is LATER:
                    nextitem = _SessionOnly(session)
                else:
                    nextitem = None if upcoming is None else upcoming[1][0]
                self._enter(assignment)
                try:
                    item.config.hook.pytest_runtest_protocol(item=item, nextitem=nextitem)
                finally:
                    self._leave()
                if last:
                    self._finish(assignment, items)
                if session.shouldfail or session.shouldstop:
                    self._stopped = True
                    if not last:
                        self._finish(assignment, [other for other in items if other.nodeid in self._reports])
                    # A group already handed for next is never started: the server writes it as not run.
                    self.channel.send({"t": "stop", "reason": str(session.shouldfail or session.shouldstop)})
                    if session.shouldfail:
                        raise session.Failed(session.shouldfail)
                    raise session.Interrupted(session.shouldstop)
                if upcoming is LATER:
                    upcoming = self._fetch(wait=True)
                if upcoming is not None:
                    take(upcoming)
            if session._setupstate.stack:
                # The session was kept up for a group that never came: it ends here, counted as the session's.
                with self.timings.session_teardown():
                    session._setupstate.teardown_exact(None)
        finally:
            self._leave()
        return True
