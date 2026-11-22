"""HQ keeps generated literal values and finds only actual instance calls.

The expression producer prints record values through Nova's wire tree in every
HQ JSON interpolation mode and inside an XForm attribute. HQ's own shortcut
interpolator must leave the protected modes byte-identical; image mapping keys
must replace only their intentional dot operands. Its HTML-decoding instance
scanner must find no instance inside a literal, including character references.
Independent XPath evaluation retains the literal's exact value.
No app is built and no Core or served reader runs for this check.

The reader of CommCare HQ's apps ports the same two helpers. HQ's own helpers
answer every vector the port is held to, as the port answers it, and for every
slot HQ interpolates, HQ's helper turns Nova's HQ JSON print, under the case
path the reader gives the slot, into the tree of Nova's suite print, read by
HQ's own XPath parser.
"""

import json

from lxml import etree

from proof.native.hq_support import hq_commit, sha256, write_evidence

FAMILIES = ("expression",)
CASES = {
    "case",
    "parent",
    "host",
    "worker",
    "session",
    "unused-fixture-token",
    "trailing-backslash",
    "trailing-three-backslashes",
    "trailing-even-backslashes",
    "backslash-before-quote",
    "backslash-before-token",
    "both-quotes",
    "instance-single",
    "instance-double",
    "instance-whitespace",
    "entity-quotes",
    "entity-letters",
    "entity-parentheses",
    "entity-whitespace",
    "entity-numeric-whitespace",
    "entity-no-semicolon",
    "entity-dropped-control",
    "entity-dropped-delete",
    "entity-dropped-vertical-tab",
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
        results.append({"id": row["id"], "mode": mode, "sha256": sha256(actual.encode("utf-8"))})

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
        enum_results.append({"id": row["id"], "sha256": sha256(actual.encode("utf-8"))})

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
            "Generated record literals and XForm attributes; the reader port's vectors and Nova's prints of a "
            "case read in each interpolating slot are held by this file's two reader cases. No app build, Core, or "
            "served reader.",
        },
    )


def _hq_tree(text):
    """The tree HQ's own XPath grammar reads ``text`` as (``proof.observe.manifest.expression_tree``: eulxml's rules
    with XPath's lexical rule for a name after a comma, which eulxml's lexer leaves out, so a call after a comma,
    ``selected(join(' ', instance('casedb')/...), ...)``, reads as Core reads it). A text the grammar refuses fails
    the comparison by name."""
    from proof.observe.manifest import expression_tree

    tree = expression_tree(text)
    assert tree is not None, f"HQ's XPath grammar refuses {text!r}"
    return tree


def _reader_payload(native):
    exports = native.family("expression")
    source = exports / "reader-interpolation.json"
    payload = json.loads(source.read_bytes())
    assert payload["schemaVersion"] == 1
    assert payload["vectors"] and payload["dots"] and payload["slots"]
    return exports, source, payload


def test_hq_answers_the_reader_ports_vectors_as_the_port_does(native):
    from corehq.apps.app_manager.exceptions import CaseXPathValidationError
    from corehq.apps.app_manager.xpath import dot_interpolate, interpolate_xpath

    exports, source, payload = _reader_payload(native)
    vector_results = []
    for vector in payload["vectors"]:
        text, case_xpath, dots = vector["text"], vector["caseXPath"], vector["interpolateDots"]
        try:
            answer = interpolate_xpath(text, case_xpath=case_xpath, interpolate_dots=dots)
        except CaseXPathValidationError:
            actual = {"ok": False, "reason": "case-reference"}
        else:
            # HQ replaces $fixture_value only for a menu that selects from a fixture, given its path; with none
            # it stays in the text, which no runtime reads, and the port refuses it.
            if "$fixture_value" in answer:
                actual = {"ok": False, "reason": "fixture-value"}
            else:
                actual = {"ok": True, "text": answer}
        assert actual == vector["port"], (vector["name"], text, actual, vector["port"])
        vector_results.append({"name": vector["name"], "answer": actual})

    dot_results = []
    for vector in payload["dots"]:
        actual = dot_interpolate(vector["text"], vector["replacement"])
        assert actual == vector["port"], (vector["name"], vector["text"], actual, vector["port"])
        dot_results.append({"name": vector["name"], "sha256": sha256(actual.encode("utf-8"))})

    write_evidence(
        exports,
        "hq-interpolation-reader-vectors",
        {
            "hqCommit": hq_commit(),
            "payloadSha256": sha256(source.read_bytes()),
            "vectors": vector_results,
            "dots": dot_results,
            "limits": "Native HQ interpolate_xpath and dot_interpolate over the reader port's vectors, each answer "
            "required to equal the port's. No app build, Core, or served reader.",
        },
    )


