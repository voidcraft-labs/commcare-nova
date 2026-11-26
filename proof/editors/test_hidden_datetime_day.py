"""An HQ-built hidden timestamp retains its time while the untyped case leaf saves its day."""

from datetime import datetime, timezone

from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE, XFORMS
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
PERSON = "person-with-a-visit"
STAMP = datetime(2025, 4, 5, 23, 24, 47, 321000, tzinfo=timezone.utc)
CLOCK = "2025-04-05T23:24:47.321Z"
DAY = "2025-04-05"


def _source(xmlns):
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"
      xmlns:jr="http://openrosa.org/javarosa" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <h:head><h:title>Visit</h:title><model>
        <instance><data xmlns="{xmlns}" name="Visit" version="1" uiVersion="1"><recorded_at/><note/></data></instance>
        <bind nodeset="/data/recorded_at" type="xsd:dateTime"
          calculate="now()"/>
        <bind nodeset="/data/note" type="xsd:string"/>
        <itext><translation lang="en" default=""><text id="note-label"><value>Note</value></text></translation></itext>
      </model></h:head>
      <h:body><input ref="/data/note"><label ref="jr:itext('note-label')"/></input></h:body>
    </h:html>"""


def prepare_hidden_day(state):
    from corehq.apps.app_manager.models import ConditionalCaseUpdate, DetailColumn

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
        "visit_day": ConditionalCaseUpdate(question_path="/data/recorded_at", update_mode="always"),
    }
    app.save()
    _patched(state, app_id, form.unique_id, _source(form.xmlns), "save the day of the hidden timestamp")

    return app_id, form.xmlns


def assert_hidden_day_payload(submission):
    payload = etree.fromstring(submission)
    assert datetime.fromisoformat(payload.findtext("{*}recorded_at")) == STAMP
    assert payload.findtext(f"{{{CASE}}}case/{{{CASE}}}update/{{{CASE}}}visit_day") == DAY


def hidden_day_database():
    from proof.observe import casedata

    return casedata.CaseDatabase(
        user_id=casedata.USER_ID, username=casedata.USERNAME, user_data=(),
        cases=(
            casedata.CaseRecord(
                case_id=PERSON, case_type="person", name="One person", owner_id=casedata.USER_ID,
                opened_on="2025-04-01T00:00:00Z", modified_on="2025-04-01T00:00:00Z",
                external_id=None, properties=(),
            ),
        ),
    )


def test_a_hidden_timestamp_submits_its_instant_and_saves_only_its_day(hq, core_runner, tmp_path):
    with hq_check(Configuration()) as (state, record):
        app_id, xmlns = prepare_hidden_day(state)
        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        archive = arrange(built.files, tmp_path)
        with admitted(core_runner, archive) as admission:
            assert admission["admitted"], admission["problems"]
            trace = core_runner.session(
                admission["app"], restore=person_cases(TEMPLATE_RESTORE.read_bytes(), [PERSON]), clock=CLOCK,
            )

        run, = (
            run for run in trace["runs"]
            if (step := form_step(run)) and step.get("xmlns") == xmlns
        )
        assert run["end"] == "submitted", run.get("refusal")
        submission, tokens = unmarked_submission(run)
        assert_hidden_day_payload(submission)
        snapshot = etree.fromstring(form_step(run)["caseDb"].encode())
        stored_day = snapshot.findtext(f"case[@case_id='{PERSON}']/visit_day")
        assert tokens.get(stored_day, stored_day) == DAY

        initial = operations.process_case_blocks(state, _submission(_case(PERSON, _create("person", "Person"))))
        assert initial.refusal is None
        stored = operations.process_case_blocks(
            state, submission, cases=[one.case for one in initial.touched.values()],
        )
        assert stored.refusal is None
        assert stored.touched[PERSON].case.case_json == {"visit_day": DAY}
