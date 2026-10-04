"""The rule ``model-order`` is sound: Core runs a form alike whatever the order of its model's binds of distinct
nodes, its secondary instances, and each kind among the others.

Contract: the rule erases the order of a model's children where Core reads
none, as Vellum's save writes its model in its own order. HQ's build
carries the order, so the proof is Core's. The plausible failures: Core
reading a bind's or a secondary instance's place (so a save would change
the form), the rule moving the main instance (the first, which Core reads
as the form's data), the rule reordering two binds of one node, the later
of which wins, and the rule reordering the binds of triggerables that draw
a random value the trace keeps, which Core evaluates in their order.

A corpus document with several secondary instances, many binds and
setvalues is published as Nova writes it and with its binds reversed, its
secondary instances reversed and every setvalue moved before the binds:
HQ's builds differ by that order alone, which the rule erases, and Core's
sessions compare equal. With a second bind naming a typed question's node,
holding its node set alone, written after the question's own bind and
before it, Core reads the question untyped in the first and typed in the
second, and the rule keeps the two binds' order. With two nodes calculated
by ``random()`` and ``1 + random()``, their binds written in one order and
the other, Core's seeded draws land in the other node, and the rule keeps
the binds' order. On the parsed form, the rule keeps the order of binds
holding an expression Core's lexer refuses, and sorts binds drawing
``uuid()`` ids, which the trace names by the node they land in.
"""

from __future__ import annotations

from lxml import etree

from proof.rules.conftest import build_differences, published, rewritten, runs_alike, shown
from proof.rules.model_order import RULE, normalize

DOCUMENT = "case-operation-sequence"
XF = "{http://www.w3.org/2002/xforms}"
HEAD = "{http://www.w3.org/1999/xhtml}head"


def _reordered(root):
    model = root.find(HEAD).find(f"{XF}model")
    instances = model.findall(f"{XF}instance")
    binds = model.findall(f"{XF}bind")
    setvalues = model.findall(f"{XF}setvalue")
    assert len(instances) > 2 and len(binds) > 1 and setvalues, "the model has too little to reorder"
    for element in [*reversed(instances[1:]), *setvalues, *reversed(binds)]:
        model.append(element)


def _second_bind(before):
    """A bind holding its node set alone for a typed question's node, written after its own bind or ``before``."""

    def change(root):
        model = root.find(HEAD).find(f"{XF}model")
        typed = next(bind for bind in model.iter(f"{XF}bind") if bind.get("type") == "xsd:string")
        second = etree.Element(f"{XF}bind", nodeset=typed.get("nodeset"))
        if before:
            typed.addprevious(second)
        else:
            typed.addnext(second)

    return change


DRAWN = ("proof_first_draw", "proof_second_draw")


def _drawing(reversed_binds):
    """Two nodes of the form's data calculated by ``random()`` and ``1 + random()``, their binds written in that
    order or the other."""

    def change(root):
        model = root.find(HEAD).find(f"{XF}model")
        data = model.find(f"{XF}instance")[0]
        binds = []
        for name, calculate in zip(DRAWN, ("random()", "1 + random()"), strict=True):
            etree.SubElement(data, etree.QName(data, name).text)
            path = f"/{etree.QName(data).localname}/{name}"
            binds.append(etree.Element(f"{XF}bind", nodeset=path, calculate=calculate))
        last = model.findall(f"{XF}bind")[-1]
        for bind in binds if reversed_binds else binds[::-1]:
            last.addnext(bind)

    return change


def test_core_runs_a_form_alike_whatever_its_models_order(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_reordered)})
        last = app.spell(sources={"0.0": rewritten(_second_bind(before=False))})
        first = app.spell(sources={"0.0": rewritten(_second_bind(before=True))})
        drawn = app.spell(sources={"0.0": rewritten(_drawing(reversed_binds=False))})
        drawn_reversed = app.spell(sources={"0.0": rewritten(_drawing(reversed_binds=True))})
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)
        _, _, retyped = runs_alike(app, core_runner, last.build, first.build)
        _, _, redrawn = runs_alike(app, core_runner, drawn.build, drawn_reversed.build)

    built = shown(build_differences(nova.build, saved.build))
    assert built and all(path.endswith("/order()") for _, path, _ in built), built
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert any(path.endswith("/dataType") for _, path, _ in shown(retyped)), shown(retyped)
    assert build_differences(last.build, first.build, rules=(RULE,))
    # Core evaluates the two calculates in their binds' order, each taking the other's draw in the other order.
    submitted = {name for d in redrawn if "/submission/" in d.at for name in DRAWN if name in d.at}
    assert submitted == set(DRAWN), [(d.at, d.before, d.after) for d in redrawn]
    assert build_differences(drawn.build, drawn_reversed.build, rules=(RULE,))


def test_two_binds_of_one_node_keep_their_order():
    form = etree.fromstring(
        '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model>'
        '<instance><data/></instance><bind nodeset="/data/b" type="xsd:int"/><bind nodeset="/data/a"/>'
        '<bind nodeset="/data/a" type="xsd:string"/></model></h:head></h:html>'
    )
    order = [(b.get("nodeset"), b.get("type")) for b in normalize(form).iter(f"{XF}bind")]
    assert order == [("/data/b", "xsd:int"), ("/data/a", None), ("/data/a", "xsd:string")]


def test_binds_whose_order_core_may_read_keep_it():
    def binds(attribute, expression):
        form = etree.fromstring(
            '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model>'
            f'<instance><data/></instance><bind nodeset="/data/b" {attribute}="{expression}"/>'
            '<bind nodeset="/data/a"/></model></h:head></h:html>'
        )
        return [bind.get("nodeset") for bind in normalize(form).iter(f"{XF}bind")]

    # A triggerable drawing a value the trace keeps as drawn.
    assert binds("calculate", "random()") == ["/data/b", "/data/a"]
    assert binds("relevant", "uuid(8) = 'x'") == ["/data/b", "/data/a"]
    # An expression Core's lexer refuses, or that the port does not read.
    assert binds("constraint", "#form/a = 1") == ["/data/b", "/data/a"]
    assert binds("calculate", "/data/é") == ["/data/b", "/data/a"]
    # A draw the trace names by its node, a draw outside a triggerable, and no draw.
    assert binds("calculate", "uuid()") == ["/data/a", "/data/b"]
    assert binds("constraint", "random() &lt; 1") == ["/data/a", "/data/b"]
    assert binds("calculate", "concat(/data/a, 'random')") == ["/data/a", "/data/b"]
