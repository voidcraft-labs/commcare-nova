"""The rule ``condition-operator-default`` is sound: HQ builds a condition's null operator as ``=``.

Contract: the rule erases a form action condition's ``operator`` null, which
HQ's Case Management page writes on a condition that is not ``if``, against
``=``, the default a form HQ creates and Nova's export hold. The plausible
failures: HQ's build telling null from ``=`` where it reads the operator (an
``if`` condition), and the rule erasing another operator, which HQ builds
differently.

A corpus document whose form opens a case is published with that action's
condition made an ``if`` on one of the form's questions, its operator null,
``=`` and ``selected``: the first two build alike and the rule erases their
difference; ``selected`` builds another relevance, which the rule leaves.
"""

from __future__ import annotations

from proof.rules.condition_operator_default import RULE
from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    build_differences,
    edited,
    published,
    shown,
    stored_differences,
)

DOCUMENT = "nested-menu-registration-children"
# Its registration, the first form of its second menu, opens its own case and one child at the form's root.
MODULE, FORM = 1, 0


def _if_condition(operator):
    def change(doc):
        form = doc["modules"][MODULE]["forms"][FORM]
        condition = form["actions"]["open_case"]["condition"]
        question = form["actions"]["open_case"]["name_update"]["question_path"]
        condition.update(type="if", question=question, answer="proof", operator=operator)

    return edited(change)


def test_hq_builds_a_null_operator_as_equals(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=_if_condition(None))
        saved = app.spell(doc=_if_condition("="))
        selected = app.spell(doc=_if_condition("selected"))

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/condition/operator"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, selected.stored, rules=(RULE,)))
    assert build_differences(nova.build, selected.build), "HQ builds a selected() condition as an equality"


# Its visit menu's second and third forms are shared entries of the first, each with its own extra loads.
SHARED = "targeted-shared-visit-entries"


def _extra_close_operator(operator):
    def change(doc):
        for form in doc["modules"][0]["forms"]:
            for load in (form.get("extra_actions") or {}).get("load_update_cases") or []:
                load["close_condition"]["operator"] = operator

    return edited(change)


def test_hq_builds_a_shared_entrys_null_close_operator_as_equals(rule_documents, hq, core_runner):
    """A shared entry's extra loads, as HQ's advanced Case Management page saves them (each ``close_condition``'s
    operator null), build as Nova's ``=`` does: ``ShadowForm._merge_actions`` hands them to the same reader."""
    with published(rule_documents[SHARED], core_runner) as app:
        nova = app.spell(doc=_extra_close_operator("="))
        saved = app.spell(doc=_extra_close_operator(None))

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/close_condition/operator"))
    assert_same_build(nova, saved)
