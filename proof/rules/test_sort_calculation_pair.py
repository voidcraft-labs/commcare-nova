"""The rule ``sort-calculation-pair`` is sound where it holds: a calculated column's sort by its own expression
sorts as HQ's ``$calculated_property`` does, and a column whose format sorts by its own expression builds alike
with any sort calculation.

Contract: the rule erases a sort element's ``sort_calculation`` on a
calculated column where it is the column's own expression and HQ's sort
without it is a sort by that expression, or where the column's format gives
its own sort, as the Case List save clears it without
``SORT_CALCULATION_IN_CASE_LIST``, and, in the suite, the
``$calculated_property`` spelling of such a sort. The conditions are the
rule's: another expression sorts otherwise, and so does HQ's sort without a
calculation on a ``late-flag`` column (its flag), on a column whose
expression names ``$lang`` (its variable holds a ``lang`` of its own) and
for a sort of type ``distance`` (its expression over the variable). The
plausible failures: Core ordering rows by the variable otherwise than by
the expression it holds, HQ reading the calculation on a column whose
format sorts by its own expression, and the rule erasing a calculation HQ
builds into another sort.

A document whose case list sorts by a calculated column is published with
its sort's calculation the column's expression (Nova's) and cleared (the
save's): HQ builds two suites the rule reads alike, and Core's sessions give
the same rows; a calculation of another expression gives other rows, and the
rule leaves it. As a ``late-flag`` column, with ``$lang`` in its expression,
and sorted as a distance, the column's sort builds otherwise with its
calculation set and cleared, and the rule leaves the stored calculation. A
document whose sorted column is a translatable enum builds alike with its
calculation set or cleared.
"""

from __future__ import annotations

from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    build_differences,
    edited,
    published,
    runs_alike,
    shown,
    stored_differences,
)
from proof.rules.sort_calculation_pair import RULE

PAIRED = "expander-expanddoc-hq-json-projection-sort-elements-1e1c54c0-0"
OWN_SORT = "expander-expanddoc-hq-json-projection-sort-elements-5899296f-0"


def _calculation(value_of, column_change=None, sort_type=None):
    """Each sort element's calculation ``value_of`` its column, after ``column_change`` made to the column and
    with the element's type ``sort_type``, where given."""

    def change(doc):
        detail = doc["modules"][0]["case_details"]["short"]
        for element in detail["sort_elements"]:
            column = detail["columns"][int(element["field"].rsplit("_", 1)[1])]
            if column_change is not None:
                column_change(column)
            if sort_type is not None:
                element["type"] = sort_type
            element["sort_calculation"] = value_of(column)

    return edited(change)


def _late_flag(column):
    column["format"] = "late-flag"
    column["late_flag"] = 30


def _with_lang(column):
    column["field"] = f"concat({column['field']}, $lang)"


# Where HQ's sort without a calculation is not a sort by the column's own expression: (column change, sort type).
SORTED_OTHERWISE = {"late-flag": (_late_flag, None), "lang": (_with_lang, None), "distance": (None, "distance")}


def test_a_sort_by_the_columns_own_expression_sorts_as_the_calculated_property(rule_documents, hq, core_runner):
    with published(rule_documents[PAIRED], core_runner) as app:
        nova = app.spell(doc=_calculation(lambda column: column["field"]))
        saved = app.spell(doc=_calculation(lambda column: ""))
        other = app.spell(doc=_calculation(lambda column: f"0 - number({column['field']})"))
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)
        _, _, reordered = runs_alike(app, core_runner, nova.build, other.build)
        otherwise = {
            name: (
                app.spell(doc=_calculation(lambda column: column["field"], column_change, sort_type)),
                app.spell(doc=_calculation(lambda column: "", column_change, sort_type)),
            )
            for name, (column_change, sort_type) in SORTED_OTHERWISE.items()
        }

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/sort_calculation"))
    assert shown(build_differences(nova.build, saved.build)), "HQ built the two spellings into one suite"
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert reordered, "another sort calculation sorts the rows alike: the case database orders nothing"
    assert build_differences(nova.build, other.build, rules=(RULE,))
    assert shown(stored_differences(nova.stored, other.stored, rules=(RULE,)))
    for name, (paired, cleared) in otherwise.items():
        assert all(spelled.build.files is not None and not spelled.build.raised for spelled in (paired, cleared)), name
        assert shown(build_differences(paired.build, cleared.build, rules=(RULE,))), name
        assert shown(stored_differences(paired.stored, cleared.stored, rules=(RULE,))), name


def test_a_column_that_sorts_by_its_own_expression_ignores_the_calculation(rule_documents, hq, core_runner):
    with published(rule_documents[OWN_SORT], core_runner) as app:
        nova = app.spell()
        assert nova.stored["doc"]["modules"][0]["case_details"]["short"]["sort_elements"][0]["sort_calculation"]
        saved = app.spell(doc=_calculation(lambda column: ""))

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/sort_calculation"))
    assert_same_build(nova, saved)
