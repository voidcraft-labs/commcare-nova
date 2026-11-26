"""Two child routes choose different people after a parent's genuine HQ Search."""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from itertools import product

from lxml import etree

from proof.checks import proof6, readerbundle
from proof.formplayer import apps
from proof.formplayer.walk import screen_kind
from proof.hq import operations
from proof.matrix.authoring import Authoring
from proof.matrix import ops
from proof.observe import publish
from proof.observe.casedata import document_case_database

DOCUMENT = "targeted-searched-shared-visit"
SEARCH_INPUT = "cohort"
NEW_LABEL = "Household cohort"
ORIGINAL_SEARCH_LABELS = {"en": "Cohort", "fra": "Cohorte"}
EDITED_SEARCH_LABELS = {**ORIGINAL_SEARCH_LABELS, "en": NEW_LABEL}
CASE_NS = "{http://commcarehq.org/case/transaction/v2}"
DISTRICT_HEADERS = {"en": "District region", "fra": "Région du district"}
SEARCH_ROWS = [
    ("household-2", ["Pilot Aster", "West"]),
    ("household-1", ["Pilot Zinnia", "North"]),
]


def _database(document):
    base = document_case_database(document)
    by_id = {case.case_id: case for case in base.cases}
    return replace(base, cases=(
        replace(by_id["district-1"], properties=(("region", "North"),)),
        replace(by_id["district-2"], properties=(("region", "West"),)),
        replace(by_id["household-1"], name="Pilot Zinnia", properties=(("cohort", "Pilot"),)),
        replace(by_id["household-2"], name="Pilot Aster", properties=(("cohort", "Pilot"),)),
        replace(
            by_id["household-3"], name="Outside Willow", properties=(("cohort", "Outside"),),
            indices=by_id["household-1"].indices,
        ),
        replace(by_id["person-1"], name="Zinnia resident", properties=(("visit_note", "Original Zinnia"),)),
        replace(by_id["person-2"], name="Aster resident", properties=(("visit_note", "Original Aster"),)),
        replace(by_id["person-3"], name="Outside resident", properties=(("visit_note", "Original Outside"),)),
    ))


def _choose(screen, label):
    assert screen_kind(screen) == "commands", screen
    labels = [item["displayText"] for item in screen["commands"]]
    assert label in labels, (label, labels)
    return [*map(str, screen["selections"]), str(labels.index(label))]


def _worker_visits(published, runner, label, child_order, search_labels):
    from corehq.form_processor.models import CommCareCase

    records = {locale: {} for locale in DISTRICT_HEADERS}
    routes = (("Visits", "household-1", "person-1"), ("Clinic", "household-2", "person-2"))
    people = [person for _, _, person in routes] + ["person-3"]

    def notes(served):
        return {
            person: CommCareCase.objects.get_case(person, served.domain).get_case_property("visit_note")
            for person in people
        }

    with apps.served(published, runner, label=label, database=_database(published.document)) as served:
        for locale, (menu, household, person) in product(DISTRICT_HEADERS, routes):
            with served.run(f"{label}-{locale}-{menu}"):
                web = apps.web(runner, served, locale=locale)
                path = ["0"]  # The app has a single root menu, Households.
                query = web.navigate(path)
                assert screen_kind(query) == "query", query
                (prompt,) = query["displays"]
                search_label = search_labels[locale]
                assert prompt["id"] == SEARCH_INPUT and prompt["text"] == search_label, prompt
                query_data = {query["queryKey"]: {"inputs": {SEARCH_INPUT: "Pilot"}, "execute": True}}
                results = web.navigate(path, query_data=query_data)
                assert screen_kind(results) == "entities", results
                requests = [
                    request.params for request in served.hq.searches
                    if request.values(SEARCH_INPUT) == ("Pilot",)
                ]
                assert requests, served.hq.searches
                rows = [(row["id"], row["data"]) for row in results["entities"]]
                assert rows == SEARCH_ROWS, results
                headers = results["headers"]
                assert headers == ["Household", DISTRICT_HEADERS[locale]], results

                selected = web.navigate([*map(str, results["selections"]), household], query_data=query_data)
                visible_routes = [
                    command["displayText"] for command in selected["commands"] if command["displayText"] in child_order
                ]
                assert visible_routes == child_order, selected
                members = web.navigate(_choose(selected, menu), query_data=query_data)
                assert screen_kind(members) == "entities", members
                assert [row["id"] for row in members["entities"]] == [person], members
                form_or_menu = web.navigate([*map(str, members["selections"]), person], query_data=query_data)
                form = (
                    web.navigate(_choose(form_or_menu, "Record visit"), query_data=query_data)
                    if screen_kind(form_or_menu) == "commands" else form_or_menu
                )
                assert screen_kind(form) == "form" and form["title"] == "Record visit", form
                assert [value for value in form["selections"] if value in {household, person}] == [
                    household, person,
                ], form

                (question,) = [node for node in form["tree"] if node["type"] == "question"]
                answer = f"Recorded in {menu} during {label} ({locale})"
                before = notes(served)
                received = len(served.hq.submissions)
                response = web.submit(form["session_id"], {question["ix"]: answer})
                assert response["status"] == "success", response
                (receipt,) = served.hq.submissions[received:]
                after = notes(served)
                assert after == {**before, person: answer}
                root = etree.fromstring(receipt.instance)
                (case,) = [block for block in root.iter(f"{CASE_NS}case")]
                assert case.get("case_id") == person and root.findtext("{*}note") == answer
                datums = {key: root.findtext(f"{{*}}{key}") for key in ("selected_household", "selected_person")}
                assert datums == {"selected_household": household, "selected_person": person}
                records[locale][menu] = {
                    "childMenuOrder": visible_routes,
                    "search": {
                        "label": search_label, "input": query_data, "requests": requests,
                        "headers": headers, "rows": rows,
                    },
                    "selections": form["selections"],
                    "datums": datums,
                    "case": case.get("case_id"),
                    "notes": {"before": before, "after": after},
                    "namespace": etree.QName(root).namespace,
                }
    return records


