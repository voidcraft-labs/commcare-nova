"""Vellum puts consecutive response rows under each result name on save.

Android's IntentExtensionParser inserts each name in its response Hashtable
on first encounter and appends destinations to each name's Vector. Keep both
orders. In particular, sorting distinct names could change the write order
for colliding keys that both fill one question.
"""

from __future__ import annotations

from collections import Counter

from proof.rules import SpellingRule
from proof.rules._xforms import VELLUM, XHTML, XFORMS, is_xform, tag

_INTENT = "{http://opendatakit.org/xforms}intent"
_EXTRA = tag(XFORMS, "extra")
_RESPONSE = tag(XFORMS, "response")
_ATTRIBUTES = {"key", "ref", tag(VELLUM, "ref")}


def normalize(root):
    head = root.find(tag(XHTML, "head")) if is_xform(root) else None
    if head is None:
        return root
    intents = head.findall(_INTENT)
    ids = Counter(intent.get("id") for intent in intents)
    for intent in intents:
        if (not intent.get("id") or ids[intent.get("id")] != 1
                or intent.get("class") in {None, "", "org.commcare.dalvik.action.PRINT"}
                or set(intent.attrib) != {"id", "class"} or (intent.text or "").strip()):
            continue
        if any(row.tag not in {_EXTRA, _RESPONSE} or not set(row.attrib) <= _ATTRIBUTES
               or row.get("key") in {None, "", "__proto__", "hasOwnProperty"}
               or not row.get("ref") or len(row) or (row.text or "").strip()
               or (row.tail or "").strip() for row in intent):
            continue
        positions = [(index, row) for index, row in enumerate(intent) if row.tag == _RESPONSE]
        by_key = {}
        for _, row in positions:
            by_key.setdefault(row.get("key"), []).append(row)
        grouped = [row for rows in by_key.values() for row in rows]
        if grouped == [row for _, row in positions]:
            continue
        for _, row in positions:
            intent.remove(row)
        for (index, _), row in zip(positions, grouped, strict=True):
            intent.insert(index, row)
    return root


RULE = SpellingRule(
    "android-intent-response-groups",
    ("form:*", "*/form:*"),
    "Consecutive Android intent responses with the same name, preserving first distinct name and each destination order.",
    normalize,
)
