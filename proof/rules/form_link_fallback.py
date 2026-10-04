"""A form's ``post_form_workflow_fallback`` ``""`` or null: no fallback either way.

HQ's form settings save writes ``post_form_workflow_fallback`` from the
page, ``""`` where none is chosen (``views/forms.py::edit_form_attr``),
where Nova writes null. HQ reads it once, as true or false, to add the
fallback frame (``suite_xml/post_process/workflow.py``,
``if form.post_form_workflow_fallback``).

The rule makes ``""`` null on every form.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import forms, modules


def normalize(app):
    for module in modules(app):
        for form in forms(module):
            if form.get("post_form_workflow_fallback") == "":
                form["post_form_workflow_fallback"] = None
    return app


RULE = SpellingRule(
    "form-link-fallback",
    "app.json",
    'A form\'s post_form_workflow_fallback "" rather than null, which the suite reads as true or false'
    " (suite_xml/post_process/workflow.py).",
    normalize,
)
