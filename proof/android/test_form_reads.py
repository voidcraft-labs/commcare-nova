"""What CommCare Android makes of three of a form's reads, on HQ's build of the form Nova publishes.

Contract (``proof/android/README.md``, "Checks"): each test reads HQ's build
of a corpus document as the pull request's own emitter wrote it, published as
the corpus captured it (``proof.rules.conftest.published``, the ``minimum``
export), released and served by HQ's own views
(``proof.formplayer.hq.serve``), and installed from HQ's download of the
release (``observe.release_archive``), on a device whose network is HQ's views
over that state (``observe.app``). The device enters a form from home,
answers it, finishes and saves it with Android's own code, and sends it to
HQ's receiver; ``sent`` holds each instance it sent, as Android wrote it.

- A registration form reads its own new case's id from the session's datum
  (``case_id_new_<type>_0``), which HQ's build also sets the create block's
  ``case_id`` from (``xform.py::XFormCaseBlock.add_create_block``): the
  calculation holds the create block's id on a form completed in one go and
  on one saved incomplete at its first screen, reopened and completed.
- A form's ``<h:title>`` and data node ``name`` are its name in the app's
  default language: the form's title and the name a completed save carries
  follow the title (commcare-android ``FormEntryInstanceState
  .getDefaultFormTitle``), and the header a worker reads from home is the
  menu's own text, the same as before.
- A count over the rows whose answer is ``yes``, its predicate's own node
  printed ``./.`` (the self-reference Vellum refuses in a condition is a
  bare ``.``), decides the dependent answer: accepted where the count is the
  one the validation asks for, refused with Android's own message where it is
  not.
- A label's markdown form, as Android's label renderer draws it (Markwon,
  ``CommCareApplication.getMarkwonInstance``, with no HTML or image plugin):
  ``targeted-preview-android-renders``'s label ``a``, a newline, then
  ``b ![x](y) <b>c</b>`` reads ``a b x c``, the single newline a space, the
  image its alt text and the raw tag gone with its text kept. Preview running
  as Android renders labels the same way (``lib/preview/platform.ts``,
  ``labelMarkdown``); the test asserts what the device drew, so a change in
  Android's rendering fails here before Preview's reading goes stale.
- A label with no markdown form shows its text as written: Android draws a
  label's markdown only where its text holds that form
  (``QuestionWidget.java::setTextFromPrompt``, ``setChoiceText``), so in
  ``targeted-plain-labels`` the question and choice labels Nova wrote from
  ``plainLabel`` show ``*not bold*``, ``# 5``, ``1. first`` and
  ``<b>tag</b>`` as typed, and the same texts with a markdown form show
  formatted, which tells the two halves apart on the same device.
- A help text with no markdown form shows its text as written: Android draws
  a help text's markdown only where its text holds that form
  (``QuestionWidget.java::createHelpLayout``: ``getHelpMultimedia`` of the
  markdown form, else ``getHelpText()``), so in ``targeted-plain-help`` the
  help Nova wrote from ``plainHelp`` shows ``**bold** and a
  [link](https://example.org)`` as typed and the same help with a markdown
  form shows ``bold and a link``. The form holding ``plainText`` writes no
  markdown form on its label, its choice or its help text, so each shows as
  typed. This is the evidence for the Android reading of a help text with no
  markdown form, ``RUNS (as written)``.
- What a number keypad question keeps of what a worker enters into its box
  (``StringNumberWidget``'s key listener, ``DigitsKeyListener(true, true)``
  with the digits, ``.``, ``-``, ``+`` and space accepted): in
  ``targeted-number-keypad``, ``+1 555-1234``, ``1.2.3`` and ``12+`` are
  kept as entered and ``a1`` as ``1``, the reading Preview's ``numberKeypad``
  rule ``keys`` holds for Android (``lib/preview/engine/numberKeypad.ts``).
  ``a1`` is the control: a box that keeps the letter did not pass the widget's
  filter, so the read is no evidence of what the keypad keeps.

The plausible failures: a session read Android does not resolve, or resolves
to another id than the create block's after a reopen (an id drawn again); a
title or saved name in the source language, or a header that moved with the
title; a count Android reads as the row's own node (so the validation
never holds) or as no row; and a label written with no markdown form that
Android formats all the same, or a markdown form it stops reading; a help text written with no markdown form that
Android formats all the same, or one with a markdown form that it shows as typed; and a number keypad that drops a
sign out of place, a second period or a space, which Preview's Android rule would then keep where a phone does not.
"""

