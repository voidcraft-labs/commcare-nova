"""Installed Android widgets supply the passive OK, the worker's checkbox, and the unchanged optional default."""

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


def test_android_sends_only_the_file_attached_at_a_capture_question(android_documents, hq):
    from proof.android.test_form_reads import _app, _entries, _forms, _served
    from proof.formplayer.walk import CAPTURES_DIR

    filename = "proof-file.pdf"
    keep = {"/data/report": [], "/data/photo": [], "/data/replacement": []}
    with _served(android_documents["targeted-worker-messages"]) as (served, archive):
        refused, refused_sent = _app(served, archive, "kept", commands=["m0-f1"], questions=keep)
        posted = []
        accepted, _ = _app(served, archive, "replaced", commands=["m0-f1"],
                           questions={**keep, "/data/replacement": [filename]}, submissions=posted)
    first, = _forms(refused["walks"]["m0-f1"])
    last, = _forms(accepted["walks"]["m0-f1"])
    assert not refused_sent and not first["saved"]["finishing"], first
    assert last["saved"]["finishing"], last
    assert _entries(last, "/data/report[1]")[0]["kept"] == "carry-forward.pdf", last
    assert _entries(last, "/data/photo[1]")[0]["kept"] is None, last
    submission, = posted
    root = etree.fromstring(submission.instance)
    assert root.findtext("{*}report") == "carry-forward.pdf" and not root.findtext("{*}photo"), submission.instance
    actual, = submission.files
    assert actual == (root.findtext("{*}replacement"), (CAPTURES_DIR / filename).read_bytes()), actual[0]
