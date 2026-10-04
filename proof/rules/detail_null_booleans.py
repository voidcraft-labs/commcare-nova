"""A case list or case detail flag left null where HQ's Case List save writes false.

``Detail.persist_case_context``, ``persist_tile_on_forms`` and
``pull_down_tile`` are ``BooleanProperty()`` with no default
(``models/case_list.py::Detail``), so Nova's app leaves them null, and HQ's
Case List save writes each one false from the page
(``views/modules.py::edit_module_detail_screens``). Every reader tests the
flag for truth: ``suite_xml/sections/details.py`` (the persistent case
context), ``suite_xml/sections/entries.py`` (the persistent context and the
pull-down tile) and ``models/case_list.py::Detail.persist_tile_on_forms``'s
own use there.

The rule makes each of the three null in every module's case list and case
detail where it is false.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import case_details, modules

_FLAGS = ("persist_case_context", "persist_tile_on_forms", "pull_down_tile")


def normalize(app):
    for module in modules(app):
        for detail in case_details(module):
            for flag in _FLAGS:
                if detail.get(flag) is False:
                    detail[flag] = None
    return app


RULE = SpellingRule(
    "detail-null-booleans",
    "app.json",
    "A detail's persist_case_context, persist_tile_on_forms or pull_down_tile null rather than false, which every"
    " reader tests for truth (suite_xml/sections/details.py, entries.py).",
    normalize,
)
