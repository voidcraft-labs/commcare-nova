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
- A label's value is formatted with the label: ``targeted-styled-value``'s
  question is labelled ``Styled `` then a Hidden Value calculated as
  ``'**x**'``, which Core splices into the label's markdown form as written
  (``FormDef.fillTemplateString``) before Markwon draws it, so the screen
  shows ``Styled x`` with the value in bold and no asterisk, the order
  Preview plays (``lib/preview/engine/labelRefs.ts``).
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
Android formats all the same, or a markdown form it stops reading; a value spliced into a label after its
formatting, so its asterisks show; a help text written with no markdown form that
Android formats all the same, or one with a markdown form that it shows as typed; and a number keypad that drops a
sign out of place, a second period or a space, which Preview's Android rule would then keep where a phone does not.
"""

from __future__ import annotations

import io
import json
import zipfile
from contextlib import contextmanager

import pytest
from lxml import etree

pytestmark = pytest.mark.reader("android")

REGISTRATION = "expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0"
RENDERS = "targeted-preview-android-renders"
STYLED = "targeted-styled-value"
# The label of ``targeted-styled-value``'s question: ``Styled `` then a Hidden Value calculated as ``'**x**'``
# (``proof/targeted/documents/styledValue.ts::STYLED_LABEL_LEAD``, ``STYLED_VALUE``), as Core splices it, and as
# Markwon draws it once spliced.
STYLED_SPLICED = "Styled **x**"
STYLED_DRAWN = "Styled x"
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
def _served(document, publication=None, *, database=None):
    """HQ's release of ``document`` as Nova first publishes it, served by HQ's own views, and the archive a
    worker installs of it."""
    from proof.android import observe
    from proof.formplayer import hq as formplayer_hq
    from proof.rules.conftest import published

    if publication is not None:
        from proof.webapps.hq import authored_project

        with authored_project(document, publication) as project, project.released(None) as served:
            yield served, observe.release_archive(served)
        return

    with published(document, None) as app, formplayer_hq.serve(app.unit, document, app.app_id, database=database) as served:
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


def _completed_walk(answer, command):
    walk = answer["walks"][command]
    # The reader returns the native exception as data so other walks can
    # continue. Retain that exception, or the actual stopping screen,
    # before indexing the controls whose absence is only a consequence.
    assert "raised" not in walk, json.dumps(walk.get("raised"), ensure_ascii=False)
    forms = _forms(walk)
    assert len(forms) == 1, json.dumps(walk, ensure_ascii=False)
    form = forms[0]
    if form.get("ended") != "end" or not form.get("saved", {}).get("finishing"):
        last = form.get("screens", [])[-2:]
        raise AssertionError(json.dumps({
            "command": command, "ended": form.get("ended"), "saved": form.get("saved"),
            "screens": [{k: v for k,v in screen.items() if k not in ("view", "banners")} for screen in last],
            "lastVisibleText": _texts((last[-1].get("view") or {})) if last else [],
        }, ensure_ascii=False))
    return form


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


def test_an_image_question_sends_the_resized_photo_to_hq(android_documents, hq):
    """Inspect the binary part received with the Android submission. The raw image
    shown by the ImageWidget is 32 by 24. The submitted JPEG has longest side 15."""
    from io import BytesIO
    from PIL import Image

    submissions = []
    with _served(android_documents["targeted-capture-widgets"]) as (served, archive):
        _app(served, archive, "resized-photo", commands=[FORM], submissions=submissions)
    (posted,) = submissions
    name = _child(etree.fromstring(posted.instance), "photo").text
    assert name, posted.instance
    with Image.open(BytesIO(dict(posted.files)[name])) as photo:
        assert (photo.format, photo.size) == ("JPEG", (15, 11))
        assert (photo.getexif()[256], photo.getexif()[257]) == (15, 11)


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


def test_a_labels_value_is_formatted_with_the_label(android_documents, hq):
    """The survey "Styles" asks "Seen", labelled ``Styled `` then the value of a Hidden Value calculated as
    ``'**x**'``. Core splices the value into the label's markdown form as written
    (``FormEntryCaption.getSpecialFormQuestionText``, ``FormDef.fillTemplateString``), and Android formats the label
    after that, so the question's screen shows ``Styled x``, the asterisks drawn as bold, and never the asterisks:
    the order Preview plays (``lib/preview/engine/labelRefs.ts``), a value substituted and then formatted."""
    with _served(android_documents[STYLED]) as (served, archive):
        answer, _ = _app(served, archive, "styled", views=True)

    shown_by_language = {"en": [], "fr": []}
    for path, walk in answer["walks"].items():
        language = "fr" if "@language:fr" in path else "en"
        for form in _forms(walk):
            shown_by_language[language].extend(_shown(form, "/data/seen[1]"))
    assert STYLED_DRAWN in shown_by_language["en"] and STYLED_SPLICED not in shown_by_language["en"]
    assert "Zone nord, secteur nord" in shown_by_language["fr"] and STYLED_DRAWN not in shown_by_language["fr"]


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


@pytest.mark.parametrize("publication", ["A", "B"])
def test_android_question_display_preserves_widgets_and_answers(android_documents, hq, publication, android_walk_evidence):
    """The released form includes both halves of each composition. Worker's
    choices and dates must survive under their original data identities."""
    with _served(android_documents["hq-question-display"], publication) as (served, archive):
        answer, sent = _app(
            served, archive, "question-display", commands=[FORM], views=True,
            questions={
                "/data/arrival": ["calendar:2016-01-01"], "/data/follow_up": ["calendar:2023-09-12"],
                "/data/place": ["2"], "/data/plain_place": ["1"],
            },
        )
    android_walk_evidence(answer["walks"][FORM])
    form = _completed_walk(answer, FORM)
    widgets = {
        question["reference"]: question["widget"]
        for screen in form["screens"] for question in screen.get("questions", [])
    }
    for path, widget in {
        "arrival":"EthiopianDateWidget", "follow_up":"DateWidget", "return_day":"NepaliDateWidget",
        "place":"SelectOneWidget", "plain_place":"SpinnerWidget", "route":"ComboboxWidget",
        "ranked_route":"ComboboxWidget", "weather":"GridWidget", "auto_weather":"GridWidget",
        "agreement":"SignatureWidget", "web_agreement":"ImageWidget",
    }.items():
        assert widgets.get(f"/data/{path}[1]") == widget, (path, widgets)
    assert form["saved"]["finishing"] is True, form
    (instance,) = sent
    root = etree.fromstring(instance, etree.XMLParser(resolve_entities=False, no_network=True))
    for path, value in {"arrival":"2023-09-12","follow_up":"2023-09-12","place":"upper","plain_place":"north"}.items():
        assert _child(root, path).text == value, instance


@pytest.mark.parametrize("publication", ["A", "B"])
def test_android_display_palette_uses_its_native_controls_and_keeps_worker_answers(android_documents, hq, publication, android_walk_evidence):
    menu = "m1-f0"
    with _served(android_documents["hq-question-display"], publication) as (served, archive):
        answer, sent = _app(
            served, archive, "visit-options", commands=[menu], controls=True, keys=True,
            questions={
                "/data/house_number": ["a007"], "/data/travel_stage": ["2"],
                "/data/packed_items": ["1 3"], "/data/private_postcode": ["B2"],
                "/data/zone_code": ["44"],
                "/data/door_photo": ["camera"], "/data/sign_photo": ["camera"],
                "/data/access_video": ["camera"], "/data/quick_scan": ["scan:TRIP-007"],
            },
        )
    android_walk_evidence(answer["walks"][menu])
    form = _completed_walk(answer, menu)
    questions = {
        q["reference"]: q for screen in form["screens"] for q in screen.get("questions", [])
    }

    def question(path):
        return questions[f"/data/{path}[1]"]

    for grid in ("visit_rating", "display_season", "packed_items"):
        tile = question(grid)["control"]
        assert tile["firstTile"] == "ImageView" and not tile["firstTileHasImage"], tile

    by_widget = {
        "GridWidget": ("visit_rating", "display_season"),
        "GridMultiWidget": ("packed_items",),
        "LabelWidget": ("stop_headings", "supply_headings"),
        "SelectOneAutoAdvanceWidget": ("arrival_status",),
        "SelectOneWidget": ("travel_stage", "display_place", "received_district"),
        "ListWidget": ("travel_mode", "road_surface"),
        "ListMultiWidget": ("comfort_items", "health_items"),
        "SpinnerWidget": ("door_colour",),
        "SpinnerMultiWidget": ("supplies",),
        "ComboboxWidget": ("district", "market", "route_name"),
        "GregorianDateWidget": ("planned_date",),
        "DateWidget": ("arrival_date",),
        "GeoPointWidget": ("map_point",),
        "BarcodeWidget": ("parcel_number", "quick_scan"),
        "AudioWidget": ("earlier_recording",),
        "CommCareAudioWidget": ("interview", "spoken_note"),
        "VideoWidget": ("access_video",),
        "ImageWidget": ("door_photo", "sign_photo", "attachment"),
        "StringNumberWidget": ("house_suffix", "house_number"),
        "StringWidget": ("private_location", "private_postcode", "zone_code", "followup_location"),
        "TriggerWidget": ("mobile_note", "copyable_note"),
    }
    for widget, paths in by_widget.items():
        for path in paths:
            assert question(path)["widget"] == widget, (path, question(path))
    (scan,) = [entry for entry in _entries(form,"/data/quick_scan[1]") if "openedOnArrival" in entry]
    assert scan["openedOnArrival"] and scan["cancelledWithoutAnswer"] and scan["advanced"], scan
    assert question("visit_rating")["control"]["columns"] == 2
    assert question("private_location")["control"]["masked"] is True
    assert question("private_postcode")["control"]["masked"] is True
    assert question("house_number")["control"]["masked"] is False
    assert question("copyable_note")["control"]["canCopy"] is True
    assert question("mobile_note")["control"]["visible"] is False
    assert question("zone_code")["control"]["imeAction"] == 6  # EditorInfo.IME_ACTION_DONE
    # A text question under a compact group draws its one-line label beside its answer box, with the keyboard
    # action Preview's compact row gives it. The same question under a bordered group draws as anywhere.
    compact = questions["/data/quick_summary[1]/remark[1]"]
    assert compact["widget"] == "StringWidget", compact
    assert compact["control"]["compact"] is True and compact["control"]["compactRowHorizontal"] is True, compact
    assert compact["control"]["compactRow"] == [{"answerBox": False, "maxLines": 1}, {"answerBox": True}], compact
    # A compact group is no question list, so its question is the last on its own screen.
    assert compact["control"]["imeAction"] == 6, compact  # EditorInfo.IME_ACTION_DONE
    bordered = questions["/data/final_details[1]/remark[1]"]
    assert bordered["widget"] == "StringWidget", bordered
    assert bordered["control"]["compact"] is False and "compactRow" not in bordered["control"], bordered
    for path, offered in {
        "door_photo": False, "sign_photo": True, "attachment": True,
        "access_video": False, "interview": False, "spoken_note": True,
    }.items():
        assert question(path)["control"]["canChooseFile"] is offered, (path, question(path))
    for path, camera in {"door_photo": "android.media.action.IMAGE_CAPTURE",
                         "sign_photo": "org.commcare.activities.camera.CameraOverlayActivity",
                         "access_video": "android.media.action.VIDEO_CAPTURE"}.items():
        entries = _entries(form, f"/data/{path}[1]")
        assert any(entry.get("camera") == camera and entry.get("taken") is True for entry in entries), (path, entries)
    for path in ("interview", "spoken_note", "attachment"):
        recorded = _entries(form, f"/data/{path}[1]")
        assert any(entry.get("taken") is True for entry in recorded), (path, recorded)
    assert any(entry.get("offeredSaveAfterStop") is True for entry in _entries(form, "/data/interview[1]"))
    assert form["saved"]["finishing"] is True, form
    (instance,) = sent
    root = etree.fromstring(instance, etree.XMLParser(resolve_entities=False, no_network=True))
    for path, value in {"travel_stage": "upper", "packed_items": "north south", "private_postcode": "B2",
                        "zone_code": "44", "house_number": "007", "quick_scan": "TRIP-007"}.items():
        assert _child(root, path).text == value, (path, instance)


def test_gregorian_clear_button_removes_only_its_own_date(android_documents, hq, android_walk_evidence):
    untouched = ("untouched_ordinary", "untouched_ethiopian", "untouched_nepali", "untouched_gregorian", "untouched_gregorian_with_clear")
    with _served(android_documents["targeted-question-calendar"]) as (served, archive):
        answer, sent = _app(
            served, archive, "clear-calendar", commands=[FORM], controls=True,
            questions={"/data/scheduled": [], "/data/rescheduled": ["clear-calendar"],
                       **{f"/data/{name}": [] for name in untouched}},
        )
    android_walk_evidence(answer["walks"][FORM])
    form = _completed_walk(answer, FORM)
    questions = {
        question["reference"]: question for screen in form["screens"] for question in screen.get("questions", [])
    }
    assert not questions["/data/scheduled[1]"]["control"]["canClearDay"]
    assert questions["/data/rescheduled[1]"]["control"]["canClearDay"]
    (review,) = [screen for screen in form["screens"] if any(
        question["reference"] == "/data/review[1]/notes[1]" for question in screen.get("questions", [])
    )]
    assert list(_texts(review["banners"])) == ["Ready; Check"], review["banners"]
    (cleared,) = _entries(form, "/data/rescheduled[1]")
    assert cleared["beforeClear"] and cleared["given"] is None, cleared
    (instance,) = sent
    root = etree.fromstring(instance, etree.XMLParser(resolve_entities=False, no_network=True))
    assert _child(root, "scheduled").text == "2023-09-12", instance
    assert _child(root, "rescheduled").text is None, instance
    days = {}
    for path in untouched:
        question = questions[f"/data/{path}[1]"]
        assert question["answer"] is None, question
        day = question["control"]["civilDay"]
        assert day and _child(root, path).text == day, (path, question, instance)
        days[path] = day
    assert len(set(days.values())) == 1, days


def _files_drawn_in_labels(view):
    """The center colors of images drawn beside each text in the worker widget's own MediaLayout."""
    def pixels(node):
        if "centerPixel" in node:
            yield node["centerPixel"]
        for child in node.get("children", ()):
            yield from pixels(child)

    if view.get("class") == "MediaLayout":
        for text in _texts(view):
            yield text, list(pixels(view))
    for child in view.get("children", ()):
        yield from _files_drawn_in_labels(child)


