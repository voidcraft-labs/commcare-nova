"""HQ's entries and menus for Nova's nested menus equal Nova's, except the two target shapes Nova refuses.

Contract: for eight of the ten nested-menu scenarios, every ``<entry>`` and
``<menu>`` HQ's suite contributors build equals Nova's, compared whole (every
attribute, leaf text and child, in order) once each side's ``<instance>``
declarations that nothing in the element reads are set aside. The other two
(``parent-multiple``, ``same-smaller``) are the shapes Nova's HQ export
refuses (``hq-nested-target-refusals.json``), and their entries differ: HQ
loses a multiple parent selection's source and bypasses a smaller child's
maximum. ``NestedMenuRuntimeTest`` then runs all ten on both paths in Core
and reproduces both losses. The plausible failures: a nested shape Nova
exports that HQ regenerates differently, a refused shape HQ starts to keep
(so the refusal is stale), and a refusal Nova stops making.

Which instances an element reads is decided by HQ's own XPath parser
(js-xpath, which HQ's build runs on every filter; ``xpath_instances.mjs``):
each attribute the suite holds as XPath is parsed and the
``instance('<id>')`` calls in its tree are collected. What is XPath is
decided by where the attribute sits (``NOT_XPATH``, from Core's suite
parsers), never by whether it parses: an XPath attribute js-xpath cannot
parse stops the comparison, naming it, since counting it as reading no
instance would set aside a declaration it needs and hide one missing on
either side.
"""

import json
import subprocess
from pathlib import Path

import pytest
from lxml import etree

from proof.native.hq_support import hq_commit, sha256, shape, write_evidence

FAMILIES = ("nested-menu",)
REFUSED = {"parent-multiple", "same-smaller"}
XPATH_INSTANCES = Path(__file__).resolve().parent / "xpath_instances.mjs"
SELECTORS = ["entry", "menu"]


# The attributes Core's suite parsers read as a name, a URL, a media path or a
# flag, never as an XPath expression, by the element that carries them
# (commcare-core, org/commcare/xml):
# - MenuParser::parse: a menu's id, root and style; a command's id;
# - EntryParser::parse and ::parsePost: a command's id; a post's url;
# - SessionDatumParser::parse: a datum's or instance-datum's id, its details
#   (detail-select, -confirm, -inline, -persistent), autoselect and
#   max-select-value; ::parseRemoteQueryDatum: a query's template, url,
#   storage-instance, default_search and search_on_clear;
# - StackFrameStepParser::parse, ::parseQuery and ::parseJump: a stack
#   datum's or instance-datum's id; a stack query's id and its value, a URL;
#   a jump's id;
# - QueryDataParser::parse: a data element's key;
# - QueryPromptParser::parse: a prompt's appearance, key, input, receive,
#   hidden, allow_blank_value and group_key; QueryGroupParser::parse: a
#   group's key;
# - TextParser::parse: a locale's id; an xpath variable's name;
# - CommCareElementParser::parseDisplayBlock: a text's form; a media
#   element's image and audio.
# Every other attribute is parsed as XPath, and <instance> declarations are
# what the comparison sets aside, so theirs are not read.
_DATUM_NAMES = frozenset(
    {"id", "detail-select", "detail-confirm", "detail-inline", "detail-persistent", "autoselect", "max-select-value"}
)
NOT_XPATH = {
    "menu": frozenset({"id", "root", "style"}),
    "command": frozenset({"id"}),
    "post": frozenset({"url"}),
    "datum": _DATUM_NAMES,
    "instance-datum": _DATUM_NAMES,
    "query": frozenset({"id", "value", "template", "url", "storage-instance", "default_search", "search_on_clear"}),
    "jump": frozenset({"id"}),
    "data": frozenset({"key"}),
    "prompt": frozenset({"appearance", "key", "input", "receive", "hidden", "allow_blank_value", "group_key"}),
    "group": frozenset({"key"}),
    "locale": frozenset({"id"}),
    "variable": frozenset({"name"}),
    "text": frozenset({"form"}),
    "media": frozenset({"image", "audio"}),
}


class UnreadableExpression(AssertionError):
    """An attribute the suite holds as XPath that HQ's XPath parser cannot parse."""


def _expressions(element):
    """The value of every attribute under ``element`` the suite holds as XPath, outside ``<instance>``."""
    for node in element.iter():
        if node.tag == "instance":
            continue
        skipped = NOT_XPATH.get(node.tag, frozenset())
        for name, value in node.attrib.items():
            if name not in skipped:
                yield value


def _positions_not_xpath(root):
    """Each ``element@attribute`` under the compared elements that is not read as XPath."""
    positions = set()
    for selector in SELECTORS:
        for element in root.findall(selector):
            for node in element.iter():
                if node.tag != "instance":
                    skipped = NOT_XPATH.get(node.tag, frozenset())
                    positions.update(f"{node.tag}@{name}" for name in node.attrib if name in skipped)
    return positions


