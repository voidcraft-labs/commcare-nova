"""The rule ``open-action-blanks`` is sound: HQ builds an advanced open action's ``""`` blanks as null.

Contract: the rule erases an advanced open action's ``repeat_context`` ``""``
against null, and its open condition's ``question`` ``""`` against null where
the condition is not ``if``, as the advanced Case Management save writes
them. The plausible failures: the build telling ``""`` from null (so the save
would change the open actions' blocks), and the rule erasing a repeat context
or an ``if`` condition's question, which HQ builds into the block.

A corpus document whose advanced registration opens two cases outside a
repeat, one under an ``if`` condition and one always, is published with both
fields as Nova writes them (``""`` context, null question) and as the save
writes them (null context, ``""`` question): HQ builds both alike and the rule
erases the difference; the ``if`` condition's question made another question
builds another relevance, which the rule leaves.
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
from proof.rules.open_action_blanks import RULE

DOCUMENT = "targeted-advanced-module"
# Its Patients menu's registration: an open action under an ``if`` condition and one opened always, neither in a
# repeat.
MODULE, FORM = 1, 0


def _open_cases(doc):
    return doc["modules"][MODULE]["forms"][FORM]["actions"]["open_cases"]


def _saved_blanks(doc):
    """The open actions as the advanced save writes them: no repeat context, an empty question where not ``if``."""
    opened = _open_cases(doc)
    assert {action["open_condition"]["type"] for action in opened} >= {"if", "always"}, opened
    for action in opened:
        assert action["repeat_context"] == "", action
        action["repeat_context"] = None
        if action["open_condition"]["type"] != "if":
            action["open_condition"]["question"] = ""


def _other_if_question(doc):
    """The ``if`` condition's question made the always-opened action's name question."""
    opened = _open_cases(doc)
    conditioned = next(action for action in opened if action["open_condition"]["type"] == "if")
    always = next(action for action in opened if action["open_condition"]["type"] != "if")
    conditioned["open_condition"]["question"] = always["name_update"]["question_path"]


def test_hq_builds_blank_open_action_fields_as_null(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        saved = app.spell(doc=edited(_saved_blanks))
        other = app.spell(doc=edited(_other_if_question))

    assert_spelled(
        nova, saved, RULE, lambda path: path.endswith("/repeat_context") or path.endswith("/open_condition/question")
    )
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, other.stored, rules=(RULE,)))
    assert build_differences(nova.build, other.build), "HQ builds an if condition's question into the relevance"
