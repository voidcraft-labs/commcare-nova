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

The plausible failures: a session read Android does not resolve, or resolves
to another id than the create block's after a reopen (an id drawn again); a
title or saved name in the source language, or a header that moved with the
title; and a count Android reads as the row's own node (so the validation
never holds) or as no row.
"""

from __future__ import annotations

import json
from contextlib import contextmanager

import pytest
from lxml import etree

pytestmark = pytest.mark.reader("android")

REGISTRATION = "expander-form-hashtag-expansion-records-no-case-id-load-39a69840-0"
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
    "Registrar" opens under the header ``Aplicación de salud > Registrar``, as it did before the title moved;
    its title, the title form entry gives a completed save, and the name of the record the save leaves are all
    ``Registrar``."""
    with _served(android_documents[BILINGUAL]) as (served, archive):
        answer, _ = _app(served, archive, "walked")

    starting = {name: walk for name, walk in answer["walks"].items() if "@language:" not in name}
    forms = [form for walk in starting.values() for form in _forms(walk)]
    assert forms, sorted(answer["walks"])
    for form in forms:
        assert form["FormEntryActivity.getHeaderString"] == "Aplicación de salud > Registrar", form
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
