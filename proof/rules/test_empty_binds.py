"""The rule ``empty-binds`` is sound where it holds: Core runs a form alike with or without a bind naming only a
node no other bind names.

Contract: the rule erases a bind whose only attribute (outside Vellum's
namespace) is its ``nodeset``, where no other bind names that node, as
Vellum's save writes one for every group, repeat and case block part. HQ's
build carries the binds, so the proof is Core's. The condition is the
rule's: a bind with its node set alone after another bind of the same node
resets that node's data type and settings to Core's defaults. The plausible
failures: Core applying an empty bind as something other than its defaults
(so a save would change the form), and the rule erasing such a bind beside
another of the same node.

A corpus document with groups, a repeat and case blocks is published as
Nova writes it and with an empty bind for every element of its data that
none names: HQ's builds differ by those binds alone, which the rule erases,
and Core's sessions compare equal. An empty bind written after a typed
question's own bind makes Core read that question as untyped, and the rule
leaves it.
"""

from __future__ import annotations

from lxml import etree

from proof.rules.conftest import build_differences, published, rewritten, runs_alike, shown
from proof.rules.empty_binds import RULE

DOCUMENT = "case-capture-repeat"
XF = "{http://www.w3.org/2002/xforms}"
HEAD = "{http://www.w3.org/1999/xhtml}head"


def _paths(element, prefix, namespace):
    """Each element of the form's own data under ``element``, by its path; case blocks and other namespaces'
    elements, which HQ's build binds itself, are left out."""
    for child in element:
        if isinstance(child.tag, str) and etree.QName(child).namespace == namespace:
            path = f"{prefix}/{etree.QName(child).localname}"
            yield path
            yield from _paths(child, path, namespace)


def _with_empty_binds(root):
    model = root.find(HEAD).find(f"{XF}model")
    data = model.find(f"{XF}instance")[0]
    named = {bind.get("nodeset") for bind in model.iter(f"{XF}bind")}
    added = 0
    for path in _paths(data, f"/{etree.QName(data).localname}", etree.QName(data).namespace):
        if path not in named:
            etree.SubElement(model, f"{XF}bind", nodeset=path)
            named.add(path)
            added += 1
    assert added, "every element of the form's data has a bind already"


def _after_a_typed_bind(root):
    model = root.find(HEAD).find(f"{XF}model")
    typed = next(bind for bind in model.iter(f"{XF}bind") if bind.get("type") == "xsd:string")
    typed.addnext(etree.Element(f"{XF}bind", nodeset=typed.get("nodeset")))


def test_core_runs_a_form_alike_with_empty_binds_on_unbound_nodes(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_with_empty_binds)})
        reset = app.spell(sources={"0.0": rewritten(_after_a_typed_bind)})
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)
        _, _, untyped = runs_alike(app, core_runner, nova.build, reset.build)

    built = shown(build_differences(nova.build, saved.build))
    assert built and all("/bind[@nodeset=" in path and path.endswith("]") for _, path, _ in built), built
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert any(path.endswith("/dataType") for _, path, _ in shown(untyped)), shown(untyped)
    assert build_differences(nova.build, reset.build, rules=(RULE,))
