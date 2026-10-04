"""``type="xsd:string"`` on the bind of a select's node, which Core reads as a choice either way.

Nova types a select question's bind ``xsd:string``; Vellum's save writes no
type for a select (``Vellum/src/mugs/defaultOptions.js::getBindList`` writes
``mug.options.dataType``, which is empty for a select,
``mugs/types/select.js``). Core gives a
node the data type of its binds (``xsd:string`` is ``DATATYPE_TEXT``, no
type is ``DATATYPE_NULL``: commcare-core ``XFormParser.getDataType``,
``attachBind``), then turns every node a ``select1`` or ``select`` control
names from either of those into a choice or a choice list
(``applyControlProperties``), so the two read as one type.

The rule removes ``type="xsd:string"`` from a bind of a form HQ holds or
builds whose node set is the ``ref`` of a ``select1`` or ``select`` control
of the form's body. Any other type, and a string type on any other node,
stays.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._xforms import XFORMS, body, is_xform, model, tag

_BIND = tag(XFORMS, "bind")
_SELECTS = frozenset({tag(XFORMS, "select1"), tag(XFORMS, "select")})


def normalize(root):
    form_model = model(root) if is_xform(root) else None
    form_body = body(root) if form_model is not None else None
    if form_body is None:
        return root
    selected = {control.get("ref") for control in form_body.iter() if control.tag in _SELECTS}
    selected.discard(None)
    for bind in form_model.iter(_BIND):
        if bind.get("nodeset") in selected and bind.get("type") == "xsd:string":
            del bind.attrib["type"]
    return root


RULE = SpellingRule(
    "select-string-type",
    ("form:*", "*/form:*"),
    "xsd:string on a select's bind, which Core turns into a choice as it does an untyped one"
    " (XFormParser.applyControlProperties).",
    normalize,
)
