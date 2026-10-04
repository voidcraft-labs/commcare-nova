"""The rule ``sort-type-plain`` is sound: HQ builds a sort typed ``plain`` as one typed ``string``.

Contract: the rule erases a sort element's ``type`` ``plain`` against
``string``, as the Case List save names a text sort. The plausible
failures: HQ building them as two sort types (so the save would change the
order Core sorts in), and the rule erasing another type, which HQ builds
as that type.

A corpus document whose case list sorts by a calculated column is
published with its sort typed ``string`` (Nova's text spelling),
``plain`` (the save's) and ``int``: the first two build alike and the rule
erases their difference; ``int`` builds another sort type, which the rule
leaves.
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
from proof.rules.sort_type_plain import RULE

DOCUMENT = "expander-expanddoc-hq-json-projection-sort-elements-1e1c54c0-0"


def _sort_type(kind):
    def change(doc):
        for element in doc["modules"][0]["case_details"]["short"]["sort_elements"]:
            element["type"] = kind

    return edited(change)


def test_hq_builds_a_plain_sort_as_a_string_sort(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=_sort_type("string"))
        saved = app.spell(doc=_sort_type("plain"))
        numeric = app.spell(doc=_sort_type("int"))

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/sort_elements/*/type"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, numeric.stored, rules=(RULE,)))
    assert build_differences(nova.build, numeric.build), "HQ builds an int sort as a string sort"
