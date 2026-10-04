"""The rule ``case-list-form-unset`` is sound: HQ builds an unset registration action alike in either spelling.

Contract: the rule erases, on a module with no registration form from its
case list, ``case_list_form.form_id`` ``""`` against null and a label
holding no text. The plausible failures: a reader telling ``""`` from null
(so the module settings save would change the build), and the rule erasing
the label of an action whose form is set, which HQ's app strings write.

A corpus document is published with its module's ``case_list_form`` as Nova
writes it and as the module settings save writes it: HQ builds both alike
and the rule erases the difference; a set form's label stays.
"""

from __future__ import annotations

from proof.rules.case_list_form_unset import RULE, normalize
from proof.rules.conftest import assert_same_build, assert_spelled, edited, published

DOCUMENT = "arithmetic"


def _as_the_save_writes(doc):
    action = doc["modules"][0]["case_list_form"]
    action["form_id"] = ""
    action["label"] = {lang: "" for lang in doc["langs"]}


def test_hq_builds_an_unset_registration_action_alike(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        assert not nova.stored["doc"]["modules"][0]["case_list_form"].get("form_id")
        saved = app.spell(doc=edited(_as_the_save_writes))

    assert_spelled(nova, saved, RULE, lambda path: path.startswith("/modules/*/case_list_form/"))
    assert_same_build(nova, saved)


def test_a_set_forms_label_is_left():
    doc = {"modules": [{"case_list_form": {"form_id": "form-a", "label": {"en": ""}}}]}
    assert normalize(doc)["modules"][0]["case_list_form"] == {"form_id": "form-a", "label": {"en": ""}}
