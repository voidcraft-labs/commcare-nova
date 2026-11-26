"""An ordinary wording edit and a fresh save retain the real confirmation, message slots, and starting answer."""

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.editors.hq import HQAnswers
from proof.rules.conftest import published


def test_vellum_saves_editable_worker_messages(hq, core_runner, editor_driver):
    with published(corpus_document("targeted-worker-messages"), core_runner) as app:
        form = app._app().modules[0].forms[0]
        endpoint = HQAnswers(app.unit, app.unit)
        first = vellum.open_and_save(
            editor_driver, endpoint, app.app_id, form.unique_id,
            edit={"path": "/data/confirmed", "label": "I have reviewed the notes", "way": "builder-model"},
        )
        assert first.saved and first.stored_source, (first.load_error, first.save_refusal, first.form_errors)
        fresh = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id)
        assert fresh.saved and fresh.stored_source, (fresh.load_error, fresh.save_refusal, fresh.form_errors)
        for source in (first.stored_source, fresh.stored_source):
            tree = etree.fromstring(source.encode())
            triggers = tree.xpath("//*[local-name()='trigger']")
            assert [trigger.get("ref") for trigger in triggers] == ["/data/notice", "/data/confirmed", "/data/optional"]
            assert [trigger.get("appearance") for trigger in triggers] == ["minimal", None, None]
            assert tree.xpath("//*[local-name()='bind' and @nodeset='/data/confirmed']/@required") == ["true()"]
            assert tree.xpath("//*[local-name()='bind' and @nodeset='/data/confirmed']/@constraint")
            assert tree.xpath("//*[local-name()='bind' and @nodeset='/data/location']/@constraint")
            assert tree.xpath("//*[local-name()='setvalue' and @ref='/data/optional']/@value") == ["'later'"]
            texts = tree.xpath("//*[local-name()='value']/text()")
            for value in ("I have reviewed the notes", "Read this first", "Open the notes before continuing",
                          "Confirm that you reviewed the notes", "Stand outside", "Check the coordinates"):
                assert value in texts, (value, texts)
            assert triggers[0].find("{*}hint") is not None and triggers[0].find("{*}help") is not None
        write_evidence("worker-messages", {"edited": first.stored_source, "reopened": fresh.stored_source})


def test_vellum_retains_a_filename_and_the_replacement_condition_after_edit_and_reopen(hq, core_runner, editor_driver):
    with published(corpus_document("targeted-worker-messages"), core_runner) as app:
        form = app._app().modules[0].forms[1]
        endpoint = HQAnswers(app.unit, app.unit)
        edited = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id, edit={
            "path": "/data/replacement", "label": "Report for this visit", "way": "builder-model",
        })
        assert edited.saved and edited.stored_source, (edited.load_error, edited.save_refusal)
        reopened = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id)
        assert reopened.saved and reopened.stored_source, (reopened.load_error, reopened.save_refusal)
    for source in (edited.stored_source, reopened.stored_source):
        tree = etree.fromstring(source.encode())
        for question, value in (("report", "'carry-forward.pdf'"), ("replacement", "'needs-file.pdf'"), ("photo", "''")):
            assert tree.xpath("//*[local-name()='setvalue' and @ref=$path]/@value", path="/data/" + question) == [value]
        report, replacement = [tree.xpath("//*[local-name()='bind' and @nodeset=$path]", path="/data/" + name)[0]
                               for name in ("report", "replacement")]
        assert report.get("constraint") and replacement.get("constraint")
        msg = "{http://openrosa.org/javarosa}constraintMsg"
        assert not report.get(msg) and replacement.get(msg)
        assert tree.xpath("//*[local-name()='upload' and @ref='/data/photo']/*[local-name()='help']/@ref")
        words = tree.xpath("//*[local-name()='value']/text()")
        assert "Choose the current report" in words and "Report for this visit" in words
    write_evidence("capture-filenames", {"edited": edited.stored_source, "reopened": reopened.stored_source})
