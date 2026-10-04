"""A case list's callout result header and template while the list shows no callout results.

Under ``CASE_LIST_LOOKUP`` HQ's Case List save writes
``lookup_field_header`` (``""`` for the page's language) and
``lookup_field_template`` (``@case_id``) from the page
(``views/modules.py::edit_module_detail_screens``, ``case_list_lookup``).
HQ reads both only where ``lookup_display_results`` is true: the callout's
result column in the suite (``suite_xml/sections/details.py``) and its
header in the app strings (``app_strings.py``) are written under that test
alone.

The rule removes both keys from a module's case list and case detail whose
``lookup_display_results`` is not true.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import case_details, modules

_KEYS = ("lookup_field_header", "lookup_field_template")


def normalize(app):
    for module in modules(app):
        for detail in case_details(module):
            if detail.get("lookup_display_results") is True:
                continue
            for key in _KEYS:
                detail.pop(key, None)
    return app


RULE = SpellingRule(
    "lookup-fields-unshown",
    "app.json",
    "A case list's lookup_field_header and lookup_field_template while lookup_display_results is off, which HQ"
    " reads only when it is on (suite_xml/sections/details.py, app_strings.py).",
    normalize,
)
