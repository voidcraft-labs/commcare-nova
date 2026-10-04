"""HQ's XML parser agrees with Nova's well-formedness corpus, and HQ reads Nova's text exactly.

Contract: libxml, as HQ's lxml runs it (no recovery, no entity resolution,
no network), accepts and refuses each case of Nova's well-formedness corpus
(``proof/native/xml/well-formedness.json``, which ``xmlBoundary.test.ts``
also runs against Nova's own gates) exactly as the corpus records; HQ's
import refuses to parse each pre-fix source Nova's audit found
(``before-audit-*``) and parses the Unicode scenario; and in HQ's parse and
the CCZ form alike the label reads its exact decoded text and the default
keeps its tab, newline and carriage return (``'A\\tB\\nC\\rD'``), while the
profile carries the app's name. Reference-separated prose retains whitespace
outputs through both the local and HQ-regenerated forms in each
language and text variant. ``XmlTextRuntimeTest`` then reads exact substituted
plain and Markdown prompts in Core. The plausible failures: a character Nova's gate admits that
libxml refuses (or the reverse), a pre-fix source HQ starts to accept, and
whitespace or text HQ's parse changes. DTDs and XML 1.1 are Nova policy, not
malformedness, so the corpus's ``policyOnly`` cases are not claimed here.
"""

import json
from pathlib import Path

from lxml import etree

from proof.native.hq_support import hq_commit, sha256, write_evidence

FAMILIES = ("xml",)
CORPUS = Path(__file__).resolve().parent / "xml" / "well-formedness.json"
NAMESPACES = {"x": "http://www.w3.org/2002/xforms"}


def test_libxml_verdicts_match_the_well_formedness_corpus(native):
    results = []
    for case in json.loads(CORPUS.read_bytes()):
        if case.get("policyOnly"):
            continue  # Nova accepts neither DTDs nor XML 1.1 resources, by policy.
        error_name = None
        try:
            etree.fromstring(
                case["xml"].encode("utf-8"),
                parser=etree.XMLParser(recover=False, resolve_entities=False, no_network=True),
            )
            accepted = True
        except (etree.XMLSyntaxError, UnicodeEncodeError) as error:
            accepted = False
            error_name = type(error).__name__
        assert accepted == case["accepted"], case["name"]
        results.append({"name": case["name"], "accepted": accepted, "error": error_name})
    assert results
    write_evidence(
        native.out,
        "xml-well-formedness",
        {
            "lxmlVersion": etree.LXML_VERSION,
            "libxmlVersion": etree.LIBXML_VERSION,
            "corpusSha256": sha256(CORPUS.read_bytes()),
            "xmlCases": results,
        },
    )


def test_hq_refuses_the_pre_fix_sources_and_reads_novas_text_exactly(native):
    records = native.step("xml")
    exports = native.family("xml")
    forms = []
    for record in records:
        scenario = record["scenario"]
        accepted = record["error"] is None
        assert accepted == scenario["accepted"], scenario["name"]
        if accepted:
            local = etree.fromstring((exports / f"{scenario['name']}.xml").read_bytes())
            profile = etree.fromstring((exports / f"{scenario['name']}.ccpr").read_bytes())
            regenerated = etree.fromstring((exports / f"{scenario['name']}.hq.xml").read_bytes())
            for artifact in [etree.fromstring(record["source"]), local, regenerated]:
                labels = artifact.xpath(
                    '//x:itext/x:translation[@lang="en"]/x:text[@id="answer-label"]/x:value[not(@form)]/text()',
                    namespaces=NAMESPACES,
                )
                assert labels == [scenario["text"]], labels
                # Character references preserve XML attribute whitespace;
                # literal whitespace would instead be normalized by the parser.
                starting = artifact.xpath('//x:model/x:setvalue[@ref="/data/answer"]/@value', namespaces=NAMESPACES)
                assert starting == ["'A\tB\nC\rD'"], starting
            assert profile.attrib["name"] == "Café 雪 😀"
        forms.append(
            {
                "name": scenario["name"],
                "accepted": accepted,
                "error": record["error"],
                "inputSha256": record["inputSha256"],
            }
        )
    write_evidence(
        exports,
        "xml-boundary",
        {
            "hqCommit": hq_commit(),
            "nativeHqForms": forms,
            "limits": "Read-only native HQ Application.from_source and XForm.xml, native libxml well-formedness, "
            "and decoded text from actual CCZ artifacts. No database writes, remote calls, HQ build or Android "
            "installation. DTD and XML 1.1 refusal is Nova policy, excluded from native malformedness claims.",
        },
    )


