"""The rule ``itext-value-order`` is sound: Core runs a form alike whatever the order of a text's values.

Contract: the rule erases the order of a ``<text>``'s ``<value>`` forms,
which Vellum's save writes in its own order. HQ's build carries the order,
so the proof is Core's: the plausible failures are Core reading a value by
its place (so a save would change what a question shows), and the rule
erasing a changed value.

A corpus document is published as Nova writes it and with every text's
values reversed: HQ's builds differ by that order alone, which the rule
erases, and Core's sessions, which record each question's texts, compare
equal. A changed label is left.
"""

from __future__ import annotations

from proof.rules.conftest import build_differences, published, rewritten, runs_alike, shown, stored_differences
from proof.rules.itext_value_order import RULE

DOCUMENT = "arithmetic"
XF = "{http://www.w3.org/2002/xforms}"


def _reversed_values(root):
    texts = [text for text in root.iter(f"{XF}text") if len(text) > 1]
    assert texts, "no text of the form has more than one value"
    for text in texts:
        for value in reversed(list(text)):
            text.append(value)


def _relabelled(root):
    value = next(root.iter(f"{XF}value"))
    value.text = f"{value.text or ''} changed"


def test_core_runs_a_form_alike_whatever_the_order_of_its_values(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_reversed_values)})
        relabelled = app.spell(sources={"0.0": rewritten(_relabelled)})
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)

    built = shown(build_differences(nova.build, saved.build))
    assert built and all(path.endswith("/order()") for _, path, _ in built), built
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert shown(stored_differences(nova.stored, relabelled.stored, rules=(RULE,)))
