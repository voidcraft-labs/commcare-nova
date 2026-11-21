"""The earlier date-and-time case writer on the native readers.

Nova's reader recognizes the former millisecond formatter of a typed question and records the case property it
writes (reader/xform/generated.ts, reader/caseManagement/saveToCase.ts). The first publish writes six UTC
fraction digits, as HQ's form_processor.utils.xform.adjust_datetimes stores them. Unlike Core's trace, native
readers keep the actual timestamp. Never normalize text across the app or discard a digit the device recorded.
"""

import json
import re
from datetime import datetime

from proof.checks import xform_parts
from proof.rules import _xpath

SUBMISSION = "/runs/*/steps/*/submissions/*/instance/data/"
FORMPLAYER = {SUBMISSION + "nova_datetime_*[*]/text()", SUBMISSION + "case[*]/update[*]/*/text()"}
CASES = "/walks/*/steps/*/form/saved/cases/*"
MILLISECONDS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")


def padded(before, after):
    if not isinstance(before, str) or not MILLISECONDS.fullmatch(before) or after != before[:-1] + "000Z":
        return False
    try:
        datetime.fromisoformat(before[:-1])
    except ValueError:
        return False
    return True


def candidate(difference):
    return difference.kind == "changed" and (
        (
            difference.artifact.startswith("formplayer@")
            and difference.path in FORMPLAYER
            and padded(difference.before, difference.after)
        )
        or (difference.artifact.startswith(("android@", "android-tablet@")) and difference.path == CASES)
    )


def saved_property(difference):
    """The case type and property if padding that single value accounts for the whole device case.
    android._form serializes each case as one symptom, including its type, name, owner, indices and all siblings."""
    try:
        before, after = json.loads(difference.before), json.loads(difference.after)
    except (TypeError, ValueError):
        return None
    if not isinstance(before, dict) or not isinstance(after, dict) or not isinstance(before.get("type"), str):
        return None
    a, b = before.get("properties"), after.get("properties")
    if not isinstance(a, dict) or not isinstance(b, dict) or a.keys() != b.keys():
        return None
    changed = [key for key in a if a[key] != b[key]]
    if len(changed) != 1 or not padded(a[changed[0]], b[changed[0]]):
        return None
    prop = changed[0]
    a[prop] = b[prop]
    if json.dumps(before, sort_keys=True, ensure_ascii=False) == difference.after:
        return before["type"], prop
    return None


def writes(app, position, case_types):
    """The reviewed form's directly updated datetime properties and the former writer for each.
    A same-named text question, another case type, and a write from a different expression give no witness."""
    m, f = map(int, position.split("."))
    modules = app.get("modules") or []
    if not isinstance(modules, list) or m >= len(modules) or not isinstance(modules[m], dict):
        return {}
    forms = modules[m].get("forms") or []
    if not isinstance(forms, list) or f >= len(forms) or not isinstance(forms[f], dict):
        return {}
    form = forms[f]
    kind = modules[m].get("case_type")
    types = (case_types or {}).get(kind, {})
    update = (form.get("actions") or {}).get("update_case") or {}
    xml = (app.get("_attachments") or {}).get(f"{form.get('unique_id')}.xml")
    if not isinstance(xml, str) or (update.get("condition") or {}).get("type") == "never":
        return {}
    parts = xform_parts.parts(xml) or {}
    found = {}
    for prop, action in (update.get("update") or {}).items():
        if types.get(prop) != "datetime" or not isinstance(action, dict):
            continue
        helper = action.get("question_path")
        if not isinstance(helper, str) or not (steps := xform_parts.node_steps(helper)):
            continue
        leaf = steps[-1]
        if not leaf.startswith("nova_datetime_"):
            continue
        question = "/" + "/".join((*steps[:-1], leaf.removeprefix("nova_datetime_")))
        calc = f"if({question} = '', '', format-date(coalesce({question}, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))"
        if (
            _xpath.tokens(parts.get(f"{helper}/:bind/@calculate", (None, None))[1]) == _xpath.tokens(calc)
            and parts.get(f"{question}/:bind/@type", (None, None))[1] == "xsd:dateTime"
        ):
            found[kind, prop] = steps
    return found


def submission(place, writes_at):
    if not place or place[0] != "form" or place[2:3] != ("xform",):
        return False
    writes = writes_at(place[1])
    node = place[3:]
    return node in writes.values() or (
        node[:3] == ("data", "case", "update") and len(node) == 4 and any(prop == node[-1] for _, prop in writes)
    )
