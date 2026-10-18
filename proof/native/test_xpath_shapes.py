"""The native XML comparisons distinguish spelling from a changed reader input.

These tests run HQ's pinned js-xpath parser, without HQ boot, a native
producer or Core. A carrier's parse must retain every operand, literal and
path step; values outside the finite carrier set and the complete XML
sequence remain exact. The native families still run both generated suites
in their own Core tests.
"""

import pytest
from lxml import etree

from proof.native.hq_support import (
    UnreadableExpression,
    attributes,
    parse_xml_xpaths,
    parse_xpaths,
    shape,
    xpath_attributes,
)


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("@case_type='patient'", '(@case_type = "patient")'),
        ("f(a,b + 1)", "f( a , b+1 )"),
        ("(a+b)*c", "(a + b) * c"),
        ("a and (b and c)", "a and b and c"),
        ("(a and b) and c", "a and b and c"),
        ("a or (b or c)", "a or b or c"),
        ("(a or b) or c", "a or b or c"),
        ("1.0", "1"),
        (".5", "0.5"),
        ("child::case", "case"),
        ('processing-instruction("a b")', "processing-instruction('a b')"),
        ('((instance("db")))/rows/row[ @id = "x" ]', "instance('db')/rows/row[@id='x']"),
    ],
)
def test_hq_parse_structure_ignores_only_syntax_spelling(left, right):
    parsed = parse_xpaths([left, right])
    assert parsed[left]["structure"] == parsed[right]["structure"]


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("'a b'", "'a  b'"),
        ("'trailing '", "'trailing'"),
        ("'a\\b'", "'a\\\\b'"),
        ("1", "2"),
        ("a = b", "a != b"),
        ("a < b", "a <= b"),
        ("a - b", "b - a"),
        ("a + (b - c)", "a + b - c"),
        ("a and (b or c)", "(a and b) or c"),
        ("a and b", "b and a"),
        ("a or b", "b or a"),
        ("a and a", "a"),
        ("a or a", "a"),
        ("-a", "a"),
        ("$left", "$right"),
        ("f(a, b)", "f(b, a)"),
        ("f(a)", "g(a)"),
        ("a | b", "b | a"),
        ("/case", "case"),
        ("parent::case", "child::case"),
        ("ns:case", "other:case"),
        ("ns:*", "other:*"),
        ("text()", "node()"),
        ("processing-instruction('a')", "processing-instruction('b')"),
        ("//case[1]", "(//case)[1]"),
        ("/case[@status='open'][1]", "/case[1][@status='open']"),
        ("instance('cases')/case", "instance('other')/case"),
    ],
)
def test_hq_parse_structure_keeps_each_semantic_distinction(left, right):
    parsed = parse_xpaths([left, right])
    assert parsed[left]["structure"] != parsed[right]["structure"]


def _shapes(left, right):
    roots = [etree.fromstring(xml) for xml in (left, right)]
    parsed = parse_xml_xpaths(*roots)
    return [shape(root, parsed) for root in roots]


def test_xml_compares_known_xpath_and_ignores_only_element_indentation():
    left, right = _shapes(
        '<entry><instance id="cases" src="jr://instance/casedb"/><session>'
        '<datum id="case" nodeset="instance(\'cases\')/casedb/case[@status=\'open\']" value="./@case_id"/>'
        '</session><stack><push if="a=b"><command value="\'next\'"/></push></stack></entry>',
        '<entry>\n  <instance src="jr://instance/casedb" id="cases"/>\n  <session>\n'
        '<datum value="./@case_id" nodeset="instance(&quot;cases&quot;)/casedb/case[@status = &quot;open&quot;]" '
        'id="case"/>'
        '\n</session>\n<stack><push if="a = b"><command value="&quot;next&quot;"/></push></stack>\n</entry>',
    )
    assert left == right


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ('<entry note="a=b"/>', '<entry note="a = b"/>'),
        ('<entry note="same"/>', '<entry note="same" extra=""/>'),
        ("<entry><text>label </text></entry>", "<entry><text>label</text></entry>"),
        ("<entry><text> </text></entry>", "<entry><text/></entry>"),
        ("<entry><first/><second/></entry>", "<entry><second/><first/></entry>"),
        (
            '<entry><instance id="cases" src="jr://instance/casedb"/></entry>',
            "<entry/>",
        ),
        (
            '<entry><instance id="cases" src="jr://instance/casedb"/></entry>',
            '<entry><instance id="other" src="jr://instance/casedb"/></entry>',
        ),
        (
            '<entry><instance id="cases" src="jr://instance/casedb"/></entry>',
            '<entry><instance id="cases" src="jr://instance/other"/></entry>',
        ),
        (
            '<entry><instance id="first"/><instance id="second"/></entry>',
            '<entry><instance id="second"/><instance id="first"/></entry>',
        ),
        (
            '<entry><instance><text><xpath function="a=b"/></text></instance></entry>',
            '<entry><instance><text><xpath function="a = b"/></text></instance></entry>',
        ),
        (
            '<entry><stack><push><query value="https://example.test/a=b"/></push></stack></entry>',
            '<entry><stack><push><query value="https://example.test/a = b"/></push></stack></entry>',
        ),
        (
            '<entry><session><instance-datum nodeset="/case" value="@id" max-select-value="1"/></session></entry>',
            '<entry><session><instance-datum nodeset="/case" value="@id" max-select-value="1.0"/></session></entry>',
        ),
        (
            "<entry><text>before <xpath function=\"'value'\"/> after</text></entry>",
            "<entry><text>before<xpath function=\"'value'\"/> after</text></entry>",
        ),
        (
            "<entry><text>before <xpath function=\"'value'\"/> after</text></entry>",
            "<entry><text>before <xpath function=\"'value'\"/>after</text></entry>",
        ),
        (
            '<entry><text>before <xpath function="\'value\'"/>\n  <locale id="x"/></text></entry>',
            '<entry><text>before <xpath function="\'value\'"/><locale id="x"/></text></entry>',
        ),
        (
            '<entry><text><xpath function="\'value\'"/> <locale id="x"/></text></entry>',
            '<entry><text><xpath function="\'value\'"/><locale id="x"/></text></entry>',
        ),
    ],
)
def test_ordinary_xml_and_instance_membership_remain_exact(left, right):
    left_shape, right_shape = _shapes(left, right)
    assert left_shape != right_shape


