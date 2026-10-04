"""A subcase action's ``reference_id`` and ``repeat_context`` ``""`` or null.

Nova writes a subcase's ``reference_id`` and ``repeat_context`` ``""``; HQ's
Case Management save writes null for both
(``static/app_manager/js/forms/case_config_ui.js``, where a subcase's
``reference_id`` is ``o.reference_id || null`` and its repeat context is
computed by ``get_repeat_context``, nothing for a question outside a
repeat). HQ's build reads the index name as
``subcase.reference_id or 'parent'`` and the repeat context only where it
is true (``xform.py::XForm._create_casexml``; ``FormActions.
count_subcases_per_repeat_context`` is read only for a true context).

The rule makes ``""`` null for both on every subcase of every form.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import forms, modules

_KEYS = ("reference_id", "repeat_context")


def normalize(app):
    for module in modules(app):
        for form in forms(module):
            actions = form.get("actions")
            for subcase in (actions.get("subcases") or []) if isinstance(actions, dict) else []:
                if isinstance(subcase, dict):
                    for key in _KEYS:
                        if subcase.get(key) == "":
                            subcase[key] = None
    return app


RULE = SpellingRule(
    "subcase-empty-strings",
    "app.json",
    'A subcase\'s reference_id or repeat_context "" rather than null, which the build reads as false'
    " (xform.py::XForm._create_casexml).",
    normalize,
)
