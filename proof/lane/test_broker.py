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

Contract (pieces): a group that follows pieces (a heavy document's own
group, after the groups that each observed one of its configurations) is
handed out only once every piece has ended with every item passed, and a
worker with nothing else to run waits meanwhile. When a piece fails, runs no
item, or is lost with its worker, the group that follows it fails at once
by the piece's name and is never handed out. A worker that holds a piece is
handed nothing ahead of it. The plausible failures: the
document's group handed out first (it is the name the timings know as the
heaviest) and observing the document whole while its pieces observe it
again; a worker told nothing is left while a piece still runs, so the
judging never happens; a failed piece's document observed whole on one
worker in its place, past the shard's deadline; a block never reported
because its last group could not be handed out; and a worker that takes a
piece and, asking ahead at once (a piece is one item), is handed the
document's other piece too, so one worker observes the whole document while
the others stand idle.
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


# Pieces --------------------------------------------------------------------------------------------

PIECES = ("corpus:heavy@maximum", "corpus:heavy@minimum")


def _split(*others, estimates=(60.0, 40.0, 2.0)):
    """A block of one document in pieces (and ``others``): its two pieces and its own group after them."""
    groups = (
        QueuedGroup(PIECES[0], True, (), estimates[0]),
        QueuedGroup(PIECES[1], True, (), estimates[1]),
        QueuedGroup("corpus:heavy", False, PIECES, estimates[2]),
        *(QueuedGroup(name, False, (), SECONDS[name]) for name in others),
    )
    return Block(block_id(group.group for group in groups), 102.0, groups)


PASSED = {"outcomes": {"checks/pieces.py::test[x]": "passed"}}


def test_a_piece_its_queue_gives_no_estimate_is_ordered_by_its_share_among_its_documents_pieces():
    """The heaviest group goes out first. A queue that carries no estimates is ordered by the timings, where a
    piece no run measured is a share of its document, for the number of pieces the document is observed in
    (``proof.checks.sharding.piece_share``). Counted at the two-piece share whatever their number, each of four
    pieces of a 200-second document would pass for 130 seconds and go out before a 100-second group it is
    lighter than."""
    from proof.checks import sharding

    pieces = tuple(f"control:wide@{name}" for name in ("a", "b", "c", "d"))
    groups = (
        *(QueuedGroup(piece) for piece in pieces),
        QueuedGroup("control:wide", False, pieces),
        QueuedGroup("corpus:beside"),
    )
    broker = Broker(sharding.estimate({"control:wide": 200.0, "corpus:beside": 100.0}))
    broker.add_phase("main", static=True)
    broker.offer("main", [Block(block_id(group.group for group in groups), 400.0, groups)])
    assert broker.next_for("main", 1).group == "corpus:beside"
    assert broker.next_for("main", 2).group in pieces


def test_a_group_that_follows_pieces_is_handed_out_once_each_has_passed_and_a_worker_waits_meanwhile():
    block = _split()
    # The timings know the document's own name as its whole cost, far past either piece: the queue's estimates,
    # and its pieces still running, are what order it last.
    broker = Broker({"corpus:heavy": 500.0}.get)
    broker.add_phase("main", static=True)
    broker.offer("main", [block])
    first, second = broker.next_for("main", 1), broker.next_for("main", 2)
    assert (first.group, second.group) == PIECES
    assert first.fresh and first.after == ()
    # Both pieces are out, and the document's group waits on them: a third worker waits, and is not sent away.
    assert broker.next_for("main", 3) == WAIT
    assert not broker.exhausted("main") and broker.demand("main") == 1
    broker.started(first)
    broker.started(second)
    broker.ended(first, PASSED)
    assert broker.next_for("main", 3) == WAIT  # one piece still runs
    broker.ended(second, PASSED)
    judging = broker.next_for("main", 3)
    assert (judging.group, judging.fresh, judging.after) == ("corpus:heavy", False, PIECES)
    assert broker.next_for("main", 1) is None and broker.exhausted("main")
    assert broker.take_completed() == []
    broker.started(judging)
    broker.ended(judging, {"outcomes": {"checks/test_bar.py::test[heavy]": "passed"}})
    [(_, run)] = broker.take_completed()
    assert {name: state.status for name, state in run.groups.items()} == dict.fromkeys(
        (*PIECES, "corpus:heavy"), "finished"
    )


def test_a_worker_takes_other_groups_while_a_documents_pieces_run():
    block = _split("corpus:a", "corpus:d")
    broker = _broker(static=True, blocks=[block])
    handed = [broker.next_for("main", worker).group for worker in (1, 2, 3, 4)]
    assert handed == [*PIECES, "corpus:a", "corpus:d"]  # longest first, the document's own group passed over
    assert broker.next_for("main", 5) == WAIT


