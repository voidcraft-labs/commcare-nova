"""An advanced open action's ``repeat_context`` ``""``, and its open condition's ``question`` ``""``, or null.

Nova writes an advanced open action outside a repeat with ``repeat_context``
``""`` and a condition that is not ``if`` with ``question`` null; HQ's
advanced Case Management save writes the opposite of each
(``static/app_manager/js/forms/advanced/actions.js``, where an open action's
``repeat_context`` is ``get_repeat_context`` of its name question, nothing
for a question outside a repeat, and the open condition's question select
of ``case_config_ko_templates.html``'s ``case-config:condition`` template,
``forms/case_knockout_bindings.js::questionsSelect``, whose placeholder
option is ``""``, writes that option back to the question
``actionBase.clean_condition`` clears on a condition that is not ``if``). HQ's build
reads the repeat context only where it is true
(``xform.py::XForm._create_casexml_advanced``; ``helpers/validators.py`` and
``AdvancedFormActions.count_subcases_per_repeat_context`` are read only for a
true context) and a condition's question only where its type is ``if``
(``XForm.action_relevance``, ``AdvancedOpenCaseAction.get_paths``).

The rule makes ``""`` null for both on every open action of every form.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import forms, modules


def normalize(app):
    for module in modules(app):
        for form in forms(module):
            actions = form.get("actions")
            for action in (actions.get("open_cases") or []) if isinstance(actions, dict) else []:
                if not isinstance(action, dict):
                    continue
                if action.get("repeat_context") == "":
                    action["repeat_context"] = None
                condition = action.get("open_condition")
                if isinstance(condition, dict) and condition.get("type") != "if" and condition.get("question") == "":
                    condition["question"] = None
    return app


RULE = SpellingRule(
    "open-action-blanks",
    "app.json",
    'An advanced open action\'s repeat_context, or its open condition\'s question where the condition is not "if",'
    ' "" rather than null, which the build reads as false (xform.py::XForm._create_casexml_advanced).',
    normalize,
)
