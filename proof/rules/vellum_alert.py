"""Vellum's ``<alert>`` naming the same plain message as the question's bind's ``jr:constraintMsg``.

Vellum's save writes a question's validation message twice: on its bind as
``jr:constraintMsg="jr:itext('<id>')"``, as Nova writes it, and as an
``<alert ref="jr:itext('<id>')"/>`` in the question's control
(``Vellum/src/writer.js::createAlert``, and ``mugs/defaultOptions.js::
getBindList`` for the bind). Core reads the message a person sees on a
refused answer from the alert where there is one, else from the bind
(commcare-core ``FormEntryPrompt.getConstraintText``, which Android's
``FormEntryActivity`` and Formplayer's ``JsonActionUtils`` call). The two
readings differ in three ways:

- the alert's text is read through ``localizeText`` and
  ``FormEntryCaption.getQuestionText``, which takes the text's ``long``
  form where it has one (``getIText(id, "long")``) and its default form
  only otherwise; the bind's ``jr:itext('<id>')`` reads the default form
  alone (``FormDef.initEvalContext``'s ``jr:itext``, ``Localizer.getText``);
- the alert's text has its arguments filled in the question's context
  (``substituteStringArgs``, ``FormDef.fillTemplateString``): each
  ``<output>`` of it, which the parser writes as ``${n}``
  (``XFormParser.getLabel``), and any ``${n}`` its characters hold, which
  names the form's ``n``-th output; the bind's text is filled with none;
- the locale each reads in is the same: both read the current locale's
  table, which holds the default locale's texts beneath its own
  (``Localizer.getLocaleData``).

So the two read alike exactly when the text has, in no language, a ``long``
form, an ``<output>`` or a ``${``: then both are the localizer's default
form of ``<id>``.

The rule removes an ``<alert>`` from a control where the alert is an empty
element whose ``ref`` names a text as Core's form parser reads it
(``XFormParser.parseHelperText``: the ``ref`` starts with ``jr:itext('``
and ends with ``')``, and the id lies between), the control's ``ref`` and
every bind's ``nodeset`` are paths of plain steps (``_xpath.plain_path``,
so a node is named by one text alone), the control's bind (the one bind
whose ``nodeset`` is the control's ``ref``) carries ``jr:constraintMsg``
spelled exactly ``jr:itext('<id>')`` for the same id, and no ``<text
id="<id>">`` of the form holds a ``long`` form, an ``<output>`` or a ``${``.
An alert that holds anything, names another text or a text read otherwise,
or stands without the bind's message is a different message, and stays.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._xforms import JAVAROSA, XFORMS, body, is_element, is_xform, model, own_attributes, tag
from proof.rules._xpath import plain_path

_ALERT = tag(XFORMS, "alert")
_BIND = tag(XFORMS, "bind")
_TEXT = tag(XFORMS, "text")
_VALUE = tag(XFORMS, "value")
_OUTPUT = tag(XFORMS, "output")
_CONSTRAINT_MESSAGE = tag(JAVAROSA, "constraintMsg")
# How Core's form parser reads a text reference (``XFormParser.ITEXT_OPEN``, ``ITEXT_CLOSE``).
_ITEXT_OPEN, _ITEXT_CLOSE = "jr:itext('", "')"
# The text form Core reads an alert's text in first (``FormEntryCaption.TEXT_FORM_LONG``).
_LONG = "long"


def _alert_text_id(reference):
    """The text id Core's form parser reads from an alert's ``ref`` (``XFormParser.parseHelperText``), or None
    where it reads none or an id holding a quote, which no ``jr:itext`` call spells alike."""
    if not isinstance(reference, str) or not (reference.startswith(_ITEXT_OPEN) and reference.endswith(_ITEXT_CLOSE)):
        return None
    text_id = reference[len(_ITEXT_OPEN) : reference.index(_ITEXT_CLOSE)]
    return text_id if text_id and "'" not in text_id else None


def _read_otherwise(form_model):
    """The ids of the texts the alert reads otherwise than the bind: any with a ``long`` form, an ``<output>`` or
    a ``${`` in some language."""
    found = set()
    for text in form_model.iter(_TEXT):
        for value in text.iter(_VALUE):
            if (
                value.get("form") == _LONG
                or value.find(f".//{_OUTPUT}") is not None
                or "${" in "".join(value.itertext())
            ):
                found.add(text.get("id"))
    return found


def _plain_alert(alert):
    return (
        len(alert) == 0
        and not (alert.text or "").strip()
        and set(own_attributes(alert)) == {"ref"}
        and _alert_text_id(alert.get("ref")) is not None
    )


def normalize(root):
    form_model = model(root) if is_xform(root) else None
    form_body = body(root) if form_model is not None else None
    if form_body is None:
        return root
    binds = {}
    for bind in form_model.iter(_BIND):
        binds.setdefault(bind.get("nodeset"), []).append(bind)
    if not all(plain_path(nodeset) for nodeset in binds):
        return root
    read_otherwise = _read_otherwise(form_model)
    for alert in list(form_body.iter(_ALERT)):
        control = alert.getparent()
        if control is None or not is_element(control) or not _plain_alert(alert):
            continue
        message = _alert_text_id(alert.get("ref"))
        named = binds.get(control.get("ref"), [])
        if (
            plain_path(control.get("ref"))
            and len(named) == 1
            and named[0].get(_CONSTRAINT_MESSAGE) == f"{_ITEXT_OPEN}{message}{_ITEXT_CLOSE}"
            and message not in read_otherwise
        ):
            control.remove(alert)
    return root


RULE = SpellingRule(
    "vellum-alert",
    ("form:*", "*/form:*"),
    "Vellum's <alert> naming the bind's own jr:constraintMsg text, which has no long form, <output> or ${"
    " (FormEntryPrompt.getConstraintText reads both alike).",
    normalize,
)
