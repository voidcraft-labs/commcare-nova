"""The rule ``question-appearance-read-alike`` is sound: each question appearance CommCare HQ can hold in a spelling
Nova writes otherwise reads alike in both spellings, on every runtime.

Contract: the rule writes, in place of a question's appearance in Core's trace
and in Formplayer's answers, what Web Apps and Android read of it
(``question_appearance_read_alike.reading``), so two spellings stand alike
exactly where both runtimes read them alike. Its readers are HQ's build, which
writes the form's source as it stands, Core, which reads no question's
appearance and records it as spelled, Formplayer, which hands it to the
client, the Web Apps client (``form_ui.js``, ``entries.js``), and CommCare
Android (``proof/android/predicates.py::test_a_form_reads_each_respelled_question_alike``).
The plausible failures: a runtime reading a word's order, a case, a dropped
word or a count the model takes to be alike, and the rule erasing a spelling a
runtime reads otherwise (``quick compact-2``, Android's grid of 2 columns,
beside ``quick compact``, its automatic grid).

``targeted-plain-help``'s first form, which Core's sessions open from its menu
with no case to choose, is written with six more questions: a single select
written ``compact-2 quick``, another ``compact2``, a text question
``Numbers``, a label ``floating-note``, a text question ``1x2-per-row`` and a
single select ``minimal hint-as-placeholder foo``, as CommCare HQ stored them
in ``hq-question-display``; then as Nova writes each (``quick compact``,
``compact``, ``numbers``, ``floating-hidden``, ``1-per-row``,
``minimal hint-as-placeholder``); then with Nova's first grid written
``quick compact-2``. HQ builds each whole and the builds differ only at those
appearances; Core's sessions over the first two differ only at the question
events' appearances, which the rule erases, while the third stays a
difference under the rule. Formplayer's walks and the Web Apps client's
screens of the first two releases compare equal once the rule reads
Formplayer's answers.
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
from proof.rules.question_appearance_read_alike import RULE, normalize, reading

DOCUMENT = "targeted-plain-help"
FORM = "0.0"
XHTML = "http://www.w3.org/1999/xhtml"
XFORMS = "http://www.w3.org/2002/xforms"
APPEARANCE = ("trace", "/runs/*/trace/*/events/*/appearance", "changed")
# Each question, its control, and its appearance as HQ stored it and as Nova writes it.
QUESTIONS = (
    ("grid", "select1", "compact-2 quick", "quick compact"),
    ("single", "select1", "compact2", "compact"),
    ("keypad", "input", "Numbers", "numbers"),
    ("note", "trigger", "floating-note", "floating-hidden"),
    ("row", "input", "1x2-per-row", "1-per-row"),
    ("dropdown", "select1", "minimal hint-as-placeholder foo", "minimal hint-as-placeholder"),
)
STORED = {name: stored for name, _, stored, _ in QUESTIONS}
NOVA = {name: nova for name, _, _, nova in QUESTIONS}
COUNTED = {**NOVA, "grid": "quick compact-2"}


# The rule over values alone ------------------------------------------------------------------------------------


def test_each_respelling_reads_alike_and_each_control_does_not():
    controls = {"select1": "select1", "input": "text", "trigger": "trigger"}
    for name, control, stored, nova in QUESTIONS:
        assert reading(controls[control], stored) == reading(controls[control], nova), name
    for control, one, other in (
        ("select1", "quick compact-2", "quick compact"),  # Android: 2 columns, or automatic
        ("select1", "compact-2", "compact"),
        ("select1", "combobox fuzzy", "fuzzy combobox"),  # Web Apps: the second word is the match
        ("text", "2-per-row", "3-per-row"),  # Web Apps: 6 or 4 grid columns
        ("text", "numbers", "short"),
        ("trigger", "floating-good", "floating-hidden"),  # Android: a banner, or none
        ("trigger", "minimal", "floating-hidden"),
    ):
        assert reading(control, one) != reading(control, other), (one, other)
    assert reading("text", "intent:scan") is None and reading("date", "ethiopian") is None
    assert reading("text", "numbers  ") is None


def test_the_rule_writes_a_question_s_reading_in_core_s_trace_and_formplayer_s_answers():
    events = [
        {"event": "question", "control": "select1", "dataType": "choice", "appearance": "compact-2 quick"},
        {"event": "question", "control": "select1", "dataType": "choice", "appearance": "quick compact"},
        {"event": "question", "control": "input", "dataType": "date", "appearance": "Ethiopian"},
        {"event": "group", "appearance": "compact-2 quick"},
    ]
    normalized = normalize({"runs": [{"trace": [{"events": events}]}]})["runs"][0]["trace"][0]["events"]
    assert normalized[0]["appearance"] == normalized[1]["appearance"] != "quick compact"
    assert normalized[2]["appearance"] == "Ethiopian" and normalized[3]["appearance"] == "compact-2 quick"
    tree = normalize(
        {"tree": [{"type": "question", "datatype": "str", "style": {"raw": "Numbers"}},
                  {"type": "question", "datatype": "str", "style": {"raw": "numbers"}}]}
    )["tree"]
    assert tree[0]["style"] == tree[1]["style"] and tree[0]["style"]["raw"] != "numbers"
    assert RULE.applies_to("trace") and RULE.applies_to("formplayer") and not RULE.applies_to("form:0.0")


# The readers, run ---------------------------------------------------------------------------------------------


def _with_questions(appearances):
    """The form with six more questions at its end, each of ``appearances``, as HQ's form page takes an upload."""

    def change(root):
        model = root.find(f".//{{{XFORMS}}}model")
        data = model.find(f"{{{XFORMS}}}instance")[0]
        namespace = etree.QName(data).namespace
        body = root.find(f"{{{XHTML}}}body")
        for name, control, _, _ in QUESTIONS:
            etree.SubElement(data, f"{{{namespace}}}{name}" if namespace else name)
            if control != "trigger":
                etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset=f"/data/{name}", type="xsd:string")
            element = etree.SubElement(body, f"{{{XFORMS}}}{control}", ref=f"/data/{name}")
            element.set("appearance", appearances[name])
            etree.SubElement(element, f"{{{XFORMS}}}label").text = name
            if control == "select1":
                for value in ("north", "south"):
                    item = etree.SubElement(element, f"{{{XFORMS}}}item")
                    etree.SubElement(item, f"{{{XFORMS}}}label").text = value.title()
                    etree.SubElement(item, f"{{{XFORMS}}}value").text = value
        # The binds stand before the model's own text, where HQ's form builder writes them.
        itext = model.find(f"{{{XFORMS}}}itext")
        if itext is not None:
            model.remove(itext)
            model.append(itext)

    return rewritten(change)


