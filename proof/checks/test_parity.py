"""Parity: Nova's reader and the lane's manifest check agree on every app made in CommCare HQ, wherever the lane
decides.

Contract (``proof.checks.parity``): on each ``hq-authored`` document, every
use the lane's check extracts from HQ's source answer for A and decides has a
record of the reader's claim log at the same ``(artifact, where)`` naming an
entry of its key, with a standing that projects to the lane's; and every
record that names a key is a use the lane extracted there. The plausible
failures: a value one classifier holds and the other refuses, a key the reader
claims at another place than its value sits (the two place vocabularies
drifted), and a container the reader claims and never reads inside. What the
lane does not decide is counted by key in the evidence (``undecided``). No
register entry names ``parity``, so any difference fails, with ``parity.disagreement``'s message.

A run whose documents hold no app made in HQ (a sample, documents named by
hand, a self-test's private corpus) collects no item here: there is nothing to
read, so nothing is judged, and an empty parametrization would otherwise fail
collection (``proof/pytest.ini``, ``empty_parameter_set_mark``).
"""

from __future__ import annotations

import pytest

from proof.checks import cases, observations, parity


PARITY = cases.document_params("parity")


if PARITY:

    @pytest.mark.parametrize("document", PARITY)
    def test_nova_s_reader_and_the_lane_s_manifest_check_agree(document, hq, core_runner, editor_driver):
        records = observations.records_for(document, core_runner, editor_driver=editor_driver)
        found = parity.differences(document, records)
        try:
            cases.hold("parity", document, found, cases.load_register(), undecided=parity.undecided(document, records))
        except AssertionError as error:
            lines = [parity.disagreement(document.id, difference) for difference in found]
            raise AssertionError("\n".join([*lines, str(error)])) from error
