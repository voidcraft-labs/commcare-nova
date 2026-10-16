"""What CommCare Android makes of a case name's guard and its trim, on HQ's build of the form.

Contract (``proof/android/README.md``, "Checks"): each test reads HQ's build
of a corpus document as the pull request's own emitter wrote it, published as
the corpus captured it (``proof.rules.conftest.published``, the ``minimum``
export), released and served by HQ's own views
(``proof.formplayer.hq.serve``), and installed from HQ's download of the
release (``observe.release_archive``), on a device whose network is HQ's views
over that state (``observe.app``). The form is ``navigation-base``'s
"Register" (``m0-f1``; ``m0-f0`` is the follow-up "Visit"), entered from home,
answered, finished and saved with Android's own code, its case block applied
to the device's case storage, and sent to HQ's receiver; ``sent`` holds each
instance it sent, as Android wrote it.

Nova binds a create's name to a Hidden Value beside the question,
``nova_trimmed_<question>``, whose calculation trims the answer, and guards
the question the worker answers with a constraint: the trimmed answer is at
least one character and at most 255 (``lib/commcare/xform/builder.ts``,
``lib/domain/caseScalarTextGuard.ts``). The form names no validation message,
so Android shows its own.

- A whitespace-only name, typed into the question's own box, is held with
  "Sorry, this response is required!": Android's text widget hands a
  whitespace-only entry on as no answer, which the question's ``required``
  refuses.
- A 256-character name is held with "Sorry, this response is invalid!".
- In each, the device does not save the form and sends nothing.
- A name with surrounding spaces is accepted; the instance's
  ``case/create/case_name`` is the trimmed name, and the device holds the
  ``patient`` case it made under that name.

The lane's answer table gives no whitespace-only or over-long name. The
plausible failures: a guard Android does not evaluate (a case made with a
blank or over-long name), a refusal with no message a worker can read, and a
case block that reads the raw answer instead of the trimmed node.
"""

from __future__ import annotations

import json
from contextlib import contextmanager

import pytest
from lxml import etree

pytestmark = pytest.mark.reader("android")

DOCUMENT = "navigation-base"
FORM = "m0-f1"
FORM_ENTRY = "FormEntryActivity"
NAME = "/data/name"
CASE = "{http://commcarehq.org/case/transaction/v2}"
# A case the device made, as the reader writes its id (``Cases.java``).
MADE = "@device-case:"
REQUIRED = "Sorry, this response is required!"
INVALID = "Sorry, this response is invalid!"
PARSER = etree.XMLParser(resolve_entities=False, no_network=True)


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


def _form(answer):
    """The one form the walk of ``FORM`` entered, as its step records it."""
    (form,) = [
        step["form"]
        for step in answer["walks"][FORM].get("steps", [])
        if step.get("screen") == FORM_ENTRY and "form" in step
    ]
    return form


def _name_entries(form):
    """Every answer the walk gave the name question, screen by screen."""
    return [
        entry
        for screen in form.get("screens", [])
        for entry in screen.get("answered", [])
        if entry["reference"] == f"{NAME}[1]"
    ]


def _held(document, name, label):
    """The form with the name ``name`` typed into its box: Android refuses it, saves nothing and sends nothing.
    The record of the screen it stops on."""
    with _served(document) as (served, archive):
        answer, sent = _app(
            served, archive, label, commands=[FORM], questions={NAME: [name]}, views=True, type_refused=True
        )
    form = _form(answer)
    refused = [entry for entry in _name_entries(form) if "refused" in entry]
    assert refused, form
    assert all(
        any(reason.endswith(": constraint") for reason in entry["refused"]) and entry.get("typed") == name
        for entry in refused
    ), refused
    assert form["saved"]["finishing"] is False, form["saved"]
    assert sent == []
    return form["screens"][-1]


def test_a_whitespace_only_name_is_held_as_required(android_documents, hq):
    """Three spaces typed into the name's box: Android hands them on as no answer, and holds the question with
    its own required message."""
    screen = _held(android_documents[DOCUMENT], "   ", "whitespace")
    assert REQUIRED in json.dumps(screen, ensure_ascii=False), screen


def test_an_over_long_name_is_held_as_invalid(android_documents, hq):
    """A 256-character name typed into the name's box: Android holds the question with its own invalid-answer
    message."""
    screen = _held(android_documents[DOCUMENT], "x" * 256, "over-long")
    assert INVALID in json.dumps(screen, ensure_ascii=False), screen


def test_an_accepted_name_creates_the_case_with_the_trimmed_name(android_documents, hq):
    """A name with surrounding spaces is accepted; the instance the device sends names the case ``proof``, and
    the device holds the ``patient`` case it made under that name."""
    questions = {NAME: ["  proof  "], "/data/external": ["Ext-1"]}
    with _served(android_documents[DOCUMENT]) as (served, archive):
        answer, sent = _app(served, archive, "accepted", commands=[FORM], questions=questions)

    saved = _form(answer)["saved"]
    assert saved["finishing"] is True, saved
    (instance,) = sent
    root = etree.fromstring(instance, PARSER)
    (block,) = root.findall(f"{CASE}case")
    assert block.findtext(f"{CASE}create/{CASE}case_name") == "proof", instance
    made = [case for case in saved["cases"] if str(case.get("id")).startswith(MADE)]
    assert [(case.get("type"), case.get("name")) for case in made] == [("patient", "proof")], saved["cases"]
