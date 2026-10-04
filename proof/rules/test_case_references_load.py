"""The rule ``case-references-load`` is sound: HQ builds a form alike whatever its ``case_references_data.load``.

Contract: the rule erases a form's case load references, which only HQ's
app summary reads. The plausible failures: a build step reading them (so a
Vellum save, which rewrites them, would change the build), and the rule
erasing the ``save`` references, which HQ's build and validators read.

A corpus document whose form lists case load references is published, and
the form's ``load`` is stored as Nova writes it, emptied, and holding a
reference Nova does not list: HQ's three builds are the same; the rule
erases the stored differences; a changed ``save`` is left.
"""

from __future__ import annotations

from proof.rules.case_references_load import RULE
from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    edited,
    published,
    shown,
    stored_differences,
)

DOCUMENT = "nested-menu-parent"
FORM = (1, 0)


def _references(doc):
    m, f = FORM
    return doc["modules"][m]["forms"][f]["case_references_data"]


def test_hq_builds_alike_whatever_a_forms_case_load_references(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        assert _references(nova.stored["doc"]).get("load"), "the form lists no load references to vary"
        emptied = app.spell(doc=edited(lambda doc: _references(doc).update(load={})))
        widened = app.spell(
            doc=edited(lambda doc: _references(doc)["load"].update({"/data/unlisted": ["#case/unlisted"]}))
        )
        saved = app.spell(
            doc=edited(
                lambda doc: _references(doc).update(
                    save={"/data/unlisted": {"case_type": "patient", "properties": ["unlisted"]}}
                )
            )
        )

    for other in (emptied, widened):
        assert_spelled(nova, other, RULE, lambda path: path.startswith("/modules/*/forms/*/case_references_data/load"))
        assert_same_build(nova, other)
    assert shown(stored_differences(nova.stored, saved.stored, rules=(RULE,)))
