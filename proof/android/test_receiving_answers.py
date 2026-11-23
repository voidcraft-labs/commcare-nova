"""On an installed Android app, ordinary answers arrive and the form creates the household."""

import pytest
from lxml import etree

from proof.android import observe
from proof.formplayer import apps
from proof.formplayer import hq as hq_forms
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")


@pytest.mark.parametrize("android_only", [False, True], ids=["both-platforms", "android-only"])
def test_android_keeps_the_answer_and_processes_the_household(android_documents, hq, core_runner, android_only):
    app_id = "targeted-receiving-answers" + ("-android" if android_only else "")
    document = android_documents[app_id]
    expected = {"case_note": "Chen", "script": "Agreed to visit"}
    if android_only:
        expected["Registration"] = "R12"
    with apps.published(document, core_runner, "maximum") as published:
        with hq_forms.serve(published.unit, document, published.app_id) as served:
            blobs, sent = Blobs(), []
            report = observe.app(
                served, blobs, label=app_id, archive=observe.release_archive(served),
                commands=["m0-f0"], questions={"/data/visit/" + k: [v] for k, v in expected.items()},
                views=True, sent=sent,
            )
            walk = blobs.get_json(report["answer"])["walks"]["m0-f0"]
    form, = [s["form"] for s in walk["steps"] if "form" in s and s["screen"] == "FormEntryActivity"]
    saved = form["saved"]
    assert saved["finishing"], saved
    household, = [c for c in saved["cases"] if c.get("name") == "Chen" and c.get("type") == "household"]
    received, = sent
    root = etree.fromstring(received)
    assert {k: root.findtext("{*}visit/{*}" + k) for k in expected} == expected
    assert root.find("{*}visit/{urn:receiving-service:household}service_value") is not None
    case = root.find("{http://commcarehq.org/case/transaction/v2}case")
    assert case is not None and case.get("case_id") == household["id"]
