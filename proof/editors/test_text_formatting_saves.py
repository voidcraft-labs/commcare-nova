"""HQ's form builder keeps a hint and a validation message without a markdown form, and keeps a form's text
formatting off, through its saves.

Contract: Nova writes no ``<value form="markdown">`` on a hint's or a
validation message's text, and a form whose text formatting is off carries
``vellum:ignore="markdown"`` on ``h:html`` with no markdown form on any text.
HQ's form builder writes a text's markdown form only where it read one
(Vellum ``src/javaRosa/plugin.js::contributeToModelXML``, ``item.hasMarkdown``,
which ``parseXForm`` sets only from a markdown form it read), and none in a
form whose ``vellum:ignore`` names ``markdown``, which it reads as the form's
Disable Text Formatting and writes back (``src/parser.js::parseXForm``,
``src/writer.js::write_html_tag_boilerplate``). So a save leaves both as Nova
wrote them.

Proof 4 cannot show this: it compares each save with the spelling rules
applied, and ``hint-validation-markdown-form`` erases a markdown form on a
hint or a validation message, as ``vellum-attributes`` erases every attribute
in Vellum's namespace, both being spellings no runtime reads. Whether the form
builder adds the one or drops the other is what an HQ author's next edit
sees, so it is read here from what HQ stores, before any rule.

``targeted-plain-help`` is published as Nova's publish leaves it, and each of
its two forms is opened and saved in HQ's form builder twice. After each save,
the form "Help" holds no markdown form on its hint's or its validation
message's text, and none on the help of the question holding ``plainHelp``,
while the other question's help keeps the one Nova wrote; and the form "As
typed" carries ``vellum:ignore`` naming ``markdown`` and no markdown form at
all.

The plausible failures: a save that adds a markdown form to a hint or a
validation message (the form builder treating its text as formatting), a save
that drops Disable Text Formatting (HQ's form builder would then format every
text an author edits next), and a save that writes nothing back at all (the
kept markdown form of the second help rules that out).
"""

from __future__ import annotations

import dataclasses

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, record_timing, write_evidence
from proof.hq import operations
from proof.hq.check import hq_check

DOCUMENT = "targeted-plain-help"
XF = "{http://www.w3.org/2002/xforms}"
JR = "{http://openrosa.org/javarosa}"
VELLUM = "{http://commcarehq.org/xforms/vellum}"
# The question holding ``plainHelp``, and the one whose help Nova writes with a markdown form.
PLAIN_HELP = "/data/plain_help"
MARKED_HELP = "/data/marked_help"
SAVES = 2


def _itext_id(reference):
    """The id of an exact ``jr:itext('<id>')`` reference, as Nova and HQ's form builder spell it."""
    prefix, suffix = "jr:itext('", "')"
    assert reference.startswith(prefix) and reference.endswith(suffix), reference
    return reference[len(prefix) : -len(suffix)]


def _markdown_ids(root):
    """The ids of every text with a markdown form, in any translation."""
    return {
        text.get("id")
        for text in root.iter(f"{XF}text")
        if any(value.get("form") == "markdown" for value in text.iter(f"{XF}value"))
    }


def _help_id(root, path):
    (control,) = [element for element in root.iter() if isinstance(element.tag, str) and element.get("ref") == path]
    (help_text,) = control.findall(f"{XF}help")
    return _itext_id(help_text.get("ref"))


def _help_form(source):
    """What the form "Help" holds: the hint and validation message ids holding a markdown form, and whether each
    question's help holds one."""
    root = etree.fromstring(source.encode("utf-8"))
    hints = {_itext_id(hint.get("ref")) for hint in root.iter(f"{XF}hint")}
    messages = {
        _itext_id(bind.get(f"{JR}constraintMsg"))
        for bind in root.iter(f"{XF}bind")
        if bind.get(f"{JR}constraintMsg") is not None
    }
    assert hints and messages, (hints, messages)
    marked = _markdown_ids(root)
    return {
        "hintAndMessageMarkdown": sorted((hints | messages) & marked),
        "plainHelpMarkdown": _help_id(root, PLAIN_HELP) in marked,
        "markedHelpMarkdown": _help_id(root, MARKED_HELP) in marked,
    }


def _as_typed_form(source):
    """What the form "As typed" holds: whether ``vellum:ignore`` names ``markdown`` (HQ's form builder's Disable Text
    Formatting), and the ids holding a markdown form."""
    root = etree.fromstring(source.encode("utf-8"))
    return {
        "ignoresMarkdown": "markdown" in (root.get(f"{VELLUM}ignore") or "").split(),
        "markdown": sorted(_markdown_ids(root)),
    }


def test_form_builder_saves_keep_hints_and_messages_plain_and_a_forms_formatting_off(hq, editor_driver):
    from proof.observe import publish

    export = corpus_document(DOCUMENT).exports["minimum"]
    configuration = export.configuration.hq()
    configuration = dataclasses.replace(configuration, privileges=configuration.privileges | {"CLOUDCARE"})
    with hq_check(configuration) as (state, _):
        app_id, refusal, _ = publish.create(state, export)
        assert refusal is None, refusal
        help_form, as_typed = (form.unique_id for form in operations.held_app(state, app_id).modules[0].forms)

        def held():
            app = operations.held_app(state, app_id)
            return {
                "help": _help_form(app.get_form(help_form).source),
                "asTyped": _as_typed_form(app.get_form(as_typed).source),
            }

        found = [held()]
        for _ in range(SAVES):
            for form_id in (help_form, as_typed):
                run = vellum.open_and_save(editor_driver, state, app_id, form_id)
                record_timing("vellum_open", run.seconds["open"])
                record_timing("vellum_save", run.seconds["save"])
                assert run.loaded and run.saved and run.save_button == "saved", (run.load_error, run.save_refusal)
            found.append(held())

    write_evidence("text-formatting-saves", {"published": found[0], "saves": found[1:]})
    expected = {
        "help": {"hintAndMessageMarkdown": [], "plainHelpMarkdown": False, "markedHelpMarkdown": True},
        "asTyped": {"ignoresMarkdown": True, "markdown": []},
    }
    for index, state_held in enumerate(found):
        assert state_held == expected, (index, state_held)
