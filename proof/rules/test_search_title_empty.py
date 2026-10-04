"""The rule ``search-title-empty`` is sound: HQ builds a case search title holding no text as none.

Contract: the rule erases ``search_config.title_label`` whose every value is
``""``, as the Case List save writes it. The plausible failures: a reader
telling ``{lang: ""}`` from ``{}`` (so the save would change the app strings
or the suite), and the rule erasing a title holding text.

A corpus document with a case search is published (under its maximum
configuration, where the search's app strings are built) with its title
``{}`` (Nova's), ``""`` for each language (the save's) and holding text: the
first two build alike and the rule erases their difference; text is left.
"""

from __future__ import annotations

from proof.rules.conftest import assert_same_build, assert_spelled, edited, published, shown, stored_differences
from proof.rules.search_title_empty import RULE

DOCUMENT = "search-browse"
CONFIGURATION = "maximum"


def _title(text):
    def change(doc):
        config = doc["modules"][0]["search_config"]
        config["title_label"] = {} if text is None else {lang: text for lang in doc["langs"]}

    return edited(change)


def test_hq_builds_a_search_title_holding_no_text_as_none(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner, CONFIGURATION) as app:
        nova = app.spell(doc=_title(None))
        saved = app.spell(doc=_title(""))
        titled = app.spell(doc=_title("Find a patient"))

    assert_spelled(nova, saved, RULE, lambda path: "/search_config/title_label" in path)
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, titled.stored, rules=(RULE,)))
