"""The rule ``required-condition`` is sound: Core runs a form alike with or without Vellum's ``requiredCondition``.

Contract: the rule erases a bind's ``requiredCondition``, which Vellum's save
writes beside a conditional ``required``. HQ's build carries it, so the
proof is Core's: the plausible failures are Core reading it (so a save would
change which questions are required) and the rule erasing ``required``.

A corpus document whose form requires a question on a condition is
published as Nova writes it and with ``requiredCondition`` holding the
condition beside ``required``: HQ's builds differ by that attribute alone,
which the rule erases, and Core's sessions, which record whether each
question is required, compare equal. A changed ``required`` is left.
"""

from __future__ import annotations

from proof.rules.conftest import build_differences, published, rewritten, runs_alike, shown, stored_differences
from proof.rules.required_condition import RULE

DOCUMENT = "expander-conditional-required-generates-required-xpath-ae4797f7-0"
BIND = "{http://www.w3.org/2002/xforms}bind"


def _conditional(root):
    return [bind for bind in root.iter(BIND) if bind.get("required") not in (None, "true()", "false()")]


def _with_required_condition(root):
    binds = _conditional(root)
    assert binds, "the form requires no question on a condition"
    for bind in binds:
        bind.set("requiredCondition", bind.get("required"))


def _required_always(root):
    for bind in _conditional(root):
        bind.set("required", "true()")


def test_core_runs_a_form_alike_with_vellums_required_condition(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_with_required_condition)})
        always = app.spell(sources={"0.0": rewritten(_required_always)})
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)

    built = shown(build_differences(nova.build, saved.build))
    assert built and all(path.endswith("/@requiredCondition") for _, path, _ in built), built
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert stored_differences(nova.stored, saved.stored, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert shown(stored_differences(nova.stored, always.stored, rules=(RULE,)))
