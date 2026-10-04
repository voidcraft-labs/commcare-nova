"""A module with no registration form from its case list: ``case_list_form.form_id`` ``""`` or null, and the
label of that absent action holding no text.

HQ's module settings save writes ``case_list_form.form_id`` ``""`` where no
form is chosen, and the action's label from the page's field, ``""`` for the
page's language (``views/modules.py::edit_module_attr``), where Nova writes
a null id and ``{}`` (its media maps are ``empty_media_maps``'). Every
reader of the id reads it as true or false
(``app_strings.py::_create_case_list_form_app_strings``, the suite's
``sections/details.py`` and ``features/case_tiles.py``, ``add_ons.py``,
``helpers/validators.py::ModuleBaseValidator.validate_case_list_form``),
and the label is read only where the id is set (the app strings write it
under that guard, ``sections/details.py::DetailContributor.
add_register_action`` reads the action only there).

The rule makes, in a module whose ``case_list_form.form_id`` is ``""`` or
null, the id null, and its ``label`` ``{}`` where it holds no text.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import blank_to_empty, modules


def normalize(app):
    for module in modules(app):
        action = module.get("case_list_form")
        if not isinstance(action, dict) or action.get("form_id") not in (None, ""):
            continue
        if "form_id" in action:
            action["form_id"] = None
        blank_to_empty(action, "label")
    return app


RULE = SpellingRule(
    "case-list-form-unset",
    "app.json",
    'An unset case list registration form: form_id "" or null, with a label holding no text, neither of which'
    " HQ reads without a form id (app_strings.py, suite_xml/sections/details.py).",
    normalize,
)
