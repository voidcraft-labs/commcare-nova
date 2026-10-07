"""How Web Apps lays out a custom tile's cells, for Nova's export and for the app a Case List save leaves.

Nova leaves a tile cell without an alignment or a font size where the
author set none. HQ's Case List page, saved without a change, writes
``left``, ``start`` and ``medium`` into every cell, and HQ's build carries
all three into the suite (finding 42, and defect 14's tile part). Formplayer
hands the client each as the suite holds it
(``proof/formplayer/test_tiles.py``). What a worker sees is then the Web
Apps client's: it writes a style element for the tile's grid
(``menus/views.js::buildCellLayout``, ``getValidFieldAlignment``), and the
browser lays the cells out from it under HQ's stylesheets.

Contract: over the released build of Nova's export and the released build
after HQ's own Case List page saved the same app, the client run in the
lane's Chromium against Formplayer gives each cell

- the same vertical alignment: an absent one and ``start`` both compute to
  ``align-self: start``, so the register's two vertical-alignment entries
  are an equivalence a real client now shows;
- a different horizontal alignment: ``start`` for an absent one, ``left``
  for the saved app's, which a browser renders alike in a left-to-right
  language and apart in a right-to-left one, the harm finding 42 states;
- a different font size: an absent one leaves the cell at the size HQ's
  stylesheet gives a tile (12px), and ``medium`` is the browser's medium
  (16px), so the save makes every tile's text a third larger;
- the same grid area and text.

Plausible failures: a client that drops the style (every cell would compute
alike), a page with no stylesheet (an absent size would compute to the
browser's own default, which is also 16px, and the size difference would
vanish: the first run of this test, before the page had HQ's stylesheets,
read exactly that), a save that never reached the stored app (the saved
release's columns are checked), or a second release that ran the first's
install (the two build ids differ, and so do the styles Formplayer answered
with).
"""

from __future__ import annotations

from proof.editors import pages
from proof.webapps import hq as webapps_hq
from proof.webapps import static, steps
from proof.webapps.session import Session

DOCUMENT = "targeted-custom-tile"
TO_THE_LIST = steps.path(steps.open_app("Visit tiles"), steps.choose("Visits"), steps.choose("Record visit"))
LAID_OUT = ("textAlign", "justifySelf", "alignSelf", "fontSize")


def _tile_columns(release):
    return release.doc["modules"][0]["case_details"]["short"]["columns"]


def test_web_apps_lays_a_tile_out_with_the_same_vertical_alignment_and_another_horizontal_one_and_size_after_the_save(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    # Under both tile flags the Case List save keeps a custom tile (defect 12), so the saved app still shows one.
    with webapps_hq.project(webapps_documents[DOCUMENT], core_runner, "maximum") as project:
        observed = {}
        saves = {"nova": (), "saved": ((pages.CASE_LIST, project.module_id(0)),)}
        for name, made in saves.items():
            with project.released(saves=made, driver=editor_driver, label=name) as release:
                run = Session(project, release, formplayer_runner, editor_driver).run([*TO_THE_LIST, steps.SCREEN])
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
        assert nova["stored"] == [[None, None, None]] * 3 and saved["stored"] == [["left", "start", "medium"]] * 3
        assert nova["formplayer"] == [[None, None, None]] * 3
        assert saved["formplayer"] == [["left", "start", "medium"]] * 3
        assert nova["pageErrors"] == [] and saved["pageErrors"] == []
        # Both pages were laid out under HQ's own stylesheets, the Web Apps one among them.
        assert nova["stylesheets"] == saved["stylesheets"]
        assert any("formplayer-webapp" in path for path in nova["stylesheets"])

        assert nova["list"]["tiles"] is True and len(nova["list"]["cells"]) == 3
        cells = {
            name: [[cell[key] for key in LAID_OUT] for cell in side["list"]["cells"]] for name, side in observed.items()
        }
        # Absent: start, start, start, at the stylesheet's size. Saved: left, left, start, at the browser's medium.
        assert cells["nova"] == [["start", "start", "start", "12px"]] * 3
        assert cells["saved"] == [["left", "left", "start", "16px"]] * 3
        # Everything else of the list is the same.
        for side in (nova, saved):
            for cell in side["list"]["cells"]:
                for key in LAID_OUT:
                    cell.pop(key)
        assert nova["list"] == saved["list"]
        assert [row["id"] for row in nova["list"]["rows"]] == ["row-visit-2", "row-visit-3", "row-visit-1"]
