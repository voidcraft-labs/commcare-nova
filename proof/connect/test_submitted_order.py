"""Vellum can hold a worker question after a lesson while submitting its answer before that lesson."""

from lxml import etree

from proof.connect.conftest import CONNECT_XMLNS, LEARN
from proof.editors import vellum
from proof.editors.hq import HQAnswers
from proof.rules.conftest import published


def test_the_designer_keeps_independent_question_and_submitted_activity_order(
    hq, core_runner, editor_driver, connect_documents, connect_out
):
    questions = [
        {"type": "Group", "id": "practice", "label": "Practice"},
        {"type": "ConnectLearnModule", "id": "checkpoint",
         "properties": {"name": "Checkpoint", "description": "Check the lesson", "time_estimate": "1"}},
        {"type": "Text", "id": "before", "label": "First answer"},
        {"type": "Text", "id": "after", "label": "Second answer", "properties": {"dataParent": "#form/practice"}},
    ]
    with published(connect_documents[LEARN], core_runner, "maximum") as app:
        form = app._app().modules[0].forms[0]
        endpoint = HQAnswers(app.unit, app.unit)
        change = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id,
                                      edit={"way": "add-questions", "questions": questions})
        assert change.saved and change.stored_source, (change.load_error, change.save_refusal, change.form_errors)
        again = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id)
        assert again.saved and again.stored_source, (again.load_error, again.save_refusal, again.form_errors)
        out = connect_out / "sections"
        out.mkdir(exist_ok=True, parents=True)
        for label, source in [("authored", change.stored_source), ("reopened", again.stored_source)]:
            xml = source.encode()
            (out / f"independent-order-{label}.xml").write_bytes(xml)
            tree = etree.fromstring(xml)
            namespaces = {"x": "http://www.w3.org/2002/xforms", "h": "http://www.w3.org/1999/xhtml", "c": CONNECT_XMLNS}
            names = tree.xpath("//h:body/*/@ref", namespaces=namespaces)
            assert names[-3:] == ["/data/practice", "/data/before", "/data/practice/after"], names
            root, = tree.xpath("//x:instance/*[local-name()='data']", namespaces=namespaces)
            assert [etree.QName(child).localname for child in root][-3:] == ["practice", "checkpoint", "before"]
            assert root.xpath("./*[local-name()='practice']/*[local-name()='after']")
            assert root.xpath("./*[local-name()='checkpoint']/c:module/@id", namespaces=namespaces) == ["checkpoint"]
