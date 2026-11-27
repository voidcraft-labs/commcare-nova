"""A restored case count can make a Search prompt required in Web Apps."""

from dataclasses import replace
from io import BytesIO
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

from lxml import etree
import pytest

from proof.android import observe
from proof.hq import operations
from proof.matrix.registry import load_variants
from proof.observe import casedata, services
from proof.observe.record import Blobs
from proof.observe.search_address import enable_address_search
from proof.webapps import hq as webapps_hq


pytestmark = pytest.mark.reader("android")


def test_installed_search_keeps_the_request_with_a_blank_conditional_field(
    android_documents, hq, android_walk_evidence
):
    from corehq.apps.app_manager.models.case_search import CaseSearchProperty

    document = android_documents["hq-search"]
    row = next(var for var in load_variants() if var.id == "hq-search/required-reading-the-case-list")
    prompt = row.change["value"]
    database = casedata.document_case_database(document)
    client = next(case for case in database.cases if case.case_type == "client")
    client = replace(client, name="Amina", properties=(("village", "east"), ("last_visit", "2025-12-01")))
    with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
        app = operations.held_app(project.unit, project.app_id)
        app.cloudcare_enabled = True
        app.modules[0].search_config.properties[1] = CaseSearchProperty.wrap(dict(prompt))
        app.save()
        with project.released(services.formplayer(), database=replace(database, cases=(client,))) as release:
            blobs = Blobs()
            command = "search_command.m0"
            archive = observe.release_archive(release)
            with ZipFile(BytesIO(archive)) as exported:
                suite = etree.fromstring(exported.read("suite.xml"))
            queries = suite.xpath(".//query[prompt[@key='village']/required]")
            assert queries
            storage, = {query.get("storage-instance") for query in queries}
            assert storage
            assert all(query.xpath("prompt[@key='village']/required/@test") == [prompt["required"]["test"]]
                       for query in queries)
            recorded = observe.app(
                release, blobs, label="required-restored-count",
                archive=archive, commands=[command], views=True,
                search_answers={storage: {"client_name": "Amina"}},
            )
            answer = blobs.get_json(recorded["answer"])
            exchanges = blobs.get_json(recorded["hq"])
    assert answer["install"] == "Installed" and answer["signIn"].startswith("Success("), answer
    searched = [
        {"status": item["status"], "params": parse_qs(urlsplit(item["url"]).query)}
        for item in exchanges if "/phone/search/" in item["url"]
    ]
    android_walk_evidence({"answer": answer, "searches": searched})
    (request,) = [
        item for item in searched if "case_name = 'Amina'" in item["params"].get("_xpath_query", [])
    ]
    assert request["status"] == 200 and "village" not in request["params"], request
