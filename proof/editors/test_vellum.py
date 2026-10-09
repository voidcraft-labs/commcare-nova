"""Vellum opens and saves HQ's forms as HQ's form designer does, observed by Vellum's own events.

Contract: a form HQ holds opens in HQ's vendored Vellum with the options HQ's
form designer computes; the driver waits on Vellum's own events (load,
readiness, the data sources' arrival, the save's answer), never on time;
Vellum's save request is applied by HQ's view; and what the save leaves is
judged as Core reads HQ's build of it. The plausible failures: a save that
never reaches HQ (Vellum refusing, a request answered by something other than
HQ's view), a record taken before Vellum finished revalidating (a fixed wait
that is too short) or before it finished saving (Vellum re-sends a full save
when HQ's answer holds no matching sha1), parse errors or question errors that
go unrecorded, a save HQ applies in a language other than the one the person
edits in, and a comparison of text that hides or invents a difference Core
would not see.
"""

from __future__ import annotations

from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE
from proof.editors import compare, vellum
from proof.editors.conftest import SUITE_APP, publish_hq_app, record_timing, write_evidence
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
XFORMS = "http://www.w3.org/2002/xforms"


def _in_order(names, *expected):
    """Whether ``expected`` occur in ``names`` in that order."""
    position = 0
    for name in names:
        if position < len(expected) and name == expected[position]:
            position += 1
    return position == len(expected)


def _record(run):
    return {
        "loaded": run.loaded,
        "load_error": run.load_error,
        "form_errors": run.form_errors,
        "question_errors": run.question_errors(),
        "serialization_warnings": run.serialization_warnings,
        "events": run.event_names(),
        "saved": run.saved,
        "saves": [{"view": save.url_name, "status": save.status} for save in run.saves],
        "form_saves": run.form_saves(),
        "save_button": run.save_button,
        "seconds": run.seconds,
        "stored_source": run.stored_source,
    }


def test_vellum_opens_and_saves_an_hq_form_twice_through_hqs_views(hq, core_runner, editor_driver):
    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, SUITE_APP)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        before = compare.build(state, app_id, record)
        runs, builds = [], []
        for _ in range(2):
            runs.append(vellum.open_and_save(editor_driver, state, app_id, form_id))
            builds.append(compare.build(state, app_id, record, version=before.app.version))
        restore = TEMPLATE_RESTORE.read_bytes()
        traces = [compare.core_trace(core_runner, built, restore) for built in (before, *builds)]
        from corehq.apps.es.forms import form_adapter

        forms_index = form_adapter.index_name
        form_counts = [read for read in record.elasticsearch_reads if read[1] == "_count" and forms_index in read[2]]

    for index, run in enumerate(runs):
        record_timing("vellum_open", run.seconds["open"])
        record_timing("vellum_save", run.seconds["save"])
        write_evidence(f"vellum-round-{index + 1}", _record(run))
        names = run.event_names()
        assert run.loaded and run.saved, (run.load_error, run.save_refusal)
        assert _in_order(names, "formLoadingCallback", "formLoadedCallback", "onReady"), names
        assert "datasources:change" in names
        assert _in_order(names, "saveButton:save", "saveButton:saving", "onFormSave"), names
        # The data sources came from HQ's own view, and every save went to HQ's.
        assert [e.status for e in run.exchanges if e.url_name == "get_form_data_schema"] == [200]
        assert run.saves and all(
            save.url_name in ("patch_xform", "edit_form_attr") and save.status == 200 for save in run.saves
        )
        # The run ended with the save over: every save Vellum sent was answered
        # and taken, and its Save button reads "Saved".
        assert run.save_button == "saved" and run.requests_in_flight == 0
        assert len(run.form_saves()) == len(run.saves)
        # HQ's own form, in HQ's own editor: nothing to report.
        assert run.form_errors == [] and run.question_errors() == [] and run.serialization_warnings == []
        assert run.last_saved_is_created and not run.page_errors
    # Vellum asked HQ whether the form has submissions, which HQ answers by
    # counting the form's submissions in its own forms index.
    assert form_counts

    # Core reads HQ's build after the second round trip as it read it after the
    # first: the second save changed nothing Core sees.
    assert compare.first_difference(traces[1], traces[2]) is None
    write_evidence("vellum-first-save-trace-difference", {"first": compare.first_difference(traces[0], traces[1])})


def _with_orphan_bind(state, app_id, form_id):
    """The form with one bind whose nodeset names no node of the form's data."""
    app = operations.held_app(state, app_id)
    form = app.get_form(form_id)
    tree = etree.fromstring(form.source.encode("utf-8"))
    model = next(el for el in tree.iter() if etree.QName(el).localname == "model")
    etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset="/data/proof_orphan", type="xsd:string")
    form.source = etree.tostring(tree, encoding="unicode")
    app.save()


def _binds(source):
    tree = etree.fromstring(source.encode("utf-8"))
    return {el.get("nodeset") for el in tree.iter(f"{{{XFORMS}}}bind")}


def test_vellum_records_a_parse_error_and_the_save_drops_what_it_reports(hq, core_runner, editor_driver):
    with hq_check(CONFIGURATION) as (state, _):
        app_id = publish_hq_app(state, SUITE_APP)
        form_id = operations.held_app(state, app_id).modules[0].forms[0].unique_id
        _with_orphan_bind(state, app_id, form_id)
        run = vellum.open_and_save(editor_driver, state, app_id, form_id)

    write_evidence("vellum-orphan-bind", _record(run))
    assert "/data/proof_orphan" in _binds(run.source)
    assert run.loaded
    parse_errors = [e for e in run.form_errors if "/data/proof_orphan" in e["message"]]
    assert parse_errors and parse_errors[0]["level"] == "parse-warning", run.form_errors
    # Vellum discards the bind it reported, and HQ stores what Vellum saved.
    assert run.saved and run.save.status == 200
    assert "/data/proof_orphan" not in _binds(run.stored_source)


YESNO_APP = "yesno.json"


def _form_name_after_save(core_runner, editor_driver, lang):
    with hq_check(CONFIGURATION) as (state, _):
        app_id = publish_hq_app(state, YESNO_APP)
        app = operations.held_app(state, app_id)
        form_id = app.modules[0].forms[0].unique_id
        assert app.langs == ["en", "es"] and dict(app.modules[0].forms[0].name) == {"en": "Yes/No"}
        run = vellum.open_and_save(editor_driver, state, app_id, form_id, lang=lang)
        name = dict(operations.held_app(state, app_id).get_form(form_id).name)
    assert run.loaded and run.saved and run.save_button == "saved", (run.load_error, run.save_refusal)
    return name


def test_a_vellum_save_names_the_form_in_the_language_the_person_edits_in(hq, core_runner, editor_driver):
    """HQ's form designer sets the display language as the ``lang`` cookie, and HQ's save view writes
    the name Vellum sends (the display language's, falling back to another) under that language
    (``views/forms.py::_apply_form_name_and_comment_updates``). HQ's own two-language test app names
    its form in English only, so a save made in Spanish fills in the Spanish name, and one made in
    the app's first language changes nothing."""
    assert _form_name_after_save(core_runner, editor_driver, "es") == {"en": "Yes/No", "es": "Yes/No"}
    assert _form_name_after_save(core_runner, editor_driver, None) == {"en": "Yes/No"}