def test_hq_regeneration_preserves_literal_separators_without_rewriting_unicode_or_markup(native):
    exports = native.family("xml")
    record = next(record for record in native.step("xml") if record["scenario"]["name"] == "unicode")
    separators = {
        "delivery_context-label": ["/data/meals", "'\n\n'", "/data/address"],
        "space-label": ["/data/meals", "' '", "/data/address"],
        "xml_whitespace-label": ["/data/meals", "'\t \r\n'", "/data/address"],
        "edge_whitespace-label": ["' \t'", "/data/meals", "'\n '", "/data/address", "'\t '"],
        "checked-hint": ["/data/meals", "'\n\n'", "/data/address"],
        "checked-help": ["/data/meals", "' '", "/data/address"],
        "checked-constraintMsg": ["/data/meals", "'\t'", "/data/address"],
        "choose-opt0-label": ["/data/meals", "'\n\n'", "/data/address"],
        "unicode_spacing-label": [
            "/data/meals", "json-property('{\"v\":\"\\u00a0\\u2003\\u2028\"}', 'v')", "/data/address"
        ],
        "consumer_spacing-label": [
            "/data/meals",
            "json-property('{\"v\":\"\\t\\n\\r \\u0085\\u00a0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\"}', 'v')",
            "/data/address",
        ],
    }
    artifacts = {
        "hq-source": record["source"],
        "local": (exports / "unicode.xml").read_bytes(),
        "hq-regenerated": (exports / "unicode.hq.xml").read_bytes(),
    }
    for path, data in artifacts.items():
        root = etree.fromstring(data)
        assert root.xpath('//x:alert/@ref', namespaces=NAMESPACES) == ["jr:itext('checked-constraintMsg')"], path
        assert root.xpath('//x:bind[@nodeset="/data/checked"]/@jr:constraintMsg',
            namespaces={**NAMESPACES, "jr": "http://openrosa.org/javarosa"}) == ["jr:itext('checked-constraintMsg')"], path
        translations = root.xpath("//x:itext/x:translation", namespaces=NAMESPACES)
        assert [translation.attrib["lang"] for translation in translations] == ["en", "es"], path
        for translation in translations:
            for text_id, expected in separators.items():
                values = translation.xpath("x:text[@id=$id]/x:value", id=text_id, namespaces=NAMESPACES)
                assert [value.attrib.get("form") for value in values] == [None, "markdown"], (path, text_id)
                for value in values:
                    outputs = value.xpath("x:output/@value", namespaces=NAMESPACES)
                    assert outputs == expected, (path, text_id, outputs)
                    assert len(value) == len(expected), (path, text_id)
                    prefix = ""
                    if text_id == "delivery_context-label":
                        prefix = "Comidas: " if translation.attrib["lang"] == "es" else "Meals: "
                    assert "".join(value.itertext()) == prefix, (path, text_id)
                    for output in value:
                        if not output.attrib["value"].startswith("/data/"):
                            assert dict(output.attrib) == {"value": output.attrib["value"]}, (path, text_id)
            for value in translation.xpath('x:text[@id="mixed_nbsp-label"]/x:value', namespaces=NAMESPACES):
                assert "".join(value.itertext()) == 'It\'s "early"today', path
                assert [dict(output.attrib) for output in value] == [
                    {"value": "json-property('{\"v\":\"\\u00a0\"}', 'v')"}
                ], path
            for value in translation.xpath('x:text[@id="escaped_markup-label"]/x:value', namespaces=NAMESPACES):
                assert len(value) == 0, path
                assert value.text == "Literal <output value=\"'x'\"/> & #form/meals", path
    write_evidence(
        exports,
        "prose-separators",
        {"hqCommit": hq_commit(), "artifacts": {path: sha256(data) for path, data in artifacts.items()}},
    )
