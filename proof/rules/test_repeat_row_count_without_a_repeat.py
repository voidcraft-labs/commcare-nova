"""The rule ``repeat-row-count-without-a-repeat`` is sound: a group that holds no repeat reads alike with and without an
appearance made only of ``<n>-per-row-repeat``.

Contract: the rule takes the appearance away from a group event of Core's
trace, and the style from a group Formplayer answers with, where every word of
it is ``<n>-per-row-repeat`` and nothing in that step (in that group's
children) is a repeat directly under it; it leaves a value of any other word, a
question's or a repeat's appearance, and the same value on a group holding a
repeat. Its readers are HQ's build, which writes the form's source as it
stands, Core, which reads a group's appearance only as ``field-list`` and
records it as spelled, Formplayer, which hands it to the client, the Web Apps
client, which lays the count onto the group's repeats alone
(``form_ui.js::processNPerRowRepeatStyle``), and CommCare Android
(``proof/android/predicates.py::test_a_form_reads_a_group_alike_with_and_without_a_repeat_row_count``).
The plausible failures: a reader laying out a group of plain questions by the
count (Web Apps reading it as the group's own ``<n>-per-row``); the rule
erasing a value a reader reads (``2-per-row``, which Web Apps lays the group's
questions out by); and the rule erasing the count over a group that holds a
repeat.

``targeted-plain-help``'s first form, which Core's sessions open from its menu
with no case to choose, is written with its last control inside a group with no
appearance, with appearance ``2-per-row-repeat``, and with appearance
``2-per-row``. HQ builds each whole and the builds differ only at that group's
appearance; Core's sessions over the first two differ only at the group event's
appearance, which the rule erases, while the third stays a difference under the
rule. Formplayer's walks and the Web Apps client's screens of the first two
releases compare equal once the rule reads Formplayer's answers.
"""

from __future__ import annotations

import pytest
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
from proof.rules.repeat_row_count_without_a_repeat import RULE, normalize, only_repeat_row_counts

DOCUMENT = "targeted-plain-help"
FORM = "0.0"
XHTML = "http://www.w3.org/1999/xhtml"
APPEARANCE = ("trace", "/runs/*/trace/*/events/*/appearance", "changed")


# The rule over values alone ------------------------------------------------------------------------------------


def test_a_value_of_repeat_row_counts_alone_is_one_and_nothing_else_is():
    for value in ("2-per-row-repeat", "12-per-row-repeat 3-per-row-repeat"):
        assert only_repeat_row_counts(value), value
    for other in ("2-per-row", "2-per-row-repeat collapse-open", "x2-per-row-repeat", " 2-per-row-repeat", "", None):
        assert not only_repeat_row_counts(other), other


def test_the_rule_takes_the_count_away_only_from_a_group_with_no_repeat_under_it():
    trace = {
        "runs": [
            {
                "trace": [
                    {
                        "screen": "form",
                        "events": [
                            {"event": "group", "path": "/data/g[1]", "appearance": "2-per-row-repeat"},
                            {"event": "question", "path": "/data/g[1]/q[1]", "appearance": "2-per-row-repeat"},
                            {"event": "group", "path": "/data/h[1]", "appearance": "2-per-row-repeat"},
                            {"event": "repeat", "path": "/data/h[1]/r[1]", "appearance": "2-per-row-repeat"},
                            {"event": "group", "path": "/data/k[1]", "appearance": "3-per-row-repeat"},
                            {"event": "new-repeat", "path": "/data/k[1]/r", "added": False},
                            {"event": "group", "path": "/data/m[1]", "appearance": "2-per-row"},
                        ],
                    }
                ]
            }
        ]
    }
    events = normalize(trace)["runs"][0]["trace"][0]["events"]
    assert [event.get("appearance") for event in events] == [
        None,
        "2-per-row-repeat",
        "2-per-row-repeat",
        "2-per-row-repeat",
        "3-per-row-repeat",
        None,
        "2-per-row",
    ]
    answered = {
        "tree": [
            {"type": "sub-group", "repeatable": "false", "style": {"raw": "2-per-row-repeat"}, "children": []},
            {
                "type": "sub-group",
                "repeatable": "false",
                "style": {"raw": "2-per-row-repeat"},
                "children": [{"type": "sub-group", "repeatable": "true", "style": None}],
            },
            {"type": "sub-group", "repeatable": "false", "style": {"raw": "2-per-row"}, "children": []},
            {"type": "question", "style": {"raw": "2-per-row-repeat"}},
        ]
    }
    styles = [node["style"] for node in normalize(answered)["tree"]]
    assert styles == [None, {"raw": "2-per-row-repeat"}, {"raw": "2-per-row"}, {"raw": "2-per-row-repeat"}]
    assert RULE.applies_to("trace") and RULE.applies_to("formplayer") and not RULE.applies_to("form:0.0")


# The readers, run ---------------------------------------------------------------------------------------------


def _grouped(appearance):
    """The form's last control inside a group, of ``appearance`` where one is given, as HQ's form page takes an
    upload."""

    def change(root):
        body = root.find(f"{{{XHTML}}}body")
        last = body[len(body) - 1]
        group = etree.Element(f"{{{etree.QName(last).namespace}}}group")
        if appearance is not None:
            group.set("appearance", appearance)
        body.replace(last, group)
        group.append(last)

    return rewritten(change)


def test_hq_builds_and_core_runs_a_group_alike_with_and_without_a_repeat_row_count(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        plain = app.spell(sources={FORM: _grouped(None)})
        counted = app.spell(sources={FORM: _grouped("2-per-row-repeat")})
        laid_out = app.spell(sources={FORM: _grouped("2-per-row")})
        first, second, alike = runs_alike(app, core_runner, plain.build, counted.build)
        base, third, apart = runs_alike(app, core_runner, plain.build, laid_out.build)

    built = shown(build_differences(plain.build, counted.build))
    assert built, "the two spellings built the same app, so the test shows nothing"
    assert all(path.endswith("/@appearance") for _, path, _ in built), built
    assert shown(alike) == [APPEARANCE], shown(alike)
    assert trace_differences(first, second, rules=(RULE,)) == []
    assert APPEARANCE in shown(apart), "Core's trace held no group appearance, so the control shows nothing"
    assert APPEARANCE in shown(trace_differences(base, third, rules=(RULE,))), "the rule erased another value"


def _readings(app, runner, appearance):
    """The app with its form's last control in a group of ``appearance``, served and read, in a fork of the published
    state."""
    with app.unit.fork():
        app._write(sources={FORM: _grouped(appearance)})
        return served_readings(app, runner, {appearance or "plain": None})[appearance or "plain"]


@pytest.mark.reader("webapps")  # beside Formplayer, which its fixture starts: it reads the client's screens too
def test_formplayer_and_web_apps_show_a_group_alike_with_and_without_a_repeat_row_count(
    rule_documents, hq, core_runner, formplayer_runner
):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        plain = _readings(app, formplayer_runner, None)
        counted = _readings(app, formplayer_runner, "2-per-row-repeat")

    handed = shown(formplayer_differences(plain, counted))
    assert handed, "Formplayer handed both spellings alike, so the test shows nothing of the rule"
    assert all(path.endswith("/style") or path.endswith("/style/raw") for _, path, _ in handed), handed
    assert formplayer_differences(plain, counted, rules=(RULE,)) == []
    assert client_differences(plain, counted) == []
