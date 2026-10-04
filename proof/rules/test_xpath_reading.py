"""The rules read a path's and a value's shape as Core's own XPath parser builds it.

Contract: ``proof/rules/_xpath.py`` ports Core's XPath lexer for the rules,
which run in the judges without the Core runner: a text it reads as a plain
path (``plain_path``) Core parses as one path from the root of named child
steps and a named attribute step, a text it reads as reading no node
(``node_free``) Core parses as a string or number literal, negated or not,
or a call of ``now()``, ``today()`` or ``uuid()`` with no argument, and the
calls it finds (``calls``) of the functions that draw a random value
(``random``, ``uuid``) are the calls of them Core parses. The plausible
failures: the port reading a text as one of those shapes that Core parses
as another (an arithmetic step such as ``/data/a+1``, a predicate, a
wildcard, an attribute wildcard ``@*``, a relative or descendant step, a
call with an argument), or missing a call Core makes, so a rule would
reorder or erase what Core reads otherwise; and the port refusing what the
corpus spells in those shapes, so a rule would erase nothing.

Every bind node set and expression, control and setvalue ref and setvalue
value of each rule document's local build, and texts built to cross each
boundary, are read both ways: by the port, and by the runner's
``xpathParse`` (``XPathParseTool.parseXPath``, the parser every form reader
calls). Each text the port reads as a shape, Core parses as that shape;
each text Core parses, the port finds the same calls of ``random`` and
``uuid`` in or does not read; each corpus text Core parses as a plain path
the port reads as one where it is spelled with nothing between its tokens
and no prefix, each corpus value Core parses as reading no node the port
reads as one, and the port reads every corpus text Core parses.
"""

from __future__ import annotations

import zipfile

from lxml import etree

from proof.rules._xpath import calls, node_free, plain_path
from proof.rules.conftest import DOCUMENTS

XF = "{http://www.w3.org/2002/xforms}"
# The node-free calls Core builds into classes of their own (XPathNowFunc, XPathTodayFunc, XPathUuidFunc); a negated
# number is an XPathNumNegExpr over its literal.
NODE_FREE_CALLS = {"now", "today", "uuid"}
# The functions that draw from Core's random source (XPathRandomFunc, XPathUuidFunc), whose calls the rules look for.
DRAWING = {"random", "uuid"}
# The attributes the rules read as expressions: node sets, refs and values, and every bind expression Core parses.
EXPRESSIONS = ("nodeset", "ref", "value", "relevant", "required", "readonly", "calculate", "constraint")
# Texts on each side of each boundary, with what the port reads them as: (plain path, node free).
CROSSING = {
    "/data/a": (True, False),
    "/data/a/@b": (True, False),
    "/data/div": (True, False),
    "/data/a-b.c_d": (True, False),
    "/data/a+1": (False, False),
    "/data/a@b": (False, False),
    "/data/a/@b/c": (False, False),
    "/data/*": (False, False),
    "/data/@*": (False, False),
    "/data/a/@*": (False, False),
    "/data/@1": (False, False),
    "/data/@a:b": (False, False),
    "/data/a[1]": (False, False),
    "/data//a": (False, False),
    "//data": (False, False),
    "/data/./a": (False, False),
    "/data/../a": (False, False),
    "/data/x:a": (False, False),
    "/ data/a": (False, False),
    "data/a": (False, False),
    "/data/a | /data/b": (False, False),
    "/data/text()": (False, False),
    "now()": (False, True),
    "today()": (False, True),
    "uuid()": (False, True),
    "now ( )": (False, True),
    "'a'": (False, True),
    '"b c"': (False, True),
    "'é'": (False, True),
    "42": (False, True),
    "-1": (False, True),
    ".5": (False, True),
    "uuid(1)": (False, False),
    "concat('a')": (False, False),
    "now() + 1": (False, False),
    "'a' = 'b'": (False, False),
    "$x": (False, False),
    "jr:itext('x')": (False, False),
    "instance('casedb')/casedb/case": (False, False),
    "/data/é": (False, False),
}
# Texts on each side of a drawing call, with the calls of DRAWING the port finds in them (None: it reads none).
CALLING = {
    "random()": ["random"],
    "random ( )": ["random"],
    "1 + random()": ["random"],
    "concat(random(), uuid())": ["random", "uuid"],
    "uuid(8)": ["uuid"],
    "if(/data/a = '', uuid(), /data/a)": ["uuid"],
    "/data/random": [],
    "/data/random/uuid": [],
    "'random()'": [],
    "x:random()": [],
    "/data/random[uuid() = 1]": ["uuid"],
}


