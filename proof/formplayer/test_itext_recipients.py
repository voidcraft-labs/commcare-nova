"""Pinned readers of long text forms and inline video, by actual itext recipient."""

import json

from lxml import etree

from proof.formplayer import apps
from proof.formplayer.test_media_slots import GROUPED, GROUPED_QUESTION, _questions

XF = "{http://www.w3.org/2002/xforms}"
BODY = "{http://www.w3.org/1999/xhtml}body"
VIDEO = "jr://file/commcare/e9cefb19834b705b60adbb1f14ae4cce5313616c0390e9b9601a50b3ca9bab38.mp4"
LONG_TEXT = {
    "household-label": "The household title",
    "household-address-label": "The address label",
    "household-address-hint": "The address hint",
    "household-address-constraintMsg": "The address violation",
    "help-control": "The address help",
    "choice-control": "The chosen option",
    "repeat-control": "The entries title",
}


def with_recipient_forms(source, inline_video=VIDEO):
    root = etree.fromstring(source.encode() if isinstance(source, str) else source)
    model, = root.iter(f"{XF}model")
    body, = root.iter(BODY)
    data, = model.find(f"{XF}instance")
    data_ns = f"{{{etree.QName(data).namespace}}}"
    translation, = model.iter(f"{XF}translation")
    question = body.find(f".//{XF}input")
    etree.SubElement(question, f"{XF}help", ref="jr:itext('help-control')")
    etree.SubElement(data, f"{data_ns}colour")
    etree.SubElement(model, f"{XF}bind", nodeset="/data/colour", type="xsd:string")
    choices = etree.SubElement(body, f"{XF}select1", ref="/data/colour")
    etree.SubElement(choices, f"{XF}label").text = "Colour"
    item = etree.SubElement(choices, f"{XF}item")
    etree.SubElement(item, f"{XF}label", ref="jr:itext('choice-control')")
    etree.SubElement(item, f"{XF}value").text = "one"
    row = etree.SubElement(data, f"{data_ns}entries", {"{http://openrosa.org/javarosa}template": ""})
    etree.SubElement(row, f"{data_ns}note")
    group = etree.SubElement(body, f"{XF}group", ref="/data/entries")
    etree.SubElement(group, f"{XF}label", ref="jr:itext('repeat-control')")
    repeat = etree.SubElement(group, f"{XF}repeat", nodeset="/data/entries")
    note = etree.SubElement(repeat, f"{XF}input", ref="/data/entries/note")
    etree.SubElement(note, f"{XF}label").text = "Entry note"
    for identity, short in (
        ("help-control", "Help"),
        ("choice-control", "First"),
        ("repeat-control", "Entries"),
    ):
        text = etree.SubElement(translation, f"{XF}text", id=identity)
        etree.SubElement(text, f"{XF}value").text = short
    for identity, long in LONG_TEXT.items():
        text, = translation.findall(f"{XF}text[@id='{identity}']")
        for old in text.findall(f"{XF}value[@form='markdown']"):
            text.remove(old)
        etree.SubElement(text, f"{XF}value", form="long").text = long
        etree.SubElement(text, f"{XF}value", form="video-inline").text = inline_video
    return etree.tostring(root, encoding="unicode")


def with_isolated_help(source, values):
    """Add one standalone question, with a help entry only where requested."""
    root = etree.fromstring(source.encode() if isinstance(source, str) else source)
    model, = root.iter(f"{XF}model")
    body, = root.iter(BODY)
    data, = model.find(f"{XF}instance")
    namespace = etree.QName(data).namespace
    etree.SubElement(data, f"{{{namespace}}}isolated_help")
    etree.SubElement(model, f"{XF}bind", nodeset="/data/isolated_help", type="xsd:string")
    question = etree.SubElement(body, f"{XF}input", ref="/data/isolated_help")
    etree.SubElement(question, f"{XF}label").text = "Help control"
    if values is not None:
        ref = "isolated-help-control"
        etree.SubElement(question, f"{XF}help", ref=f"jr:itext('{ref}')")
        for translation in root.iter(f"{XF}translation"):
            entry = etree.SubElement(translation, f"{XF}text", id=ref)
            for form, content in values:
                value = etree.SubElement(entry, f"{XF}value", **({"form": form} if form else {}))
                value.text = content
    return etree.tostring(root, encoding="unicode")


def test_formplayer_reads_long_recipients_and_never_sends_inline_video(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[GROUPED], core_runner) as published:
        change = apps.form_written(published, {
            "0.0": lambda source: with_recipient_forms(source, "jr://file/commcare/inline-proof.mp4"),
        })
        with apps.served(published, formplayer_runner, change=change) as served:
            walked = apps.walked(formplayer_runner, served)
    steps = [step for run in walked["runs"] for step in run["steps"]]
    trees = [
        step["response"]["tree"]
        for step in steps
        if isinstance(step.get("response"), dict) and isinstance(step["response"].get("tree"), list)
    ]
    questions = [node for tree in trees for node in _questions(tree)]
    address = next(node for node in questions if node.get("binding") == GROUPED_QUESTION)
    choice = next(node for node in questions if node.get("binding") == "/data/colour")
    groups = {node["caption"] for node in questions if node.get("type") == "sub-group"}
    refusals = [
        attempt["response"] for step in steps for attempt in step.get("answers") or ()
        if attempt["response"].get("status") != "accepted"
    ]
    evidence("itext-recipient-forms", {"address": address, "choice": choice, "groups": sorted(groups), "refusals": refusals})
    assert address["caption"] == "The address label", address
    assert address["hint"] == "The address hint", address
    assert address["help"] == "The address help", address
    assert "The chosen option" in json.dumps(choice["choices"]), choice
    assert {"The household title", "The entries title"} <= groups, groups
    assert any("The address violation" in json.dumps(response) for response in refusals), refusals
    # Ordinary video is a separate, visible control beside the accepted label.
    assert str(address.get("caption_video")).endswith(".mp4"), address
    assert "inline-proof.mp4" not in json.dumps(trees), trees
