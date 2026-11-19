"""A form action condition's ``operator`` null, which HQ reads as ``=``.

HQ's Case Management page writes the ``operator`` of each condition it saves
null where the condition is not ``if``
(``static/app_manager/js/forms/case_config_ui.js::cleanCondition``), and an
app Nova published before its export wrote ``=`` holds it null on every such
condition; a form HQ creates, and Nova's export, hold ``=``, the property's
default (``models/form_actions.py::FormActionCondition.operator``). The one reader
of the operator, ``xform.py::XForm.action_relevance``, tests it for
``selected`` and ``boolean_true`` and writes the ``=`` comparison for
anything else, null included.

The rule makes a null ``operator`` ``=`` on every condition of a form's
actions (each action's ``condition`` and ``close_condition``, its subcases'
included).
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import forms, modules

_CONDITION_KEYS = ("condition", "close_condition", "open_condition")


def _conditions(value):
    if isinstance(value, dict):
        for key, inner in value.items():
            if key in _CONDITION_KEYS and isinstance(inner, dict):
                yield inner
            yield from _conditions(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from _conditions(inner)


def normalize(app):
    for module in modules(app):
        for form in forms(module):
            for condition in _conditions(form.get("actions")):
                if "operator" in condition and condition["operator"] is None:
                    condition["operator"] = "="
    return app


RULE = SpellingRule(
    "condition-operator-default",
    "app.json",
    'A form action condition\'s operator null, which XForm.action_relevance reads as "=" (xform.py).',
    normalize,
)
