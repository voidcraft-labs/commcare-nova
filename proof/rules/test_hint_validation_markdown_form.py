"""The rule ``hint-validation-markdown-form`` is sound: no runtime reads a hint's or a validation message's copy.

Contract: the rule erases a ``<value form="markdown">`` on a hint's or a
validation message's text, which HQ's form builder can hold and Nova writes
none of. Its readers are HQ's build, which carries the copy into the form it
serves, and Core, whose prompts give a hint's and a validation message's text
(``FormEntryPrompt.getHintText``, ``getConstraintText``); no other reader is
owed one, because Android and Formplayer read those texts through the same
two calls. The plausible failures: Core reading the copy (so a worker would
see another text where the form builder saved one), and the rule erasing a
copy some runtime reads, a label's.

``targeted-plain-help``'s first form, whose first question holds a hint and a
validation message typed with formatting symbols, is published as Nova writes
it (no copy) and with a copy of each hint's and validation message's text in
every translation: HQ builds both spellings whole, and its builds differ by
the copies alone, which the rule erases; Core's sessions, which record each
question's hint (``getHintText``), compare equal; and Core refuses the answer
the question's validation refuses with the same validation message
(``getConstraintText``) in every language each build holds. The sessions
answer from the lane's table, which the question accepts at once, so the
message is read where Core is handed the refused answer itself
(``evaluate``'s constraint check, as a targeted document's expectations ask
it). Each read is first held to the typed text, so a session that never
reached the question or a check that read no message cannot pass as alike. A
label's copy taken away is a difference the rule leaves.
"""

from __future__ import annotations

import base64
import copy

from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE
from proof.rules.conftest import build_differences, published, rewritten, runs_alike, shown, stored_differences
from proof.rules.hint_validation_markdown_form import RULE

DOCUMENT = "targeted-plain-help"
XF = "{http://www.w3.org/2002/xforms}"
JR = "{http://openrosa.org/javarosa}"
# The first form's file in a build, and its question holding the hint and the validation message.
FORM_FILE = "modules-0/forms-0.xml"
QUESTION = "/data/plain_help"
# What the hint and the validation message hold (``proof/targeted/documents/plainHelp.ts::PLAIN_HELP_TEXT``), and
# the one answer the question's validation (``. != 'invalid'``) refuses.
TYPED = "**bold** and a [link](https://example.org)"
REFUSED = "invalid"


def _itext_id(reference):
    """The id of an exact ``jr:itext('<id>')`` reference, as the form Nova writes spells it."""
    prefix, suffix = "jr:itext('", "')"
    assert reference.startswith(prefix) and reference.endswith(suffix), reference
    return reference[len(prefix) : -len(suffix)]


def _copied(root, ids):
    """A ``markdown`` copy of each named text's default value, in every translation."""
    texts = [text for text in root.iter(f"{XF}text") if text.get("id") in ids]
    assert texts, ids
    for text in texts:
        (plain,) = [value for value in text if value.tag == f"{XF}value" and value.get("form") is None]
        assert not any(value.get("form") == "markdown" for value in text), text.get("id")
        markdown = copy.deepcopy(plain)
        markdown.set("form", "markdown")
        plain.addnext(markdown)


def _hint_and_message_ids(root):
    hints = {_itext_id(hint.get("ref")) for hint in root.iter(f"{XF}hint")}
    messages = {
        _itext_id(bind.get(f"{JR}constraintMsg"))
        for bind in root.iter(f"{XF}bind")
        if bind.get(f"{JR}constraintMsg") is not None
    }
    assert hints and messages, (hints, messages)
    return hints | messages


def _with_copies(root):
    _copied(root, _hint_and_message_ids(root))


def _without_label_copy(root):
    """The first label's text with its ``markdown`` copy removed, a copy Core reads."""
    labels = {
        _itext_id(label.get("ref"))
        for label in root.iter(f"{XF}label")
        if (label.get("ref") or "").startswith("jr:itext(")
    }
    text = next(
        text
        for text in root.iter(f"{XF}text")
        if text.get("id") in labels and any(value.get("form") == "markdown" for value in text)
    )
    for value in [value for value in text if value.get("form") == "markdown"]:
        text.remove(value)


def _hints(trace):
    """The hint Core's sessions read at the question, once for each time a session showed it."""
    return [
        event.get("hint")
        for each in trace["runs"]
        for step in each["trace"]
        for event in step.get("events") or ()
        if event.get("event") == "question" and event.get("dataPath") == QUESTION
    ]


def _validation_messages(core_runner, built):
    """Core's verdict on the refused answer, with its validation message, in each language the built form holds:
    ``{language: (result, message)}``."""
    form = built.files[FORM_FILE]
    languages = [translation.get("lang") for translation in etree.fromstring(form).iter(f"{XF}translation")]
    assert languages, "the built form holds no translation"
    found = {}
    for language in languages:
        result = core_runner.evaluate(
            restoreBase64=base64.b64encode(TEMPLATE_RESTORE.read_bytes()).decode("ascii"),
            formBase64=base64.b64encode(form).decode("ascii"),
            locale=language,
            constraintChecks=[{"path": QUESTION, "value": REFUSED}],
        )
        (check,) = result["constraints"]
        found[language] = (check["result"], check.get("constraintText"))
    return found


def test_core_reads_a_hint_and_a_validation_message_alike_whatever_their_copies(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_with_copies)})
        unlabelled = app.spell(sources={"0.0": rewritten(_without_label_copy)})
        nova_run, saved_run, alike = runs_alike(app, core_runner, nova.build, saved.build)
    messages = _validation_messages(core_runner, nova.build)
    saved_messages = _validation_messages(core_runner, saved.build)

    assert shown(build_differences(nova.build, saved.build)), "the copies made no difference to HQ's build"
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    # The sessions showed the question and read its hint as typed, on both spellings.
    hints = _hints(nova_run.trace)
    assert hints and set(hints) == {TYPED}, hints
    assert _hints(saved_run.trace) == hints
    assert alike == [], shown(alike)
    # Core refused the answer and read the validation message as typed in every language, on both spellings.
    assert messages and set(messages.values()) == {("constraint", TYPED)}, messages
    assert saved_messages == messages
    assert shown(stored_differences(nova.stored, unlabelled.stored, rules=(RULE,)))
