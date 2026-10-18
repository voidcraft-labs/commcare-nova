"""HQ keeps generated literal values and finds only actual instance calls.

The expression producer prints record values through Nova's wire tree in every
HQ JSON interpolation mode and inside an XForm attribute. HQ's own shortcut
interpolator must leave the protected modes byte-identical; image mapping keys
must replace only their intentional dot operands. Its HTML-decoding instance
scanner must find no instance inside a literal, including character references.
Independent XPath evaluation retains the literal's exact value.
No app is built and no Core or served reader runs for this check.
"""

import json

from lxml import etree

from proof.native.hq_support import hq_commit, sha256, write_evidence

FAMILIES = ("expression",)
CASES = {
    "case", "parent", "host", "worker", "session", "unused-fixture-token",
    "trailing-backslash", "trailing-three-backslashes", "trailing-even-backslashes",
    "backslash-before-quote", "backslash-before-token", "both-quotes",
    "instance-single", "instance-double", "instance-whitespace", "entity-quotes",
    "entity-letters", "entity-parentheses", "entity-whitespace",
    "entity-numeric-whitespace", "entity-no-semicolon",
    "entity-dropped-control", "entity-dropped-delete", "entity-dropped-vertical-tab",
}


def _escaped_backslash(_context, value, start, end):
    """Adapt only the serializer's backslash escape to libxml XPath.

    JavaRosa's XPathSubstrFunc indexes from zero and excludes the end. The
    only non-XPath-1 function these probes use extracts one of two literal
    backslashes. Refuse every other call rather than simulate a runtime.
    """
    assert value == "\\\\" and start == 0 and end == 1
    return value[:1]


def _value(context, text):
    return context.xpath(text, extensions={(None, "substr"): _escaped_backslash})


def test_hq_preserves_literals_through_interpolation_and_instance_discovery(native):
    from corehq.apps.app_manager.models.case_list import MappingItem
    from corehq.apps.app_manager.suite_xml.post_process.instances import get_instance_names
    from corehq.apps.app_manager.xpath import dot_interpolate, interpolate_xpath

    exports = native.family("expression")
    source = exports / "interpolation.json"
    payload = json.loads(source.read_bytes())
    assert payload["schemaVersion"] == 1
    rows = payload["interpolation"]
    assert {(row["id"], row["mode"]) for row in rows} == {
        (name, mode) for name in CASES for mode in ("none", "case", "no-case", "no-dots")
    }
    assert len(rows) == len(CASES) * 4
    context = etree.fromstring(b"<context><property>chosen</property></context>")
    results = []
    for row in rows:
        text = row["text"]
        mode = row["mode"]
        if mode == "none":
            actual = text
        elif mode == "case":
            actual = interpolate_xpath(text, case_xpath="/selected/case")
        else:
            actual = interpolate_xpath(text, interpolate_dots=mode != "no-dots")
        assert actual == text, (row["id"], mode, text, actual)
        assert _value(context, actual) == row["value"], (row["id"], mode)
        assert get_instance_names(actual) == set(), (row["id"], mode, actual)
        results.append({"id": row["id"], "mode": mode, "sha256": sha256(actual)})

    xforms = payload["xforms"]
    assert {row["id"] for row in xforms} == CASES
    assert len(xforms) == len(CASES)
    for row in xforms:
        decoded = etree.fromstring(row["xml"].encode("utf-8")).attrib["calculate"]
        assert decoded == row["text"], row["id"]
        assert _value(context, decoded) == row["value"], row["id"]
        # XForm.add_missing_instances scans self.render(), with one HTML decode.
        # Scanning the decoded attribute would add a decode HQ never performs.
        assert get_instance_names(row["xml"]) == set(), (row["id"], row["xml"])

    enum_keys = payload["enumKeys"]
    assert {row["id"] for row in enum_keys} == CASES | {"literal-dot"}
    assert len(enum_keys) == len(CASES) + 1
    enum_results = []
    for row in enum_keys:
        text = row["text"]
        actual = dot_interpolate(text, "/context/property")
        assert actual != text, row["id"]
        mapping = MappingItem(key=text)
        assert mapping.treat_as_expression, row["id"]
        assert mapping.key_as_condition("/context/property") == actual, row["id"]
        assert _value(context, actual) == f"chosen{row['value']}chosen", row["id"]
        assert get_instance_names(actual) == set(), (row["id"], actual)
        enum_results.append({"id": row["id"], "sha256": sha256(actual)})

    # A successful empty result above must not come from disabling discovery.
    assert get_instance_names("instance('casedb')/casedb/case") == {"casedb"}
    write_evidence(
        exports,
        "hq-interpolation",
        {
            "hqCommit": hq_commit(),
            "payloadSha256": sha256(source.read_bytes()),
            "interpolation": results,
            "xformCases": sorted(CASES),
            "enumKeys": enum_results,
            "limits": "Native HQ interpolate_xpath, dot_interpolate, MappingItem.key_as_condition and "
            "get_instance_names; libxml XPath values with only JavaRosa's one-backslash substr escape adapted. "
            "Generated record literals and XForm attributes only; no app build, Core, or served reader.",
        },
    )
