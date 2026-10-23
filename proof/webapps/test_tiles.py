"""How Web Apps lays out a custom tile, for Nova's export and for the app a Case List save leaves.

- **Finding 42 and defect 14's tile part** (``targeted-custom-tile``). HQ's
  Case List page writes ``left``, ``start`` and ``medium`` into every tile
  cell that holds none, and HQ's build carries all three into the suite.
  Nova now writes all three into every cell, so the save changes none.
  Contract: over the released build of Nova's export and the released build
  after HQ's own Case List page saved the same app, the client run in the
  lane's Chromium against Formplayer gives every cell the same layout:
  ``text-align`` and ``justify-self`` ``left``, ``align-self`` ``start``,
  and the browser's medium (16px), from the style element the client
  writes (``menus/views.js::buildCellLayout``, ``getValidFieldAlignment``)
  under HQ's stylesheets. Plausible failures: a client that drops the style
  (every cell would compute to the stylesheet's own size, 12px), a page
  with no stylesheet, a save that never reached the stored app (the saved
  release's columns are checked), or a second release that ran the first's
  install (the two build ids differ).

- **The corrected tile clause** (``targeted-tile-hidden-order``). A tile
  list's order rules on two columns hidden from Results, neither of which
  is on the tile, are sort rows with no stored column, for which HQ's build
  appends a zero-width field it does not style. Contract, over the released
  build with the document's cases, ranked by hand so the first rule's order
  is the reverse of the names': the rows follow the first rule, each row
  lays out the two placed cells and no other, and a search for a value only
  the first hidden column holds finds its case alone. Plausible failures: a
  carrier the client draws as a cell, a list ordered by the names (the
  default), and a search that never reads the carrier.
"""

from __future__ import annotations

from dataclasses import replace

from proof.editors import pages
from proof.observe import casedata
from proof.webapps import hq as webapps_hq
from proof.webapps import static, steps
from proof.webapps.session import Session

DOCUMENT = "targeted-custom-tile"
TO_THE_LIST = steps.path(steps.open_app("Visit tiles"), steps.choose("Visits"), steps.choose("Record visit"))
LAID_OUT = ("textAlign", "justifySelf", "alignSelf", "fontSize")


def _tile_columns(release):
    return release.doc["modules"][0]["case_details"]["short"]["columns"]


def test_web_apps_lays_a_tile_out_alike_before_and_after_the_save(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    # Under both tile flags the Case List save keeps a custom tile (defect 12), so the saved app still shows one.
    with webapps_hq.project(webapps_documents[DOCUMENT], "maximum") as project:
        observed = {}
        saves = {"nova": (), "saved": ((pages.CASE_LIST, project.module_id(0)),)}
        for name, made in saves.items():
            with project.released(formplayer_runner, saves=made, driver=editor_driver, label=name) as release:
                run = Session(release, editor_driver).run([*TO_THE_LIST, steps.SCREEN])
                answered = run.answered("navigate_menu")[-1].json()
                observed[name] = {
                    "build": release.build_id,
                    "stored": [
                        [column.get("horizontal_align"), column.get("vertical_align"), column.get("font_size")]
                        for column in _tile_columns(release)
                    ],
                    "formplayer": [
                        [style["horizontalAlign"], style["verticalAlign"], tile["fontSize"]]
                        for style, tile in zip(answered["styles"], answered["tiles"], strict=True)
                    ],
                    "list": run.screens[0]["list"],
                    "stylesheets": sorted(static.unhashed(path) for path, _ in run.statics if path.endswith(".css")),
                    "pageErrors": run.page_errors,
                }
        evidence("tile-cells", observed)
        nova, saved = observed["nova"], observed["saved"]

        # The two releases are two apps to Formplayer, and the save reached the stored app and the suite.
        assert nova["build"] != saved["build"]
        for side in (nova, saved):
            assert side["stored"] == [["left", "start", "medium"]] * 3
            assert side["formplayer"] == [["left", "start", "medium"]] * 3
            assert side["pageErrors"] == []
        # Both pages were laid out under HQ's own stylesheets, the Web Apps one among them.
        assert nova["stylesheets"] == saved["stylesheets"]
        assert any("formplayer-webapp" in path for path in nova["stylesheets"])

        assert nova["list"]["tiles"] is True and len(nova["list"]["cells"]) == 3
        # Every cell left, left, start, at the browser's medium, before the save and after it.
        for side in (nova, saved):
            assert [[cell[key] for key in LAID_OUT] for cell in side["list"]["cells"]] == [
                ["left", "left", "start", "16px"]
            ] * 3
        # And the whole list is the same.
        assert nova["list"] == saved["list"]
        assert [row["id"] for row in nova["list"]["rows"]] == ["row-visit-2", "row-visit-3", "row-visit-1"]


HIDDEN_ORDER = "targeted-tile-hidden-order"
# The first rule's values, set by hand so its order (Chausiku, Baraka, Amina) is the reverse of the names'; the
# served worker owns every case, so the second rule, the owner, ties throughout.
RANKS = {"targeted-amina-visit": "zulu", "targeted-baraka-visit": "mike", "targeted-chausiku-visit": "alpha"}
PLACED = {
    "row-targeted-amina-visit": ["Amina", "Riverside"],
    "row-targeted-baraka-visit": ["Baraka", "Hilltop"],
    "row-targeted-chausiku-visit": ["Chausiku", "Lakeside"],
}


def _ranked(database):
    """The cases with ``rank`` set as ``RANKS`` says."""
    return replace(
        database,
        cases=tuple(
            replace(
                case,
                properties=tuple(
                    (name, RANKS[case.case_id] if name == "rank" else value) for name, value in case.properties
                ),
            )
            for case in database.cases
        ),
    )


def _placed(row):
    """The texts of a tile row's cells the browser lays out."""
    return [cell["text"] for cell in row["cells"] if not cell["hidden"]]


def test_web_apps_lays_out_a_tiles_placed_cells_alone_and_orders_and_searches_by_a_hidden_order_rule(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents[HIDDEN_ORDER]
    database = _ranked(casedata.database_of_restore((document.root / "restore.xml").read_bytes()))
    # Under both tile flags HQ's build keeps the custom tile (defect 12).
    with webapps_hq.project(document, "maximum") as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run(
                [
                    *steps.open_app("Visit tile order"),
                    *steps.choose("Visits"),
                    steps.SCREEN,
                    *steps.search_list("zulu"),
                    steps.SCREEN,
                ]
            )
    listed, searched = (screen["list"] for screen in run.screens)
    evidence("tile-hidden-order", {"listed": listed, "zulu": searched})
    assert run.page_errors == []
    assert listed["tiles"] is True
    # The first rule orders the rows.
    assert [row["id"] for row in listed["rows"]] == [
        "row-targeted-chausiku-visit",
        "row-targeted-baraka-visit",
        "row-targeted-amina-visit",
    ]
    # Each row lays out its two placed cells and no other.
    for row in listed["rows"]:
        assert _placed(row) == PLACED[row["id"]], row
    # Only the first hidden column holds zulu, and the search finds Amina's row alone.
    assert [row["id"] for row in searched["rows"]] == ["row-targeted-amina-visit"]
    assert _placed(searched["rows"][0]) == PLACED["row-targeted-amina-visit"]
