"""A person can change a question in a form with its own answer root and reopen it in Vellum."""

import pytest
from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.editors.hq import HQAnswers
from proof.rules.conftest import published


def test_vellum_saves_and_reopens_the_named_answer_root(hq, core_runner, editor_driver):
    with published(corpus_document("targeted-named-answer-root"), core_runner) as app:
        form = app._app().modules[0].forms[0]
        endpoint = HQAnswers(app.unit, app.unit)
        first = vellum.open_and_save(
            editor_driver, endpoint, app.app_id, form.unique_id,
            edit={"path": "/survey/name", "label": "Family name", "way": "builder-model"},
        )
        assert first.saved and first.stored_source, (first.load_error, first.save_refusal, first.form_errors)
        reopened = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id)
        assert reopened.saved and reopened.stored_source, (reopened.load_error, reopened.save_refusal, reopened.form_errors)
        for result in (first, reopened):
            tree = etree.fromstring(result.stored_source.encode())
            instance = tree.xpath("//*[local-name()='model']/*[local-name()='instance' and not(@id)]/*")
            root, = instance
            assert etree.QName(root).localname == "survey"
            assert etree.QName(root).namespace == form.xmlns
            assert root.find("{*}name") is not None
            assert tree.xpath("//*[local-name()='input']/@ref") == ["/survey/name"]
            assert "Family name" in tree.xpath("//*[local-name()='value']/text()")
        write_evidence("named-answer-root", {"edited": first.stored_source, "reopened": reopened.stored_source})


@pytest.mark.parametrize("name", ["instance", "parsererror", "bind", "case", "registration"])
def test_designer_reads_reserved_answer_root_names_as_its_own_elements(hq, core_runner, editor_driver, name):
    with published(corpus_document("targeted-named-answer-root"), core_runner) as app:
        model = app._app()
        form = model.modules[0].forms[0]
        tree = etree.fromstring(form.source.encode())
        root, = tree.xpath("//*[local-name()='model']/*[local-name()='instance' and not(@id)]/*")
        root.tag = "{%s}%s" % (etree.QName(root).namespace, name)
        for element in tree.iter():
            for key, value in list(element.attrib.items()):
                if "/survey/" in value:
                    element.set(key, value.replace("/survey/", f"/{name}/"))
        name_mapping = form.actions.open_case.name_update
        if name_mapping.question_path == "/survey/name":
            name_mapping.question_path = f"/{name}/name"
        form.source = etree.tostring(tree, encoding="unicode")
        model.save()
        result = vellum.fresh_open_and_save(editor_driver, HQAnswers(app.unit, app.unit), app.app_id, form.unique_id)
        write_evidence(f"raw-answer-root-{name}", {"source": form.source, "loaded": result.loaded,
                       "loadError": result.load_error, "warnings": result.form_errors, "saved": result.stored_source})
        if name == "instance":
            assert not result.loaded and "multiple unnamed instance elements" in result.load_error
        elif name == "bind":
            assert not result.loaded and "Cannot read properties of undefined" in result.load_error, result.events
        elif name == "parsererror":
            assert not result.loaded and "Parsing Error" in result.load_error, result.events
        else:
            assert result.loaded and result.saved, (result.load_error, result.save_refusal)
            assert "This bind node will be discarded" not in str(result.form_errors)
            reopened = vellum.fresh_open_and_save(editor_driver, HQAnswers(app.unit, app.unit), app.app_id, form.unique_id)
            assert reopened.loaded and reopened.saved, (reopened.load_error, reopened.save_refusal)
            for event in (result, reopened):
                saved = etree.fromstring(event.stored_source.encode())
                assert saved.xpath("//*[local-name()='model']/*[local-name()='instance' and not(@id)]/*[local-name()=$name]", name=name)
                assert saved.xpath("//*[local-name()='input']/@ref") == [f"/{name}/name"]
            write_evidence(f"reopened-answer-root-{name}", {"source": reopened.stored_source, "warnings": reopened.form_errors})
