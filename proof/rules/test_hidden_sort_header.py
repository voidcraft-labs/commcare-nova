"""A hidden sort column in a Web Apps-only app: what Formplayer sends, and what its actual client renders."""

import pytest

from proof.checks import served
from proof.rules.hidden_sort_header import RULE
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


def _differences(before, after):
    def trace(response):
        return {"runs": [{"steps": [{"response": response}]}]}

    return served.formplayer_differences(
        trace(before), trace(after), check="proof3", document="doc", artifact="formplayer@B", rules=(RULE,)
    )


def test_only_the_blank_hidden_sort_header_of_a_table_is_equivalent():
    plain = {
        "type": "entities",
        "usesCaseTiles": False,
        "headers": ["Name", ""],
        "styles": [{"widthHint": -1}, {"widthHint": 0}],
        "widthHints": [50, 0],
        "sortIndices": [1],
    }
    blank = dict(plain, headers=["Name", "\u00a0"])
    assert _differences(blank, plain) == []
    for other in (
        {"type": "entity_detail"},
        {"usesCaseTiles": True},
        {"tiles": []},
        {"widthHints": [50, False]},
        {"widthHints": [50, 5]},
        {"styles": [{"widthHint": -1}, {"widthHint": 5}]},
        {"sortIndices": [0]},
        {"styles": []},
    ):
        assert _differences(blank | other, plain | other)
    assert _differences(dict(blank, headers=["Name", "Weight"]), plain)
    assert _differences(blank, dict(plain, sortIndices=[0]))


@pytest.mark.reader("webapps")
def test_web_apps_omits_both_blank_headers_for_a_zero_width_sort_column(
    rule_documents, hq, core_runner, formplayer_runner, editor_driver
):
    app = rule_documents["case-list-inline"]
    assert set(app.platforms()) == {"web-apps"}

    def spelling(named):
        def change(doc):
            short = doc["modules"][0]["case_details"]["short"]
            weight = next(column for column in short["columns"] if column["field"] == "weight")
            assert weight["format"] == "invisible"
            weight["header"] = {"en": ""}
            sort = next(rule for rule in short["sort_elements"] if rule["field"] == "weight")
            sort["display"] = {"en": "Weight" if named else ""}

        return change

    results = []
    with webapps_hq.project(app) as project:
        for named in (True, False):
            with project.released(formplayer_runner, label=f"blank-sort-{named}", change=spelling(named)) as release:
                run = Session(release, editor_driver).run(
                    [
                        *steps.open_app("Case list proof"),
                        *steps.choose("Patients & visits"),
                        *steps.type_prompt(0, "a"),
                        *steps.run_search(),
                        steps.SCREEN,
                        *steps.click("#case-list-config-button", visible=True),
                        {"call": "webapps/configurable-columns"},
                    ]
                )
                assert not run.page_errors
                handed = [
                    reply.json() for reply in run.answered("navigate_menu") if reply.json().get("type") == "entities"
                ][-1]
                shown = run.screens[0]["list"]
                results.append((handed, shown, run.value(-1)))
    (before, first, before_columns), (after, second, after_columns) = results
    changed = [i for i, (a, b) in enumerate(zip(before["headers"], after["headers"], strict=True)) if a != b]
    [index] = changed
    assert (before["headers"][index], after["headers"][index]) == ("\u00a0", "")
    assert before["sortIndices"] == after["sortIndices"] and index in before["sortIndices"]
    for handed in (before, after):
        assert handed["usesCaseTiles"] is False
        assert handed["widthHints"][index] == handed["styles"][index]["widthHint"] == 0
    visible = [i for i, hint in enumerate(before["widthHints"]) if hint != 0]
    assert visible and [h["text"] for h in first["headers"]] == [before["headers"][i] for i in visible]
    assert first["rows"] and all(len(row["cells"]) == len(visible) for row in first["rows"])
    assert first == second
    assert before_columns == after_columns == visible
    # A changed table header from these native replies compares equal only under this rule.
    keys = ("type", "usesCaseTiles", "tiles", "headers", "widthHints", "styles", "sortIndices")
    assert not _differences({k: before[k] for k in keys}, {k: after[k] for k in keys})
