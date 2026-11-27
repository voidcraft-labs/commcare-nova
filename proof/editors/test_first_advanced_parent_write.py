"""The first chosen case's declared parent receives the visit update."""

from datetime import date

from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE
from proof.core.client import load_answer_table
from proof.core.test_session import form_step
from proof.editors import compare
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.test_case_processing import _case, _create, _submission
from proof.matrix import ops, registry
from proof.matrix.authoring import Authoring
from proof.matrix.bases.hq_advanced import BASE
from proof.observe.build import arrange
from proof.observe.sessions import admitted, unmarked_submission

CASE = "{http://commcarehq.org/case/transaction/v2}"
DISTRICT = "first-load-district"
OTHER = "first-load-unrelated-district"
HOUSEHOLD = "first-load-household"
MEMBER = "first-load-member"


def _seed():
    return [
        _case(DISTRICT, _create("district", "Selected district")),
        _case(OTHER, _create("district", "Unrelated district")),
        _case(HOUSEHOLD, _create("household", "Selected household") +
              f'<index><parent case_type="district">{DISTRICT}</parent></index>'),
        _case(MEMBER, _create("member", "Selected member") +
              f'<index><parent case_type="household">{HOUSEHOLD}</parent></index>'),
    ]


def test_first_advanced_load_updates_the_declared_district(hq, core_runner, editor_driver, tmp_path):
    with hq_check(BASE.configuration) as (unit, _):
        authoring = Authoring(unit, {}, BASE.id, editor_driver, unit.operation)
        app_id = BASE.build(authoring)
        for menu, form in BASE.vellum:
            ops.builder_save(authoring, app_id, menu, form)
        registry.named_change("first_load_writes_through_declared_parent")(authoring, app_id)
        app = operations.held_app(unit, app_id)
        visit = app.get_module(1).get_form(0)
        built = compare.build(unit, app_id, unit.record)
        assert not built.errors, built.errors

        restore = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
        for block in _seed():
            restore.append(etree.fromstring(block.encode()))
        with admitted(core_runner, arrange(built.files, tmp_path / "advanced-first-parent")) as opened:
            assert opened["admitted"], opened["problems"]
            table = load_answer_table()
            table["novaKinds"]["visit-day"] = ["2026-01-30"]
            walk = core_runner.session(
                opened["app"], restore=etree.tostring(restore), answer_table=table,
                question_kinds={"/data/visited_on": "visit-day"},
            )
        visit_runs = [
            run for run in walk["runs"] if (step := form_step(run)) and step.get("xmlns") == visit.xmlns
        ]
        assert visit_runs and all(run["end"] == "submitted" for run in visit_runs), visit_runs
        body, _ = unmarked_submission(visit_runs[0])
        xml = etree.fromstring(body)
        visit_day = xml.findtext("{*}visited_on")
        date.fromisoformat(visit_day)
        updates = {
            block.get("case_id"): block.findtext(f"{CASE}update/{CASE}last_member_visit")
            for block in xml.findall(f".//{CASE}case")
        }
        assert updates[DISTRICT] == visit_day
        assert not updates.get(HOUSEHOLD) and not updates.get(MEMBER) and OTHER not in updates

        seeded = operations.process_case_blocks(unit, _submission(*_seed()))
        assert seeded.refusal is None
        applied = operations.process_case_blocks(
            unit, body, cases=[entry.case for entry in seeded.touched.values()],
        )
        assert applied.refusal is None
        assert applied.touched[DISTRICT].case.case_json["last_member_visit"] == visit_day
        assert OTHER not in applied.touched
