"""The rule ``add-ons`` is sound: HQ builds the app alike whatever its ``add_ons`` hold.

Contract: the rule erases the app's add-on switches, which only HQ's
app-manager pages read. The plausible failures: a build step or validator
reading an add-on (so the add-ons save, which writes every switch the page
shows, would change the build), and the rule erasing anything beside
``add_ons``.

A corpus document is published with its ``add_ons`` as Nova writes them, as
HQ's add-ons save writes them (every slug the page shows, those Nova leaves
out ``false``, ``advanced_itemsets`` off), with every switch inverted, and
with none: HQ's builds are the same, and the rule erases the stored
differences; a changed app name is left.
"""

from __future__ import annotations

from proof.rules.add_ons import RULE
from proof.rules.conftest import assert_same_build, assert_spelled, edited, published, shown, stored_differences

DOCUMENT = "arithmetic"
SHOWN_SLUGS = ("menu_mode", "submenus", "empty_case_lists")


def _as_the_page_saves(doc):
    for slug in SHOWN_SLUGS:
        doc["add_ons"].setdefault(slug, False)
    doc["add_ons"]["advanced_itemsets"] = False


def test_hq_builds_alike_whatever_the_apps_add_ons(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        assert nova.stored["doc"].get("add_ons"), "the app holds no add-ons to vary"
        page = app.spell(doc=edited(_as_the_page_saves))
        inverted = app.spell(doc=edited(lambda doc: doc.update(add_ons={k: not v for k, v in doc["add_ons"].items()})))
        none = app.spell(doc=edited(lambda doc: doc.update(add_ons={})))
        renamed = app.spell(doc=edited(lambda doc: doc.update(name=f"{doc['name']} renamed")))

    for other in (page, inverted, none):
        assert_spelled(nova, other, RULE, lambda path: path.startswith("/add_ons"))
        assert_same_build(nova, other)
    assert shown(stored_differences(nova.stored, renamed.stored, rules=(RULE,)))
