"""HQ's own editor keeps the ordinary answer, its integration namespace and question locks."""

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.editors.hq import HQAnswers
from proof.rules.conftest import published

VELLUM = "{http://commcarehq.org/xforms/vellum}"


def test_vellum_keeps_the_questions_in_their_receivers_namespace(hq, core_runner, editor_driver):
    document = corpus_document("targeted-receiving-answers")
    with published(document, core_runner, "maximum") as app:
        form = app._app().modules[0].forms[0]
        endpoint = HQAnswers(app.unit, app.unit)
        first = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id,
                                     edit={"way": "builder-model", "path": "/data/visit/script", "label": "Visit notes"})
        assert first.saved and first.stored_source, (first.load_error, first.save_refusal, first.form_errors)
        second = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id)
        assert second.saved and second.stored_source, (second.load_error, second.save_refusal, second.form_errors)
        for xml in [first.stored_source, second.stored_source]:
            tree = etree.fromstring(xml.encode())
            root, = tree.xpath("//*[local-name()='instance' and not(@id)]/*")
            hidden = root.find("{*}visit/{urn:receiving-service:household}service_value")
            assert hidden is not None and hidden.get(VELLUM + "lock") == "all"
            bind, = tree.xpath("//*[local-name()='bind' and @nodeset='/data/visit/case_note']")
            assert bind.get(VELLUM + "lock") == "all"
            assert root.find("{*}visit/{*}script") is not None
            assert "Visit notes" in tree.xpath("//*[local-name()='value']/text()")
        write_evidence("locked-receiving-value", {"edited": first.stored_source, "reopened": second.stored_source})
