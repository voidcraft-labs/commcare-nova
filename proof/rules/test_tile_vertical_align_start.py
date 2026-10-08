"""The rule ``tile-vertical-align-start`` is sound: every reader of a tile cell's vertical alignment lays a cell
that says ``start`` out as it lays one out that says nothing.

Contract: the rule erases the ``start`` HQ's Case List save writes into each
column's ``vertical_align``, where Nova's column holds none, in the app
document, in the cell's style in HQ's build, and in the style Formplayer
hands the client. The plausible failures: HQ's build differing in more than
the attribute; Core's sessions differing; Formplayer answering anything
else differently; the Web Apps client computing another alignment for a
cell that names none; and the rule erasing an alignment that moves a cell.

A custom tile is written three ways in forks of Nova's publish: Nova's own,
every cell aligned ``start`` as the save writes it, and every cell aligned
``center`` (the control). HQ builds the first two alike but for the
attribute, and Core's sessions over them are the same. Each is then
released and served by HQ's own views (``served_readings``): Formplayer's
walks differ only in the style's alignment, which the rule erases; and the
client, shown both in Chromium under HQ's own stylesheets, computes
``align-self: start`` for every cell of both and shows the same screens
throughout. ``center`` moves the cell in the client, and the rule leaves
it. CommCare Android's reading is ``proof/android/predicates.py::
test_a_tile_cells_style_reaches_androids_tile_view``.
"""

from __future__ import annotations

import pytest

from proof.rules.conftest import (
    assert_spelled,
    build_differences,
    client_differences,
    edited,
    formplayer_differences,
    published,
    runs_alike,
    screens,
    served_readings,
    shown,
)
from proof.rules.tile_vertical_align_start import RULE

DOCUMENT = "targeted-custom-tile"
CONFIGURATION = "maximum"


def _aligned(value):
    """The app's JSON with every cell of every custom tile aligned ``value`` vertically."""

    def change(doc):
        cells = [
            column
            for module in doc["modules"]
            for detail in (module.get("case_details") or {}).values()
            if isinstance(detail, dict) and detail.get("case_tile_template") == "custom"
            for column in detail.get("columns") or []
        ]
        assert cells, "the document holds no custom tile"
        for column in cells:
            assert column.get("vertical_align") is None, column.get("vertical_align")
            column["vertical_align"] = value

    return change


def _vertical(path):
    return "vertical_align" in path or "vert-align" in path or "verticalAlign" in path


def test_hq_builds_start_as_one_attribute_and_core_runs_both_alike(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner, CONFIGURATION) as app:
        nova = app.spell()
        saved = app.spell(doc=edited(_aligned("start")))
        centred = app.spell(doc=edited(_aligned("center")))
        assert_spelled(nova, saved, RULE, _vertical)
        built = shown(build_differences(nova.build, saved.build))
        assert built and all(artifact == "suite.xml" and _vertical(path) for artifact, path, _ in built), built
        assert shown(build_differences(nova.build, saved.build, rules=(RULE,))) == []
        assert shown(build_differences(nova.build, centred.build, rules=(RULE,))), "the rule erased center"
        _, _, ran = runs_alike(app, core_runner, nova.build, saved.build)
    assert ran == [], shown(ran)


@pytest.fixture(scope="module")
def read(rule_documents, hq, core_runner, lane_services):
    with published(rule_documents[DOCUMENT], core_runner, CONFIGURATION) as app:
        return served_readings(app, {"nova": None, "saved": _aligned("start"), "centred": _aligned("center")})


def test_formplayer_hands_start_or_none_and_nothing_else_differs(read):
    found = formplayer_differences(read["nova"], read["saved"])
    assert found, "Formplayer's walk reached no tile, so the two spellings were never read apart"
    assert all(_vertical(d.path) for d in found), shown(found)
    assert {(d.before, d.after) for d in found} == {(None, "start")}, found
    assert formplayer_differences(read["nova"], read["saved"], rules=(RULE,)) == []
    kept = formplayer_differences(read["nova"], read["centred"], rules=(RULE,))
    assert {(d.before, d.after) for d in kept} == {(None, "center")}, kept


def _alignments(reading):
    return [
        cell["alignSelf"] for screen in screens(reading) for cell in (screen.get("list") or {}).get("cells") or []
    ]


def test_the_client_lays_the_cell_out_alike_and_moves_it_for_another_alignment(read):
    for name in ("nova", "saved"):
        computed = _alignments(read[name])
        assert computed and set(computed) == {"start"}, (name, computed)
    assert client_differences(read["nova"], read["saved"]) == []
    assert set(_alignments(read["centred"])) == {"center"}
    moved = client_differences(read["nova"], read["centred"])
    assert moved and all(d.path.endswith("/alignSelf") for d in moved), shown(moved)


def test_the_rule_leaves_every_other_alignment():
    from lxml import etree

    from proof.rules.tile_vertical_align_start import normalize

    suite = etree.fromstring(
        '<suite><detail id="d"><field><style vert-align="start" horz-align="left"/></field>'
        '<field><style vert-align="center"/></field></detail></suite>'
    )
    assert [dict(style.attrib) for style in normalize(suite).iter("style")] == [
        {"horz-align": "left"},
        {"vert-align": "center"},
    ]
    app = {"modules": [{"case_details": {"short": {"columns": [{"vertical_align": "start"}, {"vertical_align": "end"}]}}}]}
    assert normalize(app)["modules"][0]["case_details"]["short"]["columns"] == [{}, {"vertical_align": "end"}]
    handed = {"runs": [{"steps": [{"response": {"styles": [{"verticalAlign": "start"}, {"verticalAlign": "end"}]}}]}]}
    assert normalize(handed)["runs"][0]["steps"][0]["response"]["styles"] == [
        {"verticalAlign": None},
        {"verticalAlign": "end"},
    ]
