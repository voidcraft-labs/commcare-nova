"""A case list sort's type ``string`` or ``plain``, which HQ builds as one sort type.

Nova writes a text sort's ``type`` ``string``; HQ's Case List save writes
``plain``, the page's name for it (``static/app_manager/js/details/
bootstrap3/sort_rows.js`` offers ``plain`` for a text sort). HQ's build maps ``plain`` (and ``date``) to the suite's
sort type ``string`` and writes any other type as it is
(``detail_screen.py::FormattedDetailColumn.sort_node``), so both build
``type="string"``; no other reader distinguishes them.

The rule makes a sort element's ``type`` ``string`` where it is ``plain``.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import case_details, modules


def normalize(app):
    for module in modules(app):
        for detail in case_details(module):
            for element in detail.get("sort_elements") or []:
                if isinstance(element, dict) and element.get("type") == "plain":
                    element["type"] = "string"
    return app


RULE = SpellingRule(
    "sort-type-plain",
    "app.json",
    "A sort element's type plain rather than string, both built as the suite's string"
    " (detail_screen.py::FormattedDetailColumn.sort_node).",
    normalize,
)
