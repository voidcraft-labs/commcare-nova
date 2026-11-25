"""HQ's regenerated case list details keep the tile contract Nova's details carry.

Contract: for each tile scenario, the details HQ's own
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
    "detail-tabs",
    "conditional-search-children",
    "detail-layout",
    "named-layout",
    "persistent-line",
    "persistent-inline",
    "persistent-external",
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
                    "format": field.find("template").get("form"),
                    "headerLabels": [item.get("id") for item in field.findall("header/text/locale")],
                    "valueLabels": [(item.get("id"), (item.tail or "").strip("\r\n\t ")) for item in field.findall("template/text/locale")],
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


def tab_contract(root, parsed):
    detail = root.find("detail[@id='m0_case_long']")
    return {
        "tabs": [
            {
                "title": tab.find("title/text/locale").get("id"),
                "fields": [field.find("header/text/locale").get("id") for field in tab.findall("field")],
                "condition": attributes(tab, parsed).get("relevant"),
            }
            for tab in detail.findall("detail")
        ],
        "variables": [(node.tag, attributes(node, parsed)["function"]) for node in detail.findall("variables/*")],
    }


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
        if record["scenario"] == "detail-tabs":
            carriers.extend(node for root in (local, hq) for selector in ("detail/detail[@relevant]", "detail/variables/*") for node in root.findall(selector))
        if record["scenario"] == "conditional-search-children":
            for id_ in ("m0_case_long", "m0_search_long"):
                for root in (local, hq):
                    [tab] = root.findall(f"detail[@id='{id_}']/detail[@nodeset]")
                    carriers.append(tab)
        parsed = parse_xml_xpaths(*carriers)
        if record["scenario"] == "conditional-search-children":
            assert record["searchChildren"] == {"visit": ["contact"]}
            for id_ in ("m0_case_long", "m0_search_long"):
                [ours] = local.findall(f"detail[@id='{id_}']/detail[@nodeset]")
                [native_tab] = hq.findall(f"detail[@id='{id_}']/detail[@nodeset]")
                assert attributes(ours, parsed) == attributes(native_tab, parsed)
                assert native_tab.get("relevant") and "visit" in native_tab.get("nodeset")
                assert "contact" not in native_tab.get("nodeset")
        else:
            assert record["searchChildren"] == {}
        if record["scenario"] == "detail-tabs":
            observed = tab_contract(hq, parsed)
            assert tab_contract(local, parsed) == observed
            assert [len(tab["fields"]) for tab in observed["tabs"]] == [2, 1]
            assert [tab["title"] for tab in observed["tabs"]] == ["m0.case_long.tab.1.title", "m0.case_long.tab.2.title"]
            assert observed["tabs"][0]["condition"] is None and observed["tabs"][1]["condition"] is not None
            assert [name for name, _ in observed["variables"]] == ["case_id"]
        native_contract = detail_contract(hq, parsed)
        assert detail_contract(local, parsed) == native_contract, record["scenario"]
        if record["scenario"] == "named-layout":
            cells = native_contract["m0_case_short"]["fields"]
            assert len(cells) == 11
            assert [cell["style"]["grid"]["grid-x"] for cell in cells[:10]] == ["0", "1", "6", "7", "0", "1", "6", "7", "0", "1"]
            assert [(cell["format"], cell["templateWidth"]) for cell in cells[:2]] == [("plain", None), ("invisible", None)]
            assert cells[0]["headerLabels"] == [] and len(cells[1]["headerLabels"]) == 1
            assert cells[1]["valueLabels"][0][1] == "\u2005"
            assert cells[-1]["style"] is None and cells[-1]["templateWidth"] == "0"
        if record["scenario"] == "detail-layout":
            fields = native_contract["m0_case_long"]["fields"]
            assert [field["style"]["grid"]["grid-y"] for field in fields] == ["0", "1", "2"]
            assert [field["style"]["border"] for field in fields] == [True, False, False]
        if record["scenario"] == "persistent-line":
            [line] = native_contract["m0_persistent_case_context"]["fields"]
            assert line["style"]["horizontal"] == "center" and line["style"]["grid"]["grid-width"] == "12"
        if record["scenario"] == "persistent-external":
            # Beside another menu's tile expanded above the forms the menu's persistence is on, so HQ's build writes
            # no fallback line for its tile list (``details.py::get_section_elements``), and neither does Nova's.
            assert "m0_persistent_case_context" not in native_contract
        scenarios.append(
            {
                "scenario": record["scenario"],
                "sourceSha256": record["sourceSha256"],
                "suiteSha256": sha256(record["local"]),
                "nativeDetailsSha256": sha256(record["native"]),
                "searchChildren": record["searchChildren"],
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
