"""The order of a form model's children, where Core reads no order: binds of distinct nodes, secondary instances,
and each kind's place among the others.

Vellum's save writes the model in its own order: the main instance, the
secondary instances in the order it holds them, the binds in the order of
its question tree, the setvalues, then the itext
(``Vellum/src/writer.js::createXForm``), where Nova writes them in the order
its emitter makes them. Core's parser reads the
model's children in one pass (commcare-core ``XFormParser.parseModel``):
the first ``<instance>`` is the main instance and the others are saved by
id, each ``<itext>`` is parsed where it stands, each ``<bind>`` is parsed in
document order, and every action (``setvalue``) is parsed after the whole
model, in document order. What the order of binds can change is which of
two binds naming one node applies last (``applyInstanceProperties``,
``attachBind``), and the order Core evaluates its triggerables in: it
orders them in layers by their dependencies, keeps each layer in the order
it parsed them (``FormDef.finalizeTriggerables``, ``buildRootNodes``,
``setOrderOfTriggerable``), and evaluates them in that order
(``evaluateTriggerables``). Triggerables of one layer read nothing another
of it sets, and a condition sets flags and no value (``Condition.apply``),
so their order shows only in random draws: Core draws every random value
from one source (``MathUtils.getRand``), and two triggerables that draw
take each other's values in the other order. The runner seeds that source;
it marks each id ``uuid()`` draws, and the trace comparison names an id by
the node it lands in (``proof/core`` ``Generated``,
``compare.trace.generated_labels``), and every ``uuid()`` draws the same
number of values (``PropertyUtils.genUUID``), so the order shows where a
triggerable calls ``random()`` or ``uuid()`` with an argument
(``PropertyUtils.genGUID``), whose values the trace keeps as drawn. The
order shows, too, in a bind expression Core refuses: it stops at the first
it refuses, in document order, and names it (``parseBind``,
``buildParseException``).
Actions keep their own relative order here: the order of same-event
setvalues is ``setvalue_order``'s.

The rule rewrites a model of a form HQ holds or builds in one canonical
order: the first instance, the other instances by ``id``, the binds (by
``nodeset`` where every bind's node set is a distinct path of plain steps,
``_xpath.plain_path``, the port of Core's lexer reads every expression of
every bind, and no triggerable calls ``random()`` or ``uuid()`` with an
argument, ``_xpath.calls``; else in their own order), the itext, then every
other child (the actions, and anything else) in its own order.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._xforms import (
    EXPRESSION_ATTRIBUTES,
    TRIGGERABLE_ATTRIBUTES,
    XFORMS,
    bind_expressions,
    is_element,
    is_xform,
    model,
    tag,
)
from proof.rules._xpath import calls, plain_path

_INSTANCE = tag(XFORMS, "instance")
_BIND = tag(XFORMS, "bind")
_ITEXT = tag(XFORMS, "itext")


def _reads_order(attribute, expression):
    """Whether Core may read the binds' order through one bind expression: one its lexer does not read (as the
    port tells), or a triggerable's that draws a value the trace keeps as drawn (the module's docstring)."""
    called = calls(expression)
    if called is None:
        return True
    draws = any(name == "random" or (name == "uuid" and argued) for name, argued in called)
    return draws and attribute in TRIGGERABLE_ATTRIBUTES


def normalize(root):
    form_model = model(root) if is_xform(root) else None
    if form_model is None:
        return root
    children = [child for child in form_model if is_element(child)]
    instances = [child for child in children if child.tag == _INSTANCE]
    binds = [child for child in children if child.tag == _BIND]
    itext = [child for child in children if child.tag == _ITEXT]
    others = [child for child in children if child.tag not in (_INSTANCE, _BIND, _ITEXT)]
    nodesets = [bind.get("nodeset") for bind in binds]
    distinct = all(plain_path(nodeset) for nodeset in nodesets) and len(set(nodesets)) == len(nodesets)
    expressions = bind_expressions(form_model, EXPRESSION_ATTRIBUTES)
    if distinct and not any(_reads_order(attribute, expression) for _, attribute, expression in expressions):
        binds = sorted(binds, key=lambda bind: bind.get("nodeset"))
    ordered = instances[:1] + sorted(instances[1:], key=lambda i: (i.get("id") or "", i.get("src") or "")) + binds
    for child in ordered + itext + others:
        form_model.append(child)
    return root


RULE = SpellingRule(
    "model-order",
    ("form:*", "*/form:*"),
    "The order of a model's binds of distinct nodes, where Core reads every expression and no triggerable draws"
    " a value the trace keeps, its secondary instances, and each kind among the others, none of which Core reads"
    " (XFormParser.parseModel).",
    normalize,
)
