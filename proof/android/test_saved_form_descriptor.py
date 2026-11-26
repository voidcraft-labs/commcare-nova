"""An Android save keeps the active language's expanded descriptor.

The project's own SaveToDiskTask saves the record, and home's archive reopens it
through SessionStateDescriptor. The actual submission then carries the answer
from before the worker left the form.
"""

import pytest
from lxml import etree

from proof.android import observe
from proof.formplayer import apps
from proof.formplayer import hq as hq_forms
from proof.observe.record import Blobs
from proof.observe.served import local_archive

pytestmark = pytest.mark.reader("android")


def test_android_saves_a_localized_descriptor_and_reopens_the_answer(android_documents, hq, core_runner):
    doc = android_documents["targeted-saved-form-descriptor"]
    with apps.published(doc, core_runner) as published, hq_forms.serve(published.unit, doc, published.app_id) as served:
        for name, archive in (
            ("local", local_archive(doc.local_ccz, published.app_id)),
            ("hq", observe.release_archive(served)),
        ):
            blobs, sent = Blobs(), []
            report = observe.app(
                served, blobs, label="saved-form-descriptor-" + name, archive=archive,
                commands=[], questions={"/data/record": []}, save_incomplete="m0-f0",
                save_language="fr", reopen=True, sent=sent,
            )
            saved = blobs.get_json(report["answer"])["savedIncomplete"]
            (record,) = [item for item in saved["records"] if item["status"] == "incomplete"]
            assert record["descriptor"] == "Visite 1", saved
            assert record["descriptor"] != record["FormRecord.getDisplayName"], saved
            reopened = saved["reopened"]
            assert reopened["screen"] == "FormEntryActivity", reopened
            observed = [
                question["answer"]
                for screen in reopened["form"]["screens"]
                for question in screen["questions"]
                if question["reference"].rsplit("/", 1)[-1].split("[", 1)[0] == "record"
            ]
            assert observed == ["1"], reopened
            assert reopened["form"]["saved"]["finishing"] is True, reopened
            assert reopened["form"]["saved"]["descriptor"] == "Visite 1", reopened
            (instance,) = sent
            assert etree.fromstring(instance).findtext("{*}record") == "1", reopened