from __future__ import annotations

import json
from contextlib import contextmanager

import pytest
from lxml import etree

pytestmark = pytest.mark.reader("android")

REGISTRATION = "expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0"
RENDERS = "targeted-preview-android-renders"
PLAIN = "targeted-plain-labels"
PLAIN_HELP = "targeted-plain-help"
# The text each help, label and choice of ``targeted-plain-help`` holds
# (``proof/targeted/documents/plainHelp.ts::PLAIN_HELP_TEXT``), beside what Markwon draws of its markdown form.
PLAIN_HELP_TEXT = "**bold** and a [link](https://example.org)"
PLAIN_HELP_DRAWN = "bold and a link"
# The form of ``targeted-plain-help`` that holds ``plainText``.
AS_TYPED_FORM = "m0-f1"
KEYPAD = "targeted-number-keypad"
# What a worker enters into the keypad question's box, beside what the box keeps of it.
KEYPAD_ENTRIES = {"+1 555-1234": "+1 5551234", "1.2.3": "1.23", "12+": "12", "a1": "1"}
# The texts each half of ``targeted-plain-labels`` labels its questions and choices with
# (``proof/targeted/documents/textReads.ts::PLAIN_LABEL_TEXTS``), each beside what Markwon draws of its markdown
# form: the emphasis without its asterisks, the heading without its mark, the list item without its number (which
# the list's span draws beside the text, not in it), and the raw tag gone with its text kept.
PLAIN_TEXTS = {"*not bold*": "not bold", "# 5": "5", "1. first": "first", "<b>tag</b>": "tag"}
BILINGUAL = "localization-bilingual"
COUNTED = "container-query-conditional"
CASE = "{http://commcarehq.org/case/transaction/v2}case"
FORM = "m0-f0"
FORM_ENTRY = "FormEntryActivity"
INVALID = "Sorry, this response is invalid!"


@contextmanager
def _served(document):
    """HQ's release of ``document`` as Nova first publishes it, served by HQ's own views, and the archive a
    worker installs of it."""
    from proof.android import observe
    from proof.formplayer import hq as formplayer_hq
    from proof.rules.conftest import published

    with published(document, None) as app, formplayer_hq.serve(app.unit, document, app.app_id) as served:
        yield served, observe.release_archive(served)


def _app(served, archive, label, **steer):
    """The ``app`` request's answer and each instance the device sent HQ."""
    from proof.android import observe
    from proof.observe.record import Blobs

    blobs, sent = Blobs(), []
    found = observe.app(served, blobs, label=label, archive=archive, sent=sent, **steer)
    return blobs.get_json(found["answer"]), sent


def _forms(walk):
    """Each form a walk entered, as its step records it."""
    return [step["form"] for step in walk.get("steps", []) if step.get("screen") == FORM_ENTRY and "form" in step]


def _child(element, name):
    """The child element of ``element`` whose local name is ``name``."""
    (found,) = [child for child in element if isinstance(child.tag, str) and etree.QName(child).localname == name]
    return found


def _entries(form, reference):
    """Every answer the walk gave the question at ``reference``, screen by screen."""
    return [
        entry
        for screen in form.get("screens", [])
        for entry in screen.get("answered", [])
        if entry["reference"] == reference
    ]


def test_a_registration_forms_read_of_its_own_id_is_its_create_blocks_id(android_documents, hq):
    """The form "Register" calculates ``tracking_code`` as ``P-`` and its own new case's id. The instance the
    device sends holds that value with the create block's ``case_id`` after it, on a form completed in one go and
    on one saved incomplete at its first screen, reopened from home and completed."""
    questions = {"/data/case_name": ["Proof name"]}
    with _served(android_documents[REGISTRATION]) as (served, archive):
        whole, sent_whole = _app(served, archive, "whole", commands=[FORM], questions=questions)
        again, sent_again = _app(
            served, archive, "reopened", commands=[], questions=questions, save_incomplete=FORM, reopen=True
        )

    (form,) = _forms(whole["walks"][FORM])
    assert form["saved"]["finishing"] is True, form
    reopened = again["savedIncomplete"]["reopened"]
    assert reopened["screen"] == FORM_ENTRY, reopened
    assert reopened["form"]["saved"]["finishing"] is True, reopened
    for sent in (sent_whole, sent_again):
        (instance,) = sent
        root = etree.fromstring(instance, etree.XMLParser(resolve_entities=False, no_network=True))
        case_id = root.find(CASE).get("case_id")
        assert case_id, instance
        assert _child(root, "tracking_code").text == f"P-{case_id}", instance