def test_hq_builds_and_core_runs_each_respelled_question_alike(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        stored = app.spell(sources={FORM: _with_questions(STORED)})
        nova = app.spell(sources={FORM: _with_questions(NOVA)})
        counted = app.spell(sources={FORM: _with_questions(COUNTED)})
        first, second, alike = runs_alike(app, core_runner, stored.build, nova.build)
        base, third, apart = runs_alike(app, core_runner, nova.build, counted.build)

    built = shown(build_differences(stored.build, nova.build))
    assert built, "the two spellings built the same app, so the test shows nothing"
    assert all(path.endswith("/@appearance") for _, path, _ in built), built
    assert shown(alike) == [APPEARANCE], shown(alike)
    assert trace_differences(first, second, rules=(RULE,)) == []
    assert APPEARANCE in shown(apart), "Core's trace held no question appearance, so the control shows nothing"
    assert APPEARANCE in shown(trace_differences(base, third, rules=(RULE,))), "the rule erased another value"


def _readings(app, runner, name, appearances):
    """The app with its form's six more questions of ``appearances``, served and read, in a fork of the published
    state."""
    with app.unit.fork():
        app._write(sources={FORM: _with_questions(appearances)})
        return served_readings(app, runner, {name: None})[name]


@pytest.mark.reader("webapps")  # beside Formplayer, which its fixture starts: it reads the client's screens too
def test_formplayer_and_web_apps_show_each_respelled_question_alike(
    rule_documents, hq, core_runner, formplayer_runner
):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        stored = _readings(app, formplayer_runner, "stored", STORED)
        nova = _readings(app, formplayer_runner, "nova", NOVA)

    handed = shown(formplayer_differences(stored, nova))
    assert handed, "Formplayer handed both spellings alike, so the test shows nothing of the rule"
    assert all(path.endswith("/style/raw") for _, path, _ in handed), handed
    assert formplayer_differences(stored, nova, rules=(RULE,)) == []
    assert client_differences(stored, nova) == []
