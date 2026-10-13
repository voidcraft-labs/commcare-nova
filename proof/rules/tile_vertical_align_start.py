"""A tile cell's vertical alignment of ``start``, which every reader lays out as it lays out none.

HQ's Case List save writes every column's ``vertical_align`` from the page's
default, ``start`` (``static/app_manager/js/details/bootstrap3/column.js``,
``self.serialize``), where Nova's column holds none. Each reader of it:

- HQ's build writes a custom tile's cell style with ``vert-align="start"``
  or without the attribute
  (``suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail``),
  and nothing else of the build differs;
- Core parses the attribute into the field's style and its sessions take
  the same steps;
- Formplayer hands the client the style as Core read it
  (``beans/menus/Style.verticalAlign``): ``start``, or none;
- the Web Apps client lays a cell out by its style's alignment where that
  is one it allows and by ``start`` otherwise
  (``cloudcare/js/formplayer/menus/views.js::getValidFieldAlignment``), so
  it computes ``align-self: start`` for both;
- CommCare Android's tile has no case for ``start``
  (``views/EntityViewTile.java``): a text cell's gravity and an image
  cell's layout are the same with it and without.

The rule removes a column's ``vertical_align`` where it is ``start`` or null
(the app document), a style's ``vert-align="start"`` (a built suite), and
makes a style's ``verticalAlign`` null where it is ``start`` (a Formplayer
trace). Any other alignment (``center``, ``end``) moves the cell in every
runtime, and the rule leaves it. Where the cell is no custom tile's, the
rule ``tile-cell-fields`` has already removed it from the app document, and
HQ's build writes no style for it.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import case_details, modules

START = "start"


def _suite(root):
    for style in root.iter("style"):
        if style.get("vert-align") == START:
            del style.attrib["vert-align"]
    return root


def _handed(value):
    """Formplayer's JSON with each tile style's ``start`` vertical alignment made none, in place."""
    if isinstance(value, dict):
        styles = value.get("styles")
        if isinstance(styles, list):
            for style in styles:
                if isinstance(style, dict) and style.get("verticalAlign") == START:
                    style["verticalAlign"] = None
        for item in value.values():
            _handed(item)
    elif isinstance(value, list):
        for item in value:
            _handed(item)
    return value


def normalize(parsed):
    if hasattr(parsed, "iter"):
        return _suite(parsed) if getattr(parsed, "tag", None) == "suite" else parsed
    if isinstance(parsed, dict) and "runs" in parsed:
        return _handed(parsed)
    for module in modules(parsed):
        for detail in case_details(module):
            for column in detail.get("columns") or []:
                if isinstance(column, dict) and column.get("vertical_align", START) in (START, None):
                    column.pop("vertical_align", None)
    return parsed


RULE = SpellingRule(
    "tile-vertical-align-start",
    ("app.json", "suite.xml", "*/suite.xml", "formplayer"),
    "A tile cell's vertical alignment of start, which the Web Apps client computes for a cell that names none"
    " (menus/views.js::getValidFieldAlignment) and CommCare Android's tile has no case for (EntityViewTile).",
    normalize,
    readers=(
        ("formplayer", "test_formplayer_hands_start_or_none_and_nothing_else_differs"),
        ("webapps", "test_the_client_lays_the_cell_out_alike_and_moves_it_for_another_alignment"),
        ("android", "test_a_tile_cells_style_reaches_androids_tile_view"),
    ),
)
