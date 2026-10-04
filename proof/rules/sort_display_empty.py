"""A case list sort's display text that holds no text: ``{}`` or ``""`` for each language.

HQ's Case List save writes each sort element's ``display`` with the page's
language mapped to ``""`` where no text is given (``views/modules.py::
_update_sort_elements``), where Nova writes ``{}``. HQ reads a sort's display
only through ``models/case_list.py::SortElement.has_display_values``, which
is false for both: the sort-only column's header in the app strings
(``app_strings.py``) and in the suite (``detail_screen.py::Invisible.header``)
are written only where it is true.

The rule makes a sort element's ``display`` ``{}`` where every value it
holds is ``""``.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import blank_to_empty, case_details, modules


def normalize(app):
    for module in modules(app):
        for detail in case_details(module):
            for element in detail.get("sort_elements") or []:
                blank_to_empty(element, "display")
    return app


RULE = SpellingRule(
    "sort-display-empty",
    "app.json",
    "A sort element's display holding no text, which SortElement.has_display_values reads as none"
    " (models/case_list.py).",
    normalize,
)
