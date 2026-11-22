import json
from dataclasses import replace
from xml.sax.saxutils import quoteattr

import pytest

from proof.checks.differences import Difference
from proof.checks.native_constraint_helpers import (
    COUNT,
    MESSAGE,
    OPEN,
    SENT,
    helper_sites,
)

FILE = "modules-1/forms-2.xml"
COUNT_NODE = "nova_constraint_adults_0"
MSG_NODE = "nova_constraint_message_kids"
MESSAGE_ID = "kids-message"
PLACES = {
    COUNT: ["/form/1.2/xform/data/" + n for n in ("adults", COUNT_NODE)],
    MESSAGE: ["/form/1.2/xform/data/" + n for n in ("kids", MSG_NODE)],
}
COUNT_EXPRESSION = "count(/data/people/name[. != ''])"
# A language's original visible text and interpolation. This is also the protected group's default.
TEXT = '<value>Asked <output value="/data/kids"/> times</value>'


def installed(side):
    a = side == "a"
    namespace = "urn:" + side
    suite = (
        f'<suite><xform><resource><location authority="local">{FILE}</location></resource></xform>'
        f'<entry><command id="m1-f2"/><form>{namespace}</form></entry></suite>'
    )
    parts = {
        "__nova_identity": MESSAGE_ID,
        "__nova_mode": "plain",
        "__nova_locale": "en",
        "__nova_piece_0": json.dumps({"v": "Asked "}),
        "__nova_piece_2": json.dumps({"v": " times"}),
    }
    parts.update({k + ";markdown": v for k, v in parts.items() if k != "__nova_identity"})
    extra = "" if a else "".join(f'<value form="{n}">{v}</value>' for n, v in parts.items())
    label = f"jr:itext('{MESSAGE_ID}')"
    combined = (
        f"if(jr:itext('{MESSAGE_ID};__nova_mode')='media', {label}, if(count(/data/kids)>1,'', "
        f"concat(json-property(jr:itext('{MESSAGE_ID};__nova_piece_0'), 'v'), /data/kids, "
        f"json-property(jr:itext('{MESSAGE_ID};__nova_piece_2'), 'v'))))"
    )
    hidden = "" if a else f"<{COUNT_NODE}/><{MSG_NODE}/>"
    binds = (
        ""
        if a
        else (
            f'<bind type="xsd:int" nodeset="/data/{COUNT_NODE}" relevant="count(/data/adults) > 0"'
            f" calculate={quoteattr(COUNT_EXPRESSION.replace('. !=', './. !='))}/>"
            f'<bind type="xsd:string" nodeset="/data/{MSG_NODE}" relevant="false()" readonly="true()"/>'
        )
    )
    control = "" if a else f'<input ref="/data/{MSG_NODE}"><label ref={quoteattr(label)}/></input>'
    calc = ". <= " + (COUNT_EXPRESSION if a else f"/data/{COUNT_NODE}")
    xml = f'''<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
        xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:jr="http://openrosa.org/javarosa">
    <h:head><h:title>Example</h:title><model><instance><data xmlns="{namespace}">
        <people><name/></people><adults/><kids/>{hidden}</data></instance>
    <bind nodeset="/data/adults" type="xsd:int" constraint={quoteattr(calc)}/>
    <bind nodeset="/data/kids" type="xsd:int" constraint=". >= 0"
          jr:constraintMsg={quoteattr(label if a else combined)}/>
    {binds}<itext><translation lang="en"><text id="{MESSAGE_ID}">{TEXT}{extra}</text></translation></itext>
    </model></h:head><h:body><input ref="/data/adults"/><input ref="/data/kids"/>{control}</h:body></h:html>'''
    return {"suite.xml": suite, FILE: xml}


def trace(side, *, count="2", message="", extra=""):
    helpers = "" if side == "a" else f"<{COUNT_NODE}>{count}</{COUNT_NODE}><{MSG_NODE}>{message}</{MSG_NODE}>"
    xml = (
        f'<data xmlns="urn:{side}"><people><name>A</name></people><people><name>B</name></people>'
        f"<people><name/></people><adults>2</adults><kids/>{helpers}{extra}</data>"
    )
    return {
        "runs": [
            {
                "script": [{"menu": 1}, {"menu": 2}],
                "steps": [
                    {"response": {"instanceXml": {"output": xml}}},
                    {"submissions": [{"instance": xml}]},
                ],
            }
        ]
    }


def row(node, value, *, submit=False):
    path = (SENT if submit else OPEN) + ("nova_constraint_*[*]" if node == COUNT_NODE else "*")
    at = ("1/submissions/0/instance" if submit else "0/response/instanceXml/output") + f"/data/{node}[1]"
    return Difference(
        "proof3",
        "example",
        "formplayer@B",
        path,
        "/runs/0/steps/" + at,
        "added",
        None,
        f'<{node} xmlns="urn:b">{value}</{node}>',
    )


