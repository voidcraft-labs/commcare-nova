"""On an installed Android app, ordinary answers arrive, the form creates the household, and HQ stores both.

An answer named ``script`` on either app, and one named ``Registration`` on the app that runs only on Android, is
an ordinary answer: the device offers its transaction parsers only stock-namespace nodes and ``case``
(``FormRecordProcessor``), and HQ's receiver stores the form whole and applies its one case change."""

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
            blobs, sent, stored = Blobs(), [], []
            report = observe.app(
                served, blobs, label=app_id, archive=observe.release_archive(served),
                commands=["m0-f0"], questions={"/data/visit/" + k: [v] for k, v in expected.items()},
                views=True, sent=sent, stored=stored,
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
    # The reader names a case the device made by the order it made it (``Cases.java``, ``@device-case:<n>``), not
    # by the id the form gave it; the submission's own case block carries that id.
    assert case is not None and case.get("case_id"), received
    assert household["id"].startswith("@device-case:"), household
    # HQ's receiver stored the form the device sent, every answer in it, and applied its case change once.
    kept, = stored
    assert "raised" not in kept, kept
    assert kept["instanceID"] == root.findtext("{*}meta/{*}instanceID"), kept
    assert kept["form"]["normal"] and kept["form"]["xmlns"] == etree.QName(root).namespace, kept
    hq_root = etree.fromstring(kept["form"]["xml"].encode())
    assert {k: hq_root.findtext("{*}visit/{*}" + k) for k in expected} == expected
    assert kept["cases"] == {case.get("case_id"): {"name": "Chen", "type": "household", "forms": [kept["instanceID"]]}}
