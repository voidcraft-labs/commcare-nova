"""The retained Search starting value and its worker's physical query context."""

from proof.editors import pages
from proof.hq import operations
from proof.observe.search_address import enable_address_search
from proof.observe.search_ordered_default import (
    COERCED,
    LITERAL,
    SOUTH,
    USERNAME,
    ordered_default_database,
    ordered_default_variant,
    query_scope,
    save_ordered_default,
)
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


def test_retained_search_default_orders_a_session_value_in_its_native_context(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["hq-search"]
    variant = ordered_default_variant()
    retained = variant.change["value"]["default_value"]
    choices = (
        ("literal", LITERAL),
        ("retained", retained),
        ("number-conversion", COERCED),
        ("context-value", USERNAME),
    )
    read_village = {
        "eval": """() => [...document.querySelectorAll('#query-properties > tr')]
            .find(row => row.querySelector('.query-caption label')?.textContent.trim() === 'Village')
            ?.querySelector('input')?.value ?? null""",
    }
    observations = {}
    for label, expression in choices:
        with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
            save_ordered_default(project, variant, expression)
            menu_id = project.module_id(0)
            saved = pages.fresh_section_save(editor_driver, project.unit, pages.CASE_LIST, project.app_id, menu_id)
            assert saved.save and saved.save.status == 200 and not saved.refused, (saved.alerts, saved.unsent)
            module = operations.held_app(project.unit, project.app_id).get_module_by_unique_id(menu_id)
            assert module.search_config.properties[1].default_value == expression
            with project.released(formplayer_runner, database=ordered_default_database(document), label=label) as release:
                scope = query_scope(release.archive(), expression)
                opening = [
                    *steps.open_app("Client search"),
                    *steps.choose("Clients"),
                    *steps.choose("Followup Form"),
                    *steps.arrive(any_screen=True),
                    steps.SCREEN,
                    read_village,
                ]
                run = Session(release, editor_driver).run([
                    *opening, *steps.type_prompt(0, "Amina"), *steps.run_search(),
                    *steps.arrive(any_screen=True), steps.SCREEN,
                ])
                observation = {
                    "scope": scope, "screens": run.screens, "outcomes": run.outcomes,
                    "errors": run.page_errors, "dialogs": run.dialogs,
                    "village": run.value(len(opening) - 1),
                    "searches": [list(search.params) for search in release.hq.searches],
                }
                evidence(label, observation)
                observations[label] = observation
    context = observations.pop("context-value")
    assert context["village"] == "proof-worker", context
    assert dict(context["searches"][0])["village"] == ("proof-worker",)
    assert not context["screens"][-1]["list"]["rows"], context
    for observation in observations.values():
        assert observation["village"] == "south" and not observation["errors"] and not observation["dialogs"], observation
        assert len(observation["searches"]) == 1, observation
        assert dict(observation["searches"][0])["village"] == ("south",), observation
        rows = observation["screens"][-1]["list"]["rows"]
        assert len(rows) == 1 and rows[0]["id"].endswith(SOUTH), rows
