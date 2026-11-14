"""The rule ``close-question-blank`` is sound: HQ builds a close condition's ``question`` ``""`` as null.

Contract: the rule erases the ``question`` ``""`` against null of an
advanced load's or open action's close condition that is not ``if``, as the
advanced Case Management save writes it on a condition the page shows. The
plausible failures: HQ's build telling ``""`` from null (so the save would
change the actions' blocks), and the rule erasing an ``if`` condition's
question, which HQ builds into the close.

A corpus document whose advanced follow-up loads two cases and opens one is
published with a load and the open action closing their cases always,
their close conditions' questions as Nova writes them (null) and as the
save writes them (``""``): HQ builds both alike and the rule erases the
difference; the other load's ``if`` close condition's question made another
question builds another close, which the rule leaves.
"""

from __future__ import annotations

from proof.rules.close_question_blank import RULE
from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    build_differences,
    edited,
    published,
    shown,
    stored_differences,
)

DOCUMENT = "targeted-advanced-module"
# Its Patients menu's visit: the household loaded and closed under an ``if`` condition, the patient loaded and
# a visit opened, neither closed.
MODULE, FORM = 1, 1


def _actions(doc):
    return doc["modules"][MODULE]["forms"][FORM]["actions"]


def _closed_always(question):
    """The patient's load and the first open action closing their cases always, each close's question
    ``question``."""

    def change(doc):
        actions = _actions(doc)
        never = [
            action
            for action in (actions["load_update_cases"][1], actions["open_cases"][0])
            if action["close_condition"]["type"] == "never"
        ]
        assert len(never) == 2, actions
        for action in never:
            action["close_condition"].update(type="always", question=question)

    return edited(change)


def _other_if_question(doc):
    """The household's ``if`` close condition's question made the opened visit's name question."""
    _closed_always(None)(doc)
    actions = _actions(doc)
    conditioned = actions["load_update_cases"][0]["close_condition"]
    assert conditioned["type"] == "if", conditioned
    conditioned["question"] = actions["open_cases"][0]["name_update"]["question_path"]
    return doc


def test_hq_builds_a_blank_close_question_as_none(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=_closed_always(None))
        saved = app.spell(doc=_closed_always(""))
        other = app.spell(doc=_other_if_question)

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/close_condition/question"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, other.stored, rules=(RULE,)))
    assert build_differences(nova.build, other.build), "HQ builds an if condition's question into the close"
