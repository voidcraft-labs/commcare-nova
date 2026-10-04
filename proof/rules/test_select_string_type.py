"""The rule ``select-string-type`` is sound where it holds: Core reads a select's node as a choice with or without
``xsd:string``, and reads a text question's type from its bind.

Contract: the rule erases ``type="xsd:string"`` on the bind of a node a
``select1`` or ``select`` names, which Vellum's save leaves untyped. The
condition is the rule's: on any other node Core reads the type. The
plausible failures: Core giving the select's node another type for either
spelling (so a save would change how answers are read and serialized), and
the rule erasing a text question's type.

A corpus document with a select question and a text question is published
as Nova writes it, with the select's type taken out (the save's), and with
the text question's type taken out: the first two build forms the rule
reads alike, and Core's sessions, which record each question's data type,
compare equal; the text question's untyped node is another data type to
Core, and the rule leaves it.
"""

from __future__ import annotations

from proof.rules.conftest import build_differences, published, rewritten, runs_alike, shown
from proof.rules.select_string_type import RULE

DOCUMENT = "expander-conditional-required-generates-required-xpath-ae4797f7-0"
XF = "{http://www.w3.org/2002/xforms}"


def _untyped(control):
    def change(root):
        refs = {element.get("ref") for element in root.iter(f"{XF}{control}")}
        binds = [bind for bind in root.iter(f"{XF}bind") if bind.get("nodeset") in refs]
        assert binds and all(bind.get("type") == "xsd:string" for bind in binds), [b.attrib for b in binds]
        for bind in binds:
            del bind.attrib["type"]

    return change


def test_core_reads_a_selects_node_alike_with_or_without_a_string_type(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_untyped("select1"))})
        text = app.spell(sources={"0.0": rewritten(_untyped("input"))})
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)
        _, _, retyped = runs_alike(app, core_runner, nova.build, text.build)

    built = shown(build_differences(nova.build, saved.build))
    assert built and all(path.endswith("/@type") for _, path, _ in built), built
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert any(path.endswith("/dataType") for _, path, _ in shown(retyped)), shown(retyped)
    assert build_differences(nova.build, text.build, rules=(RULE,))
