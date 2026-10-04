"""The rule ``sort-blanks-default`` is sound: Core sorts a sort's blanks alike under ``""`` and its direction's
default.

Contract: the rule erases a sort's ``blanks`` written as its direction's
default (``first`` ascending, ``last`` otherwise) against ``""``, as the Case
List save writes it, in HQ's app document and in the suite HQ builds from
it. HQ's build carries the attribute into the suite, so the proof is Core's:
the plausible failures are Core reading the explicit default otherwise than
``""`` (so the save would move blank rows), and the rule erasing the other
value, which moves them.

A corpus document whose case list sorts ascending is published with a case
whose sort value is blank added to its case database, and its sort's
``blanks`` ``""`` (Nova's), ``first`` (the save's) and ``last``: the first two
build suites the rule reads alike, and Core's sessions over the three lists
give the first two the same rows; ``last`` moves the blank row, and the rule
leaves it.
"""

from __future__ import annotations

from proof.checks import casedata
from proof.rules.conftest import (
    assert_spelled,
    build_differences,
    edited,
    published,
    runs_alike,
    shown,
    with_blank_case,
)
from proof.rules.sort_blanks_default import RULE

DOCUMENT = "expander-expanddoc-hq-json-projection-sort-elements-1e1c54c0-0"
SORTED_PROPERTY = "age"


def _blanks(value):
    def change(doc):
        elements = doc["modules"][0]["case_details"]["short"]["sort_elements"]
        assert [element["direction"] for element in elements] == ["ascending"]
        for element in elements:
            element["blanks"] = value

    return edited(change)


def test_core_sorts_blanks_alike_under_the_default_spelled_either_way(rule_documents, hq, core_runner):
    document = rule_documents[DOCUMENT]
    with published(document, core_runner) as app:
        nova = app.spell(doc=_blanks(""))
        saved = app.spell(doc=_blanks("first"))
        last = app.spell(doc=_blanks("last"))
        case_type = nova.stored["doc"]["modules"][0]["case_type"]
        database = with_blank_case(casedata.case_database(document.document), case_type, {SORTED_PROPERTY})
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build, database=database)
        _, _, moved = runs_alike(app, core_runner, nova.build, last.build, database=database)

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/sort_elements/*/blanks"))
    assert shown(build_differences(nova.build, saved.build)), "HQ built the two spellings into one suite"
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert moved, "a blank row sorts last as it sorts first: the case database exercises no blank"
    assert build_differences(nova.build, last.build, rules=(RULE,))
