"""Where a repeat item's own case block stands among the item's answers, in a submission.

HQ's build writes the case block of a repeat's subcase as the first child of
the repeat's item (``xform.py::XForm._create_casexml``,
``subcase_node.insert(0, subcase_block.elem)``); Nova's local archive writes
it after the item's answers. Core serializes the form's instance in its
order, so the two submissions differ only in where that one element stands
among elements that are no case blocks. Neither processor of a submission
reads that place: Core applies case blocks in document order
(``core/process/XmlFormRecordProcessor.java``), which moving one block past
answers does not change, and HQ applies them by case id
(``casexml/apps/case/xform.py::get_case_updates``); everything else reads a
submission by path.

The rule moves, in each submission of a trace, a case block (``case`` in the
case namespace) that is the child of an element other than the data node to
the front of that element, where no other child of that element holds a case
block, so the order of case blocks in the submission is never changed. A
case block at the data node stands before or after the subcase blocks
beside it, which changes the order Core applies them in (harness finding
37, ``docs/research/2026-09-26-hq-round-trip/harness-findings.md``), and
the rule leaves it.
"""

from __future__ import annotations

from lxml import etree

from proof.rules import SpellingRule
from proof.rules._xforms import CASE, tag

_CASE = tag(CASE, "case")
_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=True)


def _holds_block(element):
    return element.tag == _CASE or next(element.iter(_CASE), None) is not None


def _moved(submission):
    try:
        root = etree.fromstring(submission.encode("utf-8"), _PARSER)
    except etree.XMLSyntaxError:
        return submission
    changed = False
    for block in list(root.iter(_CASE)):
        parent = block.getparent()
        if parent is None or parent is root:
            continue
        siblings = [child for child in parent if isinstance(child.tag, str) and child is not block]
        if any(_holds_block(child) for child in siblings) or parent.index(block) == 0:
            continue
        parent.insert(0, block)
        changed = True
    return etree.tostring(root, encoding="unicode") if changed else submission


def normalize(trace):
    if not isinstance(trace, dict):
        return trace
    for run in trace.get("runs") or []:
        for step in (run or {}).get("trace") or []:
            if isinstance(step, dict) and isinstance(step.get("submission"), str):
                step["submission"] = _moved(step["submission"])
    return trace


RULE = SpellingRule(
    "case-block-position",
    "trace",
    "A repeat item's own case block before or after the item's answers in a submission, which no processor reads"
    " (XmlFormRecordProcessor, get_case_updates).",
    normalize,
)
