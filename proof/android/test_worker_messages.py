"""Installed Android widgets supply the passive OK, the worker's checkbox, and the unchanged optional default; an
attachment question starts blank, and a starting file name stops the form from opening."""

import pytest
from lxml import etree

from proof.android import observe
from proof.formplayer import apps
from proof.formplayer import hq as hq_forms
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")


def test_android_worker_confirms_the_required_checkbox_and_keeps_the_optional_default(android_documents, hq, core_runner):
    doc = android_documents["targeted-worker-messages"]
    with apps.published(doc, core_runner) as published:
        with hq_forms.serve(published.unit, doc, published.app_id) as served:
            blobs, sent = Blobs(), []
            answer = observe.app(
                served, blobs, label="worker-confirms", archive=observe.release_archive(served), commands=["m0-f0"],
                questions={"/data/notice": [], "/data/confirmed": ["OK"], "/data/optional": [], "/data/acknowledged_note": ["Followed up"]}, views=True, sent=sent,
            )
            walk = blobs.get_json(answer["answer"])["walks"]["m0-f0"]
    form, = [step["form"] for step in walk["steps"] if step.get("screen") == "FormEntryActivity" and "form" in step]
    records = [entry for screen in form["screens"] for entry in screen.get("answered", []) if "checkbox" in entry]
    assert [(entry["checkbox"], entry.get("checked"), entry["given"]) for entry in records] == [
        (False, None, "OK"), (True, True, "OK"), (True, None, "later"),
    ], (records, form)
    submission, = sent
    root = etree.fromstring(submission)
    assert root.findtext("{*}acknowledged_note") == "Followed up"
    assert [root.findtext("{*}" + name) for name in ("notice", "confirmed", "optional")] == ["OK", "OK", "later"]


def test_android_sends_only_the_file_attached_at_a_capture_question(android_documents, hq, core_runner):
    """The accepted neighbour of a starting file: the picture's blank starting value opens the form, the required file
    left out keeps the form from finishing, and once attached it is the one file sent."""
    from proof.android.test_form_reads import _entries, _forms
    from proof.formplayer.walk import CAPTURES_DIR

    filename = "proof-file.pdf"
    keep = {"/data/report": [], "/data/photo": [], "/data/replacement": []}
    doc = android_documents["targeted-worker-messages"]
    # The release HQ builds of Nova's first publish, media and all, as the other witness here installs it.
    with apps.published(doc, core_runner) as published, hq_forms.serve(published.unit, doc, published.app_id) as served:
        archive = observe.release_archive(served)

        def walked(label, questions, **steer):
            blobs, sent = Blobs(), []
            found = observe.app(served, blobs, label=label, archive=archive, sent=sent, commands=["m0-f1"],
                                questions=questions, **steer)
            return blobs.get_json(found["answer"]), sent

        refused, refused_sent = walked("kept", keep)
        posted = []
        accepted, _ = walked("replaced", {**keep, "/data/replacement": [filename]}, submissions=posted)
    first, = _forms(refused["walks"]["m0-f1"])
    last, = _forms(accepted["walks"]["m0-f1"])
    assert not refused_sent and not first["saved"]["finishing"], first
    assert last["saved"]["finishing"], last
    assert _entries(last, "/data/photo[1]")[0]["kept"] is None, last
    submission, = posted
    root = etree.fromstring(submission.instance)
    assert not root.findtext("{*}report") and not root.findtext("{*}photo"), submission.instance
    actual, = submission.files
    assert actual == (root.findtext("{*}replacement"), (CAPTURES_DIR / filename).read_bytes()), actual[0]


def test_android_cannot_open_a_form_whose_attachment_starts_with_a_file(android_documents, hq, core_runner):
    """The refusal's Android half: a starting file name written past Nova's gate
    (``questions/default-other-than-blank-on-a-capture-question``) makes the file widget look for that file in the
    form's own folder, and the form does not open (``MediaWidget.decryptMedia`` raises)."""
    doc = android_documents["targeted-worker-messages"]
    with apps.published(doc, core_runner) as published:
        starting_file = apps.with_a_starting_value("/data/report", "'carry-forward.pdf'")
        change = apps.form_written(published, {"0.1": starting_file})
        with hq_forms.serve(published.unit, doc, published.app_id, change=change) as served:
            blobs = Blobs()
            found = observe.app(served, blobs, label="starting-file", archive=observe.release_archive(served),
                                commands=["m0-f1"], questions={"/data/report": [], "/data/photo": [],
                                                                "/data/replacement": []})
            walk = blobs.get_json(found["answer"])["walks"]["m0-f1"]
    raised = walk.get("raised") or {}
    assert raised.get("class") == "java.lang.RuntimeException", walk
    assert raised.get("message", "").startswith("Failed to decrypt media at path "), raised