def test_selected_language_uses_its_own_installed_menu_form_help_and_choice_images(android_documents, hq):
    """The menu adapter resolves the chosen worker language's installed file. The form's native MediaLayout
    draws the localized question, help and choice image. Its neighboring choice remains text only."""
    with _served(android_documents["media-language-files"]) as (served, archive):
        answer, _ = _app(served, archive, "localized-files", views=True)

    expected = {
        "en": {"Visits": "50a8af47cc2e68f022bfb93e26be925081df6d21b3d4c276cdabdbd8d31de83d",
               "Record visit": "c5f74c6dda51d3941b4d17d05991f900debbf387ff748eda65d2f03dda227b2e"},
        "fra": {"Visits": "c5f74c6dda51d3941b4d17d05991f900debbf387ff748eda65d2f03dda227b2e",
                "Record visit": "30ab512e6539a83342a9415c6e7ddc7358a0ffd2aefe5369c86b9efb591e3984"},
    }
    # Each of the fixture's PNGs is a single solid color. The device may rescale or recompress the bitmap:
    # the blue, red or green channel remains its unique strongest channel respectively.
    expected_drawn = {
        "en": {"Street": "blue", "Find the visiting point": "green", "First": "red", "Second": None},
        "fra": {"Street": "red", "Find the visiting point": "blue", "First": "blue", "Second": None},
    }
    seen = set()
    seen_drawn = set()
    for name, walk in answer["walks"].items():
        language = "fra" if "@language:fra" in name else "en"
        for step in walk["steps"]:
            for item in (step.get("menu") or {}).get("items") or ():
                for title, digest in expected[language].items():
                    if title not in item["texts"]:
                        continue
                    media = item["image"]
                    assert media and media["held"] is True and media["uri"].endswith(f"/{digest}.png"), (name, title, item)
                    seen.add((language, title))
        for form in _forms(walk):
            for screen in form["screens"]:
                for label, colors in _files_drawn_in_labels(screen.get("view") or {}):
                    if label not in expected_drawn[language]:
                        continue
                    wanted = expected_drawn[language][label]
                    if wanted is None:
                        assert colors == [], (name, label, colors)
                    else:
                        (pixel,) = colors
                        channels = dict(zip(("red", "green", "blue"), bytes.fromhex(pixel[3:]), strict=True))
                        assert channels[wanted] > max(v for k, v in channels.items() if k != wanted), (name, label, pixel)
                    seen_drawn.add((language, label))
            if any(q["reference"] == "/data/colour[1]" for s in form["screens"] for q in s.get("questions", ())):
                assert form["saved"]["finishing"] is True, (name, form)
    assert seen_drawn == {(lang, label) for lang, rows in expected_drawn.items() for label in rows}, seen_drawn
    assert seen == {(language, title) for language, items in expected.items() for title in items}, seen


