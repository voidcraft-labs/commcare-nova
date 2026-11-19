"""The rule ``suite-cond-as-if`` is sound: every reader of a suite evaluates a three-argument ``cond`` as the ``if``
Nova writes.

Contract: the rule writes ``if`` for the name of each call of ``cond`` with
exactly three arguments in an attribute Core's suite parsers read as XPath,
and leaves a ``cond`` of more arguments, any other call and a text the port
of Core's lexer does not read. Its readers are HQ's build, which writes the
stored text into the suite, Core, Formplayer and the Web Apps client, which
shows what Formplayer evaluates, and CommCare Android
(``proof/android/predicates.py::test_a_list_reads_a_cond_and_its_if_alike``).
The plausible failures: Core evaluating the two otherwise where the test is
true for one case and false for another; a reader that calls the function
by its name; and the rule renaming a ``cond`` of five arguments, whose
``if`` is nested.

``case-list-local``'s first menu lists its cases with a calculated column.
The stored app is written with that column's expression wrapped as Nova
prints it, ``if(<expression> = '', 'none', concat('rank ', <expression>))``,
and with ``cond`` in place of ``if``; HQ builds both whole, the two builds
differ at the column's ``xpath@function`` alone, which the rule erases,
Core's sessions over the two compare equal, and Formplayer's walk and the
Web Apps client's screens of the two releases compare equal. The same
wrapping with another test is a difference the rule leaves.
"""

from __future__ import annotations

import json

from lxml import etree

from proof.rules.conftest import (
    build_differences,
    client_differences,
    edited,
    formplayer_differences,
    published,
    runs_alike,
    served_readings,
    shown,
)
from proof.rules.suite_cond_as_if import RULE, as_if, normalize

DOCUMENT = "case-list-local"
# The texts the wrapped column shows, one of which a walk that shows the list holds.
SHOWN = ("'none'", "rank ")
NOVA = "if({0} = '', 'none', concat('rank ', {0}))"
COND = "cond({0} = '', 'none', concat('rank ', {0}))"
OTHER = "cond({0} != '', 'none', concat('rank ', {0}))"


# The rule over texts alone -------------------------------------------------------------------------------------


def test_a_three_argument_cond_is_its_if_and_nothing_else_is_renamed():
    assert as_if("cond(a = 1, \"x\", '')") == "if(a = 1, \"x\", '')"
    assert as_if("concat(  cond(a, 'x', ''),cond(b[c = cond(d, 1, 2)], f(1, 2), ''))") == (
        "concat(  if(a, 'x', ''),if(b[c = if(d, 1, 2)], f(1, 2), ''))"
    )
    # A cond of five arguments is if nested in if, a tree of another shape; a name that only holds the word, a
    # step named cond and a text the port does not read are left.
    for left in ("cond(a, 1, b, 2, 3)", "condition(a, 1, 2)", "x/cond", "cond(a, 'x, 2)"):
        assert as_if(left) == left


def test_the_rule_reads_only_an_attribute_core_reads_as_xpath():
    suite = etree.fromstring(
        "<suite><detail id=\"cond(a, b, c)\"><field><template><text><xpath function=\"cond(a, 'x', 'y')\"/>"
        "</text></template></field></detail></suite>"
    )
    normalize(suite)
    assert next(suite.iter("xpath")).get("function") == "if(a, 'x', 'y')"
    assert suite.find("detail").get("id") == "cond(a, b, c)"
    assert RULE.applies_to("suite.xml") and not RULE.applies_to("app.json")


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


def test_hq_builds_cond_and_if_and_core_runs_both_alike(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=edited(_wrapped(NOVA)))
        cond = app.spell(doc=edited(_wrapped(COND)))
        other = app.spell(doc=edited(_wrapped(OTHER)))
        _, _, alike = runs_alike(app, core_runner, nova.build, cond.build)

    found = shown(build_differences(nova.build, cond.build))
    assert found, "the two spellings built the same suite, so the test shows nothing"
    assert all(path.endswith("/@function") for _, path, _ in found), found
    assert build_differences(nova.build, cond.build, rules=(RULE,)) == []
    assert alike == [], shown(alike)
    assert shown(build_differences(nova.build, other.build, rules=(RULE,))), "the rule erased another test"


def test_formplayer_walks_a_cond_and_its_if_alike(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        readings = served_readings(app, {"nova": _wrapped(NOVA), "cond": _wrapped(COND)})

    nova, cond = readings["nova"], readings["cond"]
    assert _calculated(nova["doc"])["field"] != _calculated(cond["doc"])["field"]
    walk = json.dumps(nova["formplayer"])
    assert any(text.strip("'") in walk for text in SHOWN), "Formplayer's walk showed no row of the list"
    assert formplayer_differences(nova, cond) == []
    assert client_differences(nova, cond) == []
