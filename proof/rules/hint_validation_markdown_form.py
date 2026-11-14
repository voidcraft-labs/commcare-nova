"""A ``markdown`` form on a hint's or a validation message's text, which no runtime reads.

HQ's form builder writes a text's ``<value form="markdown">`` where it loaded
one or the text looked like formatting (Vellum
``src/javaRosa/plugin.js::contributeToModelXML``, ``item.hasMarkdown``), so a
form an HQ author saved can hold one on a hint or a validation message, and
Nova writes none there. Nothing reads it: Android shows a hint through
``FormEntryPrompt.getHintText()`` (commcare-android
``QuestionWidget.java::addHintText``), Formplayer sends the same text
(``PromptToJson.java::parseQuestion``), and a validation message is read
through ``FormEntryPrompt.getConstraintText()``, which asks for no form.

The rule removes the ``markdown`` value of each ``<text>`` whose id a
``<hint>`` names, or a bind's ``jr:constraintMsg`` names as the whole of its
expression (``jr:itext('<id>')``, with the ``<alert>`` that shows the same
message), in every translation, where no other element of the form names the
same id (a label's or a help text's copy is read, so a text that is also one
of those keeps it).
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._xforms import JAVAROSA, XFORMS, is_xform, model, tag
from proof.rules._xpath import tokens

_TEXT = tag(XFORMS, "text")
_VALUE = tag(XFORMS, "value")
_HINT = tag(XFORMS, "hint")
_ALERT = tag(XFORMS, "alert")
_BIND = tag(XFORMS, "bind")
_CONSTRAINT_MESSAGE = tag(JAVAROSA, "constraintMsg")


def _itext_id(expression):
    """The id ``expression`` reads where it is exactly ``jr:itext('<id>')``, read as Core's lexer reads it; None
    otherwise."""
    found = tokens(expression)
    if found is None or [token.kind for token in found] != ["QNAME", "LPAREN", "STR", "RPAREN"]:
        return None
    if found[0].text != "jr:itext":
        return None
    return found[2].text[1:-1]


def _itext_reads(expression):
    """Every id ``expression`` reads through ``jr:itext('<id>')``, anywhere in it, read as Core's lexer reads it;
    None where the lexer port does not read it (it may then read any text)."""
    found = tokens(expression)
    if found is None:
        return None
    return {
        found[index + 2].text[1:-1]
        for index in range(len(found) - 2)
        if found[index].kind == "QNAME"
        and found[index].text == "jr:itext"
        and found[index + 1].kind == "LPAREN"
        and found[index + 2].kind == "STR"
    }


def _unread_ids(root):
    """The itext ids a hint or a validation message names and nothing else of the form reads: an id another
    attribute reads (a label's or a help text's reference, an output, a calculation) keeps its copy, and a form
    with an attribute the lexer port does not read keeps every copy."""
    named, other = set(), set()
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        for attribute, value in element.attrib.items():
            whole = _itext_id(value)
            if whole is not None and (
                (attribute == "ref" and element.tag in (_HINT, _ALERT))
                or (attribute == _CONSTRAINT_MESSAGE and element.tag == _BIND)
            ):
                named.add(whole)
                continue
            if "jr:itext" not in value:
                continue
            reads = _itext_reads(value)
            if reads is None:
                return set()
            other |= reads
    return named - other


def normalize(root):
    form_model = model(root) if is_xform(root) else None
    if form_model is None:
        return root
    unread = _unread_ids(root)
    if not unread:
        return root
    for text in form_model.iter(_TEXT):
        if text.get("id") not in unread:
            continue
        for value in [child for child in text if child.tag == _VALUE and child.get("form") == "markdown"]:
            text.remove(value)
    return root


RULE = SpellingRule(
    "hint-validation-markdown-form",
    ("form:*", "*/form:*"),
    "A markdown form on a hint's or a validation message's text, which no runtime reads"
    " (FormEntryPrompt.getHintText, getConstraintText).",
    normalize,
)
