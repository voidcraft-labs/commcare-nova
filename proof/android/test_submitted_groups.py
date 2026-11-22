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
        "arrival", "visit_note", "next", "household",
    ]
    assert root.findtext("{*}arrival") == "Jo"
    assert root.findtext("{*}next") == "Revisit"
    assert root.findtext("{*}household/{*}name") == "Chen"
