"""Every appearance an app made in CommCare HQ holds is sorted into an inventory row by the lane, apart from Nova's
reader.

Contract (``proof.checks.appearance_rows.row_of``): the lane puts each appearance on a body element in one row of
the inventory, read from the row's own predicate and the upstream readers, and parity joins Nova's reader on that
row (``proof.checks.parity.join``). Every appearance a retained base exhibits (``proof/hq-apps/<base>/``) is
decided: an appearance the lane cannot sort would leave parity blind there, so it fails here, by base, place and
value. The plausible failures: a row the classifier never names (a value parity silently skips), a group Core
takes for its repeat (``XFormParser.collapseRepeatGroups``) read as a plain group, and an order or a case the
inventory's predicate does not care about read as another row.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from lxml import etree

from proof.checks import appearance_rows, manifest_usage, parity
from proof.checks.manifest_value_classes import Form

ROOT = Path(__file__).resolve().parents[1]
BASES = json.loads((ROOT / "matrix" / "bases.json").read_text(encoding="utf-8"))


def _forms(base):
    stored = json.loads((ROOT / "hq-apps" / base / "app-source.json").read_text(encoding="utf-8"))
    body = stored.get("body", stored)
    body = json.loads(body) if isinstance(body, str) else body
    return [document for document in parity.source_uses(body).documents if isinstance(document, Form)]


@pytest.mark.parametrize("base", BASES)
def test_every_appearance_a_retained_base_holds_is_in_a_row_the_lane_decides(base):
    manifest = parity.manifest()
    undecided = [
        f"{form.artifact}{manifest_usage._element_path(element)}/@appearance={element.get('appearance')!r}"
        for form in _forms(base)
        if form.body is not None
        for element in form.body_elements
        if element.get("appearance") is not None and appearance_rows.row_of(manifest, form, element) is None
    ]
    assert not undecided, (
        f"The lane sorts no inventory row for these appearances of {base}, so parity cannot judge them: "
        f"{undecided}. Teach proof/checks/appearance_rows.py::row_of the row each is in, from the row's predicate "
        "in lib/commcare/surface/entries/questions.json and the readers it names."
    )


XFORM = """<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
<h:head><model><instance><data><a/><g><n/><r><q/></r></g><p><w><r2><q2/></r2></w></p><s/><d/></data></instance>
<bind nodeset="/data/a" type="xsd:string"/><bind nodeset="/data/s" type="xsd:string"/>
<bind nodeset="/data/d" type="xsd:date"/></model></h:head>
<h:body>
<input ref="/data/a" appearance="{text}"><label>A</label></input>
<group ref="/data/g" appearance="{wrapped}"><label>G</label><input ref="/data/g/n"/><repeat nodeset="/data/g/r"><input ref="/data/g/r/q"/></repeat></group>
<group ref="/data/p" appearance="{outer}"><label>P</label><group ref="/data/p/w"><label>W</label><repeat nodeset="/data/p/w/r2"><input ref="/data/p/w/r2/q2"/></repeat></group></group>
<select1 ref="/data/s" appearance="{select}"><label>S</label><item><label>x</label><value>x</value></item></select1>
<input ref="/data/d" appearance="{date}"><label>D</label></input>
</h:body></h:html>"""


def _rows(**values):
    defaults = {"text": "short", "wrapped": "2-per-row-repeat", "outer": "2-per-row-repeat", "select": "minimal",
                "date": "ethiopian"}
    form = Form(etree.fromstring(XFORM.format(**{**defaults, **values}).encode()), "form:0.0")
    manifest = parity.manifest()
    return {
        element.get("ref"): appearance_rows.row_of(manifest, form, element)
        for element in form.body_elements
        if element.get("appearance") is not None
    }


def test_a_group_core_takes_for_its_repeat_is_the_repeat_and_the_group_around_it_holds_the_rows():
    rows = _rows()
    # A group holding a question and the repeat itself holds its rows; a group whose one form element is the
    # repeat Core collapses into it (Vellum's Repeat), so the group around that one holds the repeat's rows.
    assert rows["/data/g"] == "questions/n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or"
    assert rows["/data/p"] == "questions/n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or"
    assert _rows(outer="group-border")["/data/p"] == "questions/group-group-border"


def test_a_select_s_grid_and_auto_advance_are_one_row_in_either_order_and_other_words_make_several():
    for value in ("quick compact-2", "compact-2 quick", "quick compact", "compact quick"):
        assert _rows(select=value)["/data/s"] == "questions/select1-quick-compact-n", value
    assert _rows(select="compact2")["/data/s"] == "questions/a-single-string-no-row-names-that-holds-values-android-matches"
    assert _rows(select="minimal hint-as-placeholder")["/data/s"] == (
        "questions/multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2"
    )
    assert _rows(select="minimal hint-as-placeholder foo")["/data/s"] == (
        "questions/a-multi-token-string-holding-tokens-no-runtime-reads-on-that"
    )


def test_a_case_variant_is_its_own_row_and_an_unknown_value_is_one_no_runtime_reads():
    assert _rows(text="Numbers")["/data/a"] == "questions/a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of"
    assert _rows(date="Ethiopian")["/data/d"] == "questions/a-case-variant-of-numeric-short-or-ethiopian-as-the-whole"
    assert _rows(text="1x2-per-row")["/data/a"] == "questions/any-other-per-row-token-the-first-token-web-apps-per-row-pattern"
    assert _rows(text="frobnicate")["/data/a"] == "questions/any-other-value-read-by-no-runtime-not-an-intent-value-on-an"


UNTYPED = """<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
<h:head><model><instance><data><t/><s/><ts/></data></instance>
<bind nodeset="/data/ts" type="xsd:string"/></model></h:head>
<h:body>
<input ref="/data/t" appearance="{text}"><label>T</label></input>
<secret ref="/data/s" appearance="{secret}"><label>S</label></secret>
<secret ref="/data/ts" appearance="{typed}"><label>TS</label></secret>
</h:body></h:html>"""


@pytest.mark.parametrize("value", ["numeric", "numbers", "NUMBERS", "Numeric"])
def test_an_untyped_text_box_or_secret_with_numeric_or_numbers_is_its_own_row_in_any_case(value):
    form = Form(etree.fromstring(UNTYPED.format(text=value, secret=value, typed="numeric").encode()), "form:0.0")
    manifest = parity.manifest()
    rows = {
        element.get("ref"): appearance_rows.row_of(manifest, form, element)
        for element in form.body_elements
    }
    assert rows["/data/t"] == "questions/an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring"
    assert rows["/data/s"] == "questions/a-secret-whose-bind-has-no-type-with-numeric-or-numbers-ignoring"
    # The control a typed secret is: its own row, which the untyped rows never take.
    assert rows["/data/ts"] == "questions/secret-numeric"


def _string_constants(code):
    for const in code.co_consts:
        if isinstance(const, str):
            yield const
        elif hasattr(const, "co_consts"):
            yield from _string_constants(const)


def test_every_row_the_classifier_names_is_an_inventory_row():
    """A row id the classifier returns that the inventory lacks reads as no standing, so parity judges nothing
    there: every row-shaped string the module holds is a row of ``questions.json``."""
    import inspect
    import types

    entries = json.loads((ROOT.parent / "lib" / "commcare" / "surface" / "entries" / "questions.json").read_text())
    ids = {entry["id"] for entry in entries}
    named = set()
    for _, value in inspect.getmembers(appearance_rows):
        if isinstance(value, types.FunctionType) and value.__module__ == appearance_rows.__name__:
            named.update(_string_constants(value.__code__))
        elif isinstance(value, dict):
            for inner in value.values():
                named.update(inner.values() if isinstance(inner, dict) else [inner] if isinstance(inner, str) else [])
        elif isinstance(value, (tuple, list)):
            for item in value:
                if isinstance(item, tuple):
                    named.update(part for part in item if isinstance(part, str))
    rows = {
        name.removeprefix("questions/")
        for name in named
        if isinstance(name, str) and name.count("-") >= 4 and " " not in name and "." not in name and "*" not in name
    }
    missing = sorted(row for row in rows if f"questions/{row}" not in ids)
    assert not missing, f"The classifier names rows the inventory does not hold: {missing}"
