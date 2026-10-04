"""A case search's title label that holds no text: ``{}`` or ``""`` for each language.

HQ's Case List save writes ``search_config.title_label`` with the page's
language mapped to ``""`` where no title is given
(``views/modules.py::edit_module_detail_screens``), where Nova writes
``{}``. HQ reads it through ``models/case_search.py::
CaseSearch.get_search_title_label``, which answers ``title_label.get(lang)
or ''`` and so ``""`` for both.

The rule makes ``search_config.title_label`` ``{}`` where every value it
holds is ``""``.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import blank_to_empty, modules


def normalize(app):
    for module in modules(app):
        blank_to_empty(module.get("search_config"), "title_label")
    return app


RULE = SpellingRule(
    "search-title-empty",
    "app.json",
    'A case search title label holding no text, which CaseSearch.get_search_title_label reads as ""'
    " (models/case_search.py).",
    normalize,
)