def test_hq_interpolates_novas_hq_print_into_its_suite_print(native):
    from corehq.apps.app_manager.xpath import interpolate_xpath

    exports, source, payload = _reader_payload(native)
    slots = payload["slots"]
    assert {row["mode"] for row in slots} == {"case", "no-case", "no-dots"}
    # A form's display condition is interpolated with a case path where the form opens on a case, and without one
    # where it opens on none: both are held.
    assert {("form_filter", "case"), ("form_filter", "no-case")} <= {(row["slot"], row["mode"]) for row in slots}
    slot_results = []
    for row in slots:
        interpolated = interpolate_xpath(
            row["hq"], case_xpath=row["caseXPath"], interpolate_dots=row["interpolateDots"]
        )
        assert _hq_tree(interpolated) == _hq_tree(row["suite"]), (row["slot"], interpolated, row["suite"])
        slot_results.append({"slot": row["slot"], "mode": row["mode"], "interpolated": interpolated})

    write_evidence(
        exports,
        "hq-interpolation-reader-slots",
        {
            "hqCommit": hq_commit(),
            "payloadSha256": sha256(source.read_bytes()),
            "slots": slot_results,
            "limits": "Native HQ interpolate_xpath over Nova's HQ JSON print of each slot HQ interpolates, with the "
            "case path the reader gives the slot, compared with Nova's suite print of the same expression as "
            "eulxml's XPath parser reads both. One admitted document; no app build, Core, or served reader.",
        },
    )


def test_hq_suite_lookup_discovery_and_column_interpolation_have_distinct_boundaries(
    native,
):
    from corehq.apps.app_manager.exceptions import CaseXPathValidationError
    from corehq.apps.app_manager.models import Module
    from corehq.apps.app_manager.suite_xml.post_process.instances import (
        get_all_instances_referenced_in_xpaths,
    )
    from corehq.apps.app_manager.suite_xml.sections.entries import EntriesHelper
    from corehq.apps.app_manager.xpath import interpolate_xpath
    import pytest

    module = Module.new_module("Visits", "en")
    results = []
    for tag, field, preserved, discovered in [
        ("meeting", "site.id", False, True),
        ("meeting", "a.1", True, True),
        ("meeting", "a1.b", True, True),
        ("meeting", "a.١", True, True),
        ("a.1", "id", True, False),
        ("ⓐ", "id", True, False),
        ("ζωνες", "région", True, True),
    ]:
        expression = f"instance('item-list:{tag}')/{tag}_list/{tag}/{field}"
        module.case_details.short.filter = expression
        case_filter = EntriesHelper.get_filter_xpath(module)
        # A menu listing cases interpolates against the current case. The same unquoted
        # period is a validation error in an expression with no case (e.g. module_filter).
        if preserved:
            assert case_filter == f"[{expression}]"
            assert interpolate_xpath(expression) == expression
        else:
            assert (
                case_filter == f"[{expression.replace('site.id', 'sitecurrent()id')}]"
            )
            with pytest.raises(CaseXPathValidationError):
                interpolate_xpath(expression)
        assert interpolate_xpath(expression, interpolate_dots=False) == expression
        # This is the producer of actual suite instance declarations. All names in this
        # check are generic fixture ids, whose factory does not access an application.
        instances, unknown = get_all_instances_referenced_in_xpaths(None, [case_filter])
        assert {(i.id, i.src) for i in instances} == (
            {(f"item-list:{tag}", f"jr://fixture/item-list:{tag}")}
            if discovered
            else set()
        )
        assert not unknown
        results.append(
            {
                "tag": tag,
                "field": field,
                "caseFilter": case_filter,
                "declared": discovered,
            }
        )
    write_evidence(
        native.family("expression"),
        "hq-suite-lookup-names",
        {"hqCommit": hq_commit(), "caseFilters": results},
    )
