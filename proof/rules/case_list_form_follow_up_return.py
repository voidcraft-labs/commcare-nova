"""A case list action whose form registers nothing of the list's case type: its ``post_form_workflow``
``default`` against ``case_list``.

HQ's build reads a case list action's ``post_form_workflow`` only for a form that registers exactly one case of
the list's type (``suite_xml/post_process/workflow.py::CaseListFormWorkflow.case_list_forms_frames``, which
skips any other form before ``_get_stack_frames`` reads the value), and HQ's module settings page offers such a
form only "Go back to case list", writing ``case_list`` on save (``modules/bootstrap3/module_view.js``'s
``caseListFormModel``). Nova writes ``case_list`` for a selected parent's follow-up; an app made otherwise may
hold ``default`` there.

The rule makes, in a module whose ``case_list_form`` names a form that is no registration of the module's case
type (``models/forms.py``'s ``is_registration_form``: exactly one registration action of that type), a
``post_form_workflow`` of ``default`` ``case_list``.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import forms, modules


def _registrations(form, module, case_type):
    """The registration actions of ``form`` (in ``module``) of ``case_type``, as HQ's model counts them."""
    actions = form.get("actions") if isinstance(form.get("actions"), dict) else {}
    found = 0
    if form.get("doc_type") == "AdvancedForm":
        for action in actions.get("open_cases") or []:
            if not isinstance(action, dict) or action.get("case_type") != case_type:
                continue
            subcase = bool(action.get("case_indices")) or bool(action.get("parent_tag"))
            if subcase and action.get("repeat_context"):
                continue
            found += 1
        return found
    opening = actions.get("open_case")
    if (
        form.get("requires") != "case"
        and isinstance(opening, dict)
        and (opening.get("condition") or {}).get("type") != "never"
        and module.get("case_type") == case_type
    ):
        found += 1
    for action in actions.get("subcases") or []:
        if isinstance(action, dict) and not action.get("repeat_context") and action.get("case_type") == case_type:
            found += 1
    return found


def normalize(app):
    owners = {
        form.get("unique_id"): (form, module) for module in modules(app) for form in forms(module) if form.get("unique_id")
    }
    for module in modules(app):
        action = module.get("case_list_form")
        if not isinstance(action, dict) or action.get("post_form_workflow") != "default":
            continue
        named = owners.get(action.get("form_id"))
        if named is None:
            continue
        form, owner = named
        if _registrations(form, owner, module.get("case_type")) != 1:
            action["post_form_workflow"] = "case_list"
    return app


RULE = SpellingRule(
    "case-list-form-follow-up-return",
    "app.json",
    "A case list action whose form registers nothing of the list's case type: post_form_workflow default or"
    " case_list, which HQ's build reads only for a registration (workflow.py::CaseListFormWorkflow).",
    normalize,
)
