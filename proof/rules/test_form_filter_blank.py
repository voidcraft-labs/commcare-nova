"""The rule ``form-filter-blank`` is sound: HQ builds a form's ``form_filter`` ``""`` as null.

Contract: the rule erases a form's ``form_filter`` ``""`` against null, as
the form settings save writes it wherever the page shows the Display
Condition field. The plausible failures: HQ's build telling ``""`` from null
(so the save would change the form's menu command), and the rule erasing a
display condition, which HQ builds into the command.

A corpus document whose advanced registration has no display condition is
published with ``form_filter`` as Nova writes it (null) and as the save
writes it (``""``): HQ stores the ``""`` (an advanced form's field keeps
it), builds both alike, and the rule erases the difference; a display
condition there builds the command's relevance, which the rule leaves.
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
from proof.rules.form_filter_blank import RULE

DOCUMENT = "targeted-advanced-module"
# Its Patients menu's registration, an advanced form with no display condition.
MODULE, FORM = 1, 0


def _filter(value):
    def change(doc):
        form = doc["modules"][MODULE]["forms"][FORM]
        assert form["doc_type"] == "AdvancedForm" and form["form_filter"] is None, form.get("form_filter")
        form["form_filter"] = value

    return edited(change)


def test_hq_builds_a_blank_form_filter_as_none(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        saved = app.spell(doc=_filter(""))
        shown_always = app.spell(doc=_filter("true()"))

    assert_spelled(nova, saved, RULE, lambda path: path.endswith("/form_filter"))
    assert_same_build(nova, saved)
    assert shown(stored_differences(nova.stored, shown_always.stored, rules=(RULE,)))
    assert build_differences(nova.build, shown_always.build), "HQ builds a display condition into the command"
