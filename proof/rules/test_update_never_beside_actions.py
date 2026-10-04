"""The rule ``update-never-beside-actions`` is sound where it holds: an empty update builds alike under ``never``
and ``always`` on a form whose other actions make its case block either way.

Contract: the rule erases ``update_case`` ``always`` against ``never`` on a
basic form whose update holds nothing, where the form opens a case, has
another action active, or sits in a module that selects several cases. The
condition is the rule's: on a follow-up whose only action the update is,
``always`` adds a case block that touches the case (defect 14). The
plausible failures: the build telling the two apart where the rule holds
(so the Case Management save would change the build), and the rule erasing
the non-writing follow-up's rewrite.

Both sides: a registration form (it opens a case), a follow-up with
subcases, and a follow-up whose only action is the empty update in a module
that selects several cases (a top-level module, and a child module under
another) build alike under ``never`` (Nova's) and ``always`` (the save's),
and the rule erases the difference; a follow-up whose only action is the
empty update in a module that selects one case builds a case block under
``always`` alone, and the rule leaves it.
"""

from __future__ import annotations

from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    build_differences,
    edited,
    published,
    shown,
    stored_differences,
)
from proof.rules.update_never_beside_actions import RULE

# Each document where the rule holds, by the module whose first form's update is spelled both ways.
ALIKE = {
    # It opens a case.
    "case-extension-registration": 0,
    # A follow-up with subcases.
    "case-capture-repeat": 0,
    # A follow-up whose only action is the update, in a module that selects several cases, at the top level and
    # as a child module.
    "case-capture-multiple": 0,
    "nested-menu-same-multiple": 1,
}
NON_WRITING_FOLLOWUP = "arithmetic"


def _update(kind, module):
    def change(doc):
        update = doc["modules"][module]["forms"][0]["actions"]["update_case"]
        assert not update.get("update"), "the form's update writes a property"
        update["condition"]["type"] = kind

    return edited(change)


def _never_and_always(document, core_runner, module=0):
    with published(document, core_runner) as app:
        return app.spell(doc=_update("never", module)), app.spell(doc=_update("always", module))


def test_an_empty_update_beside_other_actions_builds_alike(rule_documents, hq, core_runner):
    for name, module in ALIKE.items():
        nova, saved = _never_and_always(rule_documents[name], core_runner, module)
        assert_spelled(nova, saved, RULE, lambda path: path.endswith("/update_case/condition/type"))
        assert_same_build(nova, saved)


def test_a_non_writing_followups_update_is_left(rule_documents, hq, core_runner):
    nova, saved = _never_and_always(rule_documents[NON_WRITING_FOLLOWUP], core_runner)
    assert shown(stored_differences(nova.stored, saved.stored, rules=(RULE,)))
    touched = shown(build_differences(nova.build, saved.build))
    assert any("case" in path for _, path, _ in touched), touched
