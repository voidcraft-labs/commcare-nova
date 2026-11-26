"""An editor-saved icon updates exactly the clicked record and keeps the worker on Results."""
from lxml import etree

from proof.editors import pages, vellum
from proof.hq.operations import held_app
from proof.observe import casedata
from proof.webapps import hq as webapps_hq, steps
from proof.webapps.session import Session

DOCUMENT = "targeted-case-list-icon-action"


def test_click_after_form_and_case_list_saves_submits_only_the_second_record(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from corehq.apps.app_manager.views.modules import _form_endpoint_options

    document = webapps_documents[DOCUMENT]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    with webapps_hq.project(document) as project:
        held = held_app(project.unit, project.app_id)
        form = held.get_module(0).get_form(0)
        saved = vellum.open_and_save(editor_driver, project.unit, project.app_id, form.unique_id)
        assert saved.loaded and saved.saved and saved.save_button == "saved", (saved.load_error, saved.save_refusal)
        reopened = held_app(project.unit, project.app_id)
        module = reopened.get_module(0)
        offered = _form_endpoint_options(reopened, module, "en")
        assert [target["id"] for target in offered] == ["mark-visit"]
        with project.released(
            formplayer_runner, saves=((pages.CASE_LIST, project.module_id(0)),),
            driver=editor_driver, label="saved-list-action", database=database
        ) as release:
            column = release.doc["modules"][0]["case_details"]["short"]["columns"][1]
            assert (column["format"], column["endpoint_action_id"]) == ("clickable-icon", "mark-visit")
            session = Session(release, editor_driver)
            display = session.run([
                *steps.open_app("Visit actions"), *steps.choose("Visits"), steps.SCREEN,
            ], name="display-only")
            assert display.screens[-1]["list"], display.screens[-1]
            assert not display.answered("get_endpoint")
            assert not session.hq.submissions
            run = session.run([
                *steps.open_app("Visit actions"), *steps.choose("Visits"),
                *steps.click("#row-second-visit button.clickable-icon img", visible=True),
                steps.SCREEN,
            ])
            requests = run.answered("get_endpoint")
            updated = []
            for submission in session.hq.submissions:
                if submission.instance:
                    root = etree.fromstring(submission.instance)
                    for block in root.xpath("//*[local-name()='case'][@case_id]"):
                        updated.append((block.get("case_id"), block.xpath("string(./*[local-name()='update']/*[local-name()='visit_state'])")))
            evidence("saved-list-icon", {"offered":offered, "updated":updated, "after":run.screens[-1]})
            assert not run.page_errors, run.page_errors
            assert len(requests) == 1 and run.answered("get_details"), run.formplayer
            assert updated == [("second-visit", "visited")]
            assert run.screens[-1]["list"], run.screens[-1]
