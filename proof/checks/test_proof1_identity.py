"""Proof 1, identity: every external identity survives Nova's next publish, and the local path's.

Contract (plan work item 11, proof 1): for a publish with no edit, every
identity in the research's identity table is equal between A and B; for a
publish after an edit batch, every identity of an entity outside the
batch's footprint is; and two local ``.ccz`` exports of one unchanged
document carry the same form ``xmlns`` and profile ``uniqueid``, the second
at a version no lower. The plausible failure is an identity Nova mints anew
on each export (defect 1), which splits exports, re-downloads every form and
strands a device's incomplete forms.

Differences are accepted only where ``proof/identity-moves.json`` names
them; every other one must fall in a class of ``proof/known-defects.json``.
"""

from __future__ import annotations

import pytest

from proof.checks import cases, observations, proof1, registers


@pytest.mark.parametrize("document", cases.document_params() + cases.control_params("proof1"))
def test_identity_survives_the_next_publish(document, hq, core_runner, editor_driver):
    found = proof1.document_identity(
        document, observations.records_for(document, core_runner, editor_driver=editor_driver)
    )
    accepted, found = registers.accepted_moves(found, registers.load_identity_moves())
    cases.hold(
        "proof1",
        document,
        found,
        cases.load_register(),
        accepted=[difference.as_json() for difference in accepted],
    )
