"""The rule ``case-list-form-follow-up-return`` is sound: HQ builds a follow-up's case list action alike whichever
return it stores.

Contract: the rule erases, on a module whose case list action names a form that registers nothing of the
module's case type, ``post_form_workflow`` ``default`` against ``case_list``. The plausible failures: HQ's build
reading the value for such a form (so the module settings save, which writes ``case_list``, would change the
build), and the rule erasing the return of a registration form, which HQ's build writes into the form's stack.

``case-list-action-basic``'s "Existing members" list offers the chosen household's follow-up, published as Nova
writes it (``case_list``) and stored as ``default``: HQ builds both alike and the rule erases the difference; a
registration form's ``default`` stays.
"""

from __future__ import annotations

from proof.rules.case_list_form_follow_up_return import RULE, normalize
from proof.rules.conftest import assert_same_build, assert_spelled, edited, published

DOCUMENT = "case-list-action-basic"
# The members list that offers the household's own follow-up ("Edit household"), as HQ numbers the modules.
FOLLOW_UP_LIST = 2


def _stored_returning_to_a_new_case(doc):
    doc["modules"][FOLLOW_UP_LIST]["case_list_form"]["post_form_workflow"] = "default"


def test_hq_builds_a_follow_ups_list_action_alike_whichever_return_it_stores(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        action = nova.stored["doc"]["modules"][FOLLOW_UP_LIST]["case_list_form"]
        assert action["post_form_workflow"] == "case_list", action
        stored = app.spell(doc=edited(_stored_returning_to_a_new_case))

    assert_spelled(nova, stored, RULE, lambda path: path == "/modules/*/case_list_form/post_form_workflow")
    assert_same_build(nova, stored)


def test_a_registration_forms_return_is_left():
    registration = {
        "unique_id": "reg",
        "doc_type": "Form",
        "requires": "none",
        "actions": {"open_case": {"condition": {"type": "always"}}},
    }
    app = {
        "modules": [
            {"case_type": "patient", "forms": [registration]},
            {"case_type": "patient", "forms": [], "case_list_form": {"form_id": "reg", "post_form_workflow": "default"}},
        ]
    }
    assert normalize(app)["modules"][1]["case_list_form"]["post_form_workflow"] == "default"
