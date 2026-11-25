"""A lookup table's ``item-list:`` instance declaration in a form whose text reads that instance.

HQ's form builder drops the declaration of an instance whose reads its own
XPath reader cannot lex (js-xpath, whose names are unaccented letters, digits,
``_``, ``.`` and ``-``): a select over a table tagged ``ζωνες`` reads
``instance('item-list:ζωνες')/ζωνες_list/ζωνες``, and a save there leaves
the form with that read and no ``<instance id="item-list:ζωνες">``. HQ's
build declares every instance a form's text reads that it lacks, where the id
names a scheme HQ knows (commcare-hq ``xform.py::XForm.add_missing_instances``
over ``suite_xml/post_process/instances.py::get_all_instances_referenced_in_xpaths``,
whose ``item-list`` factory gives ``jr://fixture/item-list:<tag>``). It finds
those reads with its own pattern over the form's text (``instance_re``), so
the rule finds them with the same pattern.

The rule removes, from a form HQ holds or builds, each declaration whose id is
``item-list:<tag>`` and whose ``src`` is ``jr://fixture/item-list:<tag>``,
where the form's text reads ``instance('item-list:<tag>')`` as HQ's pattern
finds it, and the declaration holds nothing: HQ's build writes exactly that
declaration again. A declaration of any other id, or one the text does not
read, is left, since HQ's build would not write it again.
"""

from __future__ import annotations

import re

from lxml import etree

from proof.rules import SpellingRule
from proof.rules._xforms import XFORMS, is_xform, model, tag

_INSTANCE = tag(XFORMS, "instance")
# HQ's own pattern for an instance a form's text reads (``suite_xml/post_process/instances.py::instance_re``).
_READ = re.compile(r"""instance\(\s*['"]([\w\-:]+)['"]\s*\)""", re.UNICODE)
_PREFIX = "item-list:"


def normalize(root):
    form_model = model(root) if is_xform(root) else None
    if form_model is None:
        return root
    declarations = [child for child in form_model if child.tag == _INSTANCE and child.get("id")]
    if not declarations:
        return root
    text = etree.tostring(root, encoding="unicode")
    read = set(_READ.findall(text))
    for declaration in declarations:
        instance_id = declaration.get("id")
        if (
            instance_id.startswith(_PREFIX)
            and instance_id in read
            and declaration.get("src") == f"jr://fixture/{instance_id}"
            and set(declaration.attrib) == {"id", "src"}
            and len(declaration) == 0
            and not (declaration.text or "").strip()
        ):
            form_model.remove(declaration)
    return root


RULE = SpellingRule(
    "item-list-declarations",
    ("form:*", "*/form:*"),
    "A lookup table's item-list: instance declaration where the form's text reads it, which HQ's build declares"
    " again where it is missing (XForm.add_missing_instances).",
    normalize,
)
