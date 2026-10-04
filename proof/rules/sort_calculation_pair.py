"""A calculated column's sort spelled by its own expression rather than through HQ's calculated property.

Nova writes a sort on a calculated column (a sort element whose ``field`` is
``_cc_calculated_<i>``, naming column ``i``) with ``sort_calculation`` set;
without ``SORT_CALCULATION_IN_CASE_LIST`` HQ's Case List save clears it
(``views/modules.py::_update_sort_elements`` copies it only under that
flag). HQ's build then sorts as follows
(``detail_screen.py::FormattedDetailColumn.sort_node``; the element finds
its column through ``util.py::get_sort_and_sort_only_columns``):

- a column whose format gives its own sort expression (``date``,
  ``time-ago``, ``distance``, and ``enum`` with ``conditional-enum``,
  ``enum-image``, ``translatable-enum`` and ``clickable-icon``) sorts by
  that expression, and ``sort_calculation`` is not read;
- any other sorts by ``sort_calculation`` where it is set, and otherwise by
  the column's display expression (``xpath_function``), which is the
  format's ``XPATH_FUNCTION`` with ``$calculated_property`` for the
  column's own expression: ``{xpath}`` itself for every format but
  ``image`` (``cc_case_image``) and ``late-flag`` (an ``if`` over it), the
  formats whose class writes another (``Image``, ``LateFlag``; a format no
  class registers is ``FormattedDetailColumn``'s, ``get_class_for_format``).
  ``$calculated_property`` is a variable holding the column's own expression
  (``_calculated_property``), with a ``lang`` variable inside it where that
  expression names ``$lang``, which a sort by ``sort_calculation`` is never
  given. A sort of type ``distance`` replaces either expression with
  ``Distance.SORT_XPATH_FUNCTION`` over ``$calculated_property``, which
  only the sort without a calculation is given. So where the format's
  display expression is ``{xpath}``, the column's expression names no
  ``$lang``, the sort's type is not ``distance``, and ``sort_calculation``
  is that same expression, the suite's ``<sort>`` reads ``X`` in one spelling and
  ``$calculated_property`` with ``calculated_property = X`` in the other,
  which Core evaluates to the same text in the same row: an xpath text is
  ``string(<its function>)``, and each of its variables is a text evaluated
  in the same context first (commcare-core ``suite/model/Text.evaluate``,
  ``ensureCacheIsParsed``), so ``string($calculated_property)`` is
  ``string(X)``.

The rule makes, in HQ's app document, ``sort_calculation`` ``""`` on such a
sort element where its column is calculated (``useXpathExpression``) and
either its format gives its own sort expression, or its format's display
expression is the column's own, its ``field`` names no ``$lang`` (as HQ
tests it, ``_calculated_property``), the element's type is not
``distance``, and the ``field`` is the ``sort_calculation``; and,
in a suite, rewrites a ``<sort>`` text whose xpath is
``$calculated_property`` with that one variable, holding none of its own,
as the variable's own xpath.
"""

from __future__ import annotations

import copy
import re

from proof.rules import SpellingRule
from proof.rules._app import case_details, modules

# HQ's name for a sort on column ``i`` (``const.py::CALCULATED_SORT_FIELD_RX``), read as a name.
_CALCULATED = re.compile(r"_cc_calculated_([0-9]+)")
# The formats whose column class gives a sort expression of its own (``detail_screen.py``, ``SORT_XPATH_FUNCTION``
# and ``Enum.sort_xpath_function``).
OWN_SORT_FORMATS = frozenset(
    {"date", "time-ago", "distance", "enum", "conditional-enum", "enum-image", "translatable-enum", "clickable-icon"}
)
# The formats whose display expression is not the column's own (``detail_screen.py``: ``Image.XPATH_FUNCTION``,
# ``LateFlag.XPATH_FUNCTION``), so that a sort by it is not a sort by the column's expression.
OTHER_DISPLAY_FORMATS = frozenset({"image", "late-flag"})
_VARIABLE = "calculated_property"
# What HQ's _calculated_property looks for in a column's expression before it gives the variable a lang of its own.
_LANG = "$lang"
# The sort type whose expression HQ writes over $calculated_property whatever the calculation (``sort_node``).
_DISTANCE = "distance"


def _sorts_by_own_expression(column, element):
    """Whether HQ's sort by ``$calculated_property`` sorts by the column's own expression, and the sort element's
    calculation is that expression."""
    field = column.get("field")
    return (
        column.get("format") not in OTHER_DISPLAY_FORMATS
        and element.get("type") != _DISTANCE
        and isinstance(field, str)
        and _LANG not in field
        and field == element["sort_calculation"]
    )


def _app(app):
    for module in modules(app):
        for detail in case_details(module):
            columns = detail.get("columns") or []
            for element in detail.get("sort_elements") or []:
                if not isinstance(element, dict) or not element.get("sort_calculation"):
                    continue
                named = _CALCULATED.fullmatch(element.get("field") or "")
                if named is None or int(named.group(1)) >= len(columns):
                    continue
                column = columns[int(named.group(1))]
                if not isinstance(column, dict) or column.get("useXpathExpression") is not True:
                    continue
                if column.get("format") in OWN_SORT_FORMATS or _sorts_by_own_expression(column, element):
                    element["sort_calculation"] = ""
    return app


def _suite(root):
    for sort in root.iter("sort"):
        for xpath in sort.findall("text/xpath"):
            variables = xpath.findall("variable")
            if xpath.get("function") != f"${_VARIABLE}" or len(variables) != 1 or len(xpath) != 1:
                continue
            variable = variables[0]
            inner = variable.findall("xpath")
            if variable.get("name") != _VARIABLE or len(variable) != 1 or len(inner) != 1 or len(inner[0]):
                continue
            replacement = copy.deepcopy(inner[0])
            replacement.tail = xpath.tail
            xpath.getparent().replace(xpath, replacement)
    return root


def normalize(parsed):
    if isinstance(parsed, dict):
        return _app(parsed)
    if isinstance(getattr(parsed, "tag", None), str) and parsed.tag == "suite":
        return _suite(parsed)
    return parsed


RULE = SpellingRule(
    "sort-calculation-pair",
    ("app.json", "suite.xml", "*/suite.xml"),
    "A calculated column's sort by its own expression rather than $calculated_property holding it, which Core"
    " evaluates alike (detail_screen.py::FormattedDetailColumn.sort_node).",
    normalize,
)
