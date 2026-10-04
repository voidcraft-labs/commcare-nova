"""The rule ``preload-condition`` is sound: HQ builds a preload action alike under ``never`` and ``always``.

Contract: the rule erases a preload action's condition ``always`` against
``never``, as the Case Management save writes the update action's
condition for it. The plausible failures: the build reading the condition
(so the save would change which preloads are built), and the rule erasing
another condition type.

A corpus document whose follow-up form preloads case properties is
published with the preload's condition ``never`` (Nova's) and ``always``
(the save's): HQ builds both alike and the rule erases the difference. The
rule leaves an ``if`` condition.
"""

from __future__ import annotations

from proof.rules.conftest import assert_same_build, assert_spelled, edited, published
from proof.rules.preload_condition import RULE, normalize

DOCUMENT = "case-operation-sequence"


def _condition(kind):
    def change(doc):
        preload = doc["modules"][0]["forms"][0]["actions"]["case_preload"]
        assert preload["preload"], "the form preloads nothing"
        preload["condition"]["type"] = kind

    return edited(change)


def test_hq_builds_a_preload_alike_under_never_and_always(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=_condition("never"))
        saved = app.spell(doc=_condition("always"))

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/case_preload/condition/type"))
    assert_same_build(nova, saved)


def test_an_if_condition_is_left():
    condition = {"type": "if", "question": "/data/q", "answer": "yes"}
    doc = {"modules": [{"forms": [{"actions": {"case_preload": {"preload": {}, "condition": dict(condition)}}}]}]}
    assert normalize(doc)["modules"][0]["forms"][0]["actions"]["case_preload"]["condition"] == condition
