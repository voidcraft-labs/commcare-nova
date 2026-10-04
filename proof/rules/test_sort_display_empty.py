"""The rule ``sort-display-empty`` is sound: HQ builds a sort's display holding no text as none.

Contract: the rule erases a sort element's ``display`` whose every value is
``""``, as the Case List save writes it. The plausible failures: a reader
telling ``{lang: ""}`` from ``{}`` (so the save would change the suite or the
app strings), and the rule erasing a display holding text, which HQ builds
as the sort-only column's header.

A corpus document whose case list sorts is published with a sort on a
property the list does not show (HQ builds it as an invisible column whose
header is the sort's display, ``detail_screen.py::Invisible.header``) and
that sort's display ``{}`` (Nova's), ``""`` for each language (the save's)
and holding text: the first two build alike and the rule erases their
difference; text builds a header, which the rule leaves.
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
from proof.rules.sort_display_empty import RULE

DOCUMENT = "expander-expanddoc-hq-json-projection-sort-elements-1e1c54c0-0"


def _display(text):
    def change(doc):
        short = doc["modules"][0]["case_details"]["short"]
        assert all(column["field"] != "proof_sort_only" for column in short["columns"])
        short["sort_elements"].append(
            {
                "doc_type": "SortElement",
                "field": "proof_sort_only",
                "type": "string",
                "direction": "ascending",
                "blanks": "",
                "display": {} if text is None else {lang: text for lang in doc["langs"]},
                "sort_calculation": "",
            }
        )

    return edited(change)


def test_hq_builds_a_sort_display_holding_no_text_as_none(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=_display(None))
        saved = app.spell(doc=_display(""))
        texted = app.spell(doc=_display("Age"))

    assert_spelled(nova, saved, RULE, lambda path: "/sort_elements/*/display" in path)
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, texted.stored, rules=(RULE,)))
    assert build_differences(nova.build, texted.build), "HQ builds a sort display holding text as none"
