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

- **A grouped tile list's cards under a filter**
  (``targeted-tile-group-filter``). Formplayer filters, sorts and then
  groups (``EntityScreenHelper.java::initEntities``), and the client keeps
  one model a group, the first, which draws the card's heading and is the
  model a tap names (``views.js::CaseTileGroupedListView.initialize``,
  ``CaseView.attributes``). Contract, over the released build with the
  restore's cases served: before the search the list holds three cards,
  Ada's, Ben's and Eve's, headed Nurse Amani, Nurse Chiku and Nurse Imani;
  after a search for ``Referred`` it holds two, Ben's and then Cal's, headed
  Nurse Chiku and Nurse Baraka, the second holding Cal's row alone.
  Plausible failures: a client that kept each group's own first case (the
  second card would be Ada's, under Nurse Amani), groups left in their
  unfiltered order, and a search that never reached Formplayer (three cards
  after it).
"""

from __future__ import annotations

from dataclasses import replace

import pytest

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


GROUP_FILTER = "targeted-tile-group-filter"


@pytest.mark.parametrize("column_format", ("invisible", "address"))
def test_web_apps_draws_zero_width_values_only_in_a_grouped_tile_body(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, column_format
):
    from proof.hq import operations
    from proof.matrix.authoring import Authoring
    from proof.matrix.ops import set_json

    document = webapps_documents[GROUP_FILTER]
    base = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    visits = [case for case in base.cases if case.case_type == "visit"]
    raw_values = {
        case.case_id: f"Raw visit value {case.name}" if column_format == "invisible" else f"-1.9 35.{index + 10}"
        for index, case in enumerate(visits)
    }
    database = replace(base, cases=tuple(
        replace(case, properties=tuple(
            (name, raw_values[case.case_id] if name == "outcome" else value)
            for name, value in case.properties
        )) if case.case_id in raw_values else case
        for case in base.cases
    ))
    observed = {}
    with webapps_hq.project(document, "maximum") as project:
        unit = project.unit
        for stage, grouped, raw_row in (("ordinary", False, 1), ("header", True, 0), ("body", True, 1)):
            with unit.fork():
                authoring = Authoring(unit, {}, f"grouped-width-zero-{stage}", operation=unit.operation)
                held = operations.held_app(unit, project.app_id).modules[0].case_details.short
                columns = {column.field: column.to_json() for column in held.columns}
                # The raw field is the only cell in its row of an otherwise unremarkable tile.
                visible = {**columns["seen_by"], "grid_x": 0, "grid_y": 1 - raw_row, "width": 12}
                raw = {**columns["outcome"], "format": column_format, "grid_x": 0, "grid_y": raw_row, "width": 12}
                set_json(authoring, project.app_id, "/modules/0/case_details/short/columns", [visible, raw])
                if not grouped:
                    set_json(authoring, project.app_id, "/modules/0/case_details/short/case_tile_group", {
                        "doc_type": "CaseTileGroupConfig", "index_identifier": None, "header_rows": 2,
                    })
                with project.released(formplayer_runner, database=database, label=stage) as release:
                    run = Session(release, editor_driver).run([
                        *steps.open_app("Grouped visits"),
                        *steps.choose("Visits"),
                        steps.SCREEN,
                    ])
                    answered = run.answered("navigate_menu")[-1].json()
                    shown = run.screens[0]["list"]
                    observed[stage] = {
                        "groupHeaderRows": answered["groupHeaderRows"],
                        "widthHint": answered["styles"][1]["widthHint"],
                        "displayFormat": answered["styles"][1]["displayFormat"],
                        "storedColumnFormat": _tile_columns(release)[1]["format"],
                        "storedGridY": _tile_columns(release)[1]["grid_y"],
                        "gridY": answered["tiles"][1]["gridY"],
                        "rawData": {entity["id"]: entity["data"][1] for entity in answered["entities"]},
                        "rowIds": [row["id"] for row in shown["rows"]],
                        "rawCells": [
                            cell for row in shown["rows"] for cell in row["cells"]
                            if cell["text"] in raw_values.values()
                        ],
                        "webAppCss": any("formplayer-webapp" in static.unhashed(path)
                                         for path, _ in run.statics if path.endswith(".css")),
                        "pageErrors": run.page_errors,
                    }

    evidence(f"tile-width-zero-{column_format}", observed)
    for stage, actual in observed.items():
        assert actual["pageErrors"] == [] and actual["webAppCss"], actual
        assert actual["widthHint"] == 0, actual
        assert actual["storedColumnFormat"] == column_format, actual
        assert actual["storedGridY"] == actual["gridY"], actual
        if column_format == "address":
            assert actual["displayFormat"] == "Address", actual
        assert actual["rawData"] == raw_values, actual
        assert actual["groupHeaderRows"] == (-1 if stage == "ordinary" else 1), actual
        assert actual["gridY"] == (0 if stage == "header" else 1), actual
    assert len(observed["ordinary"]["rowIds"]) == len(raw_values)
    assert len(observed["header"]["rowIds"]) == len(observed["body"]["rowIds"]) == 3
    assert {cell["text"] for cell in observed["ordinary"]["rawCells"]} == set(raw_values.values())
    assert {cell["text"] for cell in observed["header"]["rawCells"]} == {
        raw_values[f"targeted-{name}-visit"] for name in ("ada", "ben", "eve")
    }
    assert all(cell["hidden"] for cell in observed["ordinary"]["rawCells"] + observed["header"]["rawCells"])
    assert {cell["text"] for cell in observed["body"]["rawCells"]} == set(raw_values.values())
    assert all(not cell["hidden"] for cell in observed["body"]["rawCells"])



def _card(row):
    """A grouped card's id and its cells' texts, the heading's first (``tile_grouped_item.html``)."""
    return row["id"], [cell["text"] for cell in row["cells"] if not cell["hidden"]]


