"""A document observed in pieces: one configuration of it, whole, into the run's evidence store.

A corpus document's or control's checks share one observation
(``proof.checks.observations.records_for``), which with every reader takes one
worker hours for the heaviest documents. Where a lane's queue says so
(``proof.store.queue``: a document past the profile's split threshold), each
configuration the document is exported under is observed by a group of its
own instead, a piece (``corpus:<id>@<configuration>``, ``proof.lane.blocks``),
on a worker of its own: exactly the unit an unsplit observation runs for
that configuration (``proof.observe.unit.observe_configuration``), keyed and
kept as that observation keeps it. The document's own group runs once its
pieces have passed (``proof.lane.broker``), reads every part from the run's
store and observes nothing, so every check judges the document whole.

This module is no ``test_*.py``: pytest collects it only where it is named by
its path, which the lane's server does where its main queue names pieces
(``proof.lane.serve``), with ``PROOF_LANE_PIECES`` naming that queue. It then
gives one item for each piece the queue names (``proof.checks.cases
.piece_params``), so a shard collects no item no queue runs. Named by hand
with no queue (the line a failed night's issue gives for a piece), it gives
an item for every configuration of every document and control, and the one a
person names runs: it observes that configuration again, as its lane did.
"""

from __future__ import annotations

import pytest

from proof.checks import cases, observations


@pytest.mark.parametrize("piece", cases.piece_params())
def test_a_configuration_is_observed_into_the_runs_store(piece, hq, core_runner, editor_driver):
    observations.observe_piece(piece.document, piece.configuration, core_runner, editor_driver=editor_driver)
