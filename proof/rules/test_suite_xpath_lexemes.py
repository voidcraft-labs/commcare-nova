"""The rule ``suite-xpath-lexemes`` is sound: every reader of a suite reads an expression alike whatever its whitespace
and its strings' quote marks.

Contract: the rule writes each attribute Core's suite parsers read as XPath
(``proof/rules/_suite.py::XPATH_ATTRIBUTES``) as the tokens Core's lexer reads
in it, a string by its value, so a text spelled with other whitespace or
other quote marks is one with Nova's, and a text Core reads as other tokens
stays another. Its readers are HQ's build, which writes the stored text into
the suite, Core, Formplayer and the Web Apps client, which shows what
Formplayer evaluates, and CommCare Android
(``proof/android/predicates.py::test_a_list_reads_a_suite_expression_alike_in_either_spelling``).
The plausible failures: a reader that reads the text otherwise than by
Core's lexer, the rule erasing two texts Core reads as different tokens
(another string, another name, an operator moved), and the rule reading an
attribute no parser reads as XPath (an id, a locale's id, a media path).

``case-list-local``'s first menu lists its cases with a calculated column.
The stored app is written with that column's expression wrapped as Nova
spells it, ``concat(<expression>, ' / ', 'kept')``, and as an author typed
it, with other whitespace and double quotes; HQ builds both whole, the two
builds differ at the column's ``xpath@function`` alone, which the rule
erases, Core's sessions over the two, whose list shows the column's text for
its case, compare equal, and Formplayer's walk
and the Web Apps client's screens of the two releases compare equal. A
third spelling, with another string, is a difference the rule leaves.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from lxml import etree

from proof.rules._suite import XPATH_ATTRIBUTES, is_xpath
from proof.rules.conftest import (
    build_differences,
    client_differences,
    edited,
    formplayer_differences,
    listed,
    published,
    runs_alike,
    served_readings,
    shown,
)
from proof.rules.suite_xpath_lexemes import RULE, normalize, written

DOCUMENT = "case-list-local"
SURFACE = Path(__file__).resolve().parents[2] / "lib" / "commcare" / "surface" / "surface.json"
# The text the wrapped column shows beside its expression's value, which a walk that shows the list holds.
KEPT = "kept"
NOVA = "concat({}, ' / ', 'kept')"
TYPED = 'concat(  {} ,\n " / ",  "kept"  )'
OTHER = "concat({}, ' / ', 'other')"


# The rule over texts and attributes alone ------------------------------------------------------------------------


def test_texts_core_reads_as_the_same_tokens_are_one_and_others_stay_two():
    nova = "instance('casedb')/casedb/case[@case_type='p'][(referral = 'Yes' or x = \"it's\") and n != 1]"
    typed = 'instance( "casedb" )/casedb/case[@case_type = "p"][(referral =\'Yes\' or x="it\'s")and n!=1]'
    assert written(nova) == written(typed)
    for other in (
        nova.replace("'Yes'", "'yes'"),
        nova.replace("n != 1", "n = 1"),
        nova.replace("referral", "referal"),
        nova.replace("(referral", "referral").replace('"it\'s")', '"it\'s"'),
    ):
        assert written(other) != written(nova), other
    # A text the port of Core's lexer does not read is left as it stands.
    assert written("concat('a', \"b)") == "concat('a', \"b)"


def test_only_an_attribute_core_reads_as_xpath_is_written():
    suite = etree.fromstring(
        '<suite><detail id="m0_case_short"><field><header><text><locale id="m0 . header"/></text></header>'
        '<template><text><xpath function="concat( a ,\'x\')"><variable name="v"><xpath function="b = \'y\'"/>'
        '</variable></xpath></text></template></field><variables><calc function="c  +  1"/></variables></detail>'
        '<entry><session><datum id="case_id" nodeset="x[a =\'1\']" value="./@case_id"/></session></entry>'
        "</suite>"
    )
    normalize(suite)
    functions = [element.get("function") for element in suite.iter("xpath")]
    assert functions == ["concat ( a , 'x' )", "b = 'y'"]
    assert suite.find("detail/variables/calc").get("function") == "c + 1"
    assert suite.find("entry/session/datum").get("nodeset") == "x [ a = '1' ]"
    # An id, a locale's id: no parser reads them as XPath.
    assert suite.find("detail").get("id") == "m0_case_short"
    assert next(suite.iter("locale")).get("id") == "m0 . header"
    assert not is_xpath(suite.find("detail"), "id")
    assert RULE.applies_to("suite.xml") and RULE.applies_to("profile-1/suite.xml")
    assert not RULE.applies_to("app.json") and not RULE.applies_to("form:0.0")


def test_the_attributes_read_as_xpath_are_the_surfaces():
    """``XPATH_ATTRIBUTES`` is every ``(element, attribute)`` a ``parser:`` item of the surface marks ``parsedAs:
    xpath``, and no ``parser:`` item names one of them without it."""
    items = json.loads(SURFACE.read_text(encoding="utf-8"))["items"]
    read, other = set(), set()
    for key, item in items.items():
        if not key.startswith("parser:") or "@" not in key:
            continue
        element, attribute = key.split("/", 1)[1].rsplit("@", 1)
        (read if "xpath" in (item.get("parsedAs") or ()) else other).add((element, attribute))
    assert XPATH_ATTRIBUTES == read
    assert XPATH_ATTRIBUTES & other == set()


# The readers, run ---------------------------------------------------------------------------------------------


def _calculated(doc):
    """The first menu's first calculated column of the case list, as HQ stores it."""
    columns = doc["modules"][0]["case_details"]["short"]["columns"]
    return next(column for column in columns if column.get("useXpathExpression") is True)


def _wrapped(template):
    def change(doc):
        column = _calculated(doc)
        column["field"] = template.format(column["field"])

    return change


def _suite_differences(first, second, *, rules=()):
    return [
        difference
        for difference in build_differences(first.build, second.build, rules=rules)
        if difference.artifact.endswith("suite.xml")
    ]


def test_hq_builds_either_spelling_and_core_runs_both_alike(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=edited(_wrapped(NOVA)))
        typed = app.spell(doc=edited(_wrapped(TYPED)))
        other = app.spell(doc=edited(_wrapped(OTHER)))
        first, _, alike = runs_alike(app, core_runner, nova.build, typed.build, reads="case list")

    found = shown(build_differences(nova.build, typed.build))
    assert found, "the two spellings built the same suite, so the test shows nothing"
    assert all(path.endswith("/@function") for _, path, _ in found), found
    assert build_differences(nova.build, typed.build, rules=(RULE,)) == []
    assert any(field.endswith(f" / {KEPT}") for field in listed(first)), "Core's list showed no row of the column"
    assert alike == [], shown(alike)
    assert shown(_suite_differences(nova, other, rules=(RULE,))), "the rule erased another string"


@pytest.mark.reader("webapps")  # beside Formplayer, which its fixture starts: it reads the client's screens too
def test_formplayer_walks_a_suite_expression_alike_in_either_spelling(
    rule_documents, hq, core_runner, formplayer_runner
):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        readings = served_readings(app, formplayer_runner, {"nova": _wrapped(NOVA), "typed": _wrapped(TYPED)})

    nova, typed = readings["nova"], readings["typed"]
    assert _calculated(nova["doc"])["field"] != _calculated(typed["doc"])["field"]
    assert KEPT in json.dumps(nova["formplayer"]), "Formplayer's walk showed no row of the list"
    assert formplayer_differences(nova, typed) == []
    assert client_differences(nova, typed) == []