def observe(rows, **replace):
    args = {
        "before_files": installed("a"),
        "after_files": installed("b"),
        "before_trace": trace("a"),
        "after_trace": trace("b"),
        "declared": PLACES,
    }
    return helper_sites(rows, **(args | replace))


def test_native_open_and_submission_counts_match_the_same_observed_nonempty_members_and_empty_hidden_message():
    rows = [row(COUNT_NODE, "2"), row(COUNT_NODE, "2", submit=True), row(MSG_NODE, "")]
    sites, witnessed = observe(rows)
    assert [d.path for d in witnessed] == [
        d.path + suffix
        for d, suffix in zip(
            rows,
            (":reviewed-count", ":reviewed-count", ":reviewed-message"),
            strict=True,
        )
    ]
    assert [sites[(d.artifact, d.at)] for d in witnessed] == [
        ("form", "1.2", "xform", "data", name) for name in (COUNT_NODE, COUNT_NODE, MSG_NODE)
    ]


@pytest.mark.parametrize(
    "change",
    [
        "wrong-value",
        "misreported-value",
        "different-collection",
        "altered-rule",
        "unmentioned-source",
        "wrong-namespace",
        "wrong-command",
        "old-helper",
        "ambiguous-child",
        "written-by-event",
        "wrong-release",
        "wrong-session",
        "wrong-ordinal",
        "visible-count",
        "orphan-helper",
    ],
)
def test_other_counts_never_acquire_the_declared_validation(change):
    rows = [row(COUNT_NODE, "5" if change == "wrong-value" else "2")]
    changes = {}
    b = installed("b")
    if change == "wrong-value":
        changes["after_trace"] = trace("b", count="5")
    elif change == "misreported-value":
        changes["after_trace"] = trace("b", count="3")
    elif change == "different-collection":
        changes["before_trace"] = trace("a", extra="<people><name>Additional</name></people>")
    elif change == "altered-rule":
        b[FILE] = b[FILE].replace("count(/data/people/name[", "count(/data/other/name[")
    elif change == "unmentioned-source":
        changes["declared"] = {COUNT: [PLACES[COUNT][-1]]}
    elif change == "wrong-namespace":
        b["suite.xml"] = b["suite.xml"].replace("urn:b", "urn:a")
    elif change == "wrong-command":
        b["suite.xml"] = b["suite.xml"].replace("m1-f2", "m1-f3")
    elif change == "old-helper":
        a = installed("a")
        a[FILE] = a[FILE].replace("</data>", f"<{COUNT_NODE}/></data>")
        changes["before_files"] = a
    elif change == "ambiguous-child":
        changes["after_trace"] = trace("b", extra=f"<{COUNT_NODE}>2</{COUNT_NODE}>")
    elif change == "written-by-event":
        b[FILE] = b[FILE].replace("</model>", f'<setvalue ref="/data/{COUNT_NODE}" value="2"/></model>')
    elif change == "wrong-release":
        changes["after_differing"] = [FILE]
    elif change == "wrong-session":
        changed = trace("b")
        changed["runs"][0]["script"] = [{"menu": 7}]
        changes["after_trace"] = changed
    elif change == "orphan-helper":
        # The release actually points at an unmodified form. A plausible orphan at the
        # conventional path, even with that same namespace, can never explain a worker's result.
        b["serves/original.xml"] = installed("a")[FILE].replace("urn:a", "urn:b")
        b["suite.xml"] = b["suite.xml"].replace(FILE, "serves/original.xml")
    elif change == "wrong-ordinal":
        rows = [replace(rows[0], at=rows[0].at[:-3] + "[2]")]
    else:
        b[FILE] = b[FILE].replace("</h:body>", f'<input ref="/data/{COUNT_NODE}"/></h:body>')
    assert observe(rows, after_files=b, **changes) == ({}, rows)


@pytest.mark.parametrize(
    "change",
    [
        "holder-value",
        "holder-markup",
        "visible",
        "wrong-rule",
        "wrong-fragment",
        "wrong-output",
        "wrong-label",
        "wrong-owner",
    ],
)
def test_an_authored_or_changed_constraint_message_is_unexplained(change):
    rows = [row(MSG_NODE, "extra" if change == "holder-value" else "")]
    changes = {}
    b = installed("b")
    if change == "holder-value":
        changes["after_trace"] = trace("b", message="extra")
    elif change == "holder-markup":
        changes["after_trace"] = trace("b", message="<other/>")
    elif change == "visible":
        b[FILE] = b[FILE].replace('relevant="false()"', 'relevant="true()"')
    elif change == "wrong-rule":
        b[FILE] = b[FILE].replace("if(count(/data/kids)&gt;1", "if(count(/data/kids)&gt;2")
    elif change == "wrong-fragment":
        b[FILE] = b[FILE].replace('{"v": "Asked "}', '{"v": "Changed "}')
    elif change == "wrong-output":
        b[FILE] = b[FILE].replace('<output value="/data/kids"/>', '<output value="/data/adults"/>')
    elif change == "wrong-label":
        b[FILE] = b[FILE].replace(
            "<label ref=\"jr:itext('kids-message')\"/>",
            "<label ref=\"jr:itext('other')\"/>",
        )
    else:
        changes["declared"] = {MESSAGE: [PLACES[MESSAGE][-1], "/form/1.2/xform/data/adults"]}
    assert observe(rows, after_files=b, **changes) == ({}, rows)


