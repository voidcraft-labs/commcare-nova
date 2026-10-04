"""HQ's workbook reader decodes Nova's lookup workbooks as Nova expects, stripping exactly what Nova predicts.

Contract: HQ's lookup workbook reader reads Nova's corpus workbook as the
tables Nova wrote (``expected.json``: tags, columns and row values, global,
sorted, keyless and ownerless), as many sheet rows as Nova wrote, and the
same values Nova's fixture XML carries; reads a 50-column table whole; and
strips exactly the padding code points Nova's ``hqWouldTrimLookupText``
predicts, which is why Nova's HQ export guards that text. HQ also regenerates
the two lookup forms, which ``LookupRuntimeTest`` runs in Core on both
paths. The plausible failures: a column, row or value HQ reads differently,
and a code point HQ strips that Nova does not predict (or the reverse).
"""

import json

from lxml import etree

from proof.native.hq_support import hq_commit, hq_source_hashes, sha256, write_evidence

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

    # The upstream coercion behind Nova's HQ-only export guard.
    (padding,) = result["padding"]["tables"]
    padding_values = [row[padding["columns"].index("value")] for row in padding["values"]]
    assert padding_values == [value.strip() for value in expected["padding"]], padding_values
    assert expected["stripCharacters"] == [point for point in range(0x110000) if chr(point).strip() == ""]
    assert padding_values != expected["padding"]

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
                if path.is_file() and not path.name.endswith(".evidence.json")
            },
            "tables": actual,
            "paddingInput": expected["padding"],
            "paddingDecoded": padding_values,
            "limits": "Actual native HQ workbook parser, table definitions, row models and lexical cells; "
            "independent lxml fixture decoding. No database persistence, replacement transaction, restore "
            "distribution or device runtime.",
        },
    )
