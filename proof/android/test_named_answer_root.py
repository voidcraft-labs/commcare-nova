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
