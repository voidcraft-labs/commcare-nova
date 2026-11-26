"""An accented property name survives the Basic Case Management save and submit."""

import json

from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE
from proof.core.client import load_answer_table
from proof.core.test_session import form_step, person_cases
from proof.editors import compare
from proof.editors.conftest import TWO_LANGUAGE_APP, publish_hq_app
from proof.editors.test_case_management_user_index import CASE, _source
from proof.editors.test_hq_own_registration_alert import _hq
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.seams import formplayer_validation
from proof.hq.test_case_processing import _case, _create, _submission
from proof.observe.build import arrange
from proof.observe.hqside import _patched
from proof.observe.sessions import admitted, unmarked_submission


def test_basic_case_management_saves_the_accented_key_without_changing_its_spelling(hq, core_runner, tmp_path):
    from corehq.apps.app_manager.form_action_diff import make_multi
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, DetailColumn

    selected_id, untouched_id = "proof-member", "unselected-member"
    accented, ascii_neighbor = "estado_é", "estado_e"
    answer = "Visit completed"
    with hq_check(Configuration(privileges={"CLOUDCARE"})) as (state, record):
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
        form.actions.update_case.update = {}
        app.save()
        _patched(state, app_id, form.unique_id, _source(form.xmlns), "accented case property")
        _hq(state, "edit_form_actions", app_id, form.unique_id, data=[
            ("requires", "case"),
            ("actions", json.dumps(make_multi(form.actions.to_json()))),
            ("case_mapping_diff", json.dumps({"update_case": {"add": {
                accented: [{"question_path": "/data/note", "update_mode": "always"}],
            }}})),
        ])
        kept = operations.held_app(state, app_id).get_form(form.unique_id).actions.update_case.update
        assert {key: write.question_path for key, write in kept.items()} == {accented: "/data/note"}
        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        generated = built.files["modules-0/forms-0.xml"]
        validation = json.loads(formplayer_validation(generated))
        assert validation["validated"], validation

        table = load_answer_table()
        table["novaKinds"]["accented-property-note"] = [answer]
        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            trace = core_runner.session(
                admission["app"], restore=person_cases(TEMPLATE_RESTORE.read_bytes(), [selected_id]),
                answer_table=table, question_kinds={"/data/note": "accented-property-note"},
            )
        run, = (run for run in trace["runs"] if (step := form_step(run)) and step.get("xmlns") == form.xmlns)
        assert run["end"] == "submitted", run.get("refusal")
        submission, _ = unmarked_submission(run)
        data = etree.fromstring(submission)
        case, = data.iter(f"{{{CASE}}}case")
        assert case.get("case_id") == selected_id
        assert case.findtext(f"{{{CASE}}}update/{{{CASE}}}{accented}") == answer
        snapshot = etree.fromstring(form_step(run)["caseDb"].encode())
        assert snapshot.findtext(f"case[@case_id='{selected_id}']/{accented}") == answer

        initial = operations.process_case_blocks(state, _submission(
            _case(selected_id, _create("person", "Member") + f"<update><{ascii_neighbor}>before</{ascii_neighbor}></update>"),
            _case(untouched_id, _create("person", "Another") + f"<update><{accented}>before</{accented}></update>"),
        ))
        assert initial.refusal is None
        received = operations.process_case_blocks(state, submission, cases=[one.case for one in initial.touched.values()])
        assert received.refusal is None
        assert set(received.touched) == {selected_id}
        assert received.touched[selected_id].case.case_json == {ascii_neighbor: "before", accented: answer}
