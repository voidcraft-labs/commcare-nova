"""The rule ``column-tab-keys`` is sound: HQ builds a detail column alike with or without the page's tab keys.

Contract: the rule erases a column's ``nodesetCaseType`` and
``nodesetFilter``, which HQ's Case List and Case Detail pages write on every
column. The plausible failures: a reader of either on a column (so the
saves would change the build), and the rule erasing another key of a
column.

A corpus document is published with its case list's and case detail's
columns as Nova writes them and with both keys on each, ``""`` and a case
type: HQ builds them alike and the rule erases the difference; a changed
column header stays.
"""

from __future__ import annotations

from proof.rules.column_tab_keys import RULE
from proof.rules.conftest import assert_same_build, assert_spelled, edited, published, shown, stored_differences

DOCUMENT = "arithmetic"


def _columns(doc):
    return [column for display in ("short", "long") for column in doc["modules"][0]["case_details"][display]["columns"]]


def _with_tab_keys(doc):
    for index, column in enumerate(_columns(doc)):
        column["nodesetCaseType"] = "" if index % 2 else doc["modules"][0]["case_type"]
        column["nodesetFilter"] = ""


def test_hq_builds_a_column_alike_with_the_pages_tab_keys(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        saved = app.spell(doc=edited(_with_tab_keys))
        renamed = app.spell(doc=edited(lambda doc: _columns(doc)[0]["header"].update(en="Renamed")))

    assert_spelled(nova, saved, RULE, lambda path: path.rsplit("/", 1)[-1] in ("nodesetCaseType", "nodesetFilter"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, renamed.stored, rules=(RULE,)))
