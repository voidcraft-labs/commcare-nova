"""An advanced action's close condition's ``question`` ``""``, or null, where the condition is not ``if``.

Nova writes the close condition of an advanced load or open action that is
not ``if`` with ``question`` null. HQ's advanced Case Management save writes
``""`` there wherever the page shows the condition: an action's close
condition is shown while the action closes its case (its type not
``never``, ``static/app_manager/js/forms/advanced/actions.js::close_case``),
and its question select, of ``case_config_ko_templates.html``'s
``case-config:condition`` template
(``forms/case_knockout_bindings.js::questionsSelect``), whose placeholder
option is ``""``, writes that option back to the question
``actionBase.clean_condition`` clears on a condition that is not ``if``. HQ
reads a condition's question only where its type is ``if``: the build
(``xform.py::XForm.action_relevance``), the paths an action reads
(``models/form_actions.py::AdvancedAction.get_paths``) and the app case
summary, which keeps a closing condition only where it is ``if``
(``app_schemas/app_case_metadata.py::CaseTypeMeta.add_closer``). The form
summary's comparison of two versions compares no close condition
(``app_schemas/form_metadata.py::FORM_ATTRIBUTES``).

The rule makes ``""`` null for the close condition of every load and open
action of every form, where the condition is not ``if``.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import forms, modules

_ADVANCED_ACTIONS = ("load_update_cases", "open_cases")


def normalize(app):
    for module in modules(app):
        for form in forms(module):
            actions = form.get("actions")
            if not isinstance(actions, dict):
                continue
            for kind in _ADVANCED_ACTIONS:
                for action in actions.get(kind) or []:
                    condition = action.get("close_condition") if isinstance(action, dict) else None
                    if (
                        isinstance(condition, dict)
                        and condition.get("type") != "if"
                        and condition.get("question") == ""
                    ):
                        condition["question"] = None
    return app


RULE = SpellingRule(
    "close-question-blank",
    "app.json",
    'An advanced action\'s close condition\'s question "" rather than null where the condition is not "if",'
    " which the build never reads (xform.py::XForm.action_relevance).",
    normalize,
)
