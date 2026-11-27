"""The retained Search starting value and its worker's physical query context."""

from io import BytesIO
from zipfile import ZipFile

from lxml import etree

from proof.editors import pages
from proof.hq import operations
from proof.matrix import ops, registry
from proof.matrix.authoring import Authoring
from proof.observe.search_address import address_default_database, enable_address_search
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


def test_retained_search_default_orders_a_session_value_in_its_native_context(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["hq-search"]
    variant = next(row for row in registry.load_variants() if row.id == "hq-search/starting-value-of-an-ordered-text")
    retained = variant.change["value"]["default_value"]
    username = "instance('commcaresession')/session/context/username"
    choices = (
        ("literal", "'south'"),
        ("retained", retained),
        ("number-conversion", f"if(number({username}) > number('m'), 'north', 'south')"),
        ("context-value", username),
    )
    read_village = {
        "eval": """() => [...document.querySelectorAll('#query-properties > tr')]
            .find(row => row.querySelector('.query-caption label')?.textContent.trim() === 'Village')
            ?.querySelector('input')?.value ?? null""",
    }
    observations = {}
    for label, expression in choices:
        with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
            author = Authoring(project.unit, webapps_documents, document.id, operation=project.unit.operation)
            ops.set_json(author, project.app_id, variant.change["pointer"], {**variant.change["value"], "default_value": expression})
            app = operations.held_app(project.unit, project.app_id)
            app.cloudcare_enabled = True
            app.save()
            menu_id = project.module_id(0)
            saved = pages.fresh_section_save(editor_driver, project.unit, pages.CASE_LIST, project.app_id, menu_id)
            assert saved.save and saved.save.status == 200 and not saved.refused, (saved.alerts, saved.unsent)
            module = operations.held_app(project.unit, project.app_id).get_module_by_unique_id(menu_id)
            assert module.search_config.properties[1].default_value == expression
            with project.released(formplayer_runner, database=address_default_database(document), label=label) as release:
                with ZipFile(BytesIO(release.archive())) as archive:
                    suite = etree.fromstring(archive.read("suite.xml"))
                scope = [
                    {
                        "default": prompt.get("default"),
                        "instances": prompt.xpath("ancestor::entry//instance/@id"),
                    }
                    for prompt in suite.xpath(".//query/prompt[@key='village'][@default=$default]", default=expression)
                ]
                assert scope, expression
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
    assert context["village"] and "proof-worker" in context["village"], context
    for observation in observations.values():
        assert observation["village"] == "south" and not observation["errors"] and not observation["dialogs"], observation
        assert len(observation["searches"]) == 1, observation
        assert ("village", "south") in map(tuple, observation["searches"][0]), observation
