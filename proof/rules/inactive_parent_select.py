"""The module a case list's parent selection would read, while the selection is off.

HQ's Case List save fills ``parent_select.module_id`` from the page, ``""``
or the first module that can be a parent
(``static/app_manager/js/details/parent_select.js``, ``self.moduleId``),
while ``parent_select.active`` stays false, where Nova writes null. Every
reader of the module id tests ``active`` before it reads it:
``suite_xml/utils.py``, ``suite_xml/sections/entries.py``,
``suite_xml/post_process/remote_requests.py`` (through
``util.py::module_uses_inline_search_with_parent_relationship_parent_select``),
``app_schemas/casedb_schema.py`` and ``app_schemas/session_schema.py``.

The rule removes ``module_id`` from a module's ``parent_select`` whose
``active`` is not true.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import modules


def normalize(app):
    for module in modules(app):
        selection = module.get("parent_select")
        if isinstance(selection, dict) and selection.get("active") is not True:
            selection.pop("module_id", None)
    return app


RULE = SpellingRule(
    "inactive-parent-select",
    "app.json",
    "parent_select.module_id while the selection is off, which every reader reads only when it is on"
    " (suite_xml/utils.py, sections/entries.py).",
    normalize,
)
