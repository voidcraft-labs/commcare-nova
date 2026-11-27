"""The installed app sends its restored worker session's owner exclusion."""

from dataclasses import replace
from io import BytesIO
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

from lxml import etree
import pytest

from proof.android import observe
from proof.hq import operations
from proof.matrix.authoring import Authoring
from proof.matrix.registry import load_variants
from proof.observe import casedata, services
from proof.observe.record import Blobs
from proof.observe.search_address import enable_address_search
from proof.webapps import hq as webapps_hq


pytestmark = pytest.mark.reader("android")


def test_installed_search_sends_the_owner_the_worker_comparison_selects(
    android_documents, hq, android_walk_evidence,
):
    from proof.matrix.variants.case_search import owner_exclusion_on_an_ordered_text

    document = android_documents["hq-search"]
    variant = next(one for one in load_variants() if one.id == "hq-search/owner-exclusion-on-an-ordered-text")
    assert variant.change["name"] == owner_exclusion_on_an_ordered_text.__name__
    seed = casedata.document_case_database(document)
    client = next(case for case in seed.cases if case.case_type == "client")
    clients = tuple(
        replace(client, case_id=f"owner-exclusion-{owner}", name=f"Client {owner}", owner_id=owner,
                properties=(("standing", "active"), ("district", "d1")), indices=())
        for owner in ("a", "b")
    )
    with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
        author = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
        owner_exclusion_on_an_ordered_text(author, project.app_id)
        app = operations.held_app(project.unit, project.app_id)
        expected = app.modules[1].search_config.blacklisted_owner_ids_expression
        with project.released(services.formplayer(), database=replace(seed, cases=clients)) as release:
            archive = observe.release_archive(release)
            with ZipFile(BytesIO(archive)) as deployed:
                suite = etree.fromstring(deployed.read("suite.xml"))
            query, = suite.xpath(".//query[data[@key='commcare_blacklisted_owner_ids']]")
            assert query.xpath("data[@key='commcare_blacklisted_owner_ids']/@ref") == [expected]
            storage = query.get("storage-instance")
            assert storage
            blobs = Blobs()
            record = observe.app(
                release, blobs, label="owner-exclusion", archive=archive,
                commands=["search_command.m1"], views=True, search_answers={storage: {}},
            )
            answer = blobs.get_json(record["answer"])
            exchanges = blobs.get_json(record["hq"])
    assert answer["install"] == "Installed" and answer["signIn"].startswith("Success("), answer
    searched = [
        {"status": item["status"], "params": parse_qs(urlsplit(item["url"]).query)}
        for item in exchanges if "/phone/search/" in item["url"]
    ]
    android_walk_evidence({"answer": answer, "searches": searched})
    requests = [
        item for item in searched
        if "standing = 'active' and district = 'd1'" in item["params"].get("_xpath_query", [])
    ]
    assert requests and all(
        item["status"] == 200 and item["params"]["commcare_blacklisted_owner_ids"] == ["b"]
        for item in requests
    ), searched
    results, = [step["list"] for step in answer["walks"]["search_command.m1"]["steps"] if "list" in step]
    assert (results["count"], results["chose"]) == (1, "owner-exclusion-a"), results
