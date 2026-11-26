"""A question's appearance spelled otherwise, where every runtime reads the two spellings alike.

An app made in CommCare HQ can hold a question's display settings in a
spelling Nova writes otherwise: words in another order (``compact-2 quick``,
which Nova writes ``quick compact``), a case variant a whole-value read takes
ignoring case (``Numbers``), a word no runtime reads on that control
(``minimal hint-as-placeholder foo``), a single string Android matches inside
(``compact2``), a per-row count Web Apps parses the same (``1x2-per-row``), or a
hidden label's own word (``floating-note``). Nova's first publish writes its
own spelling (``question-display-respelled``). Core records the spelling in its
runner's trace (``FormRun.java``, ``FormEntryPrompt.getAppearanceHint``) and
Formplayer hands it to the Web Apps client as the question's ``style.raw``
(``api/json/PromptToJson.java::parseStyle``); neither reads a question's
appearance (Core reads a group's alone, ``FormEntryController.
isHostWithAppearance``).

The rule writes, in place of a question's appearance, what each runtime reads
of it, modelled from each reader's own code, where it models every reader of
that control:

- Web Apps (``form_entry/form_ui.js``, ``entries.js``): each word it compares
  whole (``getMatchingStyles`` with a string, ``const.js``), the second word
  where ``combobox`` is one of them (``getEntry``: ``style.raw().split(' ')[1]``),
  the first word holding a per-row count with the width ``calculateElementWidth``
  makes of it (``parseInt`` of its text before the first ``-``), the first word
  holding ``receive`` and every word holding ``broadcast`` (``/receive-*/``,
  ``/broadcast-*/``), as written;
- CommCare Android (``WidgetFactory.java``): a single select's and a multiple
  select's widget as ``buildSelectOne``, ``buildCompactSelectOne``,
  ``buildComboboxSelectOne`` and ``buildSelectMulti`` choose it (a grid's
  column count the text after the value's first ``-`` read as a Java ``int``,
  else none), a text input's as ``buildBasicWidget`` does (``numbers`` and
  ``numeric`` in any case) with ``StringWidget.shouldSupportIMEAction``'s
  ``short`` in any case, and a label's as ``TriggerWidget`` and
  ``FormNavigationUI.FloatingLabel`` read it (interactive unless exactly
  ``minimal`` or ``selectable``, hidden where it starts ``floating-``, a banner
  only for exactly ``floating-good``, ``floating-caution`` or ``floating-bad``).

Two spellings with the same readings are then written alike; any other
difference stays. A control the rule does not model (a date, an upload, a
barcode), an ``intent:`` value, and a value holding white space other than
single spaces are left as they are.
"""

from __future__ import annotations

import json
import math
import re

from proof.rules import SpellingRule

WEB_WORDS = frozenset(
    {
        "numeric",
        "address",
        "minimal",
        "label",
        "list-nolabel",
        "combobox",
        "group-collapse",
        "collapse-open",
        "collapse-closed",
        "12-hour",
        "ethiopian",
        "signature",
        "text-align-center",
        "text-align-right",
        "button-select",
        "short",
        "medium",
        "group-border",
        "hint-as-placeholder",
    }
)
PER_ROW = re.compile(r"\d+-per-row(\s|$)")
GRID_COLUMNS = 12
FLOATING = frozenset({"floating-good", "floating-caution", "floating-bad"})
INT_MIN, INT_MAX = -(2**31), 2**31 - 1
# The controls the rule models, by Core's trace name with its data type, and by Formplayer's ``datatype``.
TRACE_CONTROLS = {"select1": "select1", "select": "select", "trigger": "trigger"}
TEXT_TYPES = frozenset({"text", "null"})
FORMPLAYER_TYPES = {"select": "select1", "multiselect": "select", "info": "trigger", "str": "text"}


def _js_parse_int(text: str):
    """JavaScript's ``parseInt(text, 10)``: leading white space, a sign, then digits; None for NaN."""
    found = re.match(r"\s*([+-]?)(\d+)", text)
    if found is None:
        return None
    return int(found.group(1) + found.group(2))


