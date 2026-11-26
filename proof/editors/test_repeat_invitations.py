"""A fresh Vellum save preserves both translated invitations through an ordinary wording change."""

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.editors.hq import HQAnswers
from proof.rules.conftest import published


def test_the_designer_keeps_both_translated_invitations(hq, core_runner, editor_driver):
    with published(corpus_document("targeted-repeat-invitations"), core_runner) as app:
        form = app._app().modules[0].forms[0]
        endpoint = HQAnswers(app.unit, app.unit)
        edited = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id,
                                      edit={"path": "/data/worker", "label": "Your name", "way": "builder-model"})
        assert edited.saved and edited.stored_source, (edited.load_error, edited.save_refusal, edited.form_errors)
        reopened = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id)
        assert reopened.saved and reopened.stored_source, (reopened.load_error, reopened.save_refusal, reopened.form_errors)
    for source in (edited.stored_source, reopened.stored_source):
        root = etree.fromstring(source.encode())
        repeat, = root.xpath("//*[local-name()='repeat' and @nodeset='/data/visit']")
        first, = repeat.findall("{http://openrosa.org/javarosa}addEmptyCaption")
        later, = repeat.findall("{http://openrosa.org/javarosa}addCaption")
        ids = []
        for element in (first, later):
            ref = element.get("ref", "")
            assert ref.startswith("jr:itext('") and ref.endswith("')"), ref
            ids.append(ref[len("jr:itext('"):-2])
        assert len(set(ids)) == 2
        for lang, values in (("en", ["Record the first visit", "Record another visit"]),
                             ("es", ["Registrar la primera visita", "Registrar otra visita"])):
            translations, = root.xpath("//*[local-name()='translation' and @lang=$lang]", lang=lang)
            assert [translations.findtext("{*}text[@id='%s']/{*}value" % key) for key in ids] == values
        assert "Your name" in root.xpath("//*[local-name()='value']/text()")
    write_evidence("repeat-invitations", {"wording": edited.stored_source, "reopened": reopened.stored_source})
