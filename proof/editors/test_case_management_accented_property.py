"""An accented property name survives the Basic Case Management save and submit."""

import json

import pytest
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


CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
SELECTED, UNTOUCHED = "proof-member", "unselected-member"
ACCENTED, ASCII_NEIGHBOR = "estado_é", "estado_e"
ANSWER = "Visit completed"


def _author_basic_mapping(state):
    from corehq.apps.app_manager.form_action_diff import make_multi
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, DetailColumn

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
            ACCENTED: [{"question_path": "/data/note", "update_mode": "always"}],
        }}})),
    ])
    kept = operations.held_app(state, app_id).get_form(form.unique_id).actions.update_case.update
    assert {key: write.question_path for key, write in kept.items()} == {ACCENTED: "/data/note"}
    return app_id, form.xmlns


def _assert_wire(submission):
    data = etree.fromstring(submission)
    case, = data.iter(f"{{{CASE}}}case")
    assert case.get("case_id") == SELECTED
    assert case.findtext(f"{{{CASE}}}update/{{{CASE}}}{ACCENTED}") == ANSWER
    assert case.find(f"{{{CASE}}}update/{{{CASE}}}{ASCII_NEIGHBOR}") is None


def test_basic_case_management_saves_the_accented_key_without_changing_its_spelling(hq, core_runner, tmp_path):
    with hq_check(CONFIGURATION) as (state, record):
        app_id, xmlns = _author_basic_mapping(state)
        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        generated = built.files["modules-0/forms-0.xml"]
        validation = json.loads(formplayer_validation(generated))
        assert validation["validated"], validation

        table = load_answer_table()
        table["novaKinds"]["accented-property-note"] = [ANSWER]
        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            trace = core_runner.session(
                admission["app"], restore=person_cases(TEMPLATE_RESTORE.read_bytes(), [SELECTED]),
                answer_table=table, question_kinds={"/data/note": "accented-property-note"},
            )
        run, = (run for run in trace["runs"] if (step := form_step(run)) and step.get("xmlns") == xmlns)
        assert run["end"] == "submitted", run.get("refusal")
        submission, _ = unmarked_submission(run)
        _assert_wire(submission)
        snapshot = etree.fromstring(form_step(run)["caseDb"].encode())
        assert snapshot.findtext(f"case[@case_id='{SELECTED}']/{ACCENTED}") == ANSWER

        initial = operations.process_case_blocks(state, _submission(
            _case(SELECTED, _create("person", "Member") + f"<update><{ASCII_NEIGHBOR}>before</{ASCII_NEIGHBOR}></update>"),
            _case(UNTOUCHED, _create("person", "Another") + f"<update><{ACCENTED}>before</{ACCENTED}></update>"),
        ))
        assert initial.refusal is None
        received = operations.process_case_blocks(state, submission, cases=[one.case for one in initial.touched.values()])
        assert received.refusal is None
        assert set(received.touched) == {SELECTED}
        assert received.touched[SELECTED].case.case_json == {ASCII_NEIGHBOR: "before", ACCENTED: ANSWER}


@pytest.mark.reader("android")
def test_installed_android_submits_the_accented_case_property_to_hq(hq):
    from corehq.form_processor.models import CommCareCase

    from proof.android import observe
    from proof.formplayer import hq as forms_hq
    from proof.observe import casedata
    from proof.observe.record import Blobs

    with hq_check(CONFIGURATION) as (state, _):
        app_id, _ = _author_basic_mapping(state)
        restore = person_cases(TEMPLATE_RESTORE.read_bytes(), [SELECTED])
        database = casedata.database_of_restore(restore)
        with forms_hq.serve(state, None, app_id, database=database) as release:
            blobs, sent, stored = Blobs(), [], []
            result = observe.app(
                release, blobs, label="basic-accented-property", archive=observe.release_archive(release),
                commands=["m0-f0"], questions={"/data/note": [ANSWER]},
                installation_languages=("en",), views=True, sent=sent, stored=stored,
            )
            walk = blobs.get_json(result["answer"])["walks"]["m0-f0"]
            assert len(sent) == 1, walk
            _assert_wire(sent[0])
            receipt, = stored
            assert "raised" not in receipt, receipt
            assert receipt["form"]["normal"] is True
            assert set(receipt["cases"]) == {SELECTED}, receipt
            case = CommCareCase.objects.get_case(SELECTED, state.domain)
            assert case.case_json == {ACCENTED: ANSWER}