def _java_int(text: str):
    """``Integer.parseInt``: an optional sign and decimal digits, the whole text, within an int; else None."""
    if not re.fullmatch(r"[+-]?\d+", text):
        return None
    number = int(text)
    return number if INT_MIN <= number <= INT_MAX else None


def web_reading(raw: str):
    words = raw.split(" ")
    per_row = next((word for word in words if PER_ROW.search(word)), None)
    width = None
    if per_row is not None:
        count = _js_parse_int(per_row.split("-")[0])
        # ``Math.round(12 / count)``: NaN for no number, Infinity for none per row, half rounded up.
        width = "NaN" if count is None else "Infinity" if count == 0 else str(math.floor(GRID_COLUMNS / count + 0.5))
    return {
        "words": sorted({word for word in words if word in WEB_WORDS}),
        "match": words[1] if "combobox" in words and len(words) > 1 else None,
        "perRow": width,
        "receive": next((word for word in words if "receive" in word), None),
        "broadcast": [word for word in words if "broadcast" in word],
    }


def _columns(raw: str):
    return _java_int(raw[raw.index("-") + 1 :] if "-" in raw else raw)


def android_reading(control: str, raw: str):
    if control == "select1":
        if "compact" in raw:
            return ["grid", _columns(raw), "quick" in raw]
        if raw == "minimal":
            return ["spinner"]
        if "combobox" in raw:
            return ["combobox", "multiword" if "multiword" in raw else "fuzzy" if "fuzzy" in raw else "standard"]
        named = {"quick": "auto-advance", "list": "list", "list-nolabel": "list-unlabelled", "label": "labels"}
        return [named.get(raw, "select")]
    if control == "select":
        if "compact" in raw:
            return ["grid", _columns(raw)]
        named = {"minimal": "spinner", "list": "list", "list-nolabel": "list-unlabelled", "label": "labels"}
        return [named.get(raw, "select")]
    if control == "text":
        lower = raw.lower()
        return ["number" if lower in ("numbers", "numeric") else "string", lower == "short"]
    if control == "trigger":
        return [
            raw not in ("minimal", "selectable"),
            raw == "selectable",
            raw.startswith("floating-"),
            raw if raw in FLOATING else None,
        ]
    return None


def reading(control: str, raw):
    """What every runtime reads of a question's appearance on ``control``, as one text; None where the rule models
    none of it."""
    if not isinstance(raw, str) or raw == "" or raw.startswith("intent:") or " ".join(raw.split()) != raw:
        return None
    android = android_reading(control, raw)
    if android is None:
        return None
    return "read as " + json.dumps({"android": android, "webApps": web_reading(raw)}, sort_keys=True)


def _trace_control(event):
    control = event.get("control")
    if control == "input" or control == "secret":
        return "text" if event.get("dataType") in TEXT_TYPES else None
    return TRACE_CONTROLS.get(control)


def normalize(value):
    """Every question of Core's trace (an event ``question``) and of Formplayer's answers (a ``question`` with a
    ``style``), wherever each stands."""
    if isinstance(value, dict):
        if value.get("event") == "question" and "appearance" in value:
            control = _trace_control(value)
            read = reading(control, value.get("appearance")) if control else None
            if read is not None:
                value["appearance"] = read
        style = value.get("style")
        if value.get("type") == "question" and isinstance(style, dict):
            control = FORMPLAYER_TYPES.get(value.get("datatype"))
            read = reading(control, style.get("raw")) if control else None
            if read is not None:
                style["raw"] = read
        for child in value.values():
            normalize(child)
    elif isinstance(value, list):
        for child in value:
            normalize(child)
    return value


RULE = SpellingRule(
    "question-appearance-read-alike",
    ("trace", "formplayer"),
    "A question's appearance spelled otherwise where Web Apps (form_ui.js, entries.js) and CommCare Android"
    " (WidgetFactory, TriggerWidget, FormNavigationUI) read the two spellings alike, and Core and Formplayer read"
    " neither.",
    normalize,
    readers=(
        ("formplayer", "test_formplayer_and_web_apps_show_each_respelled_question_alike"),
        ("webapps", "test_formplayer_and_web_apps_show_each_respelled_question_alike"),
        ("android", "test_a_form_reads_each_respelled_question_alike"),
    ),
)
