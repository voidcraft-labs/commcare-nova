"""A native added helper or changed update has to agree with both installed forms and both served instances."""

from dataclasses import replace

import pytest
from lxml import etree

from proof.checks import formplayer_trim_helpers as trim
from proof.checks.compare.xml_tree import parse_xml
from proof.checks.served import formplayer_differences

F = "urn:farms"
C = "http://commcarehq.org/case/transaction/v2"
X = "http://www.w3.org/2002/xforms"
FILE = "modules-0/forms-0.xml"
PREFIX = "/form/0.0/xform/data/group/"
DECLARED = (PREFIX + "label", PREFIX + "nova_trimmed_label")
FIELD = "/data/group/label"
HELPER = "/data/group/nova_trimmed_label"
VALUE = "  first  last  "
WRITTEN = "first  last"


def _side(*, before, opening=False, raw=VALUE, name=None, helper=None, case_id="farmer-1", active=True):
    target = FIELD if before else HELPER
    calculated = FIELD if before else HELPER
    if name is None:
        name = (VALUE if before else WRITTEN) if active else ""
    if helper is None:
        helper = name
    source = f"<label>{raw}</label>"
    node = "" if before else f"<nova_trimmed_label>{helper}</nova_trimmed_label>"
    instance = f'<data xmlns="{F}"><group>{source}{node}</group><case xmlns="{C}" case_id="{case_id}"><update><case_name>{name}</case_name></update></case></data>'
    bind = (
        ""
        if before
        else rf"""<bind nodeset="{HELPER}" relevant="count({FIELD}) > 0" calculate="replace({FIELD}, '^[\x00-\x20]+|[\x00-\x20]+$', '')"/>"""
    )
    built = f'''<html><model xmlns="{X}"><instance><data xmlns="{F}"/></instance>
          <bind nodeset="{FIELD}" relevant="selected(/data/which, 'name')"/>{bind}
          <bind nodeset="/data/case/update/case_name" calculate="{calculated}" relevant="count({target}) > 0"/>
        </model><input xmlns="{X}" ref="{FIELD}"/></html>'''
    source = {
        "modules": [
            {
                "forms": [
                    {
                        "xmlns": F,
                        "actions": {
                            "update_case": {
                                "condition": {"type": "always"},
                                "update": {"name": {"question_path": FIELD, "update_mode": "always"}},
                            }
                        },
                    }
                ]
            }
        ]
    }
    step = (
        {"response": {"instanceXml": {"output": instance}, "tree": [{"binding": FIELD}] if active else []}}
        if opening
        else {"submissions": [{"instance": instance}], "answers": []}
    )
    return {
        "trace": {"runs": [{"steps": [step]}]},
        "files": {FILE: built},
        "namespaces": {F: "0.0"},
        "differing": (),
        "reviewed": source,
        "before": before,
    }


def _judged(a, b, *, declared=DECLARED):
    differences = formplayer_differences(
        a["trace"], b["trace"], check="proof3", document="test", artifact="formplayer@B"
    )
    chosen = [d for d in differences if trim.candidate(d)]
    sites = trim.sites(chosen, declared, [trim.side(**a), trim.side(**b)])
    return chosen, sites


def test_submitted_update_and_helper_require_the_exact_raw_source_and_case_transaction():
    a, b = _side(before=True), _side(before=False)
    differences, sites = _judged(a, b)
    assert {d.path for d in differences} == {trim.SENT, trim.UPDATE}
    assert set(sites.values()) == {
        ("form", "0.0", "xform", "data", "group", name) for name in ("label", "nova_trimmed_label")
    }
    for corrupted in (
        _side(before=False, helper="first last"),
        _side(before=False, raw="another"),
        _side(before=False, case_id="farmer-2"),
        _side(before=False, helper="other", name="other"),
    ):
        assert not _judged(a, corrupted)[1]
    for text in (
        '<setvalue ref="/data/group/nova_trimmed_label"/>',
        '<bind nodeset="/data/group/nova_trimmed_label"/>',
    ):
        original = b["files"][FILE]
        b["files"][FILE] = original.replace("</model>", text + "</model>")
        assert not _judged(a, b)[1]
        b["files"][FILE] = original
    assert not _judged(a, b, declared=(DECLARED[0], "/form/1.0/xform/data/group/nova_trimmed_label"))[1]
    assert not _judged(a, {**b, "differing": [FILE]})[1]
    b["reviewed"]["modules"][0]["forms"][0]["actions"]["update_case"]["update"]["name"]["question_path"] = (
        "/data/sibling"
    )
    assert not _judged(a, b)[1]


