"""What CommCare Android makes of the case blocks Nova's generated groups hold, on HQ's build of the form.

Contract (``proof/android/README.md``, "Checks"): each test reads HQ's build
of a corpus document as the pull request's own emitter wrote it, published as
the corpus captured it (``proof.rules.conftest.published``, the ``minimum``
export), released and served by HQ's own views
(``proof.formplayer.hq.serve``), and installed from HQ's download of the
release (``observe.release_archive``), on a device whose network is HQ's views
over that state (``observe.app``). Every document's form is "Edit"
(``m0-f0``), a follow-up on the first listed case, entered from home,
answered, finished and saved with Android's own code, its case blocks applied
to the device's case storage, and sent to HQ's receiver; ``sent`` holds each
instance it sent, as Android wrote it.

Nova writes every case operation's block inside a ``nova_operations`` group,
a conditional update or close inside a ``nova_condition_<operation>`` group
whose relevance is the condition, each guard as an update-only block after
its operation's (blank ``case_id`` where its test fails), and a root create
keyed by an answer inside a one-row repeat (``lib/commcare/xform/caseOps.ts``).

- With the condition true the instance holds every block, in the order the
  form's operations are listed; with it false, an empty create and no other
  block, and the device makes no case.
- A guard that fails stops the save: Android's "Error Saving your Form", the
  record quarantined, the device's cases as the form opened them, nothing
  sent.
- A root create keyed by an answer writes its keyed id, also on a form saved
  incomplete at its first screen, reopened from home and completed.
- No generated group, repeat or row is a screen or a question.

The lane's answer table answers no text ``yes``, so its walks reach every
condition false, and none gives a whitespace-only name or saves a form
incomplete. The plausible failures: a group Android steps into as a screen; a
condition Android does not apply to the blocks inside its group; a guard
Android lets through, or applies after its create's case was made; a keyed
row Android never makes, or makes again blank after a reopen; and blocks
submitted in another order than the form's, which Core applies in document
order (``XmlFormRecordProcessor.process``).
"""

from __future__ import annotations

import re
from contextlib import contextmanager

import pytest
from lxml import etree

pytestmark = pytest.mark.reader("android")

CONDITIONAL = "case-operation-conditional"
KEYED = "case-operation-key"
ORDERED = (
    "case-operation-conditional",
    "case-operation-key",
    "case-operation-query",
    "case-operation-repeat",
    "case-operation-sequence",
    "case-operation-retype",
)
CASE = "{http://commcarehq.org/case/transaction/v2}case"
FORM = "m0-f0"
FORM_ENTRY = "FormEntryActivity"
OPERATIONS = "nova_operations"
SAVE_ERROR = "Error Saving your Form"
# A record Android keeps aside where processing its form failed (commcare-android ``FormRecord.STATUS_QUARANTINED``).
QUARANTINED = "limbo"
# A case the device made, as the reader writes its id (``Cases.java``).
MADE = "@device-case:"
KEYED_ID = re.compile(r"nova-case-v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:k1")
# What each request answers the form's own questions with; every other question takes the lane's table.
ANSWERED = {
    "/data/answer": ["Proof name"],
    "/data/items/item/answer": ["Proof name"],
    "/data/key": ["k1"],
    "/data/items/item/key": ["k1"],
}
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


def _questions(enabled, **more):
    return {**ANSWERED, "/data/enabled": [enabled], **more}


def _form(answer):
    """The one form the walk of ``FORM`` entered, as its step records it."""
    (form,) = [
        step["form"]
        for step in answer["walks"][FORM].get("steps", [])
        if step.get("screen") == FORM_ENTRY and "form" in step
    ]
    return form


def _local(element):
    return etree.QName(element).localname


def _operations(instance):
    """Each ``nova_operations`` element of a sent instance, in document order."""
    root = etree.fromstring(instance, PARSER)
    return [element for element in root.iter(etree.Element) if _local(element) == OPERATIONS]


def _made(cases):
    return [case for case in cases if str(case.get("id")).startswith(MADE)]


def test_a_condition_decides_the_blocks_a_device_submits_and_the_cases_it_makes(android_documents, hq):
    """With ``enabled`` ``yes`` the instance holds, below ``nova_operations``, ``create_visit``, ``tag_visit``,
    ``unlink_visit`` and ``finish_visit`` in that order, each with its case block; with ``no``,
    ``nova_operations`` holds one empty ``create_visit``, and the device made no case."""
    with _served(android_documents[CONDITIONAL]) as (served, archive):
        true, sent_true = _app(served, archive, "true", commands=[FORM], questions=_questions("yes"))
        false, sent_false = _app(served, archive, "false", commands=[FORM], questions=_questions("no"))

    assert _form(true)["saved"]["finishing"] is True, _form(true)["saved"]
    ((operations,),) = [_operations(instance) for instance in sent_true]
    blocks = ("create_visit", "tag_visit", "unlink_visit", "finish_visit")
    held = [element for element in operations.iter(etree.Element) if _local(element) in blocks]
    assert [_local(element) for element in held] == list(blocks), etree.tostring(operations)
    assert all(element.find(CASE) is not None for element in held), etree.tostring(operations)

    saved = _form(false)["saved"]
    assert saved["finishing"] is True, saved
    ((operations,),) = [_operations(instance) for instance in sent_false]
    children = [child for child in operations if isinstance(child.tag, str)]
    assert [_local(child) for child in children] == ["create_visit"], etree.tostring(operations)
    assert len(children[0]) == 0, etree.tostring(operations)
    assert _made(saved["cases"]) == [], saved["cases"]