@pytest.mark.parametrize(("helper", "source", "value"), [(COUNT_NODE, "adults", "2"), (MSG_NODE, "kids", "")])
@pytest.mark.parametrize(("side", "duplicate"), [("b", "helper"), ("b", "source"), ("a", "source")])
def test_two_installed_nodes_cannot_own_one_native_observation(helper, source, value, side, duplicate):
    name = source if duplicate == "source" else helper
    files = installed(side)
    files[FILE] = files[FILE].replace("</data>", f"<{name}>Previously authored</{name}></data>")
    rows = [row(helper, value)]
    assert observe(rows, **{("before_files" if side == "a" else "after_files"): files}) == ({}, rows)


def test_received_count_cannot_come_from_an_irrelevant_helper_when_its_validated_question_is_absent():
    a, b = trace("a"), trace("b")
    for side in (a, b):
        receipt = side["runs"][0]["steps"][1]["submissions"][0]
        receipt["instance"] = receipt["instance"].replace("<adults>2</adults>", "")
    rows = [row(COUNT_NODE, "2", submit=True)]
    assert observe(rows, before_trace=a, after_trace=b) == ({}, rows)


@pytest.mark.parametrize(
    "side, inserted",
    [
        ("b", f'<bind nodeset="{MSG_NODE}" relevant="true()"/>'),
        ("b", '<bind nodeset="./kids" constraint="false()"/>'),
        ("a", '<bind xmlns="urn:foreign" nodeset="./kids" constraint="false()"/>'),
        ("b", f'<setvalue ref="data/{MSG_NODE}" value="1"/>'),
        ("b", f'<setvalue xmlns="urn:foreign" ref="/data/{MSG_NODE}" value="1"/>'),
        ("a", '<bind id="other" nodeset="kids"/><setvalue bind="other" value="1"/>'),
    ],
)
def test_runtime_alias_bind_or_action_cannot_own_one_reviewed_message(side, inserted):
    files = installed(side)
    files[FILE] = files[FILE].replace("</model>", inserted + "</model>")
    rows = [row(MSG_NODE, "")]
    assert observe(rows, **{("before_files" if side == "a" else "after_files"): files}) == ({}, rows)


@pytest.mark.parametrize(
    "variant", ["same", "changed-default", "duplicate-language", "duplicate-default", "changed-translation"]
)
def test_message_must_preserve_the_default_language_and_each_languages_original_interpolation(variant):
    from copy import deepcopy

    from lxml import etree

    from proof.checks.native_constraint_helpers import XF

    sides = {}
    for side in ("a", "b"):
        files = installed(side)
        root = etree.fromstring(files[FILE].encode())
        en = root.find(".//" + XF + "translation")
        fr = deepcopy(en)
        fr.set("lang", "fr")
        if variant == "changed-default" and side == "b":
            fr.set("default", "")
        if variant == "duplicate-default" and side == "a":
            en.set("default", "")
            fr.set("default", "")
        message = fr.find(XF + "text")
        message.find(XF + "value").text = "Demande "
        for value in message.findall(XF + "value"):
            form = value.get("form") or ""
            if form.startswith("__nova_locale"):
                value.text = "fr"
            elif form.startswith("__nova_piece_0"):
                value.text = json.dumps({"v": "Changed " if variant == "changed-translation" else "Demande "})
        en.getparent().append(fr)
        if variant == "duplicate-language" and side == "a":
            en.getparent().append(deepcopy(fr))
        files[FILE] = etree.tostring(root)
        sides["before_files" if side == "a" else "after_files"] = files
    rows = [row(MSG_NODE, "")]
    sites, found = observe(rows, **sides)
    assert bool(sites) == (variant == "same")
    assert (found == rows) == (variant != "same")


@pytest.mark.parametrize(
    "side, target, classified", [("a", MESSAGE_ID, True), ("a", "different", False), ("b", MESSAGE_ID, False)]
)
def test_the_alert_core_prefers_over_a_bind_must_preserve_the_original_message(side, target, classified):
    files = installed(side)
    control = '<input ref="/data/kids"/>'
    files[FILE] = files[FILE].replace(control, f'<input ref="/data/kids"><alert ref="jr:itext(\'{target}\')"/></input>')
    sites, _ = observe([row(MSG_NODE, "")], **{("before_files" if side == "a" else "after_files"): files})
    assert bool(sites) == classified