@pytest.mark.parametrize("tag", ["group", "case", "update", "case_name", "label"])
def test_a_foreign_namesake_cannot_lend_the_real_local_sibling_its_reader_ordinal(tag):
    a, b = _side(before=True), _side(before=False)
    for side in (a, b):
        sent = side["trace"]["runs"][0]["steps"][0]["submissions"][0]
        node = parse_xml(sent["instance"])
        match = node.find(".//{*}" + tag)
        foreign = parse_xml(f'<f:{tag} xmlns:f="urn:foreign">{match.text or ""}</f:{tag}>')
        match.addprevious(foreign)
        sent["instance"] = etree.tostring(node, encoding="unicode")
    differences, sites = _judged(a, b)
    assert differences and not sites


def test_hidden_preloaded_opening_takes_the_original_effective_case_value():
    a, b = (
        _side(before=True, opening=True, raw="held", active=False),
        _side(before=False, opening=True, raw="held", active=False),
    )
    differences, sites = _judged(a, b)
    assert [d.path for d in differences] == [trim.OPEN] and len(sites) == 1
    original = b["files"][FILE]
    b["files"][FILE] = original.replace("selected(/data/which, 'name')", "false()")
    assert not _judged(a, b)[1]
    b["files"][FILE] = original
    b["trace"]["runs"][0]["steps"][0]["response"]["tree"].append({"binding": FIELD})
    assert not _judged(a, b)[1]
    broken = replace(differences[0], after="<invalid")
    assert not trim.sites([broken], DECLARED, [trim.side(**a), trim.side(**b)])


def test_two_farmers_with_the_same_answer_keep_their_own_case_identity_and_source_occurrence():
    from copy import deepcopy

    declared = tuple(path.replace("/data/", "/data/farmer/") for path in DECLARED)
    sides = [_side(before=before) for before in (True, False)]
    for side in sides:
        form = side["reviewed"]["modules"][0]["forms"][0]
        form["actions"] = {
            "subcases": [
                {
                    "repeat_context": "/data/farmer",
                    "case_type": "farmer",
                    "condition": {"type": "always"},
                    "name_update": {"question_path": "/data/farmer/group/label", "update_mode": "always"},
                }
            ]
        }
        built = parse_xml(side["files"][FILE].replace("/data/", "/data/farmer/"))
        writer = built.find(f".//{{{X}}}bind[@nodeset='/data/farmer/case/update/case_name']")
        writer.set("nodeset", "/data/farmer/case/create/case_name")
        del writer.attrib["relevant"]
        etree.SubElement(built, f"{{{X}}}repeat", nodeset="/data/farmer")
        side["files"][FILE] = etree.tostring(built, encoding="unicode")
        sent = side["trace"]["runs"][0]["steps"][0]["submissions"][0]
        root = parse_xml(sent["instance"])
        row = etree.Element(f"{{{F}}}farmer")
        row.extend(list(root))
        root.append(row)
        for case in row.findall(f"{{{C}}}case"):
            block = case.find(f"{{{C}}}update")
            block.tag = f"{{{C}}}create"
            etree.SubElement(block, f"{{{C}}}case_type").text = "farmer"
        second = deepcopy(row)
        second.find(f"{{{C}}}case").set("case_id", "farmer-2")
        root.append(second)
        sent["instance"] = etree.tostring(root, encoding="unicode")
    differences, sites = _judged(*sides, declared=declared)
    assert len(sites) == 2 and {d.kind for d in differences} == {"added"}
    sent = sides[1]["trace"]["runs"][0]["steps"][0]["submissions"][0]
    sent["instance"] = sent["instance"].replace('case_id="farmer-2"', 'case_id="farmer-1"')
    assert not _judged(*sides, declared=declared)[1]
