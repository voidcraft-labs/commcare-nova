"""The rule ``tile-cell-fields`` is sound where it holds: a column's tile cell is unread outside a custom tile.

Contract: the rule erases a column's ``grid_x``, ``grid_y``, ``width``,
``height``, ``horizontal_align``, ``vertical_align`` and ``font_size`` where
its detail is no custom tile, as the Case List and Case Detail saves write
them from the page's defaults. The condition is the rule's: on a custom
tile the cell is the tile's layout. The plausible failures: HQ reading the
cell outside a custom tile (so the saves would change the build), and the
rule erasing a custom tile's cell, which HQ builds into the suite.

Both sides of the condition: a corpus document whose case list and case
detail are no tile builds alike with the page's cell on every column, and
the rule erases the difference; a document whose case list is a custom tile
builds a different suite once a cell gains a font size, which the rule
leaves.
"""

from __future__ import annotations

from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    build_differences,
    edited,
    published,
    shown,
    stored_differences,
)
from proof.rules.tile_cell_fields import RULE

PLAIN = "arithmetic"
CUSTOM_TILE = "tile-boxed"
CELL = {
    "grid_x": 0,
    "grid_y": 0,
    "width": 1,
    "height": 1,
    "horizontal_align": "left",
    "vertical_align": "start",
    "font_size": "medium",
}


def _with_cells(doc):
    for display in ("short", "long"):
        for column in doc["modules"][0]["case_details"][display]["columns"]:
            column.update(CELL)


def test_a_cell_outside_a_custom_tile_is_unread(rule_documents, hq, core_runner):
    with published(rule_documents[PLAIN], core_runner) as app:
        nova = app.spell()
        assert nova.stored["doc"]["modules"][0]["case_details"]["short"].get("case_tile_template") != "custom"
        saved = app.spell(doc=edited(_with_cells))

    assert_spelled(nova, saved, RULE, lambda path: path.rsplit("/", 1)[-1] in CELL)
    assert_same_build(nova, saved)


def test_a_custom_tiles_cell_is_its_layout(rule_documents, hq, core_runner):
    def sized(doc):
        column = doc["modules"][0]["case_details"]["short"]["columns"][0]
        column["font_size"] = "small" if column.get("font_size") != "small" else "large"

    with published(rule_documents[CUSTOM_TILE], core_runner) as app:
        nova = app.spell()
        assert nova.stored["doc"]["modules"][0]["case_details"]["short"].get("case_tile_template") == "custom"
        resized = app.spell(doc=edited(sized))

    assert shown(stored_differences(nova.stored, resized.stored, rules=(RULE,)))
    assert build_differences(nova.build, resized.build), "HQ builds a custom tile's font size as none"
