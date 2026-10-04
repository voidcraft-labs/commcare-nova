"""The rule ``lookup-fields-unshown`` is sound where it holds: the callout result header and template are unread
while the case list shows no callout results.

Contract: the rule erases a case list's ``lookup_field_header`` and
``lookup_field_template`` where ``lookup_display_results`` is off, as the
Case List save writes them under ``CASE_LIST_LOOKUP``. The condition is the
rule's: with results shown, HQ builds both into the suite. The plausible
failures: HQ reading them with results off (so the save would change the
build), and the rule erasing them with results on.

Both sides: a corpus document is published under its maximum configuration
(which grants ``CASE_LIST_LOOKUP``) with both keys as the save writes them,
results off: it builds as Nova's app does and the rule erases the
difference. With a callout configured and its results on, the two keys'
values build two different suites (``suite_xml/sections/details.py::
DetailContributor._get_lookup_element``), and the rule leaves them.
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
from proof.rules.lookup_fields_unshown import RULE

DOCUMENT = "arithmetic"
CONFIGURATION = "maximum"


def _lookup(header, template, shown_results):
    def change(doc):
        short = doc["modules"][0]["case_details"]["short"]
        short["lookup_field_header"] = {lang: header for lang in doc["langs"]}
        short["lookup_field_template"] = template
        short["lookup_display_results"] = shown_results
        if shown_results:
            short["lookup_enabled"] = True
            short["lookup_action"] = "org.commcare.proof.CALLOUT"

    return edited(change)


def test_the_callout_result_fields_are_unread_while_results_are_off(rule_documents, hq, core_runner):
    document = rule_documents[DOCUMENT]
    assert "CASE_LIST_LOOKUP" in document.exports[CONFIGURATION].configuration.flags
    with published(document, core_runner, CONFIGURATION) as app:
        nova = app.spell()
        assert nova.stored["doc"]["modules"][0]["case_details"]["short"].get("lookup_display_results") is not True
        saved = app.spell(doc=_lookup("", "@case_id", False))
        shown_a = app.spell(doc=_lookup("Score", "@case_id", True))
        shown_b = app.spell(doc=_lookup("Score", "@score", True))

    assert_spelled(nova, saved, RULE, lambda path: "/lookup_field_" in path)
    assert_same_build(nova, saved)
    assert shown(stored_differences(shown_a.stored, shown_b.stored, rules=(RULE,)))
    assert build_differences(shown_a.build, shown_b.build), "HQ builds the shown result's template as unread"