def _app_samples(walk):
    return [
        sample
        for command in walk["walks"].values()
        for form in _forms(command)
        for screen in form["screens"]
        for question in screen.get("answered", [])
        for sample in question.get("appReturns", [])
    ]


def _result_rows(sample, when):
    form = etree.fromstring(sample[when].encode())
    return [
        {etree.QName(node).localname: node.text or "" for node in row}
        for row in form.xpath("./*[local-name()='visits' and not(@*[local-name()='template'])]")
    ]


def test_android_app_returns_update_only_the_invoking_row(android_documents, hq):
    """The same installed activity opens from a text and an integer question.
    Keep, clear and cast returned answers before moving the worker onward."""
    with _served(android_documents["targeted-android-app-answers"]) as (served, archive):
        walk, sent = _app(served, archive, "app-answers", commands=[FORM], questions={"/data/unit": ["litres"]}, callouts={
            "meter": [[
                {"primary": "one", "named": {"correction": "calibrated", "measurement": "007", "photo": {"file": "from meter"}}},
                {"cancel": True, "primary": "ignored"},
                {"bundle": True, "named": {"measurement": None}},
                {"primary": ""},
                {"simprints": "simulated", "primary": "ignored"},
                {"register": "registered", "simprints": "overridden", "primary": "ignored"},
                {"verify": "verified", "primary": "ignored"},
                {"identify": "best", "primary": "ignored"},
            ], [
                {"primary": "two", "named": {"measurement": "015"}},
                {"missingHandler": True},
            ]],
            "verify": [[{"primary": "012", "named": {"measurement": "08"}}], [{"invalid": True}]],
        })
        samples = _app_samples(walk)
        assert len(samples) == 12, samples
        (first, cancelled, cleared, empty, simprints, registration, verification,
         identification, auxiliary, second, missing_handler, invalid) = samples
        assert first["action"] == "org.example.MEASURE"
        assert first["sent"] == {"odk_intent_data": "previous", "unit": "litres"}
        first_rows = _result_rows(first, "after")
        # Android materializes the second counted row when the worker advances to it.
        assert len(first_rows) == len(_result_rows(first, "before")) == 1
        assert first_rows[0]["meter"] == "one"
        assert (first_rows[0]["description"], first_rows[0]["reading"]) == ("calibrated", "7")
        assert first_rows[0]["attachment"] == "synthetic-meter-reading.txt" and first["copied"] == "from meter"
        assert cancelled["sent"]["odk_intent_data"] == "one"
        assert _result_rows(cancelled, "after") == _result_rows(cancelled, "before")
        after_clear = _result_rows(cleared, "after")[0]
        assert (after_clear["meter"], after_clear["reading"], after_clear["description"]) == ("", "", "")
        assert after_clear["attachment"] == "synthetic-meter-reading.txt"
        assert _result_rows(empty, "after")[0]["meter"] == ""
        fingerprints = _result_rows(simprints, "after")[0]
        assert (fingerprints["guid"], fingerprints["thumb"], fingerprints["other_thumb"]) == ("simulated", "AQ==\n", "")
        assert fingerprints["meter"] == "Fingerprints scanned: 1"
        registered = _result_rows(registration, "after")[0]
        assert (registered["guid"], registered["face_template"], registered["meter"]) == (
            "registered", "c3ludGhldGlj\n", "All data stored successfully"
        )
        verified = _result_rows(verification, "after")[0]
        assert (verified["match_guid"], verified["match_confidence"], verified["match_strength"], verified["meter"]) == (
            "verified", "80", "four_stars", "★★★★"
        )
        matched = _result_rows(identification, "after")[0]
        assert (matched["match_guid"], matched["guid"], matched["meter"]) == ("best", "", "★★★★")
        assert auxiliary["sent"]["odk_intent_data"] == "9"
        altered = _result_rows(auxiliary, "after")[0]
        assert (altered["verify"], altered["meter"], altered["reading"], altered["description"]) == ("12", "★★★★", "8", "08")
        before_second = _result_rows(second, "before")
        after_second = _result_rows(second, "after")
        assert len(before_second) == len(after_second) == 2
        assert after_second[0] == before_second[0]
        assert after_second[1] == {
            **before_second[1],
            "meter": "two",
            "description": "015",
            "reading": "15",
        }
        assert missing_handler["missingHandler"]
        assert _result_rows(missing_handler, "after") == _result_rows(missing_handler, "before")
        assert _result_rows(invalid, "after") == _result_rows(invalid, "before")


