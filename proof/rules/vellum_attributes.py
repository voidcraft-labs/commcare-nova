"""Attributes in Vellum's namespace, which HQ removes from a form before it builds it.

Vellum's save writes each expression it edits a second time in its own
namespace (``vellum:ref``, ``vellum:nodeset``, ``vellum:calculate``,
``vellum:relevant``, ``vellum:required`` and the rest, with hashtags in place
of paths: ``Vellum/src/writer.js::createBindList`` and ``createControlBlock``
through ``util.writeHashtags``), and a second
save writes its first save's ``vellum:required`` again under another prefix
(``vellum:vellum__required``: ``parser.js::parseBindElement`` keeps every
attribute it does not read). HQ's build removes every attribute in Vellum's
namespace from every element of the form before anything else reads it
(``models/forms.py::FormBase.add_stuff_to_xform`` calls
``xform.py::XForm.strip_vellum_ns_attributes``), so the forms it builds, and
so what Core runs, are the same whatever those attributes say.

The rule removes every attribute in Vellum's namespace from a form HQ holds
or builds: a stored form's source and a built form (``form:<m>.<f>``, and a
build profile's ``<profile id>/form:<m>.<f>``). Nova's own local archive is
not HQ's to strip and is left as it is.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._xforms import VELLUM, is_xform

_PREFIX = f"{{{VELLUM}}}"


def normalize(root):
    if not is_xform(root):
        return root
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        for key in [key for key in element.attrib if key.startswith(_PREFIX)]:
            del element.attrib[key]
    return root


RULE = SpellingRule(
    "vellum-attributes",
    ("form:*", "*/form:*"),
    "An attribute in Vellum's namespace, which HQ removes before it builds"
    " (xform.py::XForm.strip_vellum_ns_attributes).",
    normalize,
)
