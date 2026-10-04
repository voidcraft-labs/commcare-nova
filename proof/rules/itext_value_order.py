"""The order of a translation's ``<value>`` forms within one ``<text>``, which Core reads by form.

Vellum's save writes a text's values in its own order of forms (the default
form, then ``markdown``, ``image``, ``audio`` and the rest as it holds them),
which need not be Nova's. Core reads each value of a ``<text>`` into its
localizer under the text's id and the value's ``form`` (``<id>;<form>``, or
the id alone for the default form), and refuses a text that gives one form
twice (commcare-core ``XFormParser.parseTextHandle``), so a text is a map
from form to value and the order of its values is read by nothing.

The rule sorts the values of each ``<text>`` of a form HQ holds or builds by
their ``form`` (the default form first), where no form appears twice.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._xforms import XFORMS, is_xform, model, tag

_TEXT = tag(XFORMS, "text")
_VALUE = tag(XFORMS, "value")


def _form_of(value):
    return value.get("form") or ""


def normalize(root):
    form_model = model(root) if is_xform(root) else None
    if form_model is None:
        return root
    for text in form_model.iter(_TEXT):
        values = [child for child in text if child.tag == _VALUE]
        forms = [_form_of(value) for value in values]
        if len(set(forms)) != len(forms) or forms == sorted(forms):
            continue
        for value in sorted(values, key=_form_of):
            text.append(value)
    return root


RULE = SpellingRule(
    "itext-value-order",
    ("form:*", "*/form:*"),
    "The order of a text's values by form, which Core reads as a map (XFormParser.parseTextHandle).",
    normalize,
)
