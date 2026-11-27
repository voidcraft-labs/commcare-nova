"""Observe which case database a retained Search requirement can actually read."""

from dataclasses import replace
from io import BytesIO
from zipfile import ZipFile

from lxml import etree

from proof.editors import pages
from proof.hq import operations
from proof.matrix.registry import load_variants
from proof.observe import casedata
from proof.observe.search_address import enable_address_search
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


def test_required_search_value_reads_the_worker_case_count(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from corehq.apps.app_manager.models.case_search import CaseSearchProperty

    document = webapps_documents["hq-search"]
    row = next(var for var in load_variants() if var.id == "hq-search/required-reading-the-case-list")
    assert row.change["pointer"] == "/modules/0/search_config/properties/1"
    source_prompt = row.change["value"]
    requirement = source_prompt["required"]["test"]
    initial = casedata.document_case_database(document)
    client = next(case for case in initial.cases if case.case_type == "client")
    client = replace(client, name="Amina", properties=(("village", "east"), ("last_visit", "2025-12-01")))
    held_case = replace(initial, cases=(client,))
    no_cases = replace(initial, cases=())
    observations = {}
    for name, condition, database in (
        ("case-count-empty", requirement, no_cases),
        ("case-count-one", requirement, held_case),
        ("constant-required", "true()", held_case),
    ):
        with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
            app = operations.held_app(project.unit, project.app_id)
            menu_id = app.modules[0].unique_id
            app.cloudcare_enabled = True
            app.modules[0].search_config.properties[1] = CaseSearchProperty.wrap({
                **source_prompt, "required": {**source_prompt["required"], "test": condition},
            })
            app.save()
            saved = pages.fresh_section_save(editor_driver, project.unit, pages.CASE_LIST, project.app_id, menu_id)
            assert saved.save and saved.save.status == 200 and not saved.refused, (saved.alerts, saved.unsent)
            menu = operations.held_app(project.unit, project.app_id).get_module_by_unique_id(menu_id)
            assert menu.search_config.properties[1].required.test == condition

            with project.released(formplayer_runner, database=database, label=name) as release:
                with ZipFile(BytesIO(release.archive())) as archive:
                    suite = etree.fromstring(archive.read("suite.xml"))
                query = suite.xpath(".//query[prompt[@key='village']/required]")[0]
                assert query.xpath("prompt[@key='village']/required/@test") == [condition]
                run = Session(release, editor_driver).run([
                    *steps.open_app("Client search"), *steps.choose("Clients"), *steps.choose("Followup Form"),
                    *steps.arrive(any_screen=True), steps.SCREEN,
                    *steps.type_prompt(0, "Amina"), steps.SCREEN,
                    *steps.click(steps.SEARCH_BUTTON, visible=True, within=steps.WITHIN_MS), steps.SCREEN,
                ])
                submitted = [
                    search.params for search in release.hq.searches
                    if any("case_name" in value and "Amina" in value for value in search.values("_xpath_query"))
                ]
                observations[name] = {
                    "query": etree.tostring(query, encoding="unicode"),
                    "screens": run.screens, "outcomes": run.outcomes,
                    "errors": run.page_errors, "dialogs": run.dialogs,
                    "submitted": submitted,
                }
                evidence(name, observations[name])
    assert len(observations["case-count-empty"]["submitted"]) == 1, observations["case-count-empty"]
    for label in ("constant-required", "case-count-one"):
        result = observations[label]
        assert not result["submitted"] and not result["errors"] and not result["dialogs"], result
        assert result["screens"][-1]["query"]["prompts"][1]["label"] == "Village", result
