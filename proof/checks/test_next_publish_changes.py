"""The changes Nova's review lists for the next publish, held both ways on every document whose saves are brought in.

Contract (``proof.checks.changes``): on each document whose ``hq-side.json``
states that Nova's republish brings a person's saves in CommCare HQ in, over
the differences of proof 1, proof 2 and proof 3 together, nothing changed that
the review would not have said (``/<id>/unsaid``: a difference only a row of a
change the review did not list matches), and nothing the review says failed to
show (``/<id>/unseen``; with no served reader observed, a change every row of
which names a served reader's artifact is left to the run that observes it).
Proofs 1, 2 and 3 each accept exactly the differences a listed change's row
names (``changes.undeclared``), and this holds that the list is no wider than
what they showed. The plausible failures: a publish that moves something the
review never told the person of, a review that lists a change the publish does
not make, and a row that names nothing the document shows. No register entry
names ``changes``.

A run whose documents hold none that brings its saves in (a sample, or
documents named by hand) collects no item here: nothing applies, so nothing is
judged.
"""

from __future__ import annotations

import pytest

from proof.checks import cases, changes, observations, proof1, proof2, proof3
from proof.lane import readers


def _brought_in(params):
    """The documents among ``params`` whose ``hq-side.json`` states that the republish brings the saves in: chosen by
    what each document states, never by its source."""
    return [param for param in params if (param.values[0].hq_side or {}).get("republish") == "brings-in"]


BROUGHT_IN = _brought_in(cases.document_params())


if BROUGHT_IN:

    @pytest.mark.parametrize("document", BROUGHT_IN)
    def test_the_changes_the_review_lists_for_the_next_publish_are_closed_both_ways(
        document, hq, core_runner, editor_driver
    ):
        records = observations.records_for(document, core_runner, editor_driver=editor_driver)
        scoped_search = not {changes.SEARCH_ORDER_SUFFIX, changes.LEGACY_SEARCH_GROUP_WORDING}.isdisjoint(
            document.next_publish
        )
        behavior, behavior_sites = (
            proof3.document_behavior_and_sites(document, records)
            if scoped_search else (proof3.document_behavior(document, records), changes.NO_SITES)
        )
        checked = {
            "proof1": proof1.document_identity(document, records),
            "proof2": proof2.document_build_equivalence(document, records),
            "proof3": behavior,
        }
        observed = readers.named()
        sites = (
            changes.merged_sites(proof2.document_sites(document, records), behavior_sites)
            if scoped_search or changes.UNSHOWN_MEDIA in document.next_publish else changes.NO_SITES
        )
        found = changes.differences(document, checked, readers=observed, sites=sites)
        applying = changes.placed(document, changes.load())
        try:
            cases.hold(
                "changes",
                document,
                found,
                cases.load_register(),
                **changes.evidence(applying, checked, readers=observed, sites=sites),
            )
        except AssertionError as error:
            lines = [
                changes.unsaid_message(document.id, difference)
                if difference.path.endswith("/unsaid")
                else changes.unseen_message(document.id, difference)
                for difference in found
            ]
            raise AssertionError("\n".join([*lines, str(error)])) from error
