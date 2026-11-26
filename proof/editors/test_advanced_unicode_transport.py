"""Compare the worker lexer profiles with HQ's actual XForm XML boundary."""

import json
from pathlib import Path
import re
import xml.parsers.expat
from xml.etree import ElementTree

from lxml import etree

from proof.editors import compare
from proof.editors.conftest import ADVANCED_APP, publish_hq_app, write_evidence
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

ROOT = Path(__file__).resolve().parents[2]
CASE = "http://commcarehq.org/case/transaction/v2"

# XML 1.0 (fifth edition) NCName grammar over the two pinned UTF-16 lexers' BMP units.
XML_START = "A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD"
NCNAME = re.compile(f"[{XML_START}][{XML_START}.0-9\u00B7\u0300-\u036F\u203F-\u2040-]*")
CONTROLS = {
    "ascii-hyphen": "my-parent",
    "latin-1": "Équipe",
    "shared-greek": "Ωprobe",
    "shared-digraph": "Ĳprobe",
    "shared-nko-digit": "probe߀",
    "web-only-georgian": "აprobe",
    "combining-mark": "probe-e\u0301",
    "invalid-xml-mu": "µprobe",
    "namespace-colon": "my:parent",
    "invalid-xml-control": "bad\u0003name",
}


def _units(pairs):
    return {unit for first, last in zip(pairs[::2], pairs[1::2], strict=True)
            for unit in range(first, last + 1)}


def _portable_names():
    profiles = [
        {kind: _units(pairs) for kind, pairs in json.loads((ROOT / path).read_text()).items()}
        for path in ("lib/domain/portableNameRanges.json", "lib/domain/androidNameRanges.json")
    ]
    initial = profiles[0]["initial"] & profiles[1]["initial"]
    continuation = (profiles[0]["initial"] | profiles[0]["continuationOnly"]) & (
        profiles[1]["initial"] | profiles[1]["continuationOnly"]
    )
    return {
        "initial": {unit: f"{chr(unit)}probe" for unit in sorted(initial)},
        "continuation": {unit: f"probe{chr(unit)}" for unit in sorted(continuation)},
    }


def test_advanced_index_alphabet_has_distinct_hq_xml_boundaries(hq):
    from corehq.apps.app_manager.xform import make_case_elem
    from corehq.util.xml_utils import safe_fromstring

    def construct(name):
        try:
            return etree.QName(make_case_elem(name)).localname == name
        except ValueError:
            return False

    def parse(name):
        wire = f'<{name} xmlns="{CASE}"/>'.encode()
        try:
            return etree.QName(safe_fromstring(wire)).localname == name
        except (ValueError, etree.XMLSyntaxError):
            return False

    def parse_expat(name):
        wire = f'<{name} xmlns="{CASE}"/>'.encode()
        try:
            return ElementTree.fromstring(wire).tag == f"{{{CASE}}}{name}"
        except ElementTree.ParseError:
            return False

    authorities = {
        "hq-namespaced-constructor": construct,
        "hq-raw-xml-parser": parse,
        "expat-parser": parse_expat,
    }
    alphabet = {
        position: {
            "shared-lexer-units-outside-xml-ncname": [
                unit for unit, name in names.items() if NCNAME.fullmatch(name) is None
            ],
            **{
                source: [unit for unit, name in names.items() if NCNAME.fullmatch(name) and accepts(name)]
                for source, accepts in authorities.items()
            },
        }
        for position, names in _portable_names().items()
    }
    controls = {
        label: {
            "name": name,
            "xml-ncname": NCNAME.fullmatch(name) is not None,
            **{source: accepts(name) for source, accepts in authorities.items()},
        }
        for label, name in CONTROLS.items()
    }

    with hq_check(Configuration(privileges={"CHILD_CASES"})) as (state, record):
        app_id = publish_hq_app(state, ADVANCED_APP)
        for label in ("ascii-hyphen", "latin-1", "shared-greek", "shared-digraph", "shared-nko-digit", "web-only-georgian"):
            with state.fork():
                app = operations.held_app(state, app_id)
                form = app.modules[1].forms[1]
                form.actions.open_cases[0].case_indices[0].reference_id = CONTROLS[label]
                app.save()
                try:
                    built = compare.build(state, app_id, record)
                except ValueError as error:
                    controls[label]["hq-build"] = str(error)
                else:
                    controls[label]["hq-build"] = (
                        "errors" if built.errors else etree.fromstring(built.files["modules-1/forms-1.xml"])
                        .xpath("//*[local-name()='index']/*[local-name()=$name]", name=CONTROLS[label]) != []
                    )

    versions = {"libxml": etree.LIBXML_VERSION, "lxml": etree.LXML_VERSION, "expat": xml.parsers.expat.EXPAT_VERSION}
    write_evidence("advanced-index-xml-transport", {"versions": versions, "alphabet": alphabet, "controls": controls})
    print(json.dumps({
        "versions": versions,
        "alphabet": {position: {source: len(units) for source, units in sources.items()}
                     for position, sources in alphabet.items()},
        "controls": controls,
    }, ensure_ascii=True))
    assert controls["latin-1"]["hq-build"] is True
    assert controls["shared-greek"]["hq-build"] is True
    assert controls["namespace-colon"]["hq-namespaced-constructor"] is False
    assert controls["invalid-xml-control"]["hq-raw-xml-parser"] is False
