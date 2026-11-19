"""A group's appearance ``field-list`` in another letter case, where Nova writes it in lower case.

CommCare HQ stores a form's source as it was uploaded, so an app made in HQ
can hold a group whose appearance is ``Field-List`` (``hq-questions``). Nova's
reader holds such a group as a Question List, since every runtime reads the
token in any letter case (part 06, section 10.2), and Nova writes
``field-list``. HQ's form builder reads only the lower-case token as a
Question List (``Vellum/src/parser.js``), which is why the stored form's
change is a first-publish change (``forms-and-settings-rewritten``) and why
this rule reads no form source: it reads what the runtimes hand on.

Core decides a field list by comparing the group's whole appearance with
``field-list`` ignoring case (``form/api/FormEntryController.java::
isHostWithAppearance``, ``String.equalsIgnoreCase``), and every reader asks
it there: CommCare Android and Formplayer through
``FormController.indexIsInFieldList`` and ``FormEntryController.
isFieldListHost``. But Core's runner records each group event's appearance as
the form spells it (``FormRun.java::walk``,
``FormEntryCaption.getAppearanceHint``), and Formplayer hands it to the Web
Apps client as the group's ``style.raw`` (``api/json/PromptToJson.java::
parseStyle``). The client reads a group's style only for its own tokens
(``form_entry/form_ui.js``: ``collapsible``, ``group-border``,
``collapsible-open`` and the per-row patterns, each compared as written), none
of which is ``field-list`` in any case.

The rule writes ``field-list`` for the appearance of a group event in Core's
trace, and for the ``style.raw`` of a group Formplayer answers with, where the
whole value equals ``field-list`` as Java's ``equalsIgnoreCase`` compares it.
A repeat's appearance, a question's, and any other value (``field-list
compact``, ``FIELD-LISTS``) are left.
"""

from __future__ import annotations

from proof.rules import SpellingRule

FIELD_LIST = "field-list"
# Core's trace: a group event (``FormRun.java::walk``), and Formplayer's: a group in a form's tree
# (``PromptToJson.java``, ``EVENT_GROUP``: ``type`` sub-group, ``repeatable`` false).
GROUP_EVENT = "group"
SUB_GROUP = "sub-group"


def _same_char_ignoring_case(a, b):
    """Two characters as ``String.regionMatches(true, ...)`` matches them: equal, equal upper cased, or equal lower
    cased after upper casing, each character mapped alone."""
    if a == b:
        return True
    upper_a, upper_b = a.upper(), b.upper()
    if len(upper_a) != 1 or len(upper_b) != 1:
        return False
    return upper_a == upper_b or upper_a.lower() == upper_b.lower()


def is_field_list(appearance):
    """Whether Core reads ``appearance`` as ``field-list`` (``String.equalsIgnoreCase``)."""
    return (
        isinstance(appearance, str)
        and len(appearance) == len(FIELD_LIST)
        and all(_same_char_ignoring_case(a, b) for a, b in zip(appearance, FIELD_LIST, strict=True))
    )


def _group(value):
    """Where ``value`` is a group as Core's trace records one or as Formplayer answers with one, its appearance's
    holder and key; else None."""
    if value.get("event") == GROUP_EVENT:
        return value, "appearance"
    style = value.get("style")
    if value.get("type") == SUB_GROUP and value.get("repeatable") in (False, "false") and isinstance(style, dict):
        return style, "raw"
    return None


def normalize(value):
    """Every group of Core's trace (a form step's ``events``) or of Formplayer's (each tree it answered), wherever
    it stands in the artifact."""
    if isinstance(value, dict):
        found = _group(value)
        if found is not None and is_field_list(found[0].get(found[1])):
            found[0][found[1]] = FIELD_LIST
        for child in value.values():
            normalize(child)
    elif isinstance(value, list):
        for child in value:
            normalize(child)
    return value


RULE = SpellingRule(
    "field-list-appearance-case",
    ("trace", "formplayer"),
    "A group's appearance field-list in another letter case, which Core reads ignoring case"
    " (FormEntryController.isHostWithAppearance) and no reader reads apart.",
    normalize,
    readers=(
        ("formplayer", "test_formplayer_and_web_apps_show_a_field_list_alike_in_either_case"),
        ("webapps", "test_formplayer_and_web_apps_show_a_field_list_alike_in_either_case"),
        ("android", "test_a_form_reads_a_field_list_group_alike_in_either_letter_case"),
    ),
)
