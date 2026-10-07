"""An empty ``work_area_id`` in a Connect deliver unit, which every reader of it reads as none.

Vellum's save writes a ``work_area_id`` child into each Connect deliver unit
of a form's instance, empty where the unit names no work area
(``Vellum/src/commcareConnect.js``, ``ConnectDeliverUnit``: its child nodes,
and ``mug.p.work_area_id = ""``); Nova's deliver unit holds none. The
element has no bind and no control, so it is a node of the form's data and
nothing else. Each reader of it:

- HQ's build carries a form's instance as it is stored
  (``xform.py::XForm.render``), so the two builds differ in that element
  alone;
- Core holds the node with no value and serializes it empty in the
  submission; no expression of the form names it, and it is no case block,
  so neither Core's nor HQ's case processing reads it;
- Formplayer hands a form's instance back, and takes its submission, as Core
  wrote them, the element in both;
- HQ's Connect repeater forwards every child of a Connect block
  (``repeater_generators.py::ConnectFormRepeaterPayloadGenerator``), the
  empty element as ``"work_area_id": ""``;
- Connect reads a deliver unit's work area by its truth value
  (``commcare-connect form_receiver/processor.py::process_deliver_unit``,
  ``if work_area_case_id := deliver_unit_block.get("work_area_id")``), so
  the empty string and the absent key are one reading: no work area.

The rule removes a ``work_area_id`` element that is a child of a ``deliver``
element, both in Connect's namespace, where it holds no text, no child and
no attribute: in a form's instance (a form stored or built), in a form's
instance or a submission as Formplayer hands it (``instance``), and in each
submission of a Core trace. One that holds anything names a work area, which
Connect looks up and refuses where it does not hold it; and a
``work_area_update`` block's is read otherwise (Connect refuses an empty
one, ``process_work_area_update``): the rule leaves both.
"""

from __future__ import annotations

from lxml import etree

from proof.rules import SpellingRule
from proof.rules._xforms import is_element, tag

CONNECT = "http://commcareconnect.com/data/v1/learn"
_DELIVER = tag(CONNECT, "deliver")
_WORK_AREA = tag(CONNECT, "work_area_id")
_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=True)


def _empty(element):
    return not (element.text or "").strip() and not element.attrib and not any(is_element(child) for child in element)


def _without_empty(root) -> bool:
    """Remove each empty ``work_area_id`` of a deliver unit below ``root``; whether any was removed."""
    removed = False
    for element in list(root.iter(_WORK_AREA)):
        parent = element.getparent()
        if parent is None or parent.tag != _DELIVER or not _empty(element):
            continue
        parent.remove(element)
        removed = True
    return removed


def _submission(text):
    try:
        root = etree.fromstring(text.encode("utf-8"), _PARSER)
    except etree.XMLSyntaxError:
        return text
    return etree.tostring(root, encoding="unicode") if _without_empty(root) else text


def normalize(parsed):
    if isinstance(parsed, dict):
        for run in parsed.get("runs") or []:
            for step in (run or {}).get("trace") or []:
                if isinstance(step, dict) and isinstance(step.get("submission"), str):
                    step["submission"] = _submission(step["submission"])
        return parsed
    if hasattr(parsed, "iter"):
        _without_empty(parsed)
    return parsed


RULE = SpellingRule(
    "connect-work-area-empty",
    ("form:*", "instance", "trace"),
    "An empty work_area_id in a Connect deliver unit, which Connect reads by its truth value as it reads none"
    " (process_deliver_unit) and nothing else reads.",
    normalize,
)
