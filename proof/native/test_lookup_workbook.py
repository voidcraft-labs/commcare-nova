"""HQ's workbook reader decodes Nova's lookup workbooks as Nova expects, stripping exactly what Nova predicts.

Contract: HQ's lookup workbook reader reads Nova's corpus workbook as the
tables Nova wrote (``expected.json``: tags, columns and row values, global,
sorted, keyless and ownerless), as many sheet rows as Nova wrote, and the
same values Nova's fixture XML carries; reads a 50-column table whole; reads
a table whose tag, and so whose sheet name, holds Nova's full 32 characters
(``lib/lookup/constants.ts::LOOKUP_MAX_TAG_LENGTH``) under that tag; and
strips exactly the padding code points Nova's ``hqWouldTrimLookupText``
predicts, which is why Nova's HQ export guards that text. HQ also regenerates
the two lookup forms, which ``LookupRuntimeTest`` runs in Core on both
paths. The plausible failures: a column, row or value HQ reads differently,
and a code point HQ strips that Nova does not predict (or the reverse).
"""

import json

from lxml import etree

from proof.native.hq_support import EVIDENCE_SUFFIX, hq_commit, hq_source_hashes, sha256, write_evidence

FAMILIES = ("lookup",)
HQ_SOURCES = [
    "corehq/apps/fixtures/upload/workbook.py",
    "corehq/util/workbook_json/excel.py",
    "corehq/apps/fixtures/models.py",
]


def test_hq_reads_novas_workbooks_as_nova_wrote_them(native):
    result = native.step("lookup")
    exports = native.family("lookup")
    expected = json.loads((exports / "expected.json").read_bytes())
    actual = []
    for table in result["corpus"]["tables"]:
        assert table["isGlobal"] is True
        assert table["sortKeys"] == list(range(len(table["values"])))
        assert all(key is None for key in table["keys"])
        assert all(ownership == {} for ownership in table["ownership"])
        actual.append({"tag": table["tag"], "columns": table["columns"], "rows": table["values"]})
        fixture = etree.fromstring((exports / f"{table['tag']}.xml").read_bytes())
        assert fixture.attrib == {"id": f"item-list:{table['tag']}"}
        assert len(fixture) == 1 and fixture[0].tag == f"{table['tag']}_list"
        assert [[cell.text or "" for cell in row] for row in fixture[0]] == table["values"]
        assert all([cell.tag for cell in row] == table["columns"] for row in fixture[0])
    assert actual == expected["tables"], (actual, expected["tables"])
    assert result["corpus"]["totalRows"] == expected["totalWorkbookRows"]

    (wide,) = result["wide"]["tables"]
    assert wide["columns"] == [f"c{i}" for i in range(50)]
    (wide_row,) = wide["values"]
    assert wide_row == [f"v{i}" for i in range(50)]

    # A 32-character tag names its data sheet as written, and HQ's reader takes the table under it.
    (long_tag,) = result["longTag"]["tables"]
    assert len(expected["longTag"]) == 32
    assert long_tag["tag"] == expected["longTag"]
    assert long_tag["values"] == [["north"], ["south"]]

    # The upstream coercion behind Nova's HQ-only export guard.
    (padding,) = result["padding"]["tables"]
    padding_values = [row[padding["columns"].index("value")] for row in padding["values"]]
    assert padding_values == [value.strip() for value in expected["padding"]], padding_values
    assert expected["stripCharacters"] == [point for point in range(0x110000) if chr(point).strip() == ""]
    assert padding_values != expected["padding"]

    rich = result["rich"]
    assert rich["attributes"] == ["row_code"]
    fields = {name: (properties, index) for name, properties, index in rich["fields"]}
    assert fields["label"] == (["lang"], True)
    assert [row["attributes"]["row_code"] for row in rich["rows"]] == ["north", "south", "east"]
    for row, name in zip(rich["rows"], ["Northland", "Southland", "Eastland"], strict=True):
        assert [list(item) for item in row["label"]] == [
            ["Original " + name, {"lang": "en"}],
            ["Choix " + name, {"lang": "fr"}],
        ]

    write_evidence(
        exports,
        "lookup-workbook",
        {
            "hqCommit": hq_commit(),
            "hqSourceHashes": hq_source_hashes(HQ_SOURCES),
            "novaSourceHashes": expected["sourceHashes"],
            "artifactHashes": {
                path.name: sha256(path.read_bytes())
                for path in exports.iterdir()
                if path.is_file() and not path.name.endswith(EVIDENCE_SUFFIX)
            },
            "tables": actual,
            "paddingInput": expected["padding"],
            "paddingDecoded": padding_values,
            "limits": "Actual native HQ workbook parser, table definitions, row models and lexical cells; "
            "independent lxml fixture decoding. No database persistence, replacement transaction, restore "
            "distribution or device runtime.",
        },
    )


def test_table_editor_accepts_the_xml_name_ranges_its_own_library_reads(native):
    from corehq.apps.fixtures.utils import is_identifier_invalid

    results = {}
    for unit, valid in [
        (0x370, True),
        (0x37E, False),
        (0x200C, True),
        (0x3001, True),
        (0x10000, True),
        (0xEFFFF, True),
        (0xF0000, False),
    ]:
        name = chr(unit)
        assert (not is_identifier_invalid(name)) == valid, hex(unit)
        assert (not is_identifier_invalid(f"{name}_list")) == valid, hex(unit)
        results[hex(unit)] = valid
    for name in ("", "xmlData", "a:b", "a/b", "1abc", "ⓐ"):
        assert is_identifier_invalid(name), name
    for name in (
        "XmlData",
        "a.1",
        "a1.b",
        "clé",
        "名前",
        "a\N{COMBINING ACUTE ACCENT}", "a\N{COMBINING GREEK YPOGEGRAMMENI}",
    ):
        assert not is_identifier_invalid(name), name
    write_evidence(
        native.family("lookup"),
        "hq-lookup-xml-names",
        {
            "hqCommit": hq_commit(),
            "lxml": etree.LXML_VERSION,
            "libxml": etree.LIBXML_VERSION,
            "initial": results,
        },
    )
