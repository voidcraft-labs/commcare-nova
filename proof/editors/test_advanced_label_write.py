"""The Advanced Case Management editor keeps a passive label as an ordinary field write."""

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
from proof.matrix.bases.hq_advanced import BASE
from proof.observe.build import arrange
from proof.observe.sessions import admitted, unmarked_submission

CASE = "http://commcarehq.org/case/transaction/v2"
HOUSEHOLD = "label-witness-household"
MEMBER = "label-witness-member"
OTHER = "label-witness-other"
TEXT = "Notes from the worker"
QUESTION = "/data/seen_label"


def _seed():
    return [
        _case(HOUSEHOLD, _create("household", "Witness household")),
        _case(MEMBER, _create("member", "Witness member") +
              f'<index><parent case_type="household">{HOUSEHOLD}</parent></index>'
              "<update><seen>before</seen></update>"),
        _case(OTHER, _create("member", "Unrelated member") + "<update><seen>unrelated</seen></update>"),
    ]


def _restore():
    restore = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
    for block in _seed():
        restore.append(etree.fromstring(block.encode()))
    return etree.tostring(restore)


def _authored_label(unit, driver):
    authoring = Authoring(
        state=unit, documents={}, base=BASE.id, driver=driver, operation=unit.operation,
    )
    app_id = BASE.build(authoring)
    for menu, form in BASE.vellum:
        ops.builder_save(authoring, app_id, menu, form)
    registry.named_change("load_writes_a_label")(authoring, app_id)

    def held_form():
        return operations.held_app(unit, app_id).get_module(1).get_form(0)

    form = held_form()
    page = pages.ADVANCED_CASE_MANAGEMENT
    saved = pages.fresh_section_save(driver, unit, page, app_id, form.unique_id)
    assert saved.save is not None and not saved.refused, (saved.alerts, saved.unsent, saved.response)
    form = held_form()
    load = form.actions.load_update_cases[1]
    assert load.case_tag == "load_member1"
    assert load.case_properties["seen"].question_path == QUESTION
    assert load.case_properties["seen"].update_mode == "always"
    assert load.case_properties["notes"].question_path == "/data/notes"
    return authoring, app_id, form


def _received(state, submission, relevant=True):
    root = etree.fromstring(submission)
    label = root.find("{*}seen_label")
    assert (label.text if label is not None else None) == ("OK" if relevant else None)
    assert root.findtext("{*}notes") == TEXT
    member = root.find(f".//{{{CASE}}}case[@case_id='{MEMBER}']")
    assert member is not None
    update = member.find(f"{{{CASE}}}update")
    assert update.findtext(f"{{{CASE}}}notes") == TEXT
    assert update.findtext(f"{{{CASE}}}seen") == ("OK" if relevant else None)
    raw = operations.process_case_blocks(state, _submission(*_seed()))
    assert raw.refusal is None
    applied = operations.process_case_blocks(state, submission, cases=[case.case for case in raw.touched.values()])
    assert applied.refusal is None
    assert applied.touched[MEMBER].case.case_json["seen"] == ("OK" if relevant else "before")
    assert applied.touched[MEMBER].case.case_json["notes"] == TEXT
    assert OTHER not in applied.touched


def test_advanced_editor_label_write_keeps_the_submitted_answer_and_case(hq, core_runner, editor_driver, tmp_path):
    with hq_check(BASE.configuration) as (unit, _):
        authoring, app_id, form = _authored_label(unit, editor_driver)

        def read(relevant):
            built = compare.build(unit, app_id, unit.record)
            assert not built.errors, built.errors
            xml = etree.fromstring(built.files["modules-1/forms-0.xml"])
            (bind,) = xml.xpath("//*[local-name()='bind'][@calculate=$path]", path=QUESTION)
            assert bind.get("relevant") == f"count({QUESTION}) > 0"
            assert bind.get("nodeset").endswith("/case/update/seen")
            with admitted(core_runner, arrange(built.files, tmp_path / f"label-{relevant}")) as admission:
                assert admission["admitted"], admission["problems"]
                table = load_answer_table()
                table["novaKinds"]["label-control"] = ["OK"]
                table["novaKinds"]["adjacent-text"] = [TEXT]
                trace = core_runner.session(
                    admission["app"], restore=_restore(), answer_table=table,
                    question_kinds={QUESTION: "label-control", "/data/notes": "adjacent-text"},
                )
            (run,) = (
                one for one in trace["runs"] if (step := form_step(one)) and step.get("xmlns") == form.xmlns
            )
            assert run["end"] == "submitted", run.get("refusal")
            payload, _ = unmarked_submission(run)
            _received(unit, payload, relevant)

        read(True)

        def hide(root, _form):
            (bind,) = root.xpath("//*[local-name()='bind'][@nodeset=$path]", path=QUESTION)
            bind.set("relevant", "false()")

        ops.set_form_source(authoring, app_id, 1, 0, hide, what="hide the label source")
        read(False)


@pytest.mark.reader("android")
def test_android_confirms_a_passive_label_before_the_advanced_member_update(hq, editor_driver):
    from proof.android import observe
    from proof.formplayer import hq as forms_hq
    from proof.observe import casedata
    from proof.observe.record import Blobs

    with hq_check(BASE.configuration) as (unit, _):
        _, app_id, _ = _authored_label(unit, editor_driver)
        database = casedata.database_of_restore(_restore())
        with forms_hq.serve(unit, None, app_id, database=database) as release:
            blobs, sent, stored = Blobs(), [], []
            result = observe.app(
                release, blobs, label="advanced-passive-label", archive=observe.release_archive(release),
                commands=["m1-f0"], questions={QUESTION: [], "/data/notes": [TEXT]},
                views=True, sent=sent, stored=stored,
            )
            walk = blobs.get_json(result["answer"])["walks"]["m1-f0"]
            assert len(sent) == 1, walk
            _received(unit, sent[0])
            (kept,) = stored
            assert "raised" not in kept, kept
            assert MEMBER in kept["cases"] and OTHER not in kept["cases"], kept


@pytest.mark.reader("webapps")
def test_web_apps_confirms_a_passive_label_before_the_advanced_member_update(
    hq, formplayer_runner, editor_driver,
):
    from dataclasses import replace

    from proof.formplayer import hq as forms_hq
    from proof.observe import casedata
    from proof.webapps import steps
    from proof.webapps.hq import WEB_APPS_PRIVILEGE
    from proof.webapps.session import Session
    from proof.matrix.bases import _pages

    configuration = replace(BASE.configuration, privileges=BASE.configuration.privileges | {WEB_APPS_PRIVILEGE})
    with hq_check(configuration) as (unit, _):
        authoring, app_id, _ = _authored_label(unit, editor_driver)
        _pages.turn_web_apps_on(authoring, app_id)
        database = casedata.database_of_restore(_restore())
        with forms_hq.serve(unit, None, app_id, runner=formplayer_runner, database=database) as release:
            session = Session(release, editor_driver)
            run = session.run([
                *steps.open_app("Member visits"), *steps.choose("Member visits"),
                *steps.click(f"#menu-region [id='row-{HOUSEHOLD}']"),
                *steps.select_case(MEMBER), *steps.choose("Untitled Form"),
                steps.SCREEN, *steps.answer("2", TEXT), *steps.submit_and_land(),
            ])
            assert not run.page_errors, run.page_errors
            submission, = session.hq.submissions
            _received(unit, submission.instance)