def _save_search_in_hq(published):
    authoring = Authoring(published.unit, {}, base=DOCUMENT, operation=published.unit.operation)
    config = operations.held_app(published.unit, published.app_id).get_module(0).search_config
    settings = config.to_json()
    (field,) = settings["properties"]
    assert field["name"] == SEARCH_INPUT, settings
    field.update(label=NEW_LABEL, hint=field.get("hint", {}).get("en", ""), appearance=field.get("appearance", ""))
    # The page displays scalar wording from the active language.
    for key in ("title_label", "description"):
        settings[key] = settings.get(key, {}).get("en", "")
    body, content_type = ops.form_body([
        ("type", json.dumps("case")), ("search_properties", json.dumps(settings)),
    ])
    with authoring.step("edit-parent-search", body):
        ops.post(
            authoring, "edit_module_detail_screens", [published.app_id, published.module_id(0)],
            body, content_type, "the parent menu's Search",
        )


def _read_back(published, evidence):
    from corehq import privileges
    from proof.hq import redis as hq_redis
    from proof.hq.seams import also_granted, api_rate_limits

    unit, app_id = published.unit, published.app_id
    with hq_redis.shared(None), unit.fork(), unit.committing(), also_granted(privileges.API_ACCESS), api_rate_limits(unit):
        credential = operations.seed_api_user(unit, "combined-journey-reader@example.com")
        reads = {
            key: read(unit, app_id, credential).retained()
            for key, read in (
                ("application", operations.application_read),
                ("source", operations.source_read),
                ("currentVersion", operations.current_version_read),
            )
        }
    stored = published.document.edit_document
    expected = copy.deepcopy(stored["doc"])
    household, *_ = expected["moduleOrder"]
    expected["modules"][household]["caseListConfig"]["searchInputs"][0]["label"] = NEW_LABEL
    # The HQ edit changes the English source and leaves its French translation in place.
    translated, = (
        translation for translation in expected["localization"]["translations"]["fra"].values()
        if translation["value"] == ORIGINAL_SEARCH_LABELS["fra"]
    )
    assert translated["sourceFingerprint"] == 'source-v1:text:"Cohort"'
    translated["sourceFingerprint"] = f"source-v1:text:{json.dumps(NEW_LABEL)}"
    (answer,) = readerbundle.run_reader([{
        "id": DOCUMENT,
        "mode": "read-back",
        "input": proof6.read_back_input(published.document, reads, stored),
        "expected": expected,
        "canon": True,
    }])
    evidence("search-read-back", answer)
    assert answer["kind"] == "read" and answer["differences"] == [], json.dumps(
        answer.get("findings", answer.get("differences", answer)), indent=2
    )
    return answer


def test_a_visit_after_a_parent_search_keeps_both_listed_visit_routes(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    document = formplayer_documents[DOCUMENT]
    with apps.published(document, core_runner) as published:
        before = _worker_visits(published, formplayer_runner, "original", ["Visits", "Clinic"], ORIGINAL_SEARCH_LABELS)
        with published.unit.operation("reorder-child-menus", DOCUMENT.encode()):
            refusal, lookups = publish.update(
                published.unit, published.app_id, document.edit.exports["minimum"].update, "B-edit"
            )
            assert refusal is None and (lookups is None or lookups["errors"] == []), (refusal, lookups)
        reordered = _worker_visits(published, formplayer_runner, "reordered", ["Clinic", "Visits"], ORIGINAL_SEARCH_LABELS)
        _save_search_in_hq(published)
        after = _worker_visits(published, formplayer_runner, "edited", ["Clinic", "Visits"], EDITED_SEARCH_LABELS)
        evidence("searched-shared-visit", {"before": before, "reordered": reordered, "after": after})
        _read_back(published, evidence)
    namespaces = {
        route["namespace"]
        for stage in (before, reordered, after)
        for locale in stage.values()
        for route in locale.values()
    }
    assert len(namespaces) == 1 and all(namespaces), (before, reordered, after)
