"""HQ case-management updates through the loaded case’s own indices."""

from datetime import datetime
import json

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


def _source(xmlns, bind_type="string"):
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"
      xmlns:jr="http://openrosa.org/javarosa" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <h:head><h:title>Visit</h:title><model>
        <instance><data xmlns="{xmlns}" name="Visit" version="1" uiVersion="1"><note/></data></instance>
        <bind nodeset="/data/note" type="xsd:{bind_type}"/>
        <itext><translation lang="en" default=""><text id="note-label"><value>Note</value></text></translation></itext>
      </model></h:head>
      <h:body><input ref="/data/note"><label ref="jr:itext('note-label')"/></input></h:body>
    </h:html>"""


def _restore(linked, identifier="user"):
    result = etree.fromstring(person_cases(TEMPLATE_RESTORE.read_bytes(), [ORIGIN, LINKED]))
    cases = {case.get("case_id"): case for case in result.iter(f"{{{CASE}}}case")}
    cases[LINKED].find(f"{{{CASE}}}create/{{{CASE}}}case_type").text = "household"
    if linked:
        index = etree.SubElement(cases[ORIGIN], f"{{{CASE}}}index")
        etree.SubElement(index, f"{{{CASE}}}{identifier}", case_type="household").text = LINKED
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


def test_basic_date_and_time_saves_the_same_day_to_its_case_and_parent(hq, core_runner, tmp_path):
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, DetailColumn

    instant = "2025-04-05T23:24:47.125Z"
    day = instant.split("T", 1)[0]
    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        app = operations.held_app(state, app_id)
        module = app.modules[0]
        form = module.forms[0]
        module.forms = [form]
        module.media_image = {}
        app.multimedia_map = {}
        module.case_type = "person"
        for detail in (module.case_details.short, module.case_details.long):
            detail.columns = [DetailColumn(header={"en": "Name"}, model="case", field="name", format="plain")]
        form.requires = "case"
        form.actions.open_case.name_update = ConditionalCaseUpdate()
        form.actions.update_case.condition.type = "always"
        form.actions.update_case.update = {
            key: ConditionalCaseUpdate(question_path="/data/note", update_mode="always")
            for key in ("visit_day", "parent/visit_day")
        }
        app.save()
        _patched(state, app_id, form.unique_id, _source(form.xmlns, "dateTime"), "save the visit day on two cases")
        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        archive = arrange(built.files, tmp_path)
        with admitted(core_runner, archive) as admission:
            assert admission["admitted"], admission["problems"]
            trace = core_runner.session(
                admission["app"], restore=_restore(True, "parent"), question_kinds={"/data/note": "datetime"},
                clock=instant,
            )

        run, = (
            run for run in trace["runs"]
            if (step := form_step(run)) and step.get("xmlns") == form.xmlns
        )
        assert run["end"] == "submitted", run.get("refusal")
        submission, tokens = unmarked_submission(run)
        payload = etree.fromstring(submission)
        assert datetime.fromisoformat(payload.findtext("{*}note")) == datetime.fromisoformat(instant)
        blocks = {block.get("case_id"): block for block in payload.iter(f"{{{CASE}}}case")}
        assert set(blocks) == {ORIGIN, LINKED}
        for block in blocks.values():
            assert block.findtext(f"{{{CASE}}}update/{{{CASE}}}visit_day") == day
        snapshot = etree.fromstring(form_step(run)["caseDb"].encode())
        for case_id in (ORIGIN, LINKED):
            stored = snapshot.findtext(f"case[@case_id='{case_id}']/visit_day")
            assert tokens.get(stored, stored) == day

        initial = operations.process_case_blocks(
            state,
            _submission(
                _case(ORIGIN, _create("person", "Person") + f'<index><parent case_type="household">{LINKED}</parent></index>'),
                _case(LINKED, _create("household", "Household")),
            ),
        )
        assert initial.refusal is None
        stored = operations.process_case_blocks(state, submission, cases=[one.case for one in initial.touched.values()])
        assert stored.refusal is None
        assert {case_id: one.case.case_json for case_id, one in stored.touched.items()} == {
            ORIGIN: {"visit_day": day}, LINKED: {"visit_day": day},
        }


def test_basic_case_management_saves_a_parent_user_path_and_keeps_its_empty_block(
    hq, core_runner, tmp_path
):
    from corehq.apps.app_manager.form_action_diff import make_multi
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, DetailColumn
    from proof.editors.test_hq_own_registration_alert import _hq

    intermediate = "member-parent"
    unrelated = "unrelated-linked-household"
    route = "parent/user/linked_note"

    def source(xmlns):
        return _source(xmlns).replace(
            "<note/>", "<note/><mode/>",
        ).replace(
            '<bind nodeset="/data/note" type="xsd:string"/>',
            """<bind nodeset="/data/note" type="xsd:string"
                calculate="if(/data/mode = 'write', 'A visit', '')"
                relevant="/data/mode != 'omit'"/>
              <bind nodeset="/data/mode" type="xsd:string"/>""",
        ).replace('ref="/data/note"', 'ref="/data/mode"')

    def index(identifier, case_type, target):
        return f'<index><{identifier} case_type="{case_type}">{target}</{identifier}></index>'

    def case_blocks(scenario):
        person_index = "" if scenario == "missing-parent-edge" else index("parent", "family", intermediate)
        family_index = "" if scenario == "missing-user-edge" else index("user", "household", LINKED)
        return [
            _case(ORIGIN, _create("person", "Person") + person_index),
            *([] if scenario == "missing-intermediate" else [
                _case(intermediate, _create("family", "Family") + family_index),
            ]),
            *([] if scenario == "missing-terminal" else [
                _case(LINKED, _create("household", "Household") +
                      "<update><linked_note>before</linked_note></update>"),
            ]),
            _case(unrelated, _create("household", "Unrelated")),
        ]

    def run_form(app, form, scenario, answer):
        restore = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
        for block in case_blocks(scenario):
            restore.append(etree.fromstring(block.encode()))
        table = load_answer_table()
        table["novaKinds"]["index-mode"] = [answer]
        trace = core_runner.session(
            app, restore=etree.tostring(restore), answer_table=table,
            question_kinds={"/data/mode": "index-mode"},
        )
        run, = (run for run in trace["runs"]
                if (step := form_step(run)) and step.get("xmlns") == form.xmlns)
        return run

    with hq_check(CONFIGURATION) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        app = operations.held_app(state, app_id)
        module = app.modules[0]
        form = module.forms[0]
        module.case_type = "person"
        for detail in (module.case_details.short, module.case_details.long):
            detail.columns = [DetailColumn(header={"en": "Name"}, model="case", field="name", format="plain")]
        form.requires = "case"
        form.actions.open_case.name_update = ConditionalCaseUpdate()
        form.actions.update_case.condition.type = "always"
        form.actions.update_case.update = {
            "local_note": ConditionalCaseUpdate(question_path="/data/mode", update_mode="always"),
            route: ConditionalCaseUpdate(question_path="/data/note", update_mode="always"),
        }
        app.save()
        _patched(state, app_id, form.unique_id, source(form.xmlns), "write through two declared indices")
        _hq(
            state, "edit_form_actions", app_id, form.unique_id,
            data=[("requires", "case"),
                  ("actions", json.dumps(make_multi(form.actions.to_json()))),
                  ("case_mapping_diff", "{}")],
        )
        kept = operations.held_app(state, app_id).get_form(form.unique_id).actions.update_case.update
        assert kept[route].question_path == "/data/note"

        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            for answer in ("write", "omit", "blank"):
                run = run_form(admission["app"], form, "complete", answer)
                assert run["end"] == "submitted", run.get("refusal")
                submission, _ = unmarked_submission(run)
                data = etree.fromstring(submission)
                reached = data.find(f"{{*}}parents/{{*}}parent/{{*}}user/{{{CASE}}}case")
                assert reached is not None and reached.get("case_id") == LINKED
                leaf = reached.findtext(f"{{{CASE}}}update/{{{CASE}}}linked_note")
                assert leaf == {"write": "A visit", "omit": None, "blank": ""}[answer]
                final = {"write": "A visit", "omit": "before", "blank": ""}[answer]
                snapshot = etree.fromstring(form_step(run)["caseDb"].encode())
                assert snapshot.findtext(f"case[@case_id='{LINKED}']/linked_note") == final
                assert snapshot.findtext(f"case[@case_id='{intermediate}']/linked_note") is None
                assert snapshot.findtext(f"case[@case_id='{unrelated}']/linked_note") is None
                initial = operations.process_case_blocks(state, _submission(*case_blocks("complete")))
                assert initial.refusal is None
                processed = operations.process_case_blocks(
                    state, submission, cases=[item.case for item in initial.touched.values()],
                )
                assert processed.refusal is None
                assert processed.touched[LINKED].case.case_json["linked_note"] == final
                assert processed.touched[ORIGIN].case.case_json["local_note"] == answer

            for scenario in ("missing-parent-edge", "missing-intermediate", "missing-user-edge", "missing-terminal"):
                for answer in ("write", "omit"):
                    rejected = run_form(admission["app"], form, scenario, answer)
                    assert rejected["end"] == "submission-refused", (scenario, answer, rejected.get("refusal"))
                    assert form_step(rejected)["processing"]["class"] == "org.javarosa.xml.util.InvalidStructureException"
