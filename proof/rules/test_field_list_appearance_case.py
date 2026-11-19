"""The rule ``field-list-appearance-case`` is sound: every runtime reads a group's ``field-list`` in any letter case
alike.

Contract: the rule writes ``field-list`` for a group's appearance in Core's
trace and for a group's ``style.raw`` in Formplayer's answers wherever the
whole value equals ``field-list`` as Java's ``equalsIgnoreCase`` compares it,
and leaves a repeat's, a question's and every other value. Its readers are
HQ's build, which writes the form's source as it stands, Core, which reads
the token ignoring case and records it as spelled, Formplayer, which asks Core
and hands the spelling to the client, the Web Apps client, which reads none
of a group's style but its own tokens, and CommCare Android
(``proof/android/predicates.py::test_a_form_reads_a_field_list_group_alike_in_either_letter_case``).
The plausible failures: a runtime reading the letter case (a group shown a
question a screen in one spelling); the rule erasing a value Core does not
read as ``field-list`` (``FIELD-LISTS``); and the rule changing a question's
or a repeat's appearance.

``case-list-local``'s first form is written with its last control inside a
group of appearance ``field-list``, and with the same group written
``Field-List`` and ``FIELD-LISTS``. HQ builds each whole and the builds differ
only at that group's appearance in the form; Core's sessions over the first
two differ only at the group event's appearance, which the rule erases,
while the third, which Core does not read as a field list, stays a difference
under the rule. Formplayer's walks and the Web Apps client's screens of the
first two releases, each walk derived on its own release, compare equal once the rule reads Formplayer's
answers.
"""

from __future__ import annotations

from lxml import etree

from proof.rules.conftest import (
    build_differences,
    client_differences,
    formplayer_differences,
    published,
    rewritten,
    runs_alike,
    served_readings,
    shown,
    trace_differences,
)
from proof.rules.field_list_appearance_case import RULE, is_field_list, normalize

DOCUMENT = "case-list-local"
FORM = "0.0"
XHTML = "http://www.w3.org/1999/xhtml"
APPEARANCE = ("trace", "/runs/*/trace/*/events/*/appearance", "changed")


# The rule over values alone ------------------------------------------------------------------------------------


def test_field_list_in_any_letter_case_is_field_list_and_nothing_else_is():
    for spelled in ("field-list", "Field-List", "FIELD-LIST", "fıeld-liſt"):
        assert is_field_list(spelled), spelled
    for other in ("field-list compact", "FIELD-LISTS", "field_list", "", None, "ﬁeld-list"):
        assert not is_field_list(other), other


def test_the_rule_writes_a_groups_field_list_in_lower_case_in_cores_trace_and_formplayers_answers():
    trace = {
        "runs": [
            {
                "trace": [
                    {
                        "screen": "form",
                        "events": [
                            {"event": "group", "path": "/data/g", "appearance": "Field-List"},
                            {"event": "repeat", "path": "/data/r", "appearance": "Field-List"},
                            {"event": "question", "path": "/data/q", "appearance": "Field-List"},
                            {"event": "group", "path": "/data/h", "appearance": "FIELD-LISTS"},
                        ],
                    }
                ]
            }
        ]
    }
    events = normalize(trace)["runs"][0]["trace"][0]["events"]
    assert [event["appearance"] for event in events] == ["field-list", "Field-List", "Field-List", "FIELD-LISTS"]
    answered = {
        "tree": [
            {"type": "sub-group", "repeatable": False, "style": {"raw": "Field-List"}, "children": []},
            {"type": "sub-group", "repeatable": True, "style": {"raw": "Field-List"}},
            {"type": "question", "style": {"raw": "Field-List"}},
        ]
    }
    styles = [node["style"]["raw"] for node in normalize(answered)["tree"]]
    assert styles == ["field-list", "Field-List", "Field-List"]
    assert RULE.applies_to("trace") and RULE.applies_to("formplayer") and not RULE.applies_to("form:0.0")


# The readers, run ---------------------------------------------------------------------------------------------


def _grouped(appearance):
    """The form's last control inside a group of ``appearance``, written as HQ's form page takes an upload."""

    def change(root):
        body = root.find(f"{{{XHTML}}}body")
        last = body[len(body) - 1]
        group = etree.Element(f"{{{etree.QName(last).namespace}}}group", appearance=appearance)
        body.replace(last, group)
        group.append(last)

    return rewritten(change)


def test_hq_builds_and_core_runs_a_field_list_alike_in_either_letter_case(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        lower = app.spell(sources={FORM: _grouped("field-list")})
        mixed = app.spell(sources={FORM: _grouped("Field-List")})
        other = app.spell(sources={FORM: _grouped("FIELD-LISTS")})
        first, second, alike = runs_alike(app, core_runner, lower.build, mixed.build)
        base, third, apart = runs_alike(app, core_runner, lower.build, other.build)

    built = shown(build_differences(lower.build, mixed.build))
    assert built, "the two spellings built the same app, so the test shows nothing"
    assert all(path.endswith("/@appearance") for _, path, _ in built), built
    assert shown(alike) == [APPEARANCE], shown(alike)
    assert trace_differences(first, second, rules=(RULE,)) == []
    assert shown(apart), "Core read FIELD-LISTS as the field list it is not"
    assert APPEARANCE in shown(trace_differences(base, third, rules=(RULE,))), "the rule erased another value"


def _readings(app, appearance):
    """The app with its form spelled ``appearance``, served and read, in a fork of the published state."""
    with app.unit.fork():
        app._write(sources={FORM: _grouped(appearance)})
        return served_readings(app, {appearance: None})[appearance]


def test_formplayer_and_web_apps_show_a_field_list_alike_in_either_case(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        lower = _readings(app, "field-list")
        mixed = _readings(app, "Field-List")

    handed = shown(formplayer_differences(lower, mixed))
    assert handed, "Formplayer handed both spellings alike, so the test shows nothing of the rule"
    assert all(path.endswith("/style/raw") for _, path, _ in handed), handed
    assert formplayer_differences(lower, mixed, rules=(RULE,)) == []
    assert client_differences(lower, mixed) == []