def test_android_app_raw_result_flag_distinguishes_bundled_updates(android_documents, hq):
    """The raw handler flag does not describe whether a mapped question changed."""
    with _served(android_documents["targeted-android-app-answers"]) as (served, archive):
        walk, _ = _app(served, archive, "app-result-flag", commands=[FORM], callouts={
            "meter": [[{"bundle": True, "named": {"measurement": "2"}, "raw": True},
                       {"named": {"measurement": "3"}, "raw": True}, {"primary": "", "raw": True}]]
        })
        first, second, empty = _app_samples(walk)
        assert [s["reportedSuccess"] for s in (first, second, empty)] == [False, True, True]
        assert [_result_rows(s, "after")[0]["reading"] for s in (first, second)] == ["2", "3"]


def test_required_android_app_primary_only(android_documents, hq):
    with _served(android_documents["targeted-android-app-answers"]) as (served, archive):
        for label, second, expected in [
            ("cancel", {"cancel": True}, "confirmed"),
            ("absent", {"bundle": True}, ""),
        ]:
            walk, sent = _app(served, archive, f"app-primary-{label}", commands=["m0-f1"], callouts={
                "confirmed": [[{"primary": "confirmed"}, second]]
            })
            first, next_return = _app_samples(walk)
            assert first["action"] == "org.commcare.respiratory.BREATHCOUNT"
            assert next_return["sent"]["odk_intent_data"] == "confirmed"
            assert etree.fromstring(next_return["after"].encode()).xpath("string(./*[local-name()='confirmed'])") == expected
            assert bool(sent) == bool(expected), walk

