"""The installed repeat dialog shows the worker's first and subsequent invitations in both languages."""

import json
import os
from pathlib import Path

import pytest
from lxml import etree

from proof.android import observe
from proof.formplayer import apps
from proof.formplayer import hq as hq_forms
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")


def test_android_shows_the_invitations_in_each_worker_language(android_documents, hq, core_runner):
    doc = android_documents["targeted-repeat-invitations"]
    with apps.published(doc, core_runner) as published, hq_forms.serve(published.unit, doc, published.app_id) as served:
        blobs, sent = Blobs(), []
        answer = observe.app(served, blobs, label="visit-invitations", archive=observe.release_archive(served),
                             commands=["m0-f0"], questions={"/data/visit/place": ["North"]}, views=True, sent=sent)
        walks = blobs.get_json(answer["answer"])["walks"]
    for key, first, later in (("m0-f0", "Record the first visit", "Record another visit"),
                              ("@language:es/m0-f0", "Registrar la primera visita", "Registrar otra visita")):
        form, = [step["form"] for step in walks[key]["steps"] if "form" in step and step.get("screen") == "FormEntryActivity"]
        prompts = [screen for screen in form["screens"] if "choices" in screen and "chose" in screen]
        assert [prompt["choices"][1] for prompt in prompts] == [first, later], form
        assert prompts[0]["chose"] == first and prompts[1]["chose"] == prompts[1]["choices"][2], prompts
    assert len(sent) == 2
    for instance in sent:
        rows = etree.fromstring(instance).findall("{*}visit")
        assert [row.findtext("{*}place") for row in rows] == ["North"]
    if output := os.environ.get("PROOF_OUT"):
        directory = Path(output, "android")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "repeat-invitations.json").write_text(
            json.dumps({"walks": walks, "instances": [s.decode() for s in sent]}, ensure_ascii=False)
        )