def test_the_form_name_is_the_default_language_name_under_an_unchanged_header(android_documents, hq):
    """The app's default language is Spanish and its source English. In the walk the app starts in, the form
    "Registrar" opens under the header ``Aplicación de salud > Pacientes > Registrar``, as before the title moved;
    its title, the title form entry gives a completed save, and the name of the record the save leaves are all
    ``Registrar``."""
    with _served(android_documents[BILINGUAL]) as (served, archive):
        answer, _ = _app(served, archive, "walked")

    starting = {name: walk for name, walk in answer["walks"].items() if "@language:" not in name}
    forms = [form for walk in starting.values() for form in _forms(walk)]
    assert forms, sorted(answer["walks"])
    for form in forms:
        assert form["FormEntryActivity.getHeaderString"] == "Aplicación de salud > Pacientes > Registrar", form
        assert form["formTitle"] == "Registrar", form
        assert form["FormEntryInstanceState.getDefaultFormTitle"] == "Registrar", form
        names = [record["FormRecord.getDisplayName"] for record in form["saved"]["records"]]
        assert "Registrar" in names, form["saved"]


def test_a_count_that_reads_its_own_node_decides_the_dependent_answer(android_documents, hq):
    """``confirm`` is valid when it is ``yes`` and exactly one of the two rows' ``choice`` is ``yes``, a count
    whose predicate reads its own node as ``./.``. With one row ``yes`` the device takes ``confirm`` and saves the
    form; with both, it refuses ``confirm`` with its own message, saves nothing and sends nothing."""
    given = {"/data/show": ["yes"], "/data/confirm": ["yes"], "/data/self_check": ["yes"]}
    one = {**given, "/data/items[1]/item[1]/choice[1]": ["yes"], "/data/items[1]/item[2]/choice[1]": ["no"]}
    both = {**given, "/data/items/item/choice": ["yes"]}
    with _served(android_documents[COUNTED]) as (served, archive):
        matched, sent_matched = _app(served, archive, "one", commands=[FORM], questions=one)
        unmatched, sent_unmatched = _app(
            served, archive, "both", commands=[FORM], questions=both, views=True, type_refused=True
        )

    (form,) = _forms(matched["walks"][FORM])
    confirmed = _entries(form, "/data/confirm[1]")
    assert confirmed and all(entry["given"] == "yes" and "refused" not in entry for entry in confirmed), form
    assert form["saved"]["finishing"] is True, form
    assert len(sent_matched) == 1

    (form,) = _forms(unmatched["walks"][FORM])
    refused = [entry for entry in _entries(form, "/data/confirm[1]") if "refused" in entry]
    assert refused and all("yes: constraint" in entry["refused"] for entry in refused), form
    assert form["saved"]["finishing"] is False, form
    assert INVALID in json.dumps(form["screens"][-1], ensure_ascii=False), form["screens"][-1]
    assert sent_unmatched == []


def _texts(view):
    """Every text a laid-out view shows, in the order its tree holds them."""
    found = [view["text"]] if view.get("text") else []
    for child in view.get("children", ()):
        found.extend(_texts(child))
    return found


def test_a_markdown_label_renders_as_markwon_renders_it(android_documents, hq):
    """The survey "Text" holds one label question, labelled ``a``, a newline, then ``b ![x](y) <b>c</b>``. Its
    screen shows the label's text as ``a b x c``: Markwon joins the single newline with a space, draws the image as
    its alt text, and drops the raw tag and keeps its text, the reading Preview's ``labelMarkdown`` holds for
    Android."""
    with _served(android_documents[RENDERS]) as (served, archive):
        answer, _ = _app(served, archive, "label", commands=[FORM], views=True)

    (form,) = _forms(answer["walks"][FORM])
    (label,) = [
        text
        for screen in form["screens"]
        for text in _texts(screen.get("view") or {})
        if text.startswith("a") and "c" in text
    ]
    assert " ".join(label.split()) == "a b x c", label


def _shown(form, reference):
    """The texts of the one screen whose question is the one at ``reference``, whitespace joined as one space."""
    screens = [
        [" ".join(text.split()) for text in _texts(screen.get("view") or {})]
        for screen in form["screens"]
        if any(question["reference"] == reference for question in screen.get("questions", ()))
    ]
    assert len(screens) == 1, (reference, screens)
    return screens[0]


