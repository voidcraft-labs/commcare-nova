"""A bind that names a node and says nothing about it, where no other bind names that node.

Vellum's save writes a bind for every question, group and repeat it holds,
with its node set alone where nothing else is set
(``Vellum/src/writer.js::createBindList`` writes each attribute
``mugs/defaultOptions.js::getBindList`` gives a value), so groups, repeats and Nova's case blocks gain
``<bind nodeset="..."/>``. Core applies a bind to each node it names by
setting the node's data type, relevance, requirement, read-only state and
preload from it, in document order (commcare-core
``XFormParser.applyInstanceProperties``, ``attachBind``), and a bind with its
node set alone sets each to the node's own default: no data type
(``getDataType(null)`` is ``DATATYPE_NULL``, ``TreeElement.dataType``'s
default), relevant, not required, enabled, and no preload (``DataBinding``'s
defaults), adding no condition or calculation (``attachBindGeneral``). So
such a bind changes nothing on a node no other bind names; on a node another
bind names, it would undo that bind's settings when it comes after it.

The rule removes a bind of a form HQ holds or builds whose only attribute
outside Vellum's namespace is ``nodeset``, where that node set no other bind
of the model names and every bind's node set is a path of plain steps
(``_xpath.plain_path``), so that no other spelling can name the same node.
"""

from __future__ import annotations

from collections import Counter

from proof.rules import SpellingRule
from proof.rules._xforms import XFORMS, is_xform, model, own_attributes, tag
from proof.rules._xpath import plain_path

_BIND = tag(XFORMS, "bind")


def normalize(root):
    form_model = model(root) if is_xform(root) else None
    if form_model is None:
        return root
    binds = [child for child in form_model if child.tag == _BIND]
    if not all(plain_path(bind.get("nodeset")) for bind in binds):
        return root
    named = Counter(bind.get("nodeset") for bind in binds)
    for bind in binds:
        if set(own_attributes(bind)) == {"nodeset"} and named[bind.get("nodeset")] == 1:
            form_model.remove(bind)
    return root


RULE = SpellingRule(
    "empty-binds",
    ("form:*", "*/form:*"),
    "A bind with its node set alone on a node no other bind names, which Core applies as the node's defaults"
    " (XFormParser.attachBind).",
    normalize,
)
