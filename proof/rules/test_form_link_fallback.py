"""The rule ``form-link-fallback`` is sound: HQ builds a form's fallback ``""`` as null.

Contract: the rule erases ``post_form_workflow_fallback`` ``""`` against
null, as the form settings save writes it. The plausible failures: the
suite telling ``""`` from null on a form with links (so the save would
change the stack), and the rule erasing a chosen fallback, which the suite
builds as a frame.

A corpus document whose registration form links to other forms is published
with those links made conditional (HQ builds a fallback only where a link
has a condition, ``workflow.py::_get_fallback_frame``) and the form's
fallback null (Nova's), ``""`` (the save's) and the module menu: the first
two build alike and the rule erases their difference; the module fallback
builds another stack, which the rule leaves.
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
from proof.rules.form_link_fallback import RULE

DOCUMENT = "case-extension-registration"


def _fallback(value):
    def change(doc):
        form = doc["modules"][0]["forms"][0]
        assert form.get("form_links"), "the form links to no form"
        form["post_form_workflow"] = "form"
        for link in form["form_links"]:
            link["xpath"] = "count(/data/meta) = 1"
        form["post_form_workflow_fallback"] = value

    return edited(change)


def test_hq_builds_a_blank_fallback_as_none(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=_fallback(None))
        saved = app.spell(doc=_fallback(""))
        module = app.spell(doc=_fallback("module"))

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/post_form_workflow_fallback"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, module.stored, rules=(RULE,)))
    assert build_differences(nova.build, module.build), "HQ builds a module fallback as no fallback"
