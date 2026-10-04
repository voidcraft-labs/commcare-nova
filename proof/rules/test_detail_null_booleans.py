"""The rule ``detail-null-booleans`` is sound: HQ builds a detail's null and false flags alike.

Contract: the rule erases ``persist_case_context``, ``persist_tile_on_forms``
and ``pull_down_tile`` written false where Nova leaves them null. The
plausible failures: a reader telling null from false (so the Case List save
would change the build), and the rule erasing a true flag, which HQ builds
into the suite.

A corpus document is published with its case list's three flags null
(Nova's), false (the save's) and ``persist_case_context`` true: the first two
build alike and the rule erases their difference; the third builds a
different suite, which the rule leaves.
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
from proof.rules.detail_null_booleans import RULE

DOCUMENT = "arithmetic"
FLAGS = ("persist_case_context", "persist_tile_on_forms", "pull_down_tile")


def _flags(value, flags=FLAGS):
    def change(doc):
        for display in ("short", "long"):
            for flag in flags:
                doc["modules"][0]["case_details"][display][flag] = value

    return edited(change)


def test_hq_builds_a_null_detail_flag_as_false(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=_flags(None))
        saved = app.spell(doc=_flags(False))
        persisted = app.spell(doc=_flags(True, ("persist_case_context",)))

    assert_spelled(nova, saved, RULE, lambda path: path.rsplit("/", 1)[-1] in FLAGS)
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, persisted.stored, rules=(RULE,)))
    assert build_differences(nova.build, persisted.build), "HQ builds a persistent case context as none"
