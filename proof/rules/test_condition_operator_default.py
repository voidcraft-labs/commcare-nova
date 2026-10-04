"""The rule ``condition-operator-default`` is sound: HQ builds a condition's null operator as ``=``.

Contract: the rule erases a form action condition's ``operator`` null
against ``=``, as the Case Management and user properties saves write the
default. The plausible failures: HQ's build telling null from ``=`` where it
reads the operator (an ``if`` condition), and the rule erasing another
operator, which HQ builds differently.

A corpus document whose form opens a case is published with that action's
condition made an ``if`` on one of the form's questions, its operator null
(Nova's), ``=`` (the saves') and ``selected``: the first two build alike and
the rule erases their difference; ``selected`` builds another relevance,
which the rule leaves.
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

DOCUMENT = "case-extension-registration"


def _if_condition(operator):
    def change(doc):
        form = doc["modules"][0]["forms"][0]
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