def instances_read(values):
    """Each expression's instance ids as HQ's XPath parser reads them.

    Raises ``UnreadableExpression`` naming every expression the parser could
    not parse, with its message.
    """
    values = sorted(set(values))
    finished = subprocess.run(
        ["node", str(XPATH_INSTANCES)],
        input=json.dumps(values).encode(),
        capture_output=True,
        timeout=120,
        check=False,
    )
    if finished.returncode != 0:
        raise RuntimeError(
            f"HQ's XPath parser (js-xpath, through {XPATH_INSTANCES.name}) could not read the suites' attribute "
            f"values: node exited with status {finished.returncode}.\n{finished.stderr.decode(errors='replace')}"
        )
    results = dict(zip(values, json.loads(finished.stdout), strict=True))
    unreadable = {value: result["error"] for value, result in results.items() if "error" in result}
    if unreadable:
        raise UnreadableExpression(
            "HQ's XPath parser (js-xpath) could not parse these attributes, which the suite holds as XPath, so the "
            "comparison cannot tell which instances they read. If one is not XPath in Core's suite parsers, add its "
            "element and attribute to NOT_XPATH with the parser that reads it:\n"
            + "\n".join(f"  {value!r}: {message}" for value, message in sorted(unreadable.items()))
        )
    return {value: result["instances"] for value, result in results.items()}


def comparable(root, selector, reads):
    """Each element ``selector`` finds, without the instance declarations nothing in it reads."""
    items = []
    for element in root.findall(selector):
        referenced = set()
        for value in _expressions(element):
            referenced.update(reads[value])
        for instance in list(element.findall("instance")):
            if instance.get("id") not in referenced:
                element.remove(instance)
        items.append(shape(element))
    return items


def test_hq_entries_and_menus_equal_novas_but_for_the_refused_shapes(native):
    records = native.step("nested-menu")
    suites = [(record, etree.fromstring(record["local"]), etree.fromstring(record["native"])) for record in records]
    reads = instances_read(
        value
        for _, local, hq in suites
        for root in (local, hq)
        for selector in SELECTORS
        for element in root.findall(selector)
        for value in _expressions(element)
    )
    mismatches = []
    for record, local, native_suite in suites:
        for selector in SELECTORS:
            if comparable(local, selector, reads) != comparable(native_suite, selector, reads):
                mismatches.append((record["scenario"], selector))
    assert len(records) == 10, len(records)
    refusals = json.loads((native.family("nested-menu") / "hq-nested-target-refusals.json").read_text())
    assert {scenario for scenario, findings in refusals.items() if findings} == REFUSED, refusals
    assert mismatches == [("nested-menu-parent-multiple", "entry"), ("nested-menu-same-smaller", "entry")], mismatches
    write_evidence(
        native.family("nested-menu"),
        "nested-menu-emission",
        {
            "results": [
                {"scenario": r["scenario"], "sourceSha256": r["sourceSha256"], "nativeSha256": sha256(r["native"])}
                for r in records
            ],
            "refusedShapesReproduced": mismatches,
            "attributesNotReadAsXPath": sorted(
                set().union(*(_positions_not_xpath(root) for _, local, hq in suites for root in (local, hq)))
            ),
            "hqCommit": hq_commit(),
            "limits": "Actual imported HQ model, native case/meta/Vellum XForm processing and suite contributors. "
            "Complete entry and menu trees retain all text/attributes/children. Default build 2.53 and origin from "
            "the check's configuration; advanced search and follow-up case list forms on. No real search/claim "
            "HTTP, whole HQ build or resource installation.",
        },
    )


def _entry(nodeset):
    """An entry as HQ writes one, with a remote query pushed on its stack."""
    return (
        "<entry><command id='m0-f0'><text><locale id='forms.m0f0'/></text></command>"
        "<instance id='casedb' src='jr://instance/casedb'/>"
        "<instance id='results' src='jr://instance/remote/results'/>"
        f'<session><datum id="case_id" nodeset="{nodeset}" value="./@case_id" detail-select="m0_case_short"/></session>'
        "<stack><push><query id='results' value='https://www.commcarehq.org/a/nova-proof/phone/search/app/'>"
        "<data key='case_type' ref=\"'patient'\"/></query>"
        "<command value=\"count(instance('results')/results/case) &gt; 0\"/></push></stack></entry>"
    )


def test_an_xpath_attribute_hqs_parser_cannot_parse_stops_the_comparison():
    """The instance reads come only from attributes the suite holds as XPath, and each must parse.

    The stack query's value is a URL (``StackFrameStepParser::parseQuery``),
    which js-xpath cannot parse: it is set aside by where it sits, and every
    XPath attribute reads its instances. The same entry with its nodeset
    broken stops the comparison, naming that nodeset alone.
    """
    nodeset = "instance('casedb')/casedb/case[@case_type='patient'][@status='open']"
    count = "count(instance('results')/results/case) > 0"
    accepted = etree.fromstring(_entry(nodeset))
    expressions = sorted(_expressions(accepted))
    assert expressions == sorted([nodeset, "./@case_id", "'patient'", count]), expressions
    reads = instances_read(expressions)
    assert reads == {nodeset: ["casedb"], "./@case_id": [], "'patient'": [], count: ["results"]}, reads
    assert _positions_not_xpath(etree.fromstring(f"<suite>{_entry(nodeset)}</suite>")) == {
        "command@id",
        "locale@id",
        "datum@id",
        "datum@detail-select",
        "query@id",
        "query@value",
        "data@key",
    }

    broken = nodeset + "["
    with pytest.raises(UnreadableExpression) as refusal:
        instances_read(_expressions(etree.fromstring(_entry(broken))))
    named = [line for line in str(refusal.value).splitlines() if line.startswith("  ")]
    assert len(named) == 1 and named[0].startswith(f"  {broken!r}: "), str(refusal.value)
