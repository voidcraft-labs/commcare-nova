"""The installed worker form has one order on screen and another in its submitted XML."""

import pytest
from lxml import etree

from proof.android import observe
from proof.formplayer import apps
from proof.formplayer import hq as hq_forms
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")


def test_android_submits_answers_under_their_data_groups(android_documents, hq):
    document = android_documents["targeted-submitted-groups"]
    answers = {"/data/arrival": ["Jo"], "/data/household/name": ["Chen"], "/data/next": ["Revisit"]}
    with apps.published(document, None) as published:
        with hq_forms.serve(published.unit, document, published.app_id) as served:
            blobs, sent = Blobs(), []
            found = observe.app(
                served, blobs, label="submitted-household", archive=observe.release_archive(served),
                commands=["m0-f0"], questions=answers, views=True, sent=sent,
            )
            walk = blobs.get_json(found["answer"])["walks"]["m0-f0"]
    form, = [step["form"] for step in walk["steps"] if step.get("screen") == "FormEntryActivity" and "form" in step]
    assert form["saved"]["finishing"], form
    pages = [[q["given"] for q in screen.get("answered", []) if "given" in q] for screen in form["screens"]]
    assert [page for page in pages if page] == [["Jo"], ["Chen"], ["Revisit"]]
    submission, = sent
    root = etree.fromstring(submission)
    assert [etree.QName(n).localname for n in root if etree.QName(n).localname != "meta"] == [
        "arrival", "next", "household", "visit_note",
    ]
    assert root.findtext("{*}arrival") == "Jo"
    assert root.findtext("{*}next") == "Revisit"
    assert root.findtext("{*}household/{*}name") == "Chen"

def test_crossed_control_and_data_relevance_in_android(android_documents, hq):
    document = android_documents["targeted-submitted-groups"]
    with apps.published(document, None) as published:
        with hq_forms.serve(published.unit, document, published.app_id) as served:
            blobs, sent = Blobs(), []
            found = observe.app(
                served, blobs, label="crossed-relevance", archive=observe.release_archive(served),
                commands=["m0-f1"], questions={"/data/include_details": ["no"],
                    "/data/details/finding": ["unexpected"], "/data/receipt/result": ["unexpected"]},
                views=True, sent=sent,
            )
            walk = blobs.get_json(found["answer"])["walks"]["m0-f1"]
    form, = [step["form"] for step in walk["steps"] if step.get("screen") == "FormEntryActivity" and "form" in step]
    assert form["saved"]["finishing"], form
    given = [q["given"] for screen in form["screens"] for q in screen.get("answered", []) if "given" in q]
    assert given == ["no"], form
    submission, = sent
    root = etree.fromstring(submission)
    assert root.findtext("{*}receipt/{*}result") == "reviewed"
    assert root.find("{*}receipt/{*}notice") is not None and root.findtext("{*}receipt/{*}notice") == ""
    assert root.find("{*}details") is None
