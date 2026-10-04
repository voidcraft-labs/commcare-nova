"""A form's empty ``update_case`` under ``never`` or ``always``, where the form builds the same case block either way.

Nova writes ``update_case`` ``never`` on a form whose update writes no
property; HQ's Case Management save writes ``always``
(``static/app_manager/js/forms/case_config_ui.js``,
``HQFormActions.from_case_transaction``). HQ's build reads the condition
only through the form's active actions (``models/forms.py::
Form.active_actions``): ``always`` makes ``update_case`` one of them, and
an empty update adds nothing to a case block (``xform.py::XForm.
_add_case_updates`` adds an update only for the properties it is given).
So the two build alike exactly where the active actions make the same case
block either way (``xform.py::XForm._create_casexml``):

- a form that opens a case (``open_case`` active): its case block exists
  either way, and an update holding nothing adds nothing to it;
- a follow-up (``requires`` ``case``) with another action active by HQ's own
  test (``close_case`` or ``usercase_update`` with an ``if`` or ``always``
  condition, a ``case_preload``, ``usercase_preload`` or ``load_from_form``
  with a question, or any subcase: ``Form._get_active_actions``): its case
  block exists either way;
- a follow-up in a module that selects several cases
  (``case_details.short.multi_select``) and shows no task list: its module
  has no default case management, so the case block the update asks for is
  never written (``Module.is_multi_select``; a task list would add its
  delegation stub to it).

Elsewhere they differ: a follow-up whose only action the update is gets a
case block that touches its case under ``always`` and none under ``never``
(defect 14's non-writing follow-up), and a survey that opens no case refuses
``always`` (``CaseError``). The rule leaves those.

The rule makes ``always`` ``never`` on a basic form's ``update_case`` whose
``update`` and ``conflicts`` are empty, where one of the three holds.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import forms, modules

# HQ's action types for a form's ``requires`` (``models/forms.py::Form.active_actions``), but ``update_case``.
_TYPES = {
    "none": ("open_case", "close_case", "subcases", "usercase_update", "usercase_preload"),
    "case": ("close_case", "case_preload", "subcases", "usercase_update", "usercase_preload", "load_from_form"),
}
_LEGACY = ("open_case", "close_case", "case_preload", "subcases", "usercase_update", "usercase_preload")
_PRELOADS = frozenset({"case_preload", "usercase_preload", "load_from_form"})


def _condition_active(action):
    condition = action.get("condition") if isinstance(action, dict) else None
    return isinstance(condition, dict) and condition.get("type") in ("if", "always")


def _active(actions, name):
    """Whether HQ counts the action ``name`` active (``models/form_actions.py``'s ``is_active``)."""
    action = actions.get(name)
    if name == "subcases":
        return bool(action)
    if name in _PRELOADS:
        return isinstance(action, dict) and bool(action.get("preload"))
    return _condition_active(action)


def _same_case_block(module, form, actions):
    requires = form.get("requires")
    if _condition_active(actions.get("open_case")) and requires != "case":
        return True
    if requires == "none":
        return False
    others = _TYPES.get(requires, _LEGACY)
    if any(_active(actions, name) for name in others):
        return True
    short = (module.get("case_details") or {}).get("short") or {}
    task_list = module.get("task_list") or {}
    return requires == "case" and short.get("multi_select") is True and task_list.get("show") is not True


def normalize(app):
    for module in modules(app):
        if module.get("doc_type") not in (None, "Module"):
            continue
        for form in forms(module):
            if form.get("doc_type") not in (None, "Form"):
                continue
            actions = form.get("actions")
            update = actions.get("update_case") if isinstance(actions, dict) else None
            condition = update.get("condition") if isinstance(update, dict) else None
            if not isinstance(condition, dict) or condition.get("type") != "always":
                continue
            if update.get("update") or update.get("conflicts"):
                continue
            if _same_case_block(module, form, actions):
                condition["type"] = "never"
    return app


RULE = SpellingRule(
    "update-never-beside-actions",
    "app.json",
    "An empty update_case under never or always on a form whose active actions make one case block either way"
    " (xform.py::XForm._create_casexml).",
    normalize,
)