def test_a_label_without_markdown_renders_its_text_as_written(android_documents, hq):
    """The survey "Labels" labels four questions, and the four choices of a select, with ``*not bold*``, ``# 5``,
    ``1. first`` and ``<b>tag</b>``, written with ``plainLabel`` and so with no markdown form, then the same again
    with one. The plain half's screens show each text as typed, asterisk, hash, number and tag; the markdown half's
    show each formatted, as Markwon draws it, and none as typed."""
    with _served(android_documents[PLAIN]) as (served, archive):
        answer, _ = _app(served, archive, "labels", commands=[FORM], views=True)

    (form,) = _forms(answer["walks"][FORM])
    plain_choices = _shown(form, "/data/plain_choices[1]")
    marked_choices = _shown(form, "/data/marked_choices[1]")
    for index, (written, drawn) in enumerate(PLAIN_TEXTS.items()):
        plain = _shown(form, f"/data/plain_label_{index}[1]")
        assert written in plain, (written, plain)
        marked = _shown(form, f"/data/marked_label_{index}[1]")
        assert drawn in marked and written not in marked, (written, marked)
        assert written in plain_choices, (written, plain_choices)
        assert drawn in marked_choices and written not in marked_choices, (written, marked_choices)


def test_a_help_text_without_markdown_renders_its_text_as_written(android_documents, hq):
    """The survey "Help" asks two questions with the help text ``**bold** and a [link](https://example.org)``, the
    first written with ``plainHelp`` and so with no markdown form, the second with one. Android builds each help's
    view with the question, so each question's screen holds it: the first shows the help as typed, the second shows
    it formatted, as Markwon draws it, and not as typed. The survey "As typed" holds ``plainText``, so its label,
    its choice and its help text show as typed."""
    with _served(android_documents[PLAIN_HELP]) as (served, archive):
        answer, _ = _app(served, archive, "help", commands=[FORM], views=True)
        typed, _ = _app(served, archive, "as-typed", commands=[AS_TYPED_FORM], views=True)

    (help_form,) = _forms(answer["walks"][FORM])
    plain = _shown(help_form, "/data/plain_help[1]")
    assert PLAIN_HELP_TEXT in plain, plain
    marked = _shown(help_form, "/data/marked_help[1]")
    assert PLAIN_HELP_DRAWN in marked and PLAIN_HELP_TEXT not in marked, marked

    (as_typed,) = _forms(typed["walks"][AS_TYPED_FORM])
    shown = _shown(as_typed, "/data/as_typed_choices[1]")
    assert PLAIN_HELP_TEXT in shown and PLAIN_HELP_DRAWN not in shown, shown


def test_a_number_keypad_keeps_what_its_keys_enter(android_documents, hq):
    """The registration "Register" asks a phone number on a number keypad. Entered one character at a time into the
    question's own box, ``+1 555-1234`` is kept as ``+1 5551234``, ``1.2.3`` as ``1.23``, ``12+`` as ``12`` and ``a1``
    as ``1``: the box keeps a plus or a dash only as its first character, one period, every space, and no letter.
    The form takes what the box kept and the instance the device sends holds it."""
    with _served(android_documents[KEYPAD]) as (served, archive):
        walked = {
            entered: _app(
                served,
                archive,
                f"keypad-{index}",
                commands=[FORM],
                questions={"/data/name": ["Proof name"], "/data/phone": [entered]},
                keys=True,
            )
            for index, entered in enumerate(KEYPAD_ENTRIES)
        }

    typed_entries = {}
    for entered in KEYPAD_ENTRIES:
        (form,) = _forms(walked[entered][0]["walks"][FORM])
        (typed_entries[entered],) = [entry for entry in _entries(form, "/data/phone[1]") if "typed" in entry]
    # Every read at once, so a box that keeps something else shows all four of its answers.
    assert {entered: entry["kept"] for entered, entry in typed_entries.items()} == KEYPAD_ENTRIES

    for entered, kept in KEYPAD_ENTRIES.items():
        answer, sent = walked[entered]
        (form,) = _forms(answer["walks"][FORM])
        entry = typed_entries[entered]
        assert entry["typed"] == entered and entry["kept"] == kept, entry
        assert entry["given"] == kept, entry
        assert form["saved"]["finishing"] is True, form
        (instance,) = sent
        root = etree.fromstring(instance, etree.XMLParser(resolve_entities=False, no_network=True))
        assert _child(root, "phone").text == kept, instance
