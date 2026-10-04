"""A detail column's tile cell (grid place, size, alignment, font size) where its detail is no custom tile.

HQ's Case List and Case Detail saves write every column's tile cell from the
page's defaults: ``grid_x`` and ``grid_y`` 0, ``width``, ``height``,
``horizontal_align`` ``left``, ``vertical_align`` ``start`` and ``font_size``
``medium`` (``static/app_manager/js/details/bootstrap3/column.js``,
``self.serialize``, and its bootstrap5 twin). HQ's build
reads a column's cell only to lay out a custom tile:
``suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail``
writes each column's grid and style only where the detail's
``case_tile_template`` is ``custom``, and a template of HQ's own places its
fields from the template (``DetailColumn``'s own comment: "Only applies to
custom case list tile"). On a custom tile the cell is the tile's layout,
which the rule leaves.

The rule removes those seven keys from every column of a module's case list
or case detail whose ``case_tile_template`` is not ``custom``.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._app import case_details, modules

_CELL = ("grid_x", "grid_y", "width", "height", "horizontal_align", "vertical_align", "font_size")
_CUSTOM = "custom"


def normalize(app):
    for module in modules(app):
        for detail in case_details(module):
            if detail.get("case_tile_template") == _CUSTOM:
                continue
            for column in detail.get("columns") or []:
                if isinstance(column, dict):
                    for key in _CELL:
                        column.pop(key, None)
    return app


RULE = SpellingRule(
    "tile-cell-fields",
    "app.json",
    "A column's tile cell in a detail that is no custom tile, which HQ's build does not read"
    " (suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail).",
    normalize,
)
