"""The rule ``search-description-empty`` is sound: every reader of a case search's description reads one that
holds no text as it reads none.

Contract: the rule erases a search description that holds no text, which
HQ's Case List save writes as ``{"<language>": ""}`` where Nova writes
``{}``, in the app document, in the ``<description>`` element HQ's build
gives the search for it, and in what Formplayer hands the client of it. The
plausible failures: HQ's build differing in more than that element; Core's
sessions taking another step for it; Formplayer answering anything else
differently; the Web Apps client showing a blank description box for the
non-breaking space; and the rule erasing a description that holds text.

A search app is written three ways in forks of Nova's publish: Nova's own,
the empty description the save writes, and a description that holds text
(the control). HQ builds the first two alike but for the element, and
Core's sessions over them are the same. Each is then released and served by
HQ's own views (``served_readings``): Formplayer's walks differ only in the
description it hands the client, a non-breaking space where it handed
nothing, which the rule erases; and the client, shown both walks in
Chromium, shows no description element for either and the same screens
throughout. The description that holds text is shown by the client and is a
difference the rule leaves, in the app document, the app strings and
Formplayer's answer. CommCare Android's reading is
``proof/android/predicates.py::test_a_search_description_changes_nothing_a_device_shows``.
"""

from __future__ import annotations

import pytest

from proof.rules.conftest import (
    assert_spelled,
    build_differences,
    client_differences,
    edited,
    formplayer_differences,
    published,
    runs_alike,
    screens,
    served_readings,
    shown,
)
from proof.rules.search_description_empty import RULE

DOCUMENT = "search-browse"
# A document whose search leads to a form, for Core's sessions.
FORMS = "case-list-inline"
TEXT = "Find the person you are visiting"


def _described(text):
    """The app's JSON with every search's description holding ``text`` in each of the app's languages."""

    def change(doc):
        searches = [module["search_config"] for module in doc["modules"] if module.get("search_config")]
        searches = [search for search in searches if search.get("properties")]
        assert searches, "the document holds no case search"
        for search in searches:
            assert search.get("description") == {}, search.get("description")
            search["description"] = {lang: text for lang in doc["langs"]}

    return change


def _description(path):
    return "description" in path


@pytest.mark.parametrize("document", [DOCUMENT, FORMS])
def test_hq_builds_the_empty_description_as_one_element(rule_documents, hq, core_runner, document):
    """Over a search a menu opens (a ``remote-request``'s query) and an inline one (an ``entry``'s)."""
    with published(rule_documents[document], core_runner) as app:
        nova = app.spell()
        saved = app.spell(doc=edited(_described("")))
        text = app.spell(doc=edited(_described(TEXT)))
        assert_spelled(nova, saved, RULE, _description)
        built = shown(build_differences(nova.build, saved.build))
        assert built and all(artifact == "suite.xml" and _description(path) for artifact, path, _ in built), built
        assert shown(build_differences(nova.build, saved.build, rules=(RULE,))) == []
        # A description that holds text is another app: the rule leaves its text in the app strings.
        left = shown(build_differences(nova.build, text.build, rules=(RULE,)))
        assert left and all(artifact.startswith("app_strings") for artifact, _, _ in left), left


def test_core_runs_the_search_and_its_forms_alike(rule_documents, hq, core_runner):
    with published(rule_documents[FORMS], core_runner) as app:
        nova = app.spell()
        saved = app.spell(doc=edited(_described("")))
        first, _, ran = runs_alike(app, core_runner, nova.build, saved.build)
    assert any(step.get("screen") == "search" for run in first.trace["runs"] for step in run["trace"]), (
        "Core's sessions reach no search, so they never read the description"
    )
    assert ran == [], shown(ran)


@pytest.fixture(scope="module")
def read(rule_documents, hq, core_runner, lane_services):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        return served_readings(app, {"nova": None, "saved": _described(""), "text": _described(TEXT)})


def test_formplayer_hands_white_space_for_the_empty_description_and_nothing_else_differs(read):
    found = formplayer_differences(read["nova"], read["saved"])
    assert found, "Formplayer's walk reached no search, so the two spellings were never read apart"
    assert all(d.path.endswith("/description") for d in found), shown(found)
    assert {(d.before, d.after) for d in found} == {("", "\u00a0")}, found
    assert formplayer_differences(read["nova"], read["saved"], rules=(RULE,)) == []
    # The control: a description that holds text is handed to the client, and the rule leaves it.
    kept = formplayer_differences(read["nova"], read["text"], rules=(RULE,))
    assert {(d.before, d.after) for d in kept} == {("", TEXT)}, kept


def _descriptions(reading):
    return [screen["query"]["description"] for screen in screens(reading) if screen.get("query")]


def test_the_client_shows_no_description_for_either_and_shows_one_that_holds_text(read):
    for name in ("nova", "saved"):
        shown_there = _descriptions(read[name])
        assert shown_there and all(description is None for description in shown_there), (name, shown_there)
    assert client_differences(read["nova"], read["saved"]) == []
    described = [description for description in _descriptions(read["text"]) if description is not None]
    assert described and all(description["text"].strip() == TEXT for description in described), described
    assert client_differences(read["nova"], read["text"]), "the client's record does not show a description"


def test_the_rule_leaves_a_description_that_holds_text_or_more_than_a_locale():
    from lxml import etree

    from proof.rules.search_description_empty import normalize

    suite = etree.fromstring(
        "<suite><remote-request><session><query>"
        '<description><text><locale id="case_search.m0.description"/></text></description>'
        "</query><query><description><text>Typed</text></description></query></session></remote-request></suite>"
    )
    left = [etree.tostring(d, encoding="unicode") for d in normalize(suite).iter("description")]
    assert left == ["<description><text>Typed</text></description>"]
    app = {"modules": [{"search_config": {"description": {"en": "", "es": "Buscar"}}}]}
    assert normalize(app)["modules"][0]["search_config"]["description"] == {"en": "", "es": "Buscar"}
    handed = {"runs": [{"steps": [{"response": {"type": "query", "description": " x "}}, {"description": "\u00a0"}]}]}
    assert normalize(handed) == handed
