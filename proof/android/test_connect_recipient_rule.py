"""Android checks the receipt key in its own widgets before it sends the worker's completed form."""

import pytest
from lxml import etree

from proof.android import observe
from proof.connect.recipient_rule import DOCUMENT, source
from proof.formplayer import apps
from proof.formplayer import hq as hq_forms
from proof.observe.record import Blobs

FORM = "m0-f0"
FIRST = "/data/rows[1]/recipient[1]"
SECOND = "/data/rows[2]/recipient[1]"


@pytest.mark.parametrize("repair", [False, True], ids=["held", "corrected"])
def test_the_device_checks_the_recipient_in_each_completed_visit(android_documents, hq, repair):
    document = android_documents[DOCUMENT]
    with apps.published(document, None) as published:
        change = apps.form_written(published, {"0.0": lambda original: source(original, False, confirmation=True)})
        with hq_forms.serve(published.unit, document, published.app_id, change=change) as served:
            blobs, sent = Blobs(), []
            found = observe.app(
                served, blobs, label="recipient", archive=observe.release_archive(served),
                commands=[FORM], repeat_additions=2, type_refused=True, views=True, sent=sent,
                questions={FIRST: ["First"], SECOND: ["First", "Second"] if repair else ["First"],
                           "/data/confirmed": ["Done"]},
            )
            walk = blobs.get_json(found["answer"])["walks"][FORM]
    form, = [step["form"] for step in walk["steps"] if step.get("screen") == "FormEntryActivity" and "form" in step]
    entries = [entry for screen in form["screens"] for entry in screen.get("answered", [])]
    assert any(entry["reference"] == FIRST and entry.get("given") == "First" for entry in entries), entries
    rejected = [entry for entry in entries if entry["reference"] == SECOND and "First: constraint" in entry.get("refused", [])]
    assert rejected, entries
    assert form["saved"]["finishing"] is repair, form["saved"]
    if repair:
        assert any(entry.get("given") == "Second" for entry in rejected), rejected
        instance, = sent
        assert etree.fromstring(instance).xpath("//*[local-name()='entity_id']/text()") == ["First", "Second"]
    else:
        assert any(entry.get("typed") == "First" for entry in rejected), rejected
        assert sent == []
