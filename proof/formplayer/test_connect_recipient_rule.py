"""A repeated visit's editable recipient rule during entry and final submit."""

import pytest
from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import questions, screen_kind

XFORMS = "http://www.w3.org/2002/xforms"
JR = "http://openrosa.org/javarosa"
CONNECT = "http://commcareconnect.com/data/v1/learn"
DOCUMENT = "targeted-validated-barcode-secret"


def _source(original, skip_unchanged):
    root = etree.fromstring(original.encode() if isinstance(original, str) else original)
    model, = root.xpath("//*[local-name()='model']")
    instance, = model.xpath("./*[local-name()='instance' and not(@id)]")
    data = instance[0]
    for child in list(data):
        data.remove(child)
    for child in list(model):
        if child is not instance:
            model.remove(child)
    body, = root.xpath("//*[local-name()='body']")
    for child in list(body):
        body.remove(child)

    ns = etree.QName(data).namespace
    rows = etree.SubElement(data, f"{{{ns}}}rows", {f"{{{JR}}}template": ""})
    etree.SubElement(rows, f"{{{ns}}}recipient")
    wrapper = etree.SubElement(rows, f"{{{ns}}}visit", {"{http://commcarehq.org/xforms/vellum}role": "ConnectDeliverUnit"})
    unit = etree.SubElement(wrapper, f"{{{CONNECT}}}deliver", id="visit", nsmap={None: CONNECT})
    for name in ("name", "entity_id", "entity_name", "work_area_id"):
        leaf = etree.SubElement(unit, f"{{{CONNECT}}}{name}")
        if name == "name":
            leaf.text = "Visit"
    path = "/data/rows[true()]/recipient"
    unique = f"string-length(join('|', {path})) = string-length(join('|', distinct-values({path})))"
    etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset="/data/rows/recipient",
                     type="string", required="true()", constraint=unique)
    etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset="/data/rows/visit/deliver/entity_id",
                     calculate="../../../recipient")
    itext = etree.SubElement(model, f"{{{XFORMS}}}itext")
    language = etree.SubElement(itext, f"{{{XFORMS}}}translation", lang="en", default="")
    for key, value in [("rows", "Visit"), ("recipient", "Recipient ID")]:
        label = etree.SubElement(language, f"{{{XFORMS}}}text", id=key)
        etree.SubElement(label, f"{{{XFORMS}}}value").text = value
    if skip_unchanged:
        pragma = etree.SubElement(language, f"{{{XFORMS}}}text", id="Pragma-Skip-Full-Form-Validation")
        etree.SubElement(pragma, f"{{{XFORMS}}}value").text = "yes"
    group = etree.SubElement(body, f"{{{XFORMS}}}group")
    etree.SubElement(group, f"{{{XFORMS}}}label", ref="jr:itext('rows')")
    repeat = etree.SubElement(group, f"{{{XFORMS}}}repeat", nodeset="/data/rows")
    control = etree.SubElement(repeat, f"{{{XFORMS}}}input", ref="/data/rows/recipient")
    etree.SubElement(control, f"{{{XFORMS}}}label", ref="jr:itext('recipient')")
    return etree.tostring(root, encoding="unicode")


@pytest.mark.parametrize("skip_unchanged", [False, True], ids=["full", "skip-unchanged"])
def test_each_worker_edit_keeps_the_final_delivery_ids_distinct(
    hq, core_runner, formplayer_runner, formplayer_documents, skip_unchanged
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        change = apps.form_written(published, {"0.0": lambda original: _source(original, skip_unchanged)})
        with apps.served(published, formplayer_runner, change=change) as served, served.run("recipients"):
            web = apps.web(formplayer_runner, served)
            web.navigate(["0"])
            form = web.navigate(["0", "0"])
            assert screen_kind(form) == "form", form
            session, tree = form["session_id"], form["tree"]
            entered = []
            for value in ("First", "Second"):
                add = next(node for node in questions(tree) if node.get("exists") == "false" and node.get("repeatable") == "true")
                tree = web.form_request("new-repeat", session, ix=add["ix"])["tree"]
                fields = [node for node in questions(tree) if node.get("type") == "question"]
                assert len(fields) == len(entered) + 1
                index = fields[-1]["ix"]
                if entered:
                    refused = web.answer(session, index, "First")
                    assert refused["status"] == "validation-error", refused
                accepted = web.answer(session, index, value)
                assert accepted["status"] == "accepted", accepted
                entered.append(index)
                tree = accepted["tree"]
            back = web.answer(session, entered[0], "Second")
            assert back["status"] == "validation-error", back
            # A final posted edit to an answered field must also fail.
            before = len(served.hq.submissions)
            duplicate = web.submit(session, dict.fromkeys(entered, "Second"))
            assert duplicate["status"] == "validation-error", duplicate
            assert len(served.hq.submissions) == before
            success = web.submit(session, dict(zip(entered, ("First", "Second"), strict=True)))
            assert success["status"] == "success", success
            instance = etree.fromstring(served.hq.submissions[-1].instance)
            assert instance.xpath("//*[local-name()='entity_id']/text()") == ["First", "Second"]