def _texts(document):
    """Every expression the rules read in the document's local build: node sets, refs and setvalue values."""
    found = set()
    with zipfile.ZipFile(document.root / "local.ccz") as archive:
        for name in archive.namelist():
            if not name.endswith(".xml") or "/forms-" not in name:
                continue
            root = etree.fromstring(archive.read(name))
            for element in root.iter(f"{XF}bind", f"{XF}setvalue", f"{XF}input", f"{XF}select1", f"{XF}select"):
                for attribute in EXPRESSIONS:
                    if element.get(attribute) is not None:
                        found.add(element.get(attribute))
    return found


def _core_plain_path(text, parsed):
    return (
        "error" not in parsed
        and text.lstrip(" \n\t\f\r").startswith("/")
        and parsed["functions"] == []
        and parsed["roots"] == []
        and parsed["expressions"] == ["XPathPathExpr"]
        and parsed["tests"] == ["TEST_NAME"]
        and set(parsed["axes"]) <= {"AXIS_CHILD", "AXIS_ATTRIBUTE"}
        and set(parsed["tokens"]) <= {"SLASH", "QNAME", "AT"}
    )


def _core_node_free(parsed):
    if "error" in parsed or parsed["roots"]:
        return False
    if parsed["functions"]:
        return set(parsed["functions"]) <= NODE_FREE_CALLS and parsed["expressions"] == []
    return parsed["expressions"] in (
        ["XPathStringLiteral"],
        ["XPathNumericLiteral"],
        ["XPathNumNegExpr", "XPathNumericLiteral"],
    )


def _drawn(names):
    """The drawing functions among ``names``, each once."""
    return sorted({name for name in names if name in DRAWING})


def test_the_port_reads_each_shape_as_cores_parser_builds_it(rule_documents, core_runner):
    corpus = set().union(*(_texts(rule_documents[document_id]) for document_id in DOCUMENTS))
    texts = sorted(corpus | set(CROSSING) | set(CALLING))
    results = core_runner.request("xpathParse", deadline=120.0, expressions=texts)["results"]
    parsed = dict(zip(texts, results, strict=True))

    misread = [
        (text, parsed[text])
        for text in texts
        if (plain_path(text) and not _core_plain_path(text, parsed[text]))
        or (node_free(text) and not _core_node_free(parsed[text]))
    ]
    assert misread == [], misread
    assert {text: (plain_path(text), node_free(text)) for text in CROSSING} == CROSSING
    refused = [
        text
        for text in corpus
        if (
            _core_plain_path(text, parsed[text])
            and text == "".join(text.split())
            and ":" not in text
            and not plain_path(text)
        )
        or (_core_node_free(parsed[text]) and not node_free(text))
    ]
    assert refused == [], refused
    assert any(plain_path(text) for text in corpus) and any(node_free(text) for text in corpus)

    # Each call of a drawing function Core parses, the port finds, and no other.
    miscalled = [
        (text, calls(text), parsed[text].get("functions"))
        for text in texts
        if "error" not in parsed[text]
        and calls(text) is not None
        and _drawn(name for name, _ in calls(text)) != _drawn(parsed[text]["functions"])
    ]
    assert miscalled == [], miscalled
    assert {text: _drawn(name for name, _ in calls(text)) for text in CALLING} == CALLING
    unread = sorted(text for text in corpus if "error" not in parsed[text] and calls(text) is None)
    assert unread == [], unread
    assert any(_drawn(name for name, _ in calls(text)) for text in corpus)
