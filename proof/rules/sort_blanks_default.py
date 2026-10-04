"""A case list sort's ``blanks`` left to its default, where the default is what HQ's page writes.

Nova writes a sort element's ``blanks`` ``""``; HQ's Case List save writes
``first`` for an ascending sort and ``last`` for any other
(``static/app_manager/js/details/bootstrap3/sort_rows.js``: ``params.blanks
|| (params.direction === "descending" ? "last" : "first")``), and HQ's
build writes the element's ``blanks`` into the suite's ``<sort>`` as it is
(``detail_screen.py::FormattedDetailColumn.sort_node``). Core reads a
sort's ``blanks`` as ``last``, ``first``, or else the default for its
direction, blanks last unless the direction is ``ascending``
(commcare-core ``DetailFieldParser.parseBlanksPreference``).

The rule writes the default for its direction as ``""``: in HQ's app
document a sort element's ``blanks`` ``first`` where its ``direction`` is
``ascending`` and ``last`` where it is not; in a suite (``suite.xml``, a
build profile's too) a ``<sort>``'s ``blanks`` attribute where it is ``""``
or that default, which the rule removes.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import case_details, modules


def _default(direction):
    return "first" if direction == "ascending" else "last"


def _app(app):
    for module in modules(app):
        for detail in case_details(module):
            for element in detail.get("sort_elements") or []:
                if isinstance(element, dict) and element.get("blanks") == _default(element.get("direction")):
                    element["blanks"] = ""
    return app


def _suite(root):
    for sort in root.iter("sort"):
        blanks = sort.get("blanks")
        if blanks is not None and blanks in ("", _default(sort.get("direction"))):
            del sort.attrib["blanks"]
    return root


def normalize(parsed):
    if isinstance(parsed, dict):
        return _app(parsed)
    if isinstance(getattr(parsed, "tag", None), str) and parsed.tag == "suite":
        return _suite(parsed)
    return parsed


RULE = SpellingRule(
    "sort-blanks-default",
    ("app.json", "suite.xml", "*/suite.xml"),
    "A sort's blanks left to its direction's default, which Core reads as the default"
    " (DetailFieldParser.parseBlanksPreference).",
    normalize,
)
