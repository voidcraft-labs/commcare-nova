"""An invisible column's blank Android Sort by entry still belongs to one specific source rule."""

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from proof.checks import android, blank_sort, changes, served_places
from proof.observe.record import Blobs

KEY = "m0.case_short.case_visits_2.header"
OPTIONS = "EntitySelectActivity.getSortOptionsList"
BLANK = "(v) \u00a0"
PLACE = ("menu", "0", "case_details", "short", "sort_elements", "0", "display")


def _source():
    column = {"model": "case", "format": "invisible", "field": "visits", "header": {"en": ""}}
    sort = {"field": "visits", "type": "int", "direction": "descending", "blanks": "last", "display": {"en": "Visits"}}
    short = {"columns": [{"field": "name"}, column, {"field": "count"}], "sort_elements": [sort]}
    return {"modules": [{"case_details": {"short": short}}]}


def _files(original):
    label = f'<locale id="{KEY}"/>' if original else ""
    suite = f"""<suite><menu id="m0"><command id="m0-f0"/></menu>
        <entry><command id="m0-f0"/><session><datum id="case_id" detail-select="m0_case_short"/></session></entry>
        <detail id="m0_case_short"><field><header><text>Name</text></header></field>
        <field><header width="0"><text>{label}</text></header><template width="0"><text><xpath function="visits"/></text></template>
        <sort type="int" order="1" direction="descending" blanks="last"><text><xpath function="visits"/></text></sort></field>
        <field><header><text>Count</text></header></field></detail></suite>"""
    return {"suite.xml": suite.encode(), "default/app_strings.txt": f"{KEY}=\u00a0\n" if original else ""}


def _device(original):
    options = ["Name", BLANK, "Count"] if original else ["Name", "Count"]
    rows = ["10", "10", "2"]
    tapped = {"Name": ["10", "2", "10"], BLANK: rows, "Count": ["2", "10", "10"]}
    held = {
        OPTIONS: options,
        "order": ["a", "b", "c"],
        "rows": [{"children": [{"text": cell}]} for cell in rows],
        "sorted": [{"option": name, "rows": list(tapped[name])} for name in options],
    }
    step = {"screen": "EntitySelectActivity", "session": {"command": "m0", "datum": "case_id"}, "list": held}
    return {"install": "Installed", "walks": {"cases": {"steps": [step]}}}


def _step(device):
    return device["walks"]["cases"]["steps"][0]


def _differences(a, b):
    return android.app_differences(a, b, check="proof3", document="hq-case-lists", artifact="android@B")


def test_annotated_blank_choice_and_its_actual_tap_are_located_at_the_disclosed_sort_on_each_release():
    a, b = _device(True), _device(False)
    before, after = _files(True), _files(False)
    doc = SimpleNamespace(kind="corpus", hq_authored=True, hq_side=None)
    blobs = Blobs()
    authored = {"source": {"status": 200, "body": json.dumps(_source())}}
    parts = SimpleNamespace(
        a={"apiReads": {"authored": authored}, "hooks": {"served": {"A": {"android": {"answer": blobs.put_json(a)}}}}},
        b_aligned={
            "served": {
                "B": {"android": {"answer": blobs.put_json(b)}},
                "local": {"androidDelivered": {"answer": blobs.put_json(b)}},
            }
        },
    )
    records = SimpleNamespace(blobs=blobs, configurations={"minimum": parts})
    observed = SimpleNamespace(
        a=SimpleNamespace(build=SimpleNamespace(files=before)), b_aligned=SimpleNamespace(files=after)
    )
    for side in ("B", "local.ccz"):
        rows = [replace(d, artifact=f"android@{side}") for d in _differences(a, b)]
        places = served_places.sites(records, "minimum", rows, observed, after, document=doc)
        classified = served_places.classify(doc, records, "minimum", rows, places)
        assert [(d.path, d.kind, changes.locate(d, places)) for d in classified] == [
            (blank_sort.OPTIONS + ":blank-sort-name", "changed", PLACE),
            (blank_sort.SORTED + ":blank-sort-name", "removed", PLACE),
        ]


@pytest.mark.parametrize(
    "change",
    [
        "sibling value",
        "sibling row order",
        "sibling option order",
        "tied case order",
        "lost tap",
        "wrong removed rows",
        "other menu",
    ],
)
def test_another_change_in_the_native_sort_list_cannot_be_declared_as_the_blank_choice(change):
    a, b = _device(True), _device(False)
    old, new = (_step(device)["list"] for device in (a, b))
    if change == "sibling value":
        new["sorted"][0]["rows"][0] = "other"
    elif change == "sibling row order":
        new["sorted"][0]["rows"] = ["10", "10", "2"]
    elif change == "sibling option order":
        new[OPTIONS].reverse()
        new["sorted"].reverse()
    elif change == "tied case order":
        new["order"][:2] = ["b", "a"]
    elif change == "lost tap":
        new["sorted"].pop()
    elif change == "wrong removed rows":
        old["sorted"][1]["rows"].reverse()
    else:
        _step(b)["session"]["command"] = "m0-case-list"
    rows = _differences(a, b)
    assert any(blank_sort.candidate(d) for d in rows)
    assert not blank_sort.locations(rows, _source(), a, b, _files(True), _files(False))


@pytest.mark.parametrize(
    "change",
    [
        "visible header",
        "other property",
        "second matching column",
        "other locale",
        "named translation",
        "changed order",
        "changed expression",
        "different release",
    ],
)
def test_real_blank_native_label_requires_the_same_installed_column_resource_and_unchanged_order(change):
    a, b = _device(True), _device(False)
    source = _source()
    short = source["modules"][0]["case_details"]["short"]
    before, after = _files(True), _files(False)
    differing = []
    if change == "visible header":
        short["columns"][1]["header"]["en"] = "Visits"
    elif change == "other property":
        short["sort_elements"][0]["field"] = "count"
    elif change == "second matching column":
        short["columns"].append(short["columns"][1])
    elif change == "other locale":
        before["suite.xml"] = before["suite.xml"].replace(KEY.encode(), b"m0.case_short.case_count_3.header")
    elif change == "named translation":
        before["en/app_strings.txt"] = f"{KEY}=Visits"
    elif change == "changed order":
        after["suite.xml"] = after["suite.xml"].replace(b'direction="descending"', b'direction="ascending"')
    elif change == "changed expression":
        after["suite.xml"] = after["suite.xml"].replace(b'function="visits"', b'function="count"')
    else:
        differing = ["suite.xml"]
    assert not blank_sort.locations(_differences(a, b), source, a, b, before, after, differing=differing)


def test_a_difference_from_another_row_cannot_borrow_the_native_source_witness():
    a, b = _device(True), _device(False)
    options, removed = _differences(a, b)
    borrowed = [
        replace(options, after="Count"),
        replace(removed, before="wrong"),
        replace(removed, after="wrong"),
        replace(removed, at=removed.at.replace(BLANK, "Count")),
    ]
    assert not blank_sort.locations(borrowed, _source(), a, b, _files(True), _files(False))
