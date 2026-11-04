"""HQ builds each advanced form of Nova's HQ import body as Nova wrote it into the local archive.

Contract: an advanced form's case blocks and entry are what HQ's own build
makes of its advanced actions, so Nova's local archive, which no HQ build writes, holds exactly those:
for every advanced form of the targeted documents the case family emits whole
(``targeted-advanced-module``, which holds the advanced chain, the worker's
load, two indexed creates in one repeat and an extension create carried by its
link), HQ's ``XForm._create_casexml_advanced`` over the form's source gives,
element for element, the case blocks Nova's ``.ccz`` form holds (each block's
place, its children in order and their attributes), and the binds and
setvalues on those blocks (each compared through HQ's XPath parser); HQ's
``EntriesHelper.get_datum_meta_assertions_advanced``, with the new-case
datums ``configure_entry_advanced_form`` adds after them, gives the local
suite's entry's datums in order (id, nodeset, function) and its assertions;
and HQ's ``validate_app`` reports no error for the app. The plausible failure
it catches: a datum id, a block path or a bind Nova's local injection
(``lib/commcare/xform/advancedCaseBlocks.ts``, ``lib/commcare/session.ts``)
writes differently from HQ's build, which per-document proof 3 shows only on a
document that holds the shape, and which ``AdvancedFormRuntimeTest`` then
runs.
"""

from lxml import etree

from proof.native.hq_support import (
    attributes,
    hq_commit,
    hq_source_hashes,
    parse_xml_xpaths,
    parse_xpaths,
    shape,
    write_evidence,
)
from proof.native.steps.case_emission import NAMESPACES, NATIVE_FILES

FAMILIES = ("case",)
CASE = f"{{{NAMESPACES['cx']}}}case"


def _data(tree):
    (data,) = tree.xpath("//x:model/x:instance[not(@src)]/*", namespaces=NAMESPACES)
    return data


def _blocks(tree):
    """Each case block of the form's data, by its path as a bind names it (``/data/.../case``)."""
    data = _data(tree)
    found = {}
    for block in data.iter(CASE):
        steps = [etree.QName(element).localname for element in reversed(list(block.iterancestors()))]
        path = "/" + "/".join([*steps[steps.index(etree.QName(data).localname) :], "case"])
        assert path not in found, f"Two case blocks stand at {path}"
        found[path] = block
    return found


def _on_blocks(tree, paths, xpath, attribute):
    """The elements ``xpath`` finds whose ``attribute`` names a block or a node inside one."""

    def names_a_block(value):
        return any(value == path or value.startswith(f"{path}/") for path in paths)

    found = tree.xpath(xpath, namespaces=NAMESPACES)
    return [element for element in found if names_a_block(element.get(attribute, ""))]


def _case_parts(tree, parsed):
    """A form's case blocks with what reads and sets them: each block's shape, and the binds and setvalues on them."""
    blocks = _blocks(tree)
    binds = _on_blocks(tree, blocks, "//x:bind", "nodeset")
    setvalues = _on_blocks(tree, blocks, "//x:setvalue", "ref")
    return {
        "blocks": {path: shape(block, parsed) for path, block in sorted(blocks.items())},
        "binds": sorted((bind.get("nodeset"), sorted(attributes(bind, parsed).items())) for bind in binds),
        "setvalues": sorted(sorted(attributes(setvalue, parsed).items()) for setvalue in setvalues),
    }


def _local_entry(suite, xmlns):
    (entry,) = suite.xpath("entry[form=$xmlns]", xmlns=xmlns)
    return entry


def _check_form(record, suite):
    native = etree.fromstring(record["native"])
    local = etree.fromstring(record["local"])
    entry = _local_entry(suite, record["xmlns"])
    local_datums = entry.xpath("session/datum|session/instance-datum")
    values = [
        value for datum in record["datums"] for value in (datum["nodeset"], datum["function"]) if value is not None
    ] + record["assertions"]
    parsed = parse_xml_xpaths(native, local, *local_datums, *entry.xpath("assertions/assert"), values=values)
    parsed.update(parse_xpaths(entry.xpath("assertions/assert/@test")))

    def structure(text):
        return None if text is None else parsed[text]["structure"]

    native_parts = _case_parts(native, parsed)
    assert native_parts["blocks"], (record["form"], "HQ's build wrote no case block")
    assert _case_parts(local, parsed) == native_parts, record["form"]
    hq_datums = [(datum["id"], structure(datum["nodeset"]), structure(datum["function"])) for datum in record["datums"]]
    nova_datums = [
        (datum.get("id"), structure(datum.get("nodeset")), structure(datum.get("function"))) for datum in local_datums
    ]
    assert nova_datums == hq_datums, (record["form"], nova_datums, hq_datums)
    hq_assertions = [structure(test) for test in record["assertions"]]
    assert [structure(test) for test in entry.xpath("assertions/assert/@test")] == hq_assertions, record["form"]
    return {
        "form": record["form"],
        "blocks": sorted(native_parts["blocks"]),
        "datumIds": [datum[0] for datum in hq_datums],
        "assertions": record["assertions"],
    }


def test_hq_builds_each_advanced_form_as_nova_wrote_it_into_the_local_archive(native):
    result = native.step("case")
    evidence = []
    advanced_forms = 0
    for whole in result["wholes"]:
        assert whole["validationErrors"] == [], (whole["name"], whole["validationErrors"])
        suite = etree.fromstring(whole["suite"])
        forms = [_check_form(record, suite) for record in whole["forms"]]
        advanced_forms += len(forms)
        evidence.append({"name": whole["name"], "inputSha256": whole["inputSha256"], "forms": forms})
    assert advanced_forms > 0, "No document the case family emits whole holds an advanced form"
    write_evidence(
        native.family("case"),
        "advanced-emission",
        {"hqCommit": hq_commit(), "nativeSourceSha256": hq_source_hashes(NATIVE_FILES), "evidence": evidence},
    )
