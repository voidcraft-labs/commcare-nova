"""The owner exclusion shared by a retained app's case list and Search."""

from dataclasses import replace
from io import BytesIO
from zipfile import ZipFile

from lxml import etree

from proof.editors import pages
from proof.hq import operations
from proof.matrix.authoring import Authoring
from proof.matrix.registry import load_variants
from proof.observe import casedata
from proof.observe.search_address import enable_address_search
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


def test_owner_exclusion_compares_worker_text_as_a_number_in_search(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence,
):
    from proof.matrix.variants.case_search import SESSION, _normalized, _owner_clause, owner_exclusion_on_an_ordered_text

    document = webapps_documents["hq-search"]
    variant = next(one for one in load_variants() if one.id == "hq-search/owner-exclusion-on-an-ordered-text")
    assert variant.change["name"] == owner_exclusion_on_an_ordered_text.__name__
    seed = casedata.document_case_database(document)
    client = next(case for case in seed.cases if case.case_type == "client")
    clients = tuple(
        replace(client, case_id=f"owner-exclusion-{owner}", name=f"Client {owner}", owner_id=owner,
                properties=(("standing", "active"), ("district", "d1")), indices=())
        for owner in ("a", "b")
    )
    database = replace(seed, cases=clients)
    username = f"{SESSION}/context/username"
    ordered = f"if({username} > 'm', 'a', 'b')"
    coerced = f"if(number({username}) > number('m'), 'a', 'b')"
    for label, owners, excluded, visible in (
        ("retained", ordered, "b", "a"),
        ("worker-id", ordered.replace("/username", "/userid"), "b", "a"),
        ("device-id", ordered.replace("/username", "/deviceid"), "b", "a"),
        ("device-id-below", ordered.replace("/username", "/deviceid").replace(" > ", " < "), "b", "a"),
        ("session-pair", f"if({SESSION}/context/deviceid < {SESSION}/context/userid, 'a', 'b')", "b", "a"),
        ("coerced", coerced, "b", "a"),
        ("opposite-owner", "'a'", "a", "b"),
    ):
        with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
            author = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
            owner_exclusion_on_an_ordered_text(author, project.app_id)
            app = operations.held_app(project.unit, project.app_id)
            menu = app.modules[1]
            menu_id = menu.unique_id
            assert menu.search_config.blacklisted_owner_ids_expression == _normalized(ordered)
            menu.search_config.blacklisted_owner_ids_expression = _normalized(owners)
            menu.case_details.short.filter = (
                f"standing = 'active' and district = 'd1' and ({_owner_clause(owners)})"
            )
            app.cloudcare_enabled = True
            app.save()

            saved = pages.fresh_section_save(editor_driver, project.unit, pages.CASE_LIST, project.app_id, menu_id)
            assert saved.save and saved.save.status == 200 and not saved.refused, (saved.alerts, saved.unsent)
            held = operations.held_app(project.unit, project.app_id).get_module_by_unique_id(menu_id)
            assert held.search_config.blacklisted_owner_ids_expression == _normalized(owners)
            assert _owner_clause(owners) in held.case_details.short.filter

            with project.released(formplayer_runner, database=database, label=label) as release:
                with ZipFile(BytesIO(release.archive())) as archive:
                    suite = etree.fromstring(archive.read("suite.xml"))
                query_values = suite.xpath(".//query/data[@key='commcare_blacklisted_owner_ids']/@ref")
                assert query_values == [_normalized(owners)], query_values
                run = Session(release, editor_driver).run([
                    *steps.open_app("Client search"), *steps.choose("Active clients"),
                    *steps.arrive(any_screen=True), steps.SCREEN,
                ])
                requests = [search.values("commcare_blacklisted_owner_ids") for search in release.hq.searches]
                observation = {
                    "query_values": query_values, "requests": requests, "screens": run.screens,
                    "outcomes": run.outcomes, "errors": run.page_errors, "dialogs": run.dialogs,
                }
                evidence(label, observation)
                assert not run.page_errors and not run.dialogs, observation
                assert requests == [(excluded,)], observation
                assert [row["id"] for row in run.screens[-1]["list"]["rows"]] == [
                    f"row-owner-exclusion-{visible}"
                ], observation


def test_the_list_uses_the_same_owner_exclusion_on_the_worker_restore(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence,
):
    from proof.matrix.variants.case_search import SESSION, _normalized, _owner_clause

    document = webapps_documents["hq-search"]
    seed = casedata.document_case_database(document)
    source = next(case for case in seed.cases if case.case_type == "client")
    client = replace(source, case_id="owner-exclusion-local", name="Restored client", owner_id=seed.user_id,
                     properties=(("standing", "active"), ("district", "d1")), indices=())
    database = replace(seed, cases=(client,))
    username = f"{SESSION}/context/username"
    for label, blocked, visible in (("excluded", seed.user_id, []), ("included", "unrelated-owner", [client.case_id])):
        with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
            app = operations.held_app(project.unit, project.app_id)
            menu = app.modules[1]
            rule = f"if({username} > 'm', 'other-owner', '{blocked}')"
            menu.search_config.auto_launch = False
            menu.search_config.default_search = False
            menu.search_config.blacklisted_owner_ids_expression = _normalized(rule)
            menu.case_details.short.filter = (
                f"standing = 'active' and district = 'd1' and ({_owner_clause(rule)})"
            )
            app.cloudcare_enabled = True
            app.save()
            with project.released(formplayer_runner, database=database, label=label) as release:
                run = Session(release, editor_driver).run([
                    *steps.open_app("Client search"), *steps.choose("Active clients"),
                    *steps.arrive(any_screen=True), steps.SCREEN,
                ])
                observation = {
                    "screens": run.screens, "errors": run.page_errors, "dialogs": run.dialogs,
                    "requests": [item.params for item in release.hq.searches],
                }
                evidence(f"local-owner-rule-{label}", observation)
                assert not run.page_errors and not run.dialogs and not release.hq.searches, observation
                assert [row["id"] for row in run.screens[-1]["list"]["rows"]] == [
                    f"row-{case_id}" for case_id in visible
                ], observation
