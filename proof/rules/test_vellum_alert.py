"""The rule ``vellum-alert`` is sound where it holds: Core shows a refused answer the same message with or without
Vellum's ``<alert>``, where the message has no ``long`` form, ``<output>`` or ``${``.

Contract: the rule erases an ``<alert>`` naming the same text as its bind's
``jr:constraintMsg`` where that text is read alike both ways, as Vellum's
save writes one into every validated question's control. HQ's build
carries the alert, so the proof is Core's: the plausible failures are Core
showing another message for either spelling (so a save would change what a
person sees on a refused answer), and the rule erasing an alert whose text
Core reads otherwise from the alert than from the bind: an ``<output>``,
which Core fills from the alert and leaves unfilled from the bind
(``FormDef.initEvalContext``'s ``jr:itext``); a ``${n}`` the text's
characters hold, which Core fills from the alert with the form's ``n``-th
output (``FormDef.fillTemplateString``) and shows as it stands from the
bind; and a ``long`` form, which Core shows from the alert in place of the
default form the bind reads (``FormEntryCaption.getQuestionText``).

A corpus document whose question validates its answer with a plain message
is published, then explicitly spelled without and with an alert, independent
of whether Nova already emits one: HQ's builds differ by
the alert alone, which the rule erases; Core's sessions compare equal, and
Core gives a refused answer the same message from both built forms, asked
both ways its runtimes ask (``getConstraintText`` with and without the
attempted answer). With an ``<output>`` in the message, with a ``${0}`` in
its characters while another text of the form holds an ``<output>``, and
with a ``long`` form beside it, the two messages differ, and the rule leaves
the alert.
"""

from __future__ import annotations

import base64

from lxml import etree

from proof.checks import casedata
from proof.rules.conftest import (
    build_differences,
    published,
    restore,
    rewritten,
    runs_alike,
    shown,
    stored_differences,
)
from proof.rules.vellum_alert import RULE

DOCUMENT = "expander-form-hashtag-expansion-emits-validate-msg-as-an-fe6783cb-0"
FORM = "modules-0/forms-0.xml"
XF = "{http://www.w3.org/2002/xforms}"
JR = "{http://openrosa.org/javarosa}"
REFUSED = "200"
LONG = "A longer validation message"


def _validated(root):
    binds = [bind for bind in root.iter(f"{XF}bind") if bind.get(f"{JR}constraintMsg")]
    assert binds, "no question of the form carries a validation message"
    return binds


def _set_alerts(root, present):
    for bind in _validated(root):
        control = next(
            element
            for element in root.iter(f"{XF}*")
            if element.get("ref") == bind.get("nodeset") and element.tag != f"{XF}bind"
        )
        for existing in list(control.findall(f"{XF}alert")):
            control.remove(existing)
        if present:
            etree.SubElement(control, f"{XF}alert", ref=bind.get(f"{JR}constraintMsg"))


def _with_alert(root):
    _set_alerts(root, True)


def _without_alert(root):
    _set_alerts(root, False)


def _with_output(alert):
    def change(root):
        for bind in _validated(root):
            text_id = bind.get(f"{JR}constraintMsg")[len("jr:itext('") : -len("')")]
            for text in root.iter(f"{XF}text"):
                if text.get("id") == text_id:
                    for value in text:
                        etree.SubElement(value, f"{XF}output", value=bind.get("nodeset"))
        _set_alerts(root, alert)

    return change


FILLED = "filled"


def _with_placeholder(alert):
    """The message's characters ending in ``${0}``, and the form's first output in a text of its own."""

    def change(root):
        translations = list(root.iter(f"{XF}translation"))
        for bind in _validated(root):
            text_id = bind.get(f"{JR}constraintMsg")[len("jr:itext('") : -len("')")]
            for text in root.iter(f"{XF}text"):
                if text.get("id") == text_id:
                    for value in text:
                        value.text = f"{value.text} ${{0}}"
        assert not any(True for _ in root.iter(f"{XF}output")), "the form holds an output already"
        for translation in translations:
            value = etree.SubElement(etree.SubElement(translation, f"{XF}text", id="proof-output"), f"{XF}value")
            etree.SubElement(value, f"{XF}output", value=f"'{FILLED}'")
        _set_alerts(root, alert)

    return change


