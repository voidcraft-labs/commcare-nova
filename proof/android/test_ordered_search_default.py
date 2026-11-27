"""The installed worker keeps the computed starting text in a manual Search."""

from urllib.parse import parse_qs, urlsplit

from proof.android import observe
from proof.observe import services
from proof.observe.record import Blobs
from proof.observe.search_address import enable_address_search
from proof.observe.search_ordered_default import (
    COERCED,
    LITERAL,
    USERNAME,
    ordered_default_database,
    ordered_default_variant,
    query_scope,
    save_ordered_default,
)
from proof.webapps import hq as webapps_hq


def test_installed_search_uses_the_retained_ordered_default(android_documents, hq, android_walk_evidence):
    document = android_documents["hq-search"]
    variant = ordered_default_variant()
    choices = (
        ("literal", LITERAL, "south"),
        ("retained", variant.change["value"]["default_value"], "south"),
        ("number-conversion", COERCED, "south"),
        ("context-value", USERNAME, "proof-worker"),
    )
    command = "search_command.m0"
    observations = {}
    for label, expression, expected in choices:
        with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
            save_ordered_default(project, variant, expression)
            with project.released(
                services.formplayer(), database=ordered_default_database(document), label=label,
            ) as release:
                archive = observe.release_archive(release)
                scope = query_scope(archive, expression)
                storage, = {item["instance"] for item in scope}
                assert storage, scope
                blobs = Blobs()
                recorded = observe.app(
                    release, blobs, label=f"ordered-search-{label}", archive=archive,
                    commands=[command], views=True, search_answers={storage: {"client_name": "Amina"}},
                )
                answer = blobs.get_json(recorded["answer"])
                exchanges = blobs.get_json(recorded["hq"])
        assert answer["install"] == "Installed" and answer["signIn"].startswith("Success("), answer
        walk = answer["walks"][command]
        (query,) = [step["query"] for step in walk["steps"] if "query" in step]
        searched = [
            {"status": exchange["status"], "params": parse_qs(urlsplit(exchange["url"]).query)}
            for exchange in exchanges if "/phone/search/" in exchange["url"]
        ]
        observations[label] = {"expected": expected, "scope": scope, "query": query, "searched": searched}

    android_walk_evidence(observations)
    for label, observed in observations.items():
        expected = observed["expected"]
        assert observed["query"]["RemoteQuerySessionManager.getRawQueryParams"]["village"] == [expected], (label, observed)
        search, = observed["searched"]
        assert search["status"] == 200 and search["params"]["village"] == [expected], (label, observed)
