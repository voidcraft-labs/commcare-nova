"""A group's appearance that only sets how many rows of a repeat Web Apps lays out on a line, on a group that holds
no repeat, which Nova drops.

CommCare HQ's form builder writes ``<n>-per-row-repeat`` on an outer group to
lay out the rows of the repeat it holds (``hq-question-display``'s
``directions``, a group of plain questions, holds one too). Nova's reader
holds a repeat row count only on a group that holds a repeat
(``lib/commcare/xform/readDisplaySettings.ts::readFieldAppearance``,
``hasRepeatingRows``) and accounts it elsewhere under
``questions/group-repeat-row-without-a-repeat``, whose standing is inert, so
Nova's first publish writes the group with no appearance
(``question-display-respelled``).

Web Apps is the one reader of the token: ``form_entry/form_ui.js::
processNPerRowRepeatStyle`` copies ``<n>-per-row`` onto each child of the
group that is a repeat (``type`` sub-group, ``repeatable`` true) in the answer
Formplayer just handed it, and onto nothing else, while the group's own
per-row layout reads ``<n>-per-row`` followed by a space or the end
(``const.js::PER_ROW_PATTERN``), which ``-repeat`` never is. Core reads a
group's appearance only as ``field-list`` (``FormEntryController.
isHostWithAppearance``) and records it as spelled in its runner's trace
(``FormRun.java::walk``, ``FormEntryCaption.getAppearanceHint``), Formplayer
hands it to the client as the group's ``style.raw``
(``api/json/PromptToJson.java::parseStyle``), and CommCare Android reads a
group's whole appearance for ``field-list`` and ``compact``.

The rule takes the appearance away from a group of Core's trace or of
Formplayer's answer where every word of it is ``<n>-per-row-repeat`` and the
same step of the trace, or the group's children in the answer, hold no repeat
directly under it, as Web Apps then has none to lay out. Any other value, and
the same value over a group that holds a repeat, are left.
"""

from __future__ import annotations

import re

from proof.rules import SpellingRule

# A word Web Apps reads as a repeat row count, matched whole (``const.js::PER_ROW_REPEAT_PATTERN``, which Nova's
# reader holds only as written: a run of digits, then ``-per-row-repeat``).
REPEAT_ROW_COUNT = re.compile(r"[0-9]+-per-row-repeat")
# Core's trace: a group event and the events that stand for a repeat (``FormRun.java::walk``).
GROUP_EVENT = "group"
REPEAT_EVENTS = frozenset({"repeat", "new-repeat", "repeat-juncture"})
# Formplayer's: a group in a form's tree, and a repeat (``PromptToJson.java``: ``type`` sub-group, ``repeatable``).
SUB_GROUP = "sub-group"


def only_repeat_row_counts(appearance) -> bool:
    """Whether every word of ``appearance`` is a repeat row count (Web Apps splits a style on a space)."""
    if not isinstance(appearance, str) or appearance == "":
        return False
    return all(REPEAT_ROW_COUNT.fullmatch(word) for word in appearance.split(" "))


def _parent(path) -> str | None:
    """The path a trace path's last step stands under (``/data/g[1]/r[2]`` gives ``/data/g[1]``)."""
    if not isinstance(path, str) or "/" not in path:
        return None
    return path.rsplit("/", 1)[0]


def _without_position(step: str) -> str:
    return step.split("[", 1)[0]


def _same_node(a, b) -> bool:
    """Whether two trace paths name one node: a new repeat's prompt names its repeat without positions."""
    if a is None or b is None:
        return False
    left, right = a.split("/"), b.split("/")
    return len(left) == len(right) and all(
        x == y or _without_position(x) == _without_position(y) for x, y in zip(left, right, strict=True)
    )


def _trace_events(events):
    groups_holding = {
        _parent(event.get("path"))
        for event in events
        if isinstance(event, dict) and event.get("event") in REPEAT_EVENTS
    }
    for event in events:
        if not isinstance(event, dict) or event.get("event") != GROUP_EVENT:
            continue
        if not only_repeat_row_counts(event.get("appearance")):
            continue
        if any(_same_node(event.get("path"), holder) for holder in groups_holding):
            continue
        event["appearance"] = None


def _repeatable(node) -> bool:
    return isinstance(node, dict) and node.get("type") == SUB_GROUP and node.get("repeatable") in (True, "true")


def _answered_group(node):
    style = node.get("style")
    if node.get("type") != SUB_GROUP or node.get("repeatable") not in (False, "false") or not isinstance(style, dict):
        return
    if not only_repeat_row_counts(style.get("raw")):
        return
    if any(_repeatable(child) for child in node.get("children") or ()):
        return
    node["style"] = None


def normalize(value):
    """Every step of Core's trace (its ``events``) and every group of Formplayer's answers, wherever each stands."""
    if isinstance(value, dict):
        events = value.get("events")
        if isinstance(events, list):
            _trace_events(events)
        _answered_group(value)
        for child in value.values():
            normalize(child)
    elif isinstance(value, list):
        for child in value:
            normalize(child)
    return value


RULE = SpellingRule(
    "repeat-row-count-without-a-repeat",
    ("trace", "formplayer"),
    "A group's appearance made only of <n>-per-row-repeat over a group that holds no repeat, which Web Apps lays"
    " onto the group's repeats alone (form_ui.js::processNPerRowRepeatStyle) and no other reader reads.",
    normalize,
    readers=(
        ("formplayer", "test_formplayer_and_web_apps_show_a_group_alike_with_and_without_a_repeat_row_count"),
        ("webapps", "test_formplayer_and_web_apps_show_a_group_alike_with_and_without_a_repeat_row_count"),
        ("android", "test_a_form_reads_a_group_alike_with_and_without_a_repeat_row_count"),
    ),
)
