"""One shard's claims and hand-outs: claimed one ahead, longest first, and nothing lost when a worker is.

Contract (``proof.lane.broker``): a shard that claims keeps one claimed block
in reserve beyond what its workers run, plus one per worker waiting on an
empty pool, claiming in queue order and passing over blocks another shard
took; a failed claim stops every claim. A worker gets the longest group of
the started blocks; a statically claimed phase starts every block at once.
A group a lost worker had started fails with the reason, one it had only
been handed goes to another worker, and a block is finished, and reported
once, when every group has finished or failed. The plausible failures:
claiming the whole queue at once (one shard hoarding the tail), claiming
nothing ahead (workers idle while a claim runs), handing out short groups
first, running a group twice or never after a worker dies, and reporting a
block before its last group ends.
"""

from __future__ import annotations

from proof.lane.blocks import Block, QueuedGroup, block_id
from proof.lane.broker import WAIT, Broker

SECONDS = {"corpus:a": 10.0, "corpus:b": 30.0, "corpus:c": 20.0, "corpus:d": 5.0, "corpus:e": 40.0, "corpus:f": 1.0}


def _block(*names):
    return Block(block_id(names), sum(SECONDS[name] for name in names), tuple(QueuedGroup(name) for name in names))


BLOCKS = [_block("corpus:a", "corpus:b"), _block("corpus:c"), _block("corpus:d", "corpus:e"), _block("corpus:f")]


def _broker(*, static=False, blocks=BLOCKS):
    broker = Broker(SECONDS.get)
    broker.add_phase("main", static=static)
    broker.offer("main", blocks)
    return broker


def test_a_claiming_shard_claims_one_ahead_and_one_more_for_each_waiting_worker_in_queue_order():
    broker = _broker()
    first = broker.claims_to_start()
    assert first == [("main", BLOCKS[0])]
    assert broker.claims_to_start() == []  # one in flight is the one ahead
    broker.claimed("main", BLOCKS[0].id, "claimed")
    # With the block in reserve and no one waiting, nothing more is claimed yet.
    assert broker.claims_to_start() == []
    assert broker.next_for("main", 1).group == "corpus:b"  # starts the reserved block, longest group first
    started = broker.claims_to_start()
    assert started == [("main", BLOCKS[1])]  # the reserve is spent, so one more ahead
    assert broker.next_for("main", 2).group == "corpus:a"
    assert broker.next_for("main", 3) == WAIT
    broker.wait("main")
    assert broker.claims_to_start() == [("main", BLOCKS[2])]  # one for the waiting worker
    broker.claimed("main", BLOCKS[1].id, "taken")
    assert broker.claims_to_start() == [("main", BLOCKS[3])]  # passes over the taken block
    broker.claimed("main", BLOCKS[2].id, "claimed")
    broker.stop_waiting("main")
    assert broker.next_for("main", 3).group == "corpus:e"
    assert broker.owned("main") == [BLOCKS[0], BLOCKS[2]]


def test_a_failed_claim_stops_every_claim_and_the_shard_finishes_what_it_holds():
    broker = _broker()
    broker.claims_to_start()
    broker.claimed("main", BLOCKS[0].id, "claimed")
    broker.next_for("main", 1)
    (_, block), *_ = broker.claims_to_start()
    broker.claimed("main", block.id, "failed", "the artifact service refused")
    assert broker.claim_failure == "the artifact service refused"
    assert broker.claims_to_start() == []
    assert broker.next_for("main", 2).group == "corpus:a"  # what it holds still runs
    assert broker.next_for("main", 3) is None  # and nothing more comes
    assert broker.exhausted("main")


def test_a_static_phase_owns_every_block_and_hands_its_groups_out_longest_first():
    broker = _broker(static=True)
    assert broker.claims_to_start() == []
    handed = [broker.next_for("main", worker).group for worker in range(1, 7)]
    assert handed == ["corpus:e", "corpus:b", "corpus:c", "corpus:a", "corpus:d", "corpus:f"]
    assert broker.next_for("main", 7) is None
    assert broker.exhausted("main")
    assert broker.take_completed() == []  # handed out, and none has ended


def test_a_lost_workers_running_group_fails_and_its_handed_group_goes_to_another_worker():
    broker = _broker(static=True, blocks=[BLOCKS[0]])
    running = broker.next_for("main", 1)
    handed = broker.next_for("main", 1)
    broker.started(running)
    broker.lost(running, "worker w1 exited with status -9 while running it")
    broker.lost(handed, "worker w1 exited with status -9 while running it")
    assert broker.status(running) == "failed"
    assert broker.take_completed() == []  # the handed group has not run yet
    again = broker.next_for("main", 2)
    assert again.group == handed.group
    broker.started(again)
    broker.ended(again, {"outcomes": {"x": "passed"}})
    [(phase, run)] = broker.take_completed()
    assert phase == "main" and run.block == BLOCKS[0]
    assert run.groups[running.group].failure == "worker w1 exited with status -9 while running it"
    assert run.groups[again.group].worker == 2
    assert broker.take_completed() == []
    assert broker.next_for("main", 3) is None


def test_a_block_is_reported_once_its_last_group_ends():
    broker = _broker(static=True, blocks=[BLOCKS[2]])
    first, second = broker.next_for("main", 1), broker.next_for("main", 2)
    broker.started(first)
    broker.started(second)
    broker.ended(first, {})
    assert broker.take_completed() == []
    broker.ended(second, {})
    assert [run.block for _, run in broker.take_completed()] == [BLOCKS[2]]


def test_a_phase_whose_queue_never_arrives_runs_nothing():
    broker = Broker(SECONDS.get)
    broker.add_phase("main", static=False)
    assert not broker.exhausted("main")  # its queue may still come
    assert broker.claims_to_start() == []
    broker.cancel("main")
    assert broker.exhausted("main")
    assert broker.next_for("main", 1) is None
    assert broker.demand("main") == 0
