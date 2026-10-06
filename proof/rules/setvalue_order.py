"""The order within a run of one event's setvalues that each set a node of their own to a value that reads no node.

Vellum's save writes a form's setvalues in its own order
(``Vellum/src/writer.js::createSetValues``), where Nova writes them in its
emitter's, and HQ's build adds its own after the form's (the case preloads
and the metadata, ``xform.py::XForm.add_case_preloads``, ``_add_meta_2``).
Core registers every action of the model (``setvalue``, ``send``) on its
event in document order and runs an event's actions in that order
(commcare-core ``XFormParser.parseModel`` parses actions after the whole
model; ``ActionController.triggerActionsFromEvent`` runs an event's
listeners in the order they were registered). A setvalue sets its node and
at once evaluates every triggerable that reads the node, and each that
reads what those set (``SetValueAction.processAction``,
``FormDef.setValue``, ``FormDef.triggerTriggerables``).

A value that is ``now()``, ``today()``, ``uuid()``, a literal, or
``format-date(now() or today(), literal pattern)`` reads no node:
``XPathFormatDateFunc.evalBody`` formats its already evaluated arguments,
without reading the model or context. Each setvalue of such a run sets its node to the same value in
any order, and every triggerable the run sets off is evaluated last after
the last of the run's nodes it reads, at any remove, is set, so it reads
each at the value the run leaves; a condition (``relevant``,
``required``, ``readonly``) sets flags and no value (``Condition.apply``).
Four things can still tell the run's order, and the rule leaves each:

- a calculate whose node the run also sets: it writes the node whenever a
  node it reads is set, so the later of the two writes holds. Only
  ``xforms-ready`` evaluates every triggerable again after the actions
  (``FormDef.initialize``: ``initAllTriggerables``); ``jr-insert`` skips the
  ones its actions triggered (``FormDef.createNewRepeat``,
  ``processResultOfAction``, ``initTriggerablesRootedBy``) and
  ``xforms-revalidate`` evaluates none (``FormDef.postProcessInstance``).
  The rule leaves this for every event alike;
- a random draw: Core draws every random value from one source
  (``MathUtils.getRand``), so triggerables the run sets off in another
  order draw one another's values, and one whose draws depend on what it
  reads (a ``uuid()`` under an ``if``) can draw another number of them, so
  every later draw differs. A triggerable that reads no node is never set
  off by a setvalue (``FormDef.addTriggerable`` indexes a triggerable by
  the nodes it reads), so the draws of a ``uuid()`` calculate, as HQ's
  build writes a delayed case id, wait for the form's own evaluation
  (``initAllTriggerables``, ``initTriggerablesRootedBy``) in either order.
  The ids the run's own ``uuid()`` values draw land in its nodes in its
  order; each draws the same number of values (``PropertyUtils.genUUID``),
  and the runner marks each id and the trace comparison names it by the
  node it lands in (``proof/core`` ``Generated``,
  ``compare.trace.generated_labels``), as no reader can tell one random id
  from another;
- another action of the event between two of the run's setvalues: a
  ``send`` reads the instance (``SendAction.processAction``);
- a setvalue naming its node by ``bind``, which Core reads in place of its
  ``ref`` (``XFormParser.parseSetValueAction``).

The rule sorts by ``ref`` each maximal run of an event's consecutive
actions that are setvalues whose value reads no node as Core's lexer reads
it (``_xpath.node_free``), whose ``ref`` is a path of plain steps
(``_xpath.plain_path``) that no other of the run and no calculate's bind
names, and that name no ``bind``. It sorts none in a model where a
calculate's node set is not a path of plain steps (its node could be any
the run sets), or where a triggerable may draw (``_xpath.calls`` finds
``random`` or ``uuid`` in it, or cannot read it) and is not itself a value
that reads no node (``_xpath.node_free``: ``uuid()`` alone, which no
setvalue sets off). Each setvalue keeps its place among the model's other
children, and every other action of the event keeps its place before or
after the run.
"""

from __future__ import annotations

import copy

from proof.rules import SpellingRule
from proof.rules._xforms import XFORMS, bind_expressions, is_element, is_xform, model, tag
from proof.rules._xpath import calls, node_free, plain_path

_SETVALUE = tag(XFORMS, "setvalue")
# The functions that draw from Core's random source (``XPathRandomFunc``, ``XPathUuidFunc``).
_DRAWING = frozenset({"random", "uuid"})


def _orderable(form_model):
    """Whether the model's triggerables leave a run's order unread (the module's docstring), and the nodes its
    calculates set: ``(orderable, calculated)``."""
    calculated = set()
    for bind, attribute, expression in bind_expressions(form_model):
        if attribute == "calculate":
            if not plain_path(bind.get("nodeset")):
                return False, calculated
            calculated.add(bind.get("nodeset"))
        called = calls(expression)
        if (called is None or any(name in _DRAWING for name, _ in called)) and not node_free(expression):
            return False, calculated
    return True, calculated


def _runs(actions, calculated):
    """The maximal runs of an event's consecutive actions that may take any order among themselves."""

    def joins(action):
        return (
            action.tag == _SETVALUE
            and len(action) == 0
            and action.get("bind") is None
            and node_free(action.get("value"))
            and plain_path(action.get("ref"))
            and action.get("ref") not in calculated
        )

    run = []
    for action in actions:
        if joins(action) and action.get("ref") not in {held.get("ref") for held in run}:
            run.append(action)
            continue
        yield run
        run = [action] if joins(action) else []
    yield run


def normalize(root):
    form_model = model(root) if is_xform(root) else None
    if form_model is None:
        return root
    orderable, calculated = _orderable(form_model)
    if not orderable:
        return root
    by_event = {}
    for action in form_model:
        if is_element(action) and action.get("event") is not None:
            by_event.setdefault(action.get("event"), []).append(action)
    for actions in by_event.values():
        for run in list(_runs(actions, calculated)):
            if len(run) < 2:
                continue
            ordered = [copy.deepcopy(setvalue) for setvalue in sorted(run, key=lambda s: s.get("ref"))]
            for held, placed in zip(run, ordered, strict=True):
                form_model.replace(held, placed)
    return root


RULE = SpellingRule(
    "setvalue-order",
    ("form:*", "*/form:*"),
    "The order within a run of one event's setvalues of distinct nodes whose values read no node, where no"
    " calculate sets those nodes and no triggerable they set off draws, which Core runs alike in any order"
    " (ActionController.triggerActionsFromEvent).",
    normalize,
)
