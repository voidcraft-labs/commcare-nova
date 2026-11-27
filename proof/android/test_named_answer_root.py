"""The installed Android registration addresses its question and creates the case under the named root."""

import pytest
from lxml import etree

from proof.android import observe
from proof.formplayer import apps
from proof.formplayer import hq as hq_forms
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")


def test_android_submits_a_registration_under_its_own_root(android_documents, hq, core_runner):
    doc = android_documents["targeted-named-answer-root"]
    with apps.published(doc, core_runner) as published:
        with hq_forms.serve(published.unit, doc, published.app_id) as served:
            blobs, sent = Blobs(), []
            result = observe.app(
                served, blobs, label="named-root-register", archive=observe.release_archive(served),
                commands=["m0-f0"], questions={"/survey/name": ["Chen"]}, views=True, sent=sent,
            )
            walk = blobs.get_json(result["answer"])["walks"]["m0-f0"]
    form, = [step["form"] for step in walk["steps"] if step.get("screen") == "FormEntryActivity" and "form" in step]
    assert form["saved"]["finishing"], form
    submission, = sent
    root = etree.fromstring(submission)
    assert etree.QName(root).localname == "survey"
    assert root.findtext("{*}name") == "Chen"
    case = root.find("{http://commcarehq.org/case/transaction/v2}case")
    assert case is not None and case.get("case_id")
    assert case.findtext("{*}create/{*}case_name") == "Chen"
    assert root.findtext("{*}meta/{*}instanceID")


def test_installed_android_preserves_a_unicode_primary_root(android_documents, hq, core_runner, evidence):
    from proof.formplayer.test_named_answer_root import UNICODE_ROOT, set_named_answer_root

    doc = android_documents["targeted-named-answer-root"]
    with apps.published(doc, core_runner) as published:
        set_named_answer_root(published, UNICODE_ROOT)
        with hq_forms.serve(published.unit, doc, published.app_id, platforms={"android"}) as served:
            blobs, sent, stored = Blobs(), [], []
            result = observe.app(
                served, blobs, label="unicode-answer-root", archive=observe.release_archive(served), delivered=True,
                commands=["m0-f0"], questions={f"/{UNICODE_ROOT}/name": ["Chen"]}, sent=sent, stored=stored,
            )
            assert len(sent) == 1, blobs.get_json(result["answer"])
            receipt, = stored
            assert receipt["form"]["normal"], receipt
            for raw in (sent[0], receipt["form"]["xml"].encode()):
                root = etree.fromstring(raw)
                assert etree.QName(root).localname == UNICODE_ROOT
                assert root.findtext("{*}name") == "Chen"
                case = root.find("{http://commcarehq.org/case/transaction/v2}case")
                case_id = case.get("case_id")
                assert case.findtext("{*}create/{*}case_name") == "Chen"
                assert receipt["instanceID"] in receipt["cases"][case_id]["forms"], receipt
            evidence("unicode-answer-root-android-submitted", {"root": UNICODE_ROOT, "caseType": receipt["cases"][case_id]["type"]})