def test_a_claiming_shard_starts_its_reserved_block_for_a_worker_the_pieces_would_keep_waiting():
    split, other = _split(), _block("corpus:c")
    broker = _broker(blocks=[split, other])
    broker.claims_to_start()
    broker.claimed("main", split.id, "claimed")
    assert [broker.next_for("main", worker).group for worker in (1, 2)] == list(PIECES)
    broker.claims_to_start()
    broker.claimed("main", other.id, "claimed")
    # Nothing of the started block can be handed out, so the reserved one is started for the third worker.
    assert broker.next_for("main", 3).group == "corpus:c"


def test_a_failed_piece_fails_the_group_that_follows_it_by_name_and_it_is_never_handed_out():
    for record, why in (
        ({"outcomes": {"checks/pieces.py::test[x]": "failed"}}, "did not pass (checks/pieces.py::test[x]: failed)"),
        ({"outcomes": {"checks/pieces.py::test[x]": "skipped"}}, "did not pass (checks/pieces.py::test[x]: skipped)"),
        ({"outcomes": {}}, "ran no item"),
    ):
        broker = _broker(static=True, blocks=[_split()])
        first, second = broker.next_for("main", 1), broker.next_for("main", 2)
        broker.started(first)
        broker.started(second)
        broker.ended(first, record)
        # The other piece still runs; the document's group has already failed, and no worker is given it.
        assert broker.next_for("main", 3) is None
        assert broker.take_completed() == []
        broker.ended(second, PASSED)
        assert broker.next_for("main", 3) is None
        [(_, run)] = broker.take_completed()
        whole = run.groups["corpus:heavy"]
        assert whole.status == "failed" and whole.worker is None and whole.record == {}
        assert whole.failure == (
            f"its piece {PIECES[0]} {why}, so it was not run: it judges what its pieces observed, and never"
            " observes the document whole in their place"
        )
        assert run.groups[PIECES[1]].status == "finished"


def test_a_piece_lost_with_its_worker_fails_the_group_that_follows_it_and_one_only_handed_runs_again():
    broker = _broker(static=True, blocks=[_split()])
    first, second = broker.next_for("main", 1), broker.next_for("main", 1)
    broker.started(first)
    reason = "worker w1 exited with status -9 while running it"
    broker.lost(first, reason)
    broker.lost(second, reason)
    assert broker.status(first) == "failed"
    # The piece the worker had only been handed goes to another worker; the document's group is already failed.
    again = broker.next_for("main", 2)
    assert again.group == PIECES[1]
    assert broker.next_for("main", 3) is None
    broker.started(again)
    broker.ended(again, PASSED)
    [(_, run)] = broker.take_completed()
    assert run.groups["corpus:heavy"].status == "failed"
    assert f"its piece {PIECES[0]} did not finish ({reason}), so it was not run" in run.groups["corpus:heavy"].failure


def test_a_worker_that_holds_a_piece_is_handed_nothing_ahead_of_it():
    """A worker asks ahead before its group's last item, so pytest knows what runs next. A piece is one item, as
    long as its observation: what its worker were handed at its start would wait behind it for hours."""
    broker = _broker(static=True, blocks=[_split("corpus:a")])
    first = broker.next_for("main", 1)
    assert first.group == PIECES[0]
    # Asking ahead, the piece's worker is handed nothing, though the other piece and a document wait: it is
    # told to ask again, which it does when the piece ends.
    assert broker.next_for("main", 1, ahead=True) == WAIT
    broker.started(first)
    assert broker.next_for("main", 1, ahead=True) == WAIT
    # A free worker takes the other piece, and a third the document beside them.
    second = broker.next_for("main", 2)
    assert second.group == PIECES[1]
    third = broker.next_for("main", 3)
    assert third.group == "corpus:a"
    broker.started(second)
    broker.started(third)
    broker.ended(first, PASSED)
    assert broker.next_for("main", 1) == WAIT  # the document's own group waits on the piece still running
    broker.ended(second, PASSED)
    # A worker that holds no piece is handed ahead as ever: the document's own group, to the one finishing beside.
    assert broker.next_for("main", 3, ahead=True).group == "corpus:heavy"


def test_a_worker_finishing_another_group_is_handed_a_piece_ahead():
    broker = _broker(static=True, blocks=[_split("corpus:e")])  # corpus:e is longer than either piece
    assert broker.next_for("main", 1).group == PIECES[0]
    document = broker.next_for("main", 2)
    assert document.group == "corpus:e"
    # Before its last item it asks ahead, and the piece it is handed starts as that item ends.
    assert broker.next_for("main", 2, ahead=True).group == PIECES[1]
