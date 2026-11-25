"""The rule ``item-list-declarations`` is sound where it holds: HQ builds a form alike with or without an
``item-list:`` declaration its text reads, and Core runs the two builds alike.

Contract: the rule erases a lookup table's ``<instance id="item-list:<tag>" src="jr://fixture/item-list:<tag>"/>``
where the form's text reads ``instance('item-list:<tag>')``, as HQ's form builder leaves a select over a table
tagged ``ζωνες`` after a save. HQ's build declares it again (``XForm.add_missing_instances``), so the proof is
HQ's build and Core's run of it. The condition is the rule's: HQ's build declares again only an id of a scheme it
knows, so a bare declaration's absence is a form HQ refuses to build. The plausible failures: HQ's build not
declaring the dropped instance again (so a save would leave a form a device cannot load), and the rule erasing a
declaration HQ's build would not write again.

``targeted-lookup-non-ascii-names`` is published as Nova writes it, with the declaration of ``item-list:ζωνες``
taken out (the form builder's save), and with the bare ``zones_b`` declaration taken out: the first two build
alike, file for file, and Core's sessions, which answer both selects, compare equal; HQ refuses to build the
third, and the rule leaves its stored difference.
"""

from __future__ import annotations

from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    published,
    rewritten,
    runs_alike,
    shown,
    stored_differences,
)
from proof.rules.item_list_declarations import RULE

DOCUMENT = "targeted-lookup-non-ascii-names"
XF = "{http://www.w3.org/2002/xforms}"


def _without(instance_id):
    def change(root):
        found = [element for element in root.iter(f"{XF}instance") if element.get("id") == instance_id]
        assert len(found) == 1, f"the form declares {instance_id!r} {len(found)} times"
        found[0].getparent().remove(found[0])

    return change


def test_hq_declares_a_read_item_list_instance_again_and_core_runs_the_builds_alike(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_without("item-list:ζωνες"))})
        bare = app.spell(sources={"0.0": rewritten(_without("zones_b"))})
        _, _, alike = runs_alike(app, core_runner, nova.build, saved.build)

    assert_spelled(nova, saved, RULE, lambda path: "/instance[@id=item-list:ζωνες]" in path)
    assert_same_build(nova, saved)
    assert alike == [], shown(alike)
    assert bare.build.raised, "HQ built a form that reads an instance it declares nowhere"
    assert shown(stored_differences(nova.stored, bare.stored, rules=(RULE,)))
