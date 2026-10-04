"""Proof 2, build equivalence: HQ builds the same app after Nova's next publish of an unchanged document.

Contract (plan work item 11, proof 2): ``build(A)`` against ``build(B)`` for a
publish with no edit, after B's module and form ids and ``xmlns`` are mapped
to A's by position (identity is proof 1's): both ``validate_app()`` results
and every file ``create_all_files()`` and each build profile's build write,
compared after the registered spelling rules, with a form's version and
each resource version differing only where that form's or resource's
content differs (HQ's own ``set_form_versions`` decides, with ``build(A)``
as the previous build). The plausible failures: a setting HQ holds that the
next publish drops (defect 4), and a file the comparison never looks at,
which ``compare.build_files`` refuses rather than skips.
"""

from __future__ import annotations

import pytest

from proof.checks import cases, observations, proof2


@pytest.mark.parametrize("document", cases.document_params() + cases.control_params("proof2"))
def test_hq_builds_the_same_app_after_the_next_publish(document, hq, core_runner, editor_driver):
    found = proof2.document_build_equivalence(
        document, observations.records_for(document, core_runner, editor_driver=editor_driver)
    )
    cases.hold("proof2", document, found, cases.load_register(), configurations=sorted(document.exports))
