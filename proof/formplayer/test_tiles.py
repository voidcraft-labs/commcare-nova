"""The custom tile's cell alignment Formplayer hands Web Apps, on Nova's export and on the app the Case List save leaves.

Finding 42: the Case List save writes a vertical alignment of ``start`` into
every cell of a custom tile Nova leaves unaligned, and HQ's build carries it
into each cell's style (``@vert-align``). Contract: Formplayer hands the
client each cell's style as the suite holds it
(``EntityListResponse.styles``), so the two builds differ in what Formplayer
answers: no vertical alignment for Nova's export, ``start`` for the saved
app, and nothing else of the list differs. Whether a worker sees a
difference is then the Web Apps client's reading of an absent alignment,
which this does not run.

Plausible failures: a Formplayer that drops the style (the two would read
alike here, and the register's class would be a spelling Formplayer does not
read), or a list that differs elsewhere, which would be another symptom.
"""

from __future__ import annotations

import copy

from proof.formplayer import apps

DOCUMENT = "targeted-custom-tile"
# The menu and the form whose case list shows the tile.
TILE_LIST = ["0", "0"]


def test_formplayer_hands_the_saved_apps_vertical_alignment_through_and_nothing_else_differs(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:

        def save_alignment(doc):
            """What the Case List save stores in every cell of the tile (``details/bootstrap5/column.js``)."""
            for module in doc["modules"]:
                short = module["case_details"]["short"]
                if short.get("case_tile_template") == "custom":
                    for column in short["columns"]:
                        column["vertical_align"] = "start"

        saved = apps.spelled(published, save_alignment)
        lists = {}
        for name, files in (("nova", published.build.files), ("saved", saved.files)):
            session = apps.installed(published, files)
            lists[name] = apps.web(formplayer_runner, session).navigate(TILE_LIST)
        evidence("styles", {name: listed["styles"] for name, listed in lists.items()})

        assert lists["nova"]["usesCaseTiles"] is True and len(lists["nova"]["styles"]) == 3
        assert [style["verticalAlign"] for style in lists["nova"]["styles"]] == [None, None, None]
        assert [style["verticalAlign"] for style in lists["saved"]["styles"]] == ["start", "start", "start"]
        # Nothing else of the list differs but each build's own id and the app's version, which every save of an
        # app in HQ moves on.
        rest = {}
        for name, listed in lists.items():
            rest[name] = copy.deepcopy(listed)
            rest[name].pop("appId")
            rest[name].pop("appVersion")
            for style in rest[name]["styles"]:
                style.pop("verticalAlign")
        assert rest["nova"] == rest["saved"]
