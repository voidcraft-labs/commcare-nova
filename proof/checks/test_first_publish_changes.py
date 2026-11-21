"""The first-publish register, held both ways on every app made in CommCare HQ.

Contract (``proof.checks.changes``, ``proof.checks.source``): on each
``hq-authored`` document, A's stored app against B's as HQ's source read
serves each (``source``) changes only where an entry the reading says applies
declares it, or where the claim log holds the place as inert and no claim of
another standing on its branch (``changes.inert_holds``), and never at a place
Nova keeps (``changes.held``); and over the
differences of ``source``, proof 1, proof 2 and proof 3 together the register
is closed: nothing changed that Nova's review would not have said (hold 1,
``/<id>/unsaid``), and nothing it would say failed to show (hold 2,
``/<id>/unseen``; with no served reader observed, an entry every
row of which names a served reader's artifact is left to the run that
observes it). What the judge read (every difference of the four checks, the
places, the claims, the sites, the readers) is written beside its differences
(``changes.evidence``), so the judgment is made again from a run's output alone
(``python3 -m proof.checks.changes replay``) and each row a base needs is
written from it (``rows``). The plausible failures: a first publish that rewrites what a
person kept, a register entry whose rule fires where nothing changes, and a
change the review would never mention. No register entry names ``source`` or
``changes``. A document whose saves in CommCare HQ are brought in is held to
the changes its review lists for the next publish by
``test_next_publish_changes.py``.

A run whose documents hold no app made in HQ (a sample, documents named by
hand, a self-test's private corpus) collects no item here: nothing applies, so
nothing is judged, and an empty parametrization would otherwise fail
collection (``proof/pytest.ini``, ``empty_parameter_set_mark``).
"""

from __future__ import annotations

import pytest

from proof.checks import cases, changes, observations, parity, proof1, proof2, proof3, source
from proof.lane import readers


def _records(document, core_runner, editor_driver):
    return observations.records_for(document, core_runner, editor_driver=editor_driver)


SOURCE = cases.document_params("source")
CHANGES = cases.document_params("changes")


if SOURCE:

    @pytest.mark.parametrize("document", SOURCE)
    def test_a_base_s_stored_app_changes_only_where_the_register_says(document, hq, core_runner, editor_driver):
        records = _records(document, core_runner, editor_driver)
        places = parity.claim_places_of(document, records)
        found = source.differences(document, records)
        held, ids = changes.declared(document, "source", found, places=places)
        kept = changes.undeclared(document, "source", found, places=places)
        cases.hold(
            "source",
            document,
            kept,
            cases.load_register(),
            declared=[difference.as_json() for difference in held],
            declaredBy=sorted(ids),
        )


if CHANGES:

    @pytest.mark.parametrize("document", CHANGES)
    def test_the_first_publish_register_is_closed_both_ways(document, hq, core_runner, editor_driver):
        records = _records(document, core_runner, editor_driver)
        behavior, native_and_core_sites = proof3.document_behavior_and_sites(document, records)
        identity, identity_sites = proof1.document_identity_and_sites(document, records)
        checked = {
            "source": source.differences(document, records),
            "proof1": identity,
            "proof2": proof2.document_build_equivalence(document, records),
            "proof3": behavior,
        }
        sites = changes.merged_sites(identity_sites, proof2.document_sites(document, records), native_and_core_sites)
        places = parity.claim_places_of(document, records)
        observed = readers.named()
        found = changes.differences(document, checked, places=places, sites=sites, readers=observed)
        applying = changes.placed(document, changes.load())
        try:
            cases.hold(
                "changes",
                document,
                found,
                cases.load_register(),
                **changes.evidence(applying, checked, places=places, sites=sites, readers=observed),
            )
        except AssertionError as error:
            lines = [
                changes.unsaid_message(document.id, difference)
                if difference.path.endswith("/unsaid")
                else changes.unseen_message(document.id, difference)
                for difference in found
            ]
            raise AssertionError("\n".join([*lines, str(error)])) from error
