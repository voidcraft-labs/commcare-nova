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


def installed(side, *, output="/data/kids", message_id=MESSAGE_ID):
    text = f"<value>Asked <output value={quoteattr(output)}/> times</value>"
    a = side == "a"
    namespace = "urn:" + side
    suite = (
        f'<suite><xform><resource><location authority="local">{FILE}</location></resource></xform>'
        f'<entry><command id="m1-f2"/><form>{namespace}</form></entry></suite>'
    )
    parts = {
        "__nova_identity": message_id,
        "__nova_mode": "plain",
        "__nova_locale": "en",
        "__nova_piece_0": json.dumps({"v": "Asked "}),
        "__nova_piece_2": json.dumps({"v": " times"}),
    }
    parts.update({k + ";markdown": v for k, v in parts.items() if k != "__nova_identity"})
    extra = "" if a else "".join(f'<value form="{n}">{v}</value>' for n, v in parts.items())
    label = f"jr:itext('{message_id}')"
    combined = (
        f"if(jr:itext('{message_id};__nova_mode')='media', {label}, if(count({output})>1,'', "
        f"concat(json-property(jr:itext('{message_id};__nova_piece_0'), 'v'), {output}, "
        f"json-property(jr:itext('{message_id};__nova_piece_2'), 'v'))))"
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
    {binds}<itext><translation lang="en"><text id="{message_id}">{text}{extra}</text></translation></itext>
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


CASE_ID_READ = "instance('commcaresession')/session/data/case_id"
NAME_READ = f"instance('casedb')/casedb/case[@case_id = {CASE_ID_READ}]/case_name"
CASE_BLOCK = '<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="patient-1"/>'
GROUP = "/data/visit/totals"
CASE_PLACES = {MESSAGE: ["/form/1.2/xform" + GROUP + "/" + name for name in ("kids", MSG_NODE)]}


def case_opening(side):
    # The old alert and protected expression can use different itext ids. The opening
    # records the chosen case and, in another group, the scalar both messages interpolate.
    old = side == "a"
    message = "visit/totals/kids-alert" if old else "visit-totals-kids-alert"
    files = installed(side, output=NAME_READ, message_id=message)
    helper = "" if old else f"<{MSG_NODE}/>"
    group = f"<visit><totals><kids/>{helper}</totals></visit>"
    template = group + "<loaded><name/></loaded>" + CASE_BLOCK.replace("patient-1", "")
    xml = files[FILE].replace(f"<{MSG_NODE}/>", "").replace("<kids/>", template)
    xml = xml.replace("/data/kids", GROUP + "/kids").replace("/data/" + MSG_NODE, GROUP + "/" + MSG_NODE)
    control = f'<input ref="{GROUP}/kids"'
    xml = xml.replace(control, f'<group ref="/data/visit"><group ref="{GROUP}">{control}')
    if old:
        xml = xml.replace(f"{control}/>", f"{control}><alert ref=\"jr:itext('{message}')\"/></input>")
    files[FILE] = xml.replace("</h:body>", "</group></group></h:body>").replace(
        "</instance>",
        '</instance><instance id="casedb" src="jr://instance/casedb"/>'
        '<instance id="commcaresession" src="jr://instance/session"/>'
        f'<bind nodeset="/data/case/@case_id" calculate="{CASE_ID_READ}"/>'
        '<bind nodeset="/data/loaded/name" type="xsd:string"/>'
        f'<setvalue ref="/data/loaded/name" event="xforms-ready" value="{NAME_READ}"/>',
    )
    native = f'<data xmlns="urn:{side}">{group}<loaded><name>Mary</name></loaded>{CASE_BLOCK}</data>'
    return files, native


def case_rows(a, b, *, at=None, declared=CASE_PLACES):
    def opening(native):
        return {
            "runs": [
                {"script": [{"entity": "patient-1"}], "steps": [{"response": {"instanceXml": {"output": native}}}]}
            ]
        }

    d = row(MSG_NODE, "")
    d = replace(d, at=d.at.replace("/data/", "/data/visit[1]/totals[1]/") if at is None else at)
    sites, [found] = helper_sites(
        [d],
        before_files=a[0],
        after_files=b[0],
        before_trace=opening(a[1]),
        after_trace=opening(b[1]),
        declared=declared,
    )
    return sites.get((d.artifact, d.at)), found.path


def test_nested_carrier_matches_both_installed_messages_and_the_selected_cases_native_name():
    a, b = case_opening("a"), case_opening("b")
    assert case_rows(a, b) == (
        ("form", "1.2", "xform", "data", "visit", "totals", MSG_NODE),
        OPEN + "*:reviewed-message",
    )
    at = row(MSG_NODE, "").at.replace("/data/", "/data/visit[1]/totals[2]/")
    assert case_rows(a, b, at=at) == (None, OPEN + "*")
    places = [p.replace("/visit/", "/another/") if p.endswith("/kids") else p for p in CASE_PLACES[MESSAGE]]
    assert case_rows(a, b, declared={MESSAGE: places}) == (None, OPEN + "*")


@pytest.mark.parametrize(
    "record, original, replacement",
    [
        ("opening", "<totals>", "<totals/><totals>"),
        ("opening", "<visit>", '<visit xmlns="urn:foreign"/><visit>'),
        ("opening", "<kids/>", "<kids>different</kids>"),
        ("opening", f"<{MSG_NODE}/>", f"<{MSG_NODE}>written</{MSG_NODE}>"),
        ("opening", "<name>Mary</name>", "<name>Ed</name>"),
        ("opening", 'case_id="patient-1"', 'case_id="patient-2"'),
        ("installed", 'src="jr://instance/casedb"', 'src="jr://instance/fixture"'),
        ("installed", f'calculate="{CASE_ID_READ}"', 'calculate="/data/other"'),
        ("installed", f'event="xforms-ready" value="{NAME_READ}"', 'event="xforms-ready" value="/data/unrelated"'),
        ("installed", 'event="xforms-ready"', 'event="xforms-revalidate"'),
        ("installed", "</model>", '<setvalue ref="data/loaded/name" value="\'different\'"/></model>'),
        ("installed", '<group ref="/data/visit">', '<group ref="/data/visit"><repeat nodeset="/data/visit"/>'),
        ("installed", "<totals>", "<totals/><totals>"),
    ],
)
def test_another_case_field_occurrence_or_value_cannot_explain_the_reported_empty_carrier(
    record, original, replacement
):
    a, (files, native) = case_opening("a"), case_opening("b")
    if record == "installed":
        assert original in files[FILE]
        files[FILE] = files[FILE].replace(original, replacement)
    else:
        assert original in native
        native = native.replace(original, replacement)
    assert case_rows(a, (files, native)) == (None, OPEN + "*")


@pytest.mark.parametrize("side", ["a", "b"])
@pytest.mark.parametrize("form", ["bind", "relative"])
@pytest.mark.parametrize("target", ["visit/totals", "loaded", "people"])
def test_repeat_binding_on_either_installation_cannot_own_the_message_or_its_scalar_preload(side, form, target):
    records = {s: case_opening(s) for s in ("a", "b")}
    files, _ = records[side]
    if form == "bind":
        # The bind takes precedence over the repeat's own nodeset and uses the model's data root.
        xml = files[FILE].replace("</model>", f'<bind id="rows" nodeset="./{target}"/></model>')
        repeat = '<group ref="/data/people"><repeat bind="rows" nodeset="/data/people"/></group>'
    else:
        parent, _, leaf = target.rpartition("/")
        context = "/data/" + parent if parent else "/data"
        xml = files[FILE]
        repeat = f'<group ref="{context}"><group><repeat nodeset="./{leaf}"/></group></group>'
    files[FILE] = xml.replace("</h:body>", repeat + "</h:body>")
    assert bool(case_rows(records["a"], records["b"])[0]) == (target == "people")


@pytest.mark.parametrize("side", ["a", "b"])
@pytest.mark.parametrize("target", ["loaded/name", "visit/totals/kids", f"visit/totals/{MSG_NODE}"])
def test_a_relative_input_cannot_edit_the_preload_or_duplicate_a_source_or_carrier_control(side, target):
    records = {s: case_opening(s) for s in ("a", "b")}
    files, _ = records[side]
    parent, _, field = target.rpartition("/")
    control = f'<group ref="{parent}"><input ref="./{field}"/></group>'
    files[FILE] = files[FILE].replace("</h:body>", control + "</h:body>")
    assert case_rows(records["a"], records["b"]) == (None, OPEN + "*")


@pytest.mark.parametrize("separate_id", [False, True])
def test_an_original_alerts_long_text_in_another_language_cannot_be_replaced_by_the_default(separate_id):
    from copy import deepcopy

    from lxml import etree

    from proof.checks.native_constraint_helpers import XF

    a, b = case_opening("a"), case_opening("b")
    for files, _ in (a, b):
        root = etree.fromstring(files[FILE].encode())
        en = root.find(".//" + XF + "translation")
        fr = deepcopy(en)
        fr.set("lang", "fr")
        for v in fr.iter(XF + "value"):
            if (v.get("form") or "").startswith("__nova_locale"):
                v.text = "fr"
        en.getparent().append(fr)
        files[FILE] = etree.tostring(root)
    assert case_rows(a, b)[0]

    root = etree.fromstring(a[0][FILE])
    fr = root.find(f".//{XF}translation[@lang='fr']")
    group = fr.find(XF + "text")
    if separate_id:
        group = etree.SubElement(fr, XF + "text", id=group.get("id") + ";long")
    value = etree.SubElement(group, XF + "value", {} if separate_id else {"form": "long"})
    value.text = "An entirely different validation message."
    a[0][FILE] = etree.tostring(root)
    assert case_rows(a, b) == (None, OPEN + "*")


@pytest.mark.parametrize("side", ["a", "b"])
@pytest.mark.parametrize("competing", ["itext", "foreign-itext", "earlier-model"])
def test_only_the_installed_localizers_message_can_explain_the_carrier(side, competing):
    from copy import deepcopy

    from lxml import etree

    records = {s: case_opening(s) for s in ("a", "b")}
    files, _ = records[side]
    root = etree.fromstring(files[FILE].encode())
    model = root.find(".//{*}model")
    itext = model.find("{*}itext")
    if competing == "earlier-model":
        earlier = deepcopy(model)
        earlier.tag = "{urn:alternate}model"
        model.addprevious(earlier)
        active = earlier.find("{*}itext")
    else:
        active = deepcopy(itext)
        if competing == "foreign-itext":
            # Core reads a single source in this namespace, including its translations and values.
            for node in active.iter():
                name = etree.QName(node).localname
                if name in ("itext", "translation", "text", "value"):
                    node.tag = f"{{urn:alternate}}{name}"
            model.replace(itext, active)
            files[FILE] = etree.tostring(root)
            assert case_rows(records["a"], records["b"])[0]
            model.replace(active, itext)
        model.append(active)
    group = active.find("{*}translation/{*}text")
    group.find("{*}value").text = "Other "
    for value in group.findall("{*}value"):
        if (value.get("form") or "").startswith("__nova_piece_0"):
            value.text = json.dumps({"v": "Other "})
    files[FILE] = etree.tostring(root)
    assert case_rows(records["a"], records["b"]) == (None, OPEN + "*")


@pytest.mark.parametrize("target", [f" {GROUP}/{MSG_NODE} ", GROUP + "/*"])
def test_an_unplaced_bind_cannot_override_the_hidden_carriers_relevance_or_readonly_flag(target):
    a, b = case_opening("a"), case_opening("b")
    files, _ = b
    other = f'<bind nodeset="{target}" relevant="true()" readonly="false()"/>'
    files[FILE] = files[FILE].replace("</model>", other + "</model>")
    assert case_rows(a, b) == (None, OPEN + "*")