def _with_long(alert):
    def change(root):
        for bind in _validated(root):
            text_id = bind.get(f"{JR}constraintMsg")[len("jr:itext('") : -len("')")]
            for text in root.iter(f"{XF}text"):
                if text.get("id") == text_id:
                    etree.SubElement(text, f"{XF}value", form="long").text = LONG
        _set_alerts(root, alert)

    return change


def _messages(core_runner, outcome, restored):
    """Core's message for a refused answer to every validated question of the built form, asked as a person's
    answer (``getConstraintText()``) and as a check of the attempted answer (``getConstraintText(answer)``)."""
    form = outcome.files[FORM]
    paths = [bind.get("nodeset") for bind in _validated(etree.fromstring(form))]
    found = core_runner.evaluate(
        restoreBase64=base64.b64encode(restored).decode("ascii"),
        formBase64=base64.b64encode(form).decode("ascii"),
        answers=[{"path": path, "value": REFUSED} for path in paths],
        constraintChecks=[{"path": path, "value": REFUSED} for path in paths],
    )
    answered = [(a["result"], a.get("constraintText")) for a in found["answers"]]
    checked = [(c["result"], c.get("constraintText")) for c in found["constraints"]]
    assert all(result == "constraint" for result, _ in answered + checked), (answered, checked)
    return answered, checked


def test_core_shows_the_same_plain_message_with_or_without_the_alert(rule_documents, hq, core_runner):
    document = rule_documents[DOCUMENT]
    with published(document, core_runner) as app:
        unalerted = app.spell(sources={"0.0": rewritten(_without_alert)})
        alerted = app.spell(sources={"0.0": rewritten(_with_alert)})
        output = app.spell(sources={"0.0": rewritten(_with_output(alert=False))})
        output_alert = app.spell(sources={"0.0": rewritten(_with_output(alert=True))})
        placeholder = app.spell(sources={"0.0": rewritten(_with_placeholder(alert=False))})
        placeholder_alert = app.spell(sources={"0.0": rewritten(_with_placeholder(alert=True))})
        long = app.spell(sources={"0.0": rewritten(_with_long(alert=False))})
        long_alert = app.spell(sources={"0.0": rewritten(_with_long(alert=True))})
        _, _, alike = runs_alike(app, core_runner, unalerted.build, alerted.build)
        restored = restore(app, casedata.case_database(document.document))
        plain = [_messages(core_runner, spelled.build, restored) for spelled in (unalerted, alerted)]
        filled = [_messages(core_runner, spelled.build, restored) for spelled in (output, output_alert)]
        templated = [_messages(core_runner, spelled.build, restored) for spelled in (placeholder, placeholder_alert)]
        longer = [_messages(core_runner, spelled.build, restored) for spelled in (long, long_alert)]

    built = shown(build_differences(unalerted.build, alerted.build))
    assert built and all("/alert[" in path for _, path, _ in built), built
    assert build_differences(unalerted.build, alerted.build, rules=(RULE,)) == []
    assert stored_differences(unalerted.stored, alerted.stored, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert plain[0] == plain[1] and all(text for _, text in plain[0][0]), plain
    assert filled[0] != filled[1], filled
    assert shown(stored_differences(output.stored, output_alert.stored, rules=(RULE,)))
    # The bind shows the characters as they stand, the alert fills them with the form's first output.
    shows = [{text for asked in spelled for _, text in asked} for spelled in templated]
    assert all(text.endswith(" ${0}") for text in shows[0]), templated
    assert all(text.endswith(f" {FILLED}") for text in shows[1]), templated
    assert shown(stored_differences(placeholder.stored, placeholder_alert.stored, rules=(RULE,)))
    # The bind reads the default form, the alert the long one.
    assert longer[0] == plain[0] and {text for asked in longer[1] for _, text in asked} == {LONG}, longer
    assert shown(stored_differences(long.stored, long_alert.stored, rules=(RULE,)))
