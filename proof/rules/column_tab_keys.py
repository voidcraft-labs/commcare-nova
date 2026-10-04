"""``nodesetCaseType`` and ``nodesetFilter`` on a detail column, keys of the page's tab model that no reader has.

HQ's Case List and Case Detail pages write every column with the keys of
their tab model, ``nodesetCaseType`` (``""`` or the screen's first child case
type) and ``nodesetFilter`` (``""``) (``static/app_manager/js/details/
bootstrap3/column.js``, ``tabDefaults``, and its bootstrap5 twin), and the
save stores the column as the page sends it.
``DetailColumn`` declares neither (``models/case_list.py::DetailColumn``,
whose wrap keeps them as dynamic properties) and no Python of HQ reads them
on a column: a tab's node set is read from ``DetailTab``
(``nodeset_case_type``, ``nodeset_filter``).

The rule removes both keys from every column of every module's case list
and case detail.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import case_details, modules

_KEYS = ("nodesetCaseType", "nodesetFilter")


def normalize(app):
    for module in modules(app):
        for detail in case_details(module):
            for column in detail.get("columns") or []:
                if isinstance(column, dict):
                    for key in _KEYS:
                        column.pop(key, None)
    return app


RULE = SpellingRule(
    "column-tab-keys",
    "app.json",
    "A detail column's nodesetCaseType and nodesetFilter, which DetailColumn does not declare and nothing reads"
    " (models/case_list.py::DetailColumn).",
    normalize,
)
