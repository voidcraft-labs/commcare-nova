"""The attributes of a suite Core's suite parsers hand to its XPath parser, for the rules that read a suite's
expressions.

A private helper of the rule modules (``proof.rules.unregistered_rules``
reads a module whose name starts with ``_`` as no rule). ``XPATH_ATTRIBUTES``
is each ``(element, attribute)`` an item ``parser:<Parser>/<element>@<attribute>``
of ``lib/commcare/surface/surface.json`` names with ``parsedAs: xpath``: the
attributes commcare-core's suite parsers (``org/commcare/xml/*Parser.java``)
read with ``XPathParseTool.parseXPath``, among them a detail's
``xpath@function``, a session datum's ``@nodeset`` and ``@value`` and a stack
operation's ``@if``. An element named ``*`` stands for any child of the
element before it (``variables/*``, a detail's variables). No other
parser item names one of these pairs, so an id, a locale's id or a media path
is never read as an expression; ``proof/rules/test_suite_xpath_lexemes.py``
holds both to the surface.
"""

from __future__ import annotations

# (element, attribute) of every suite attribute Core parses as XPath; ("variables/*", a) is any child of
# ``<variables>``.
XPATH_ATTRIBUTES = frozenset(
    {
        ("action", "auto_launch"),
        ("action", "relevant"),
        ("assert", "test"),
        ("clear", "if"),
        ("command", "relevant"),
        ("command", "value"),
        ("create", "if"),
        ("data", "exclude"),
        ("data", "nodeset"),
        ("data", "ref"),
        ("datum", "function"),
        ("datum", "nodeset"),
        ("datum", "value"),
        ("detail", "nodeset"),
        ("detail", "relevant"),
        ("extra", "value"),
        ("field", "relevant"),
        ("focus", "function"),
        ("form", "function"),
        ("form", "nodeset"),
        ("form", "value"),
        ("group", "function"),
        ("instance-datum", "function"),
        ("instance-datum", "nodeset"),
        ("instance-datum", "value"),
        ("itemset", "nodeset"),
        ("label", "ref"),
        ("mark", "value"),
        ("menu", "relevant"),
        ("post", "relevant"),
        ("prompt", "default"),
        ("prompt", "exclude"),
        ("prompt", "required"),
        ("push", "if"),
        ("radius", "function"),
        ("required", "test"),
        ("rewind", "value"),
        ("series", "nodeset"),
        ("sort", "ref"),
        ("validation", "test"),
        ("value", "ref"),
        ("variables/*", "function"),
        ("x", "function"),
        ("xpath", "function"),
        ("y", "function"),
    }
)


def _local(tag):
    return tag.rpartition("}")[2] if isinstance(tag, str) else None


def is_xpath(element, attribute):
    """Whether Core's suite parsers read ``element``'s ``attribute`` (an unprefixed name) as XPath."""
    if (_local(element.tag), attribute) in XPATH_ATTRIBUTES:
        return True
    parent = element.getparent()
    return parent is not None and _local(parent.tag) == "variables" and ("variables/*", attribute) in XPATH_ATTRIBUTES


def rewrite_expressions(root, rewrite):
    """``root``, a suite parsed by lxml, with each XPath attribute's text replaced by ``rewrite(text)``."""
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        for attribute, value in list(element.attrib.items()):
            if "}" not in attribute and is_xpath(element, attribute):
                element.set(attribute, rewrite(value))
    return root
