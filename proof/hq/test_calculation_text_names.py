"""HQ's app build substitutes a calculation's translation variable without changing its literal."""

import json
import re

from lxml import etree

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.seams import build_seams
from proof.observe import intent, publish
from proof.observe.record import Blobs


def test_numbered_calculation_text_names_survive_hq_build(hq, core_runner, documents):
    document = documents["targeted-calculation-text-names"]
    export = document.exports["minimum"]
    upload = json.loads(operations.upload_field(export.content.upload(), "app_file"))
    with hq_check(export.configuration.hq()) as (state, record):
        app_id, refusal, _ = publish.create(state, export)
        assert refusal is None, refusal
        with build_seams():
            built = operations.build(operations.held_app(state, app_id), record)
    assert built.errors == [], built.errors
    suite = etree.fromstring(built.files["suite.xml"])
    strings = built.files["en/app_strings.txt"].decode().splitlines()

    assert len(upload["modules"]) == 2
    local_expectations = intent.expectations(document)
    for index, (module, entry) in enumerate(zip(upload["modules"], local_expectations, strict=True)):
        short = module["case_details"]["short"]
        assert (short.get("case_tile_template") == "custom") == (index == 1), short
        (column,) = short["columns"]
        assert column["format"] == "translatable-enum", column
        (word,) = column["enum"]
        key = word["key"]
        matched = re.fullmatch(r"v00000003_(case_text_[0-9a-f]{32})", key)
        assert matched is not None, key
        usual = matched.group(1)
        literal = f"{usual} v{usual} v00000002_{usual}"
        assert column["field"] == f"concat(${key}, '{literal}')"

        (field,) = suite.xpath(f"./detail[@id='m{index}_case_short']/field")
        assert (field.find("style") is not None) == (index == 1), etree.tostring(field)
        (template,) = field.xpath("./template/text/xpath")
        assert template.get("function") == f"concat($k{key}, '{literal}')"
        (variable,) = template.findall("variable")
        assert variable.attrib["name"] == f"k{key}"
        locale = variable.find("locale")
        assert locale is not None and locale.attrib["id"].endswith(f".enum.k{key}")
        assert f"{locale.attrib['id']}=Village" in strings

        blobs = Blobs()
        observed = intent.evaluation(core_runner, document, entry, blobs, archive=document.local_ccz)
        assert "result" in observed, observed
        (row,) = blobs.get_json(observed["result"])["caseList"]["rows"]
        assert row["caseId"] == entry["expect"][0]["value"]
        assert row["fields"] == [entry["expect"][1]["value"]]