def test_web_apps_makes_a_grouped_tiles_cards_from_the_rows_a_search_leaves(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents[GROUP_FILTER]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    # Under both tile flags HQ's build keeps the custom tile (defect 12).
    with webapps_hq.project(document, "maximum") as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run(
                [
                    *steps.open_app("Grouped visits"),
                    *steps.choose("Visits"),
                    steps.SCREEN,
                    *steps.search_list("Referred"),
                    steps.SCREEN,
                ]
            )
    listed, searched = (screen["list"] for screen in run.screens)
    evidence("tile-group-filter", {"listed": listed, "referred": searched})
    assert run.page_errors == []
    assert listed["tiles"] is True
    # One card a group, each its group's first case, headed by that case's own value.
    listed_cards = [_card(row) for row in listed["rows"]]
    assert [card_id for card_id, _ in listed_cards] == [
        "row-targeted-ada-visit",
        "row-targeted-ben-visit",
        "row-targeted-eve-visit",
    ]
    assert [cells[0] for _, cells in listed_cards] == ["Nurse Amani", "Nurse Chiku", "Nurse Imani"]
    # The search leaves Ben, Cal and Dot: Ben's household first, its first match, then Cal's.
    searched_cards = [_card(row) for row in searched["rows"]]
    assert [card_id for card_id, _ in searched_cards] == ["row-targeted-ben-visit", "row-targeted-cal-visit"]
    assert [cells[0] for _, cells in searched_cards] == ["Nurse Chiku", "Nurse Baraka"]
    # Cal's card holds Cal's row alone: Ada, who does not match, is no row of it.
    assert searched_cards[1][1] == ["Nurse Baraka", "Cal", "Referred"]


def _edit_tile_group_identifier(project, editor_driver, identifier):
    from django.urls import reverse
    from urllib.parse import parse_qsl

    from proof.editors.hq import HQAnswers, editor_build

    unit = project.unit
    args = [unit.domain, project.app_id, project.module_id(0)]
    page = pages.CASE_LIST
    save_path = reverse(page.save, args=args)
    editor_build()
    answers = HQAnswers(unit, unit)
    edited = editor_driver.run([
        {"goto": reverse(page.view, args=args)},
        {"until": "pages/ready", "arg": {"bar": page.bar}},
        {"settle": True},
        {"eval": """identifier => {
            const field = document.getElementById('id_case_tile_group_by');
            field.value = identifier;
            field.dispatchEvent(new Event('change', { bubbles: true }));
        }""", "arg": identifier},
        {"click": f"{page.bar} > .btn:not(.disabled)"},
        {"awaitRequest": {"method": "POST", "pathname": save_path}},
        {"settle": True},
    ], answer=answers)
    answers.check()
    assert edited["pageErrors"] == []
    saved, = [exchange for exchange in answers.exchanges
              if exchange.method == "POST" and exchange.path == save_path]
    assert saved.status == 200, saved.response
    return dict(parse_qsl(saved.body.decode("utf-8"), keep_blank_values=True))


def test_current_editor_saves_a_tile_group_whose_path_core_may_reject(
    hq, core_runner, editor_driver, webapps_documents, evidence, tmp_path,
):
    import json

    from lxml import etree

    from proof.editors import compare
    from proof.hq import operations
    from proof.observe.build import admit, arrange

    document = webapps_documents[GROUP_FILTER]
    observed = {}
    with webapps_hq.project(document, "maximum") as project:
        unit = project.unit
        for identifier in ("my-parent", "my.parent", "-my-parent", "my parent"):
            posted = _edit_tile_group_identifier(project, editor_driver, identifier)
            assert json.loads(posted["case_tile_group"])["index_identifier"] == identifier
            reopened = pages.fresh_section_save(
                editor_driver, unit, pages.CASE_LIST, project.app_id, project.module_id(0), unit=unit,
            )
            assert reopened.save and reopened.save.status == 200 and not reopened.refused, reopened.alerts
            group = operations.held_app(unit, project.app_id).modules[0].case_details.short.case_tile_group
            assert (group.index_identifier, group.header_rows) == (identifier, 1)

            built = compare.build(unit, project.app_id, unit.record)
            assert not built.errors, built.errors
            suite = etree.fromstring(built.files["suite.xml"])
            function, = suite.xpath("//detail/group/@function")
            assert function == f"string(./index/{identifier})"
            companions = suite.xpath("//datum[contains(@id, '_parent_ids')]/@function")
            assert companions and all(f"]/index/{identifier}))" in fn for fn in companions)
            parsed = core_runner.request("xpathParse", deadline=30, expressions=[function, *companions])["results"]
            admission = admit(core_runner, arrange(built.files, tmp_path / identifier))
            if identifier in {"my-parent", "my.parent"}:
                assert all("error" not in result for result in parsed), parsed
                assert admission["admitted"], admission["problems"]
            else:
                assert all("XPathSyntaxException" in result.get("error", "") for result in parsed), parsed
                assert not admission["admitted"], admission
                assert any(problem["stage"] == "install" for problem in admission["problems"]), admission["problems"]
            observed[identifier] = {
                "function": function, "companions": companions, "headerRows": group.header_rows,
                "parser": parsed, "admitted": admission["admitted"], "problems": admission["problems"],
            }
    evidence("tile-grouping-locator-syntax", observed)


@pytest.mark.parametrize("identifier", ["my-parent", "my.parent"])
def test_tile_connection_survives_editor_grouping_and_selection(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, identifier
):
    from lxml import etree

    from proof.hq import operations
    from proof.matrix.authoring import Authoring
    from proof.matrix.ops import set_form_source

    document = webapps_documents[GROUP_FILTER]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    kijiji = "targeted-kijiji-household"
    riverside = "targeted-riverside-household"
    targets = {
        "Ada": riverside,
        "Cal": riverside,
        "Ben": kijiji,
        "Dot": kijiji,
    }
    database = replace(database, cases=tuple(
        replace(case, indices=(
            ("parent", "household", kijiji, "child"),
            *(((identifier, "household", targets[case.name], "child"),) if case.name in targets else ()),
        )) if case.case_type == "visit" else case
        for case in database.cases
    ))

    def show_companion(root, _form):
        xforms = "http://www.w3.org/2002/xforms"
        model = root.find(f".//{{{xforms}}}model")
        etree.SubElement(model, f"{{{xforms}}}instance", id="commcaresession", src="jr://instance/session")
        notes = root.find(f".//{{{xforms}}}input[@ref='/data/notes']/{{{xforms}}}label")
        notes.attrib.pop("ref", None)
        notes.text = "Grouping target "
        etree.SubElement(notes, f"{{{xforms}}}output", value="instance('commcaresession')/session/data/case_id_parent_ids")

    with webapps_hq.project(document, "maximum") as project:
        unit = project.unit
        _edit_tile_group_identifier(project, editor_driver, identifier)
        group = operations.held_app(unit, project.app_id).modules[0].case_details.short.case_tile_group
        assert (group.index_identifier, group.header_rows) == (identifier, 1)

        authoring = Authoring(unit, {}, "tile-grouping-session", operation=unit.operation)
        set_form_source(authoring, project.app_id, 0, 0, show_companion)
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([
                *steps.open_app("Grouped visits"),
                *steps.choose("Visits"),
                steps.SCREEN,
                *steps.click("#menu-region [id='row-targeted-ada-visit']"),
                *steps.click("#select-case", visible=True, within=steps.WITHIN_MS),
                steps.SCREEN,
                *steps.choose("Follow up"),
                steps.SCREEN,
            ])
    listed, selected, opened = run.screens
    evidence(f"tile-grouping-{identifier}", {"listed": listed, "selected": selected, "opened": opened})
    assert run.page_errors == []
    assert listed["list"]["tiles"] is True
    assert [_card(row) for row in listed["list"]["rows"]] == [
        ("row-targeted-ada-visit", ["Nurse Amani", "Ada", "Seen", "Cal", "Referred"]),
        ("row-targeted-ben-visit", ["Nurse Chiku", "Ben", "Referred", "Dot", "Referred"]),
        ("row-targeted-eve-visit", ["Nurse Imani", "Eve", "Seen"]),
    ]
    assert selected["breadcrumbs"][-1] == "Ada"
    assert opened["form"]["title"] == "Follow up"
    assert [question["label"] for question in opened["form"]["questions"]] == [f"Grouping target {riverside}"]


def test_tile_group_expression_in_the_connection_name_has_no_parent_value(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    import json

    document = webapps_documents[GROUP_FILTER]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    observed = {}
    with webapps_hq.project(document, "maximum") as project:
        for identifier in ("parent", "parent/parent"):
            posted = _edit_tile_group_identifier(project, editor_driver, identifier)
            assert json.loads(posted["case_tile_group"])["index_identifier"] == identifier
            with project.released(formplayer_runner, database=database, label=f"group-{len(observed)}") as release:
                run = Session(release, editor_driver).run([
                    *steps.open_app("Grouped visits"), *steps.choose("Visits"), steps.SCREEN,
                ])
            assert run.page_errors == []
            listing = run.screens[0]["list"]
            assert listing["tiles"] is True
            observed[identifier] = [_card(row) for row in listing["rows"]]

    assert [identity for identity, _ in observed["parent"]] == [
        "row-targeted-ada-visit", "row-targeted-ben-visit", "row-targeted-eve-visit",
    ]
    [(identity, cells)] = observed["parent/parent"]
    assert identity == "row-targeted-ada-visit"
    assert cells[0] == "Nurse Amani"
    assert set(cells[1:]) >= {"Ada", "Ben", "Cal", "Dot", "Eve"}
    evidence("tile-grouping-nested-locator", observed)


def _to_visits(scenario):
    return steps.path(steps.open_app(f"Tile {scenario}"), steps.choose("Visits"), steps.choose("Record visit"))


def _open_visit(case_id):
    return steps.click(f"#menu-region [id='row-{case_id}']")


def test_web_apps_offers_each_selected_cases_tabs_and_opens_their_own_fields(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from proof.observe.visit_layout_data import visits

    with webapps_hq.project(webapps_documents["tile-detail-tabs"], "maximum") as project:
        with project.released(formplayer_runner, database=visits()) as release:
            session = Session(release, editor_driver)
            west = session.run([
                *_to_visits("detail-tabs"), *_open_visit("west"), steps.SCREEN,
                *steps.click("#case-detail-modal .js-detail-tabs [role='tab']", "Follow-up"), steps.SCREEN,
            ])
            east = Session(release, editor_driver).run([*_to_visits("detail-tabs"), *_open_visit("east"), steps.SCREEN])
    first, second = [screen["detail"] for screen in west.screens]
    other = east.screens[0]["detail"]
    evidence("visit-tabs", {"west": [first, second], "east": other})
    assert first["tabs"] == [{"title": "Visit", "active": True}, {"title": "Follow-up", "active": False}]
    assert first["rows"] == [{"header": "Name", "value": "Amina"}, {"header": "Village", "value": "West"}]
    assert second["tabs"][1]["active"] is True
    assert second["rows"] == [{"header": "Last visit", "value": "Monday"}]
    assert [tab["title"] for tab in other["tabs"]] == ["Visit"]
    assert [row["value"] for row in other["rows"]] == ["Baraka", "East"]
    assert west.page_errors == east.page_errors == []


def test_web_apps_lays_out_the_selected_cases_independent_details_grid(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from proof.observe.visit_layout_data import visits

    with webapps_hq.project(webapps_documents["tile-detail-layout"], "maximum") as project:
        with project.released(formplayer_runner, database=visits()) as release:
            run = Session(release, editor_driver).run([
                *_to_visits("detail-layout"), *_open_visit("east"),
                {"call": "webapps/case_layout", "arg": {"surface": "detail"}},
            ])
    cells = run.value(-1)["cells"]
    evidence("detail-grid", cells)
    assert [cell["value"] for cell in cells] == ["Baraka", "East", "Tuesday"]
    assert [cell["position"] for cell in cells] == ["1 / 1 / 2 / 13", "2 / 1 / 3 / 13", "3 / 1 / 4 / 13"]


def test_web_apps_shows_the_named_slots_in_layout_order(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from proof.observe.visit_layout_data import visits

    with webapps_hq.project(webapps_documents["tile-named-layout"], "maximum") as project:
        with project.released(formplayer_runner, database=visits()) as release:
            run = Session(release, editor_driver).run([*_to_visits("named-layout"), steps.SCREEN])
    listed = run.screens[0]["list"]
    assert listed["tiles"]
    west = next(row for row in listed["rows"] if row["id"] == "row-west")
    evidence("named-slots-west", west["cells"])
    # The list's hidden sort field rides the tile as a zero-width cell Web
    # Apps hides; the ten named positions are the cells it shows.
    shown = [cell for cell in west["cells"] if not cell["hidden"]]
    assert len(shown) == 10
    assert len(west["cells"]) - len(shown) == 1
    assert shown[0]["text"] == "Amina"
    assert shown[1]["text"] == "Village\u2005West"
    assert shown[-1]["text"] == "Visit part 7\u2005Amina 7"


def test_web_apps_keeps_the_selected_case_above_forms_and_expands_the_chosen_detail(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from proof.observe.visit_layout_data import visits

    observed = {}
    for scenario, values, expanded in (
        ("persistent-line", ["East"], None),
        ("persistent-inline", ["Baraka", "East", "Tuesday"], ["Baraka", "East", "Tuesday"]),
        ("persistent-external", ["Tuesday"], ["Tuesday"]),
    ):
        with webapps_hq.project(webapps_documents[f"tile-{scenario}"], "maximum") as project:
            with project.released(formplayer_runner, database=visits()) as release:
                select = _open_visit("east") if expanded else steps.select_case("east")
                actions = [*_to_visits(scenario), *select, steps.SCREEN,
                           {"call": "webapps/case_layout", "arg": {"surface": "form"}}]
                context_index = len(actions) - 1
                if expanded:
                    actions.extend([*steps.click("#persistent-case-tile .persistent-sticky", visible=True), steps.SCREEN])
                run = Session(release, editor_driver).run(actions)
                assert run.screens[0]["form"]["title"] == "Record visit"
                context = run.value(context_index)
                observed[scenario] = context
                assert [cell["value"] for cell in context["cells"]] == values
                assert context["expands"] is bool(expanded)
                if expanded:
                    assert [row["value"] for row in run.screens[1]["detail"]["rows"]] == expanded
                assert run.page_errors == []
    evidence("selected-case-above-form", observed)