def test_unknown_positions_and_unused_session_attributes_stay_literal():
    root = etree.fromstring(
        '<entry><session><datum function="1+2" nodeset="not [ valid XPath" value="also [ invalid"/></session>'
        '<unknown function="not [ valid XPath"/><text function="not [ valid XPath"/>'
        '<stack><push><query value="https://example.test/search/"/></push></stack></entry>'
    )
    assert parse_xml_xpaths(root).keys() == {"1+2"}
    datum = root.find("session/datum")
    assert xpath_attributes(datum) == {"function": "1+2"}
    parsed = parse_xml_xpaths(root)
    assert attributes(datum, parsed)["nodeset"] == "not [ valid XPath"
    assert shape(root, parsed)


def test_a_broken_known_carrier_fails_even_when_both_sides_hold_it():
    xml = '<entry><session><datum nodeset="/case[" value="@id"/></session></entry>'
    with pytest.raises(UnreadableExpression) as failure:
        _shapes(xml, xml)
    named = [line for line in str(failure.value).splitlines() if line.startswith("  ")]
    assert len(named) == 1 and named[0].startswith("  '/case[': ")


def test_prompt_and_detail_carriers_are_parsed_in_their_own_positions():
    root = etree.fromstring(
        '<suite><remote-request><post url="https://example.test/claim" relevant="a=1">'
        '<data key="a=1" ref="@id" nodeset="/case" exclude="a=2"/></post><session><query url="https://example.test/search">'
        '<prompt key="a=1" default="a=3" exclude="a=4" required="a=5">'
        '<required test="a=6"/><validation test="a=7"/><itemset nodeset="/items/item">'
        '<label ref="@label"/><value ref="@value"/><sort ref="@sort"/></itemset></prompt>'
        '</query></session></remote-request><detail nodeset="/rows/row" relevant="a=8">'
        '<group function="a=9" header-rows="1"/><focus function="a=10"/>'
        '<variables><custom function="a=11"/></variables>'
        '<field relevant="a=12"/><action relevant="a=13" auto_launch="a=14"/></detail>'
        '<menu relevant="a=15"><command relevant="a=16"/></menu>'
        '<entry><assertions><assert test="a=17"/></assertions></entry>'
        "</suite>"
    )
    assert parse_xml_xpaths(root).keys() == {
        *(f"a={index}" for index in range(1, 18)),
        "@id",
        "/case",
        "/items/item",
        "@label",
        "@value",
        "@sort",
        "/rows/row",
    }


def test_worker_bind_carriers_preserve_other_attributes_and_namespaces():
    def xml(calculate, type_="xsd:string"):
        return (
            '<model xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa">'
            f'<bind nodeset="/data/commcare_usercase/case/@case_id" calculate="{calculate}" '
            f'type="{type_}" jr:preload="property" jr:preloadParams="a=b"/></model>'
        )

    left, right = _shapes(xml("a=b"), xml("a = b"))
    assert left == right
    left, right = _shapes(xml("a=b"), xml("a = b", "xsd:dateTime"))
    assert left != right
    root = etree.fromstring(xml("a=b"))
    assert xpath_attributes(root[0]) == {
        "nodeset": "/data/commcare_usercase/case/@case_id",
        "calculate": "a=b",
    }


def test_nested_menu_keeps_its_existing_unread_declaration_exemption():
    from proof.native.test_nested_menu_emission import _expressions, comparable

    def suite(declarations):
        return etree.fromstring(
            f'<suite><entry>{declarations}<session><datum nodeset="instance(\'cases\')/case" value="@id"/>'
            "</session></entry></suite>"
        )

    required = '<instance id="cases" src="jr://instance/casedb"/>'
    roots = [
        suite(required),
        suite(required + '<instance id="unused" src="jr://instance/unused"/>'),
        suite(""),
    ]
    parsed = parse_xpaths(value for root in roots for entry in root.findall("entry") for value in _expressions(entry))
    reads = {value: result["instances"] for value, result in parsed.items()}
    comparisons = [comparable(root, "entry", reads, parsed) for root in roots]
    assert comparisons[0] == comparisons[1]
    assert comparisons[0] != comparisons[2]
