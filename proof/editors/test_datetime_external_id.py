"""The retained own update that saves a datetime question straight as external_id."""

from datetime import datetime

import pytest
from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE
from proof.core.client import load_answer_table
from proof.core.test_session import form_step
from proof.editors import compare, pages
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.test_case_processing import _case, _create, _submission
from proof.matrix import ops, registry
from proof.matrix.authoring import Authoring
from proof.observe.build import arrange
from proof.observe.sessions import admitted, unmarked_submission


BASE = next(base for base in registry.BASES if base.id == "hq-case-management")
CASE = "http://commcarehq.org/case/transaction/v2"
RECORD = "date-time-external-id-household"
ORIGINAL = "original opaque reference"
QUESTION = "/data/seen_at"
MOMENT = "2025-04-06T06:24:47.125Z"
OFFSET_INPUT = "2025-04-05T23:24:47.125-07:00"
OFFSET_CAST = "2025-04-05T06:24:47.125Z"
DAY = "2025-04-06"


@pytest.mark.parametrize("property_name", ["external_id", "name"], ids=["external-id", "case-name"])
def test_datetime_question_stored_directly_in_a_case_text_facet(
    hq, core_runner, editor_driver, tmp_path, property_name,
):
    wire_property = "case_name" if property_name == "name" else property_name
    with hq_check(BASE.configuration) as (unit, record):
        authoring = Authoring(state=unit, documents={}, base=BASE.id, driver=editor_driver, operation=unit.operation)
        app_id = BASE.build(authoring)
        for menu, form in BASE.vellum:
            ops.builder_save(authoring, app_id, menu, form)
        ops.set_json(
            authoring, app_id, f"/modules/0/forms/3/actions/update_case/update/{property_name}",
            {"question_path": QUESTION, "update_mode": "always", "doc_type": "ConditionalCaseUpdate"},
        )

        def held_form():
            return operations.held_app(unit, app_id).get_module(0).get_form(3)

        form = held_form()
        saved = pages.fresh_section_save(editor_driver, unit, pages.CASE_MANAGEMENT, app_id, form.unique_id)
        assert saved.save is not None and not saved.refused, (saved.alerts, saved.unsent, saved.response)
        form = held_form()
        fields = form.actions.update_case.update
        assert fields[property_name].question_path == QUESTION
        assert fields[property_name].update_mode == "always"
        assert fields["seen_at"].question_path == "/data/nova_datetime_seen_at"

        starting_case = _case(
            RECORD, _create("household", "One household") + f"<update><external_id>{ORIGINAL}</external_id></update>",
        )
        restore = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
        restore.append(etree.fromstring(starting_case.encode()))
        def read(label, answers):
            built = compare.build(unit, app_id, record)
            assert not built.errors, built.errors
            xml = etree.fromstring(built.files["modules-0/forms-3.xml"])
            (bind,) = xml.xpath(f"//*[local-name()='bind'][contains(@nodeset,'/update/{wire_property}')]")
            assert bind.get("calculate") == QUESTION
            assert bind.get("type") is None
            assert bind.get("relevant") == f"count({QUESTION}) > 0"
            table = load_answer_table()
            table["novaKinds"]["original-datetime-answer"] = answers
            with admitted(core_runner, arrange(built.files, tmp_path / label)) as admission:
                assert admission["admitted"], admission["problems"]
                trace = core_runner.session(
                    admission["app"], restore=etree.tostring(restore), answer_table=table,
                    question_kinds={QUESTION: "original-datetime-answer"},
                )
            (run,) = (
                run for run in trace["runs"] if (step := form_step(run)) and step.get("xmlns") == form.xmlns
            )
            assert run["end"] == "submitted", run.get("refusal")
            submission, tokens = unmarked_submission(run)
            payload = etree.fromstring(submission)
            snapshot = etree.fromstring(form_step(run)["caseDb"].encode())
            stored = snapshot.findtext(f"case[@case_id='{RECORD}']/{wire_property}")
            initial = operations.process_case_blocks(unit, _submission(starting_case))
            assert initial.refusal is None
            applied = operations.process_case_blocks(unit, submission, cases=[initial.touched[RECORD].case])
            assert applied.refusal is None
            kept = applied.touched.get(RECORD) or initial.touched[RECORD]
            return payload, tokens.get(stored, stored), kept.case

        def hq_value(case):
            return case.name if property_name == "name" else case.external_id

        def expects_moment(label, answer, moment, day):
            payload, on_device, on_hq = read(label, [answer])
            assert datetime.fromisoformat(payload.findtext("{*}seen_at")) == datetime.fromisoformat(moment)
            update = payload.find(f"{{{CASE}}}case/{{{CASE}}}update")
            assert update.findtext(f"{{{CASE}}}{wire_property}") == day
            assert datetime.fromisoformat(update.findtext(f"{{{CASE}}}seen_at")) == datetime.fromisoformat(moment)
            assert on_device == hq_value(on_hq) == day
            assert wire_property not in on_hq.case_json
            assert datetime.fromisoformat(on_hq.case_json["seen_at"]) == datetime.fromisoformat(moment)

        expects_moment("utc-clock", MOMENT, MOMENT, DAY)
        # The harness casts text the way Formplayer does. DateUtils applies a
        # foreign offset to hours/minutes while retaining the written day.
        expects_moment("foreign-offset-cast", OFFSET_INPUT, OFFSET_CAST, "2025-04-05")

        payload, on_device, on_hq = read("blank", [""])
        leaf = payload.find(f"{{{CASE}}}case/{{{CASE}}}update/{{{CASE}}}{wire_property}")
        assert leaf is not None and not leaf.text
        assert not on_device and not hq_value(on_hq)

        def hide(root, _form):
            (bind,) = root.xpath("//*[local-name()='bind'][@nodeset=$path]", path=QUESTION)
            bind.set("relevant", "false()")

        ops.set_form_source(authoring, app_id, 0, 3, hide, what="hide the date-and-time question")
        payload, on_device, on_hq = read("irrelevant", [MOMENT])
        assert payload.find(f"{{{CASE}}}case/{{{CASE}}}update/{{{CASE}}}{wire_property}") is None
        assert on_device == hq_value(on_hq) == ("One household" if property_name == "name" else ORIGINAL)
