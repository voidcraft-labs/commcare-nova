"""HQ's regenerated case list details keep the tile contract Nova's details carry.

Contract: for each of the eight tile scenarios, the details HQ's own
``DetailContributor`` regenerates carry what the device reads from Nova's:
every field's grid position and size, alignment, font size, border and
shading, header and template widths, value expression and sort (type,
order, direction, expression), each detail's grouping and its action count.
Known XPath values compare as HQ's parser's complete expression trees.
``TileSuiteRuntimeTest`` then parses both in Core, and
``TileGroupingRuntimeTest`` runs Nova's grouped tiles. The plausible
failures: a style, width or sort HQ regenerates differently (a missing
``header-rows`` default halves or doubles a group's header), and a scenario
missing from the corpus.
"""

from lxml import etree

from proof.native.hq_support import attributes, hq_commit, parse_xml_xpaths, sha256, write_evidence

FAMILIES = ("tile",)
SCENARIOS = {
    "plain",
    "tile",
    "boxed",
    "persistent",
    "grouped-one",
    "grouped-two",
    "grouped-search",
    "grouped-browse",
}


def detail_contract(root, parsed):
    result = {}
    for detail in root.findall("detail"):
        fields = []
        for field in detail.findall("field"):
            style = field.find("style")
            style_contract = None
            if style is not None:
                style_contract = {
                    "grid": dict(style.find("grid").attrib),
                    "horizontal": style.get("horz-align"),
                    "vertical": style.get("vert-align"),
                    "font": style.get("font-size"),
                    "border": style.get("show-border") == "true",
                    "shading": style.get("show-shading") == "true",
                }
            sort = field.find("sort")
            fields.append(
                {
                    "style": style_contract,
                    "headerWidth": field.find("header").get("width"),
                    "templateWidth": field.find("template").get("width"),
                    "value": attributes(field.find("template/text/xpath"), parsed)["function"],
                    "sort": None
                    if sort is None
                    else {
                        "type": sort.get("type"),
                        "order": sort.get("order"),
                        "direction": sort.get("direction"),
                        "value": attributes(sort.find("text/xpath"), parsed)["function"],
                    },
                }
            )
        group = detail.find("group")
        assert detail.attrib["id"] not in result, "Duplicate detail identity"
        result[detail.attrib["id"]] = {
            "fields": fields,
            "group": None if group is None else attributes(group, parsed),
            "actions": len(detail.findall("action")),
        }
    return result


def test_hq_details_keep_novas_tile_contract(native):
    result = native.step("tile")
    assert set(result["sources"]) == SCENARIOS, "Missing or unexpected tile scenarios"
    scenarios = []
    for record in result["records"]:
        local = etree.fromstring(record["local"])
        hq = etree.fromstring(record["native"])
        # Only the expression fields this projection has always compared.
        carriers = [
            node
            for root in (local, hq)
            for selector in (
                "detail/field/template/text/xpath",
                "detail/field/sort/text/xpath",
                "detail/group",
            )
            for node in root.findall(selector)
        ]
        parsed = parse_xml_xpaths(*carriers)
        native_contract = detail_contract(hq, parsed)
        assert detail_contract(local, parsed) == native_contract, record["scenario"]
        scenarios.append(
            {
                "scenario": record["scenario"],
                "sourceSha256": record["sourceSha256"],
                "suiteSha256": sha256(record["local"]),
                "nativeDetailsSha256": sha256(record["native"]),
                "details": native_contract,
            }
        )
    write_evidence(
        native.family("tile"),
        "tile-emission",
        {
            "hqCommit": hq_commit(),
            "scenarios": scenarios,
            "limits": "Native Application.from_source and DetailContributor regeneration compared with actual CCZ "
            "details, including grid/style values, hidden sorting, grouping values and actions. Known XPath "
            "carriers compare through HQ's parser. False/absent border "
            "flags are equivalent. This is not a full HQ build or Android/Web Apps rendering. Every flag is off; "
            "network access is refused.",
        },
    )
