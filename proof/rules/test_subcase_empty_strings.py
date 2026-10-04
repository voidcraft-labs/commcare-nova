"""The rule ``subcase-empty-strings`` is sound: HQ builds a subcase's ``""`` index name and repeat context as null.

Contract: the rule erases a subcase action's ``reference_id`` and
``repeat_context`` ``""`` against null, as the Case Management save writes
them. The plausible failures: the build telling ``""`` from null (so the
save would change the subcase blocks), and the rule erasing a named index,
which HQ builds into the block.

A corpus document whose registration form opens subcases is published with
both fields ``""`` (Nova's) and null (the save's): HQ builds both alike and
the rule erases the difference; a named index builds another block, which
the rule leaves.
"""

from __future__ import annotations

from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    build_differences,
    edited,
    published,
    shown,
    stored_differences,
)
from proof.rules.subcase_empty_strings import RULE

DOCUMENT = "case-extension-registration"


def _subcases(reference_id, repeat_context=None):
    def change(doc):
        subcases = doc["modules"][0]["forms"][0]["actions"]["subcases"]
        assert subcases, "the form opens no subcase"
        for subcase in subcases:
            subcase["reference_id"] = reference_id
            if not subcase.get("repeat_context"):
                subcase["repeat_context"] = repeat_context

    return edited(change)


def test_hq_builds_blank_subcase_fields_as_null(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=_subcases("", ""))
        saved = app.spell(doc=_subcases(None, None))
        named = app.spell(doc=_subcases("host", ""))

    assert_spelled(nova, saved, RULE, lambda path: path.rsplit("/", 1)[-1] in ("reference_id", "repeat_context"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, named.stored, rules=(RULE,)))
    assert build_differences(nova.build, named.build), "HQ builds a named index as parent"