def test_a_failing_guard_stops_the_save_on_a_device(android_documents, hq):
    """With ``enabled`` ``yes`` and the visit's name three spaces, the create's text guard leaves its block's
    ``case_id`` blank: the device does not save the form, shows "Error Saving your Form", keeps the record aside,
    holds the cases it held as the form opened, and sends nothing."""
    questions = _questions("yes", **{"/data/answer": ["   "]})
    with _served(android_documents[CONDITIONAL]) as (served, archive):
        answer, sent = _app(served, archive, "guarded", commands=[FORM], questions=questions)

    saved = _form(answer)["saved"]
    assert saved["finishing"] is False, saved
    assert (saved.get("alert") or {}).get("title") == SAVE_ERROR, saved.get("alert")
    assert any(record["status"] == QUARANTINED for record in saved["records"]), saved["records"]
    assert saved["casesAsTheFormOpened"] is True, saved
    assert sent == []


def test_a_keyed_root_create_writes_its_keyed_id_also_after_a_reopen(android_documents, hq):
    """The create keyed by ``key`` sits in a one-row repeat: its block's ``case_id`` is the operation's prefix and
    ``k1``, on a form completed in one go and on one saved incomplete at its first screen, reopened from home and
    completed, and the device holds the one ``visit`` case it made under that id."""
    questions = _questions("yes")
    with _served(android_documents[KEYED]) as (served, archive):
        whole, sent_whole = _app(served, archive, "whole", commands=[FORM], questions=questions)
        again, sent_again = _app(
            served, archive, "reopened", commands=[], questions=questions, save_incomplete=FORM, reopen=True
        )

    reopened = again["savedIncomplete"]["reopened"]
    assert reopened["screen"] == FORM_ENTRY, reopened
    for saved, sent in ((_form(whole)["saved"], sent_whole), (reopened["form"]["saved"], sent_again)):
        assert saved["finishing"] is True, saved
        ((operations,),) = [_operations(instance) for instance in sent]
        (row,) = [
            child for child in operations if isinstance(child.tag, str) and _local(child).startswith("nova_keyed_")
        ]
        assert _local(row) == "nova_keyed_create_visit", etree.tostring(operations)
        case = row.find("{*}create_visit").find(CASE)
        assert KEYED_ID.fullmatch(case.get("case_id") or ""), etree.tostring(case)
        visits = [case for case in saved["cases"] if case.get("type") == "visit" and case.get("name") == "Proof name"]
        assert [case["id"] for case in visits] == ["nova-case-v1:@device-uuid:k1"], saved["cases"]


@pytest.mark.parametrize("document_id", ORDERED)
def test_every_block_is_submitted_in_order_and_no_generated_node_is_a_screen(android_documents, hq, document_id):
    """With ``enabled`` ``yes`` the device saves the form; no screen and no question it shows sits at a step Nova
    generated; and each ``nova_operations`` element the device sends holds the form's operations in the order
    the document lists them, ``create_visit`` among them where the form has one."""
    document = android_documents[document_id]
    with _served(document) as (served, archive):
        answer, sent = _app(served, archive, "ordered", commands=[FORM], questions=_questions("yes"))

    form = _form(answer)
    assert form["saved"]["finishing"] is True, form["saved"]
    shown = [screen.get("index") for screen in form.get("screens", [])]
    shown += [
        entry.get("reference")
        for screen in form.get("screens", [])
        for entry in [*screen.get("questions", []), *screen.get("answered", [])]
    ]
    generated = [
        place for place in shown if any(step.split("[")[0].startswith("nova_") for step in str(place).split("/"))
    ]
    assert generated == [], generated

    listed = [
        operation["id"]
        for listed_form in document.document["doc"]["forms"].values()
        for operation in listed_form.get("caseOperations") or ()
    ]
    (instance,) = sent
    groups = _operations(instance)
    assert groups, instance
    for group in groups:
        held = [_local(element) for element in group.iter(etree.Element) if _local(element) in listed]
        assert held == [operation for operation in listed if operation in held], held
        if "create_visit" in listed:
            assert "create_visit" in held, etree.tostring(group)