def test_android_app_answer_survives_incomplete_form_resume(android_documents, hq):
    with _served(android_documents["targeted-android-app-answers"]) as (served, archive):
        walk, sent = _app(served, archive, "app-resume", commands=[], save_incomplete="m0-f1", reopen=True,
            callouts={"confirmed": [[{"primary": "ready"}], [{"cancel": True}]]})
        reopened = walk["savedIncomplete"]["reopened"]
        assert reopened["screen"] == FORM_ENTRY, reopened
        (cancelled,) = [result for screen in reopened["form"]["screens"] for entry in screen.get("answered", [])
                        for result in entry.get("appReturns", [])]
        assert cancelled["sent"]["odk_intent_data"] == "ready"
        (instance,) = sent
        assert _child(etree.fromstring(instance), "confirmed").text == "ready"

def test_quick_app_refusal_control_uses_result_flag_for_navigation(android_documents, hq):
    """This independent device input is the quick appearance Nova refuses:
    a bundle-only write refreshes; a direct write advances."""
    with _served(android_documents["targeted-android-app-answers"]) as (served, archive):
        output = io.BytesIO()
        changed = 0
        with zipfile.ZipFile(io.BytesIO(archive)) as source, zipfile.ZipFile(output, "w") as amended:
            for info in source.infolist():
                data = source.read(info)
                if info.filename.endswith(".xml") and b"org.example.MEASURE" in data:
                    xml = etree.fromstring(data)
                    for node in xml.xpath("//*[local-name()='intent' and @class='org.example.MEASURE']"):
                        node.set("appearance", "quick")
                        changed += 1
                    data = etree.tostring(xml)
                amended.writestr(info, data)
        assert changed == 1
        walk, _ = _app(served, output.getvalue(), "quick-refusal-control", commands=[FORM], callouts={
            "meter": [[{"bundle": True, "named": {"measurement": "5"}}, {"named": {"measurement": "6"}}]]
        })
        first, second = _app_samples(walk)
        assert first["indexBefore"] == first["indexAfter"]
        assert _result_rows(first, "after")[0]["reading"] == "5"
        assert second["indexBefore"] != second["indexAfter"]
        assert _result_rows(second, "after")[0]["reading"] == "6"


