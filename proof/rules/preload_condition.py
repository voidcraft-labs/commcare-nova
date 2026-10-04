"""A preload action's condition ``never`` or ``always``, which HQ does not read.

Nova writes ``case_preload``'s condition ``never``; HQ's Case Management save
writes ``always``, the update action's condition, for it
(``static/app_manager/js/forms/case_config_ui.js``,
``HQFormActions.from_case_transaction``). A preload action is
active where its map holds a question, whatever its condition
(``models/form_actions.py::PreloadAction.is_active``), and the build reads
it as active or not (``models/forms.py::Form.active_actions``,
``xform.py::XForm._create_casexml``, ``add_case_preloads``); the condition
is read for a question only where its type is ``if``
(``FormAction.get_action_paths``), which neither spelling is.

The rule makes the condition type ``never`` where it is ``always`` on a
form's ``case_preload``, ``usercase_preload`` and ``load_from_form``.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import forms, modules

_PRELOADS = ("case_preload", "usercase_preload", "load_from_form")


def normalize(app):
    for module in modules(app):
        for form in forms(module):
            actions = form.get("actions")
            if not isinstance(actions, dict):
                continue
            for name in _PRELOADS:
                condition = (actions.get(name) or {}).get("condition") if isinstance(actions.get(name), dict) else None
                if isinstance(condition, dict) and condition.get("type") == "always":
                    condition["type"] = "never"
    return app


RULE = SpellingRule(
    "preload-condition",
    "app.json",
    "A preload action's condition never or always, which PreloadAction.is_active does not read"
    " (models/form_actions.py).",
    normalize,
)
