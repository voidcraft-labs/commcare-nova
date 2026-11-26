"""An HQ case-management update through the index actually named user."""

from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE, XFORMS
from proof.core.client import load_answer_table
from proof.core.test_session import form_step, person_cases
from proof.editors import compare
from proof.editors.conftest import TWO_LANGUAGE_APP, publish_hq_app
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.test_case_processing import _case, _create, _submission
from proof.observe.build import arrange
from proof.observe.hqside import _patched
from proof.observe.sessions import admitted, unmarked_submission

CASE = "http://commcarehq.org/case/transaction/v2"
ORIGIN, LINKED = "member-with-index", "related-household"
CONFIGURATION = Configuration(privileges={"CLOUDCARE", "USERCASE"})


def _source(xmlns):
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"
      xmlns:jr="http://openrosa.org/javarosa" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <h:head><h:title>Visit</h:title><model>
        <instance><data xmlns="{xmlns}" name="Visit" version="1" uiVersion="1"><note/></data></instance>
        <bind nodeset="/data/note" type="xsd:string"/>
        <itext><translation lang="en" default=""><text id="note-label"><value>Note</value></text></translation></itext>
      </model></h:head>
      <h:body><input ref="/data/note"><label ref="jr:itext('note-label')"/></input></h:body>
    </h:html>"""


def _restore(linked):
    result = etree.fromstring(person_cases(TEMPLATE_RESTORE.read_bytes(), [ORIGIN, LINKED]))
    cases = {case.get("case_id"): case for case in result.iter(f"{{{CASE}}}case")}
    cases[LINKED].find(f"{{{CASE}}}create/{{{CASE}}}case_type").text = "household"
    if linked:
        index = etree.SubElement(cases[ORIGIN], f"{{{CASE}}}index")
        etree.SubElement(index, f"{{{CASE}}}user", case_type="household").text = LINKED
    return etree.tostring(result)


def _visit_run(core_runner, app, form, linked):
    table = load_answer_table()
    table["novaKinds"]["index-note"] = ["A visit"]
    trace = core_runner.session(
        app,
        restore=_restore(linked),
        answer_table=table,
        question_kinds={"/data/note": "index-note"},
    )
    run, = (
        run for run in trace["runs"]
        if (step := form_step(run)) and step.get("xmlns") == form.xmlns
    )
    return run


def test_basic_case_management_writes_through_user_index_and_refuses_a_missing_link(hq, core_runner, tmp_path):
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, DetailColumn

    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        app = operations.held_app(state, app_id)
        module = app.modules[0]
        form = module.forms[0]
        module.case_type = "person"
        for detail in (module.case_details.short, module.case_details.long):
            detail.columns = [DetailColumn(header={"en": "Name"}, model="case", field="name", format="plain")]
        form.requires = "case"
        # The legacy fixture stores an unused open mapping as null. HQ's editor saves an empty mapping.
        form.actions.open_case.name_update = ConditionalCaseUpdate()
        form.actions.update_case.condition.type = "always"
        form.actions.update_case.update = {
            key: ConditionalCaseUpdate(question_path="/data/note", update_mode="always")
            for key in ("local_note", "user/linked_note")
        }
        app.save()
        _patched(state, app_id, form.unique_id, _source(form.xmlns), "write through the loaded case's user index")
        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        archive = arrange(built.files, tmp_path)
        with admitted(core_runner, archive) as admission:
            assert admission["admitted"], admission["problems"]
            accepted = _visit_run(core_runner, admission["app"], form, linked=True)
            missing = _visit_run(core_runner, admission["app"], form, linked=False)

        assert accepted["end"] == "submitted", accepted.get("refusal")
        snapshot = etree.fromstring(form_step(accepted)["caseDb"].encode())
        by_id = {case.get("case_id"): case for case in snapshot.findall("case")}
        assert by_id[ORIGIN].findtext("local_note") == "A visit"
        assert by_id[LINKED].findtext("linked_note") == "A visit"
        assert by_id[ORIGIN].findtext("linked_note") is None

        initial = operations.process_case_blocks(
            state,
            _submission(
                _case(ORIGIN, _create("person", "Person") + f'<index><user case_type="household">{LINKED}</user></index>'),
                _case(LINKED, _create("household", "Household")),
            ),
        )
        assert initial.refusal is None
        submission, _ = unmarked_submission(accepted)
        result = operations.process_case_blocks(
            state, submission, cases=[one.case for one in initial.touched.values()],
        )
        assert result.refusal is None
        assert result.touched[ORIGIN].case.case_json == {"local_note": "A visit"}
        assert result.touched[LINKED].case.case_json == {"linked_note": "A visit"}
        assert missing["end"] == "submission-refused"
        assert form_step(missing)["processing"]["class"] == "org.javarosa.xml.util.InvalidStructureException"