def test_android_sorts_filtered_case_choices_by_text_and_keeps_ties(android_documents, hq):
    from proof.observe import casedata

    rows = (
        ("north-late", "Alpha label", "north", "2"),
        ("north-tie-first", "Zulu label", "north", "10"),
        ("north-tie-second", "Beta label", "north", "10"),
        ("south", "South only", "south", "0"),
    )
    ranks = {case_id: rank for case_id, _, _, rank in rows}
    names = {case_id: name for case_id, name, _, _ in rows}
    database = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), tuple(
        casedata.CaseRecord(
            case_id, "clinic", name, casedata.USER_ID,
            "2025-12-01T08:00:00Z", "2025-12-01T08:00:00Z", None,
            (("region", region), ("rank", rank)),
        )
        for case_id, name, region, rank in rows
    ))
    with _served(android_documents["targeted-sorted-case-choices"], database=database) as (served, archive):
        for region, expected in (("north", {"north-late", "north-tie-first", "north-tie-second"}), ("south", {"south"})):
            answer, sent = _app(
                served, archive, f"case-choices-{region}", commands=[FORM], controls=True,
                questions={"/data/region": [region], "/data/sorted": ["1"]},
            )
            form = _completed_walk(answer, FORM)
            by_question = {
                question["reference"]: question["control"]["choices"]
                for screen in form["screens"] for question in screen["questions"]
                if "choices" in question.get("control", {})
            }
            natural = [choice["value"] for choice in by_question["/data/source_order[1]"]]
            ordered = by_question["/data/sorted[1]"]
            assert set(natural) == expected
            ordered_ids = sorted(natural, key=ranks.__getitem__)
            assert ordered == [
                {"value": case_id, "label": names[case_id], "index": i}
                for i, case_id in enumerate(ordered_ids)
            ]
            (instance,) = sent
            root = etree.fromstring(instance)
            assert _child(root, "sorted").text == ordered_ids[0]
