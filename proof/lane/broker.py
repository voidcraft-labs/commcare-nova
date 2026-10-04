"""Which group a worker runs next, which blocks a shard claims, and when a block is finished.

The fork server's decisions, apart from its processes (``proof.lane.serve``
drives one ``Broker`` from its events). A lane runs in phases: ``early``
(groups that need no corpus) and ``main``, each over its queue's blocks in
queue order.

Claims. A phase whose blocks are claimed statically (``--claim static``,
with or without ``--bin``) owns every block it was given from the start.
Otherwise a shard claims blocks one at a time, in queue order, keeping one
claimed block in reserve beyond what its workers are running, plus one for
each worker waiting on an empty pool (``claims_to_start``). A claim that
comes back taken moves on to the next block; one that fails stops every
claim of the shard, which then finishes what it holds.

Handing out. A worker asking for work gets the longest group (by estimate,
then name) among the started blocks' groups not yet handed out; when there
is none, the next reserved block is started, and when none is reserved
either, the worker waits for a claim, or is told the phase has nothing more
for it. A statically claimed phase starts all its blocks at once, so its
groups are handed out longest first across the whole phase.

Losing a worker. A group a lost worker had started fails, with the reason;
one it was handed and had not started goes back to the pool for another
worker. A block is finished when every one of its groups has finished or
failed.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from proof.lane.blocks import Block

WAIT = "wait"


@dataclass(frozen=True)
class Assignment:
    phase: str
    block: str
    group: str
    fresh: bool


@dataclass
class GroupState:
    queued: object  # proof.lane.blocks.QueuedGroup
    status: str = "pending"  # pending, handed, running, finished, failed
    worker: int | None = None
    record: dict = field(default_factory=dict)
    failure: str | None = None


@dataclass
class BlockRun:
    block: Block
    groups: dict[str, GroupState]
    # Whether the server has written its manifest.
    written: bool = False

    @property
    def done(self) -> bool:
        return all(state.status in ("finished", "failed") for state in self.groups.values())


@dataclass
class Phase:
    name: str
    static: bool
    blocks: list[Block] = field(default_factory=list)
    available: bool = False
    # Block id -> unclaimed, claiming, claimed, taken or failed.
    claims: dict[str, str] = field(default_factory=dict)
    reserve: deque = field(default_factory=deque)
    runs: dict[str, BlockRun] = field(default_factory=dict)
    # (block id, group) not yet handed out, of started blocks.
    pool: list[tuple[str, str]] = field(default_factory=list)
    waiting: int = 0


class Broker:
    """One shard's claims and hand-outs over its phases; ``estimate(group)`` orders the groups."""

    def __init__(self, estimate):
        self._estimate = estimate
        self.phases: dict[str, Phase] = {}
        self.claim_failure: str | None = None
        self.completed: list[tuple[str, BlockRun]] = []

    # Phases -----------------------------------------------------------------------

    def add_phase(self, name: str, *, static: bool) -> Phase:
        phase = Phase(name, static)
        self.phases[name] = phase
        return phase

    def offer(self, name: str, blocks: list[Block]) -> None:
        """The phase's blocks are known (its queue arrived); a static phase owns them all at once."""
        phase = self.phases[name]
        phase.blocks = list(blocks)
        phase.available = True
        for block in phase.blocks:
            phase.claims[block.id] = "claimed" if phase.static else "unclaimed"
            if phase.static:
                self._start(phase, block)

    def cancel(self, name: str) -> None:
        """The phase's queue will never arrive: nothing of it runs here."""
        phase = self.phases[name]
        phase.available = True
        phase.blocks = []

    def owned(self, name: str) -> list[Block]:
        """The blocks this shard owns in the phase: claimed, whether started or in reserve."""
        phase = self.phases[name]
        return [block for block in phase.blocks if phase.claims.get(block.id) == "claimed"]

    def exhausted(self, name: str) -> bool:
        """Whether the phase will never hand out another group here."""
        phase = self.phases[name]
        if not phase.available:
            return False
        if phase.pool or phase.reserve:
            return False
        if self.claim_failure is None and any(state in ("unclaimed", "claiming") for state in phase.claims.values()):
            return False
        return True

    # Claims -----------------------------------------------------------------------

    def claims_to_start(self) -> list[tuple[str, Block]]:
        """The claims to start now, each marked as being claimed: one ahead, plus one per waiting worker."""
        if self.claim_failure is not None:
            return []
        started = []
        for phase in self.phases.values():
            if not phase.available or phase.static:
                continue
            in_flight = sum(1 for state in phase.claims.values() if state == "claiming")
            wanted = 1 + phase.waiting - len(phase.reserve) - in_flight
            for block in phase.blocks:
                if wanted <= 0:
                    break
                if phase.claims[block.id] == "unclaimed":
                    phase.claims[block.id] = "claiming"
                    started.append((phase.name, block))
                    wanted -= 1
        return started

    def claimed(self, name: str, identifier: str, outcome: str, reason: str | None = None) -> None:
        """A claim ended: ``claimed``, ``taken`` (another shard holds it) or ``failed`` (``reason`` says why)."""
        phase = self.phases[name]
        if outcome == "claimed":
            phase.claims[identifier] = "claimed"
            phase.reserve.append(identifier)
        elif outcome == "taken":
            phase.claims[identifier] = "taken"
        else:
            phase.claims[identifier] = "failed"
            if self.claim_failure is None:
                self.claim_failure = reason or f"claiming block {identifier} failed"

    # Handing out ----------------------------------------------------------------------

    def _start(self, phase: Phase, block: Block) -> None:
        phase.runs[block.id] = BlockRun(block, {queued.group: GroupState(queued) for queued in block.groups})
        phase.pool.extend((block.id, queued.group) for queued in block.groups)

    def next_for(self, name: str, worker: int):
        """The next group for ``worker`` in the phase, ``WAIT`` while a claim may bring one, or None."""
        phase = self.phases[name]
        if not phase.pool and phase.reserve:
            identifier = phase.reserve.popleft()
            self._start(phase, next(block for block in phase.blocks if block.id == identifier))
        if phase.pool:
            phase.pool.sort(key=lambda entry: (-self._estimate(entry[1]), entry[1]))
            identifier, group = phase.pool.pop(0)
            state = phase.runs[identifier].groups[group]
            state.status, state.worker = "handed", worker
            return Assignment(name, identifier, group, state.queued.fresh)
        if self.exhausted(name):
            return None
        return WAIT

    def wait(self, name: str) -> None:
        self.phases[name].waiting += 1

    def stop_waiting(self, name: str) -> None:
        self.phases[name].waiting -= 1

    def _state(self, assignment: Assignment) -> GroupState:
        return self.phases[assignment.phase].runs[assignment.block].groups[assignment.group]

    def status(self, assignment: Assignment) -> str:
        """pending, handed, running, finished or failed."""
        return self._state(assignment).status

    def started(self, assignment: Assignment) -> None:
        self._state(assignment).status = "running"

    def _settle(self, assignment: Assignment) -> None:
        run = self.phases[assignment.phase].runs[assignment.block]
        if run.done:
            self.completed.append((assignment.phase, run))

    def ended(self, assignment: Assignment, record: dict) -> None:
        """The worker finished the group; ``record`` is what it reported."""
        state = self._state(assignment)
        state.status, state.record = "finished", record
        self._settle(assignment)

    def lost(self, assignment: Assignment, reason: str) -> None:
        """The worker holding ``assignment`` ended without finishing it."""
        state = self._state(assignment)
        if state.status == "running":
            state.status, state.failure = "failed", reason
            self._settle(assignment)
        else:
            state.status, state.worker = "pending", None
            self.phases[assignment.phase].pool.append((assignment.block, assignment.group))

    def take_completed(self) -> list[tuple[str, BlockRun]]:
        completed, self.completed = self.completed, []
        return completed

    def demand(self, name: str) -> int:
        """How many workers the phase could keep busy now: its groups waiting, and more while claims may come."""
        phase = self.phases[name]
        waiting_groups = len(phase.pool) + sum(
            len(next(block for block in phase.blocks if block.id == identifier).groups) for identifier in phase.reserve
        )
        more = self.claim_failure is None and any(state in ("unclaimed", "claiming") for state in phase.claims.values())
        return waiting_groups + (1 if more else 0)
