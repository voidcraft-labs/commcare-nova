"""The rule ``inactive-parent-select`` is sound where it holds: the parent module is unread while the selection
is off.

Contract: the rule erases ``parent_select.module_id`` where
``parent_select.active`` is off, as the Case List save fills it in. The
condition is the rule's: an active selection reads the module. The
plausible failures: a reader of the id that does not test ``active`` first
(so the save would change the build), and the rule erasing the id of an
active selection.

A corpus document with several modules is published with an inactive
selection's id null (Nova's), ``""`` and another module's id (the save's):
HQ builds all alike and the rule erases the differences. Its child module's
active selection builds with its parent module's id and fails to build with
``""``, and the rule leaves that id.
"""

from __future__ import annotations

from proof.rules.conftest import assert_same_build, assert_spelled, edited, published, shown, stored_differences
from proof.rules.inactive_parent_select import RULE

DOCUMENT = "nested-menu-parent"


def _inactive_module(doc):
    return next(index for index, module in enumerate(doc["modules"]) if not module["parent_select"].get("active"))


def _module_id(value_of):
    def change(doc):
        index = _inactive_module(doc)
        doc["modules"][index]["parent_select"]["module_id"] = value_of(doc, index)

    return edited(change)


def _active_module_id(value):
    def change(doc):
        selection = next(module["parent_select"] for module in doc["modules"] if module["parent_select"]["active"])
        assert selection["module_id"], "the active selection names no module"
        selection["module_id"] = value

    return edited(change)


def test_an_inactive_selections_module_is_unread(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=_module_id(lambda doc, index: None))
        blank = app.spell(doc=_module_id(lambda doc, index: ""))
        other = app.spell(
            doc=_module_id(lambda doc, index: next(m["unique_id"] for i, m in enumerate(doc["modules"]) if i != index))
        )
        active_blank = app.spell(doc=_active_module_id(""))

    for saved in (blank, other):
        assert_spelled(nova, saved, RULE, lambda path: path == "/modules/*/parent_select/module_id")
        assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, active_blank.stored, rules=(RULE,)))
    # HQ's build looks the module up (suite_xml/utils.py::get_select_chain_with_sessions) and finds none.
    assert active_blank.build.raised and not nova.build.raised, (nova.build.raised, active_blank.build.raised)
