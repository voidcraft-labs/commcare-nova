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
question's hint and every refused answer's validation message, compare
equal. A label's copy taken away is a difference the rule leaves.
"""

from __future__ import annotations

import copy

from proof.rules.conftest import build_differences, published, rewritten, runs_alike, shown, stored_differences
from proof.rules.hint_validation_markdown_form import RULE

DOCUMENT = "targeted-plain-help"
XF = "{http://www.w3.org/2002/xforms}"
JR = "{http://openrosa.org/javarosa}"


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


def test_core_reads_a_hint_and_a_validation_message_alike_whatever_their_copies(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_with_copies)})
        unlabelled = app.spell(sources={"0.0": rewritten(_without_label_copy)})
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)

    assert shown(build_differences(nova.build, saved.build)), "the copies made no difference to HQ's build"
    assert build_differences(nova.build, saved.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert shown(stored_differences(nova.stored, unlabelled.stored, rules=(RULE,)))
