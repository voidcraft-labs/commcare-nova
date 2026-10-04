"""Vellum's ``requiredCondition`` on a bind, an attribute neither HQ nor Core reads.

Vellum's save writes a question's conditional requirement a second time on
its bind as ``requiredCondition``, beside a ``required`` holding the same
expression (``Vellum/src/mugs/defaultOptions.js::getBindList``; its parser
reads a ``required`` that is neither ``true()`` nor ``false()`` back as
that condition, ``parser.js::parseBindElement``). Core parses a bind's
``required`` and no ``requiredCondition`` (commcare-core
``XFormParser.processStandardBindAttributes`` names the attributes it reads;
any other is only reported as unused markup), and no module of HQ's Python
reads it, so HQ builds it through as it is.

The rule removes ``requiredCondition`` (no namespace) from every bind of a
form HQ holds or builds.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._xforms import XFORMS, is_xform, model, tag

_BIND = tag(XFORMS, "bind")


def normalize(root):
    form_model = model(root) if is_xform(root) else None
    if form_model is None:
        return root
    for bind in form_model.iter(_BIND):
        bind.attrib.pop("requiredCondition", None)
    return root


RULE = SpellingRule(
    "required-condition",
    ("form:*", "*/form:*"),
    "Vellum's requiredCondition on a bind, which Core does not parse (XFormParser.processStandardBindAttributes).",
    normalize,
)
