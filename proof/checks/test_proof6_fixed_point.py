"""Proof 6, the fixed point: Nova reads back from CommCare HQ the document that made what HQ serves.

Contract (``proof.checks.proof6``): over HQ's API answers for each state the
unit read in a fork, Nova's reader (the bundle the corpus carries) gives a
Nova-born document's own canonical form at A and B-edit
(``read(served(D)) = canonDocument(D)``), a migration witness's at B, the
document a bring-in of a person's saves gave at B, and, on an app made in
CommCare HQ, D itself at A (``read(A) = D``) and B (``read(served(D)) = D``)
and D′'s canonical form at B-edit. Where the republish runs Nova's review of
a person's saves, HQ's own answer after the saves reads as the review read the
capture's model of them (``broughtIn.reading``). The plausible failures: a
reader that loses or changes something Nova's own export carries, a canonical
pair the reader chooses that ``CANONICALIZATIONS`` lacks, a unit that makes an
A other than the base the emission read, and a capture peer that stores a
person's save otherwise than HQ does, under a review that then judged a model.
No register entry names ``proof6``, so any difference fails, with ``proof6.fixed_point_message``.
"""

from __future__ import annotations

import pytest

from proof.checks import cases, observations, proof6


@pytest.mark.parametrize("document", cases.document_params("proof6"))
def test_nova_reads_back_the_document_that_made_what_hq_serves(document, hq, core_runner, editor_driver):
    records = observations.records_for(document, core_runner, editor_driver=editor_driver)
    found = proof6.differences(document, records)
    try:
        cases.hold("proof6", document, found, cases.load_register(), configurations=sorted(document.exports))
    except AssertionError as error:
        message = proof6.fixed_point_message(document.id, found)
        raise AssertionError(f"{message}\n{error}" if message else str(error)) from error
