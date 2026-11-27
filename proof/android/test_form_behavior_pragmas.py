"""The installed Android app treats the Web Apps pragmas as ordinary text."""

import pytest
from lxml import etree

from proof.android import observe
from proof.formplayer import apps
from proof.formplayer import hq as hq_forms
from proof.observe.record import Blobs

DOCUMENT = "targeted-form-behavior-pragmas"
pytestmark = pytest.mark.reader("android")


def _walk(served, archive, command, **inputs):
    blobs, sent = Blobs(), []
    report = observe.app(
        served, blobs, label=command, archive=archive, commands=[command], sent=sent, **inputs,
    )
    result = blobs.get_json(report["answer"])["walks"][command]
    (form,) = [step["form"] for step in result["steps"]
               if step["screen"] == "FormEntryActivity" and "form" in step]
    return form, sent, blobs.get_json(report["hq"])


def test_android_keeps_the_manual_save_and_device_sync_for_both_web_pragma_states(
    android_documents, hq, core_runner, android_walk_evidence,
):
    doc = android_documents[DOCUMENT]
    with apps.published(doc, core_runner, "maximum") as published, published.unit.fork():
        apps.saved_profile(published, custom_properties={"cc-sync-after-form": "yes"})
        with hq_forms.serve(published.unit, doc, published.app_id) as served:
            archive = observe.release_archive(served)
            blobs, sent = Blobs(), []
            record = observe.app(
                served, blobs, archive=archive, label="save-the-automatic-form",
                commands=[], questions={"/data/note": []}, save_incomplete="m0-f0", sent=sent,
            )
            saved = blobs.get_json(record["answer"])["savedIncomplete"]
            assert len([state for state in saved["records"] if state["status"] == "incomplete"]) == 1, saved
            assert not sent, sent
            syncs = []
            visits = (("m0-f0", "Automatic report"), ("m0-f1", "Manual report"), ("m0-f5", "Manual report"))
            for command, answer in visits:
                form, sent, requests = _walk(served, archive, command, questions={"/data/note": []})
                assert form["finishShown"] and form["saved"]["finishing"], form
                (instance,) = sent
                assert etree.fromstring(instance).findtext("{*}note") == answer
                restored = [(request["method"], request["status"])
                            for request in requests if "/restore/" in request["url"]]
                assert restored, requests
                syncs.append(restored)
            assert syncs[0] == syncs[1] == syncs[2], syncs
            android_walk_evidence({"incomplete": 1, "restores": [len(trace) for trace in syncs]})


@pytest.mark.parametrize("command", ["m0-f2", "m0-f3"], ids=["with-pragma", "without-pragma"])
def test_android_checks_the_earlier_answer_at_finish(
    android_documents, hq, core_runner, android_walk_evidence, command,
):
    doc = android_documents[DOCUMENT]
    with apps.published(doc, core_runner) as published, hq_forms.serve(published.unit, doc, published.app_id) as served:
        form, sent, _ = _walk(
            served, observe.release_archive(served), command,
            questions={"/data/note": "accepted", "/data/decision": "deny"}, views=True,
        )
    assert form["finishShown"] and form["saved"]["finishing"] is False, form
    assert "The first note needs to change." in str(form), form
    assert not sent, sent
    android_walk_evidence({"finished": form["saved"]["finishing"], "posted": len(sent)})


@pytest.mark.parametrize(
    ("command", "note", "calculated"),
    [
        pytest.param("m0-f6", [], "D", id="unrelated"),
        pytest.param("m0-f4", [], "a!", id="accept-starting-answer"),
        pytest.param("m0-f4", ["ab"], "ab!", id="edit-starting-answer"),
    ],
)
def test_android_keeps_the_repeat_starting_value_until_it_commits_a_dependency(
    android_documents, hq, core_runner, android_walk_evidence, command, note, calculated,
):
    doc = android_documents[DOCUMENT]
    with apps.published(doc, core_runner) as published, hq_forms.serve(published.unit, doc, published.app_id) as served:
        form, sent, _ = _walk(
            served, observe.release_archive(served), command, repeat_additions=1,
            questions={
                "/data/rows/note": note,
                "/data/rows/seen": [],
                "/data/unrelated": "unrelated",
            },
        )
    assert form["saved"]["finishing"], form
    (received,) = sent
    submitted = etree.fromstring(received)
    (row,) = submitted.findall("{*}rows")
    actual = row.findtext("{*}seen"), row.findtext("{*}value")
    assert row.findtext("{*}note") == (note[0] if note else "a"), received
    assert submitted.findtext("{*}unrelated") == "unrelated"
    assert actual == ("D", calculated), received
    android_walk_evidence({"sent": actual})
