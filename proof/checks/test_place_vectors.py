"""The lane spells a place as the reader of CommCare HQ's apps spells it.

Contract: ``fixtures/place-vectors.json`` holds nodes of XForm documents with
the ``where`` each is recorded at, names in namespaces with the qualified name
each is written as, and JSON keys with the pointer token each becomes. The
manifest check's own functions give exactly those: ``_element_path`` for an
element (each step its qualified name and, below the root, its position among
its parent's elements of the same expanded name, comments passed over), the
element's path, ``/@`` and ``qualified`` of the attribute for an attribute,
for its default namespace the ``where`` of the ``@xmlns`` use
``xform_vocabulary`` itself records over the vector's document, ``qualified``
for a name, and
``pointer_token`` for a key. The reader's side holds the same file
(``lib/commcare/reader/__tests__/placeVectors.test.ts``), so a change to one
side's spelling fails here or there, before part of the parity join silently
misses: a record the reader writes at one place and the lane at another.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from lxml import etree

from proof.checks.differences import pointer_token
from proof.checks.manifest_usage import Uses, _element_path, load_manifest, qualified, xform_uses

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "place-vectors.json").read_text(encoding="utf-8"))
XML_NS = "http://www.w3.org/XML/1998/namespace"


def _node(document, path):
    element = etree.fromstring(document.encode("utf-8"))
    for index in path:
        element = [child for child in element if isinstance(child.tag, str)][index]
    return element


def _position(element):
    """The element's path from the root as ``_node`` walks it: its index among each parent's elements."""
    path = []
    while element.getparent() is not None:
        parent = element.getparent()
        path.append([child for child in parent if isinstance(child.tag, str)].index(element))
        element = parent
    return list(reversed(path))


def _namespace_read(document, path):
    """Where ``xform_vocabulary`` records the read of the default namespace of the element at ``path``: its own
    ``@xmlns`` use, from what it found in the document."""
    found = Uses()
    xform_uses(document.encode("utf-8"), load_manifest(), "form:0.0", found)
    reads = [
        use.where
        for use in found.uses
        if use.key.endswith("@xmlns")
        and use.at is not None
        and use.at.attribute is None
        and _position(use.at.element) == path
    ]
    assert len(reads) == 1, f"The lane records {len(reads)} namespace reads of the vector's element, not one."
    return reads[0]


def _clark(element, written):
    """An attribute's name as lxml keys it, from the name the source wrote."""
    prefix, _, local = written.rpartition(":")
    if not prefix:
        return local
    namespace = XML_NS if prefix == "xml" else element.nsmap[prefix]
    return f"{{{namespace}}}{local}"


@pytest.mark.parametrize("vector", VECTORS["nodes"], ids=lambda vector: vector["where"])
def test_a_node_is_where_the_reader_records_it(vector):
    element = _node(VECTORS["documents"][vector["document"]], vector["path"])
    attribute = vector["attribute"]
    if attribute is None:
        where = _element_path(element)
    elif attribute == "xmlns":
        where = _namespace_read(VECTORS["documents"][vector["document"]], vector["path"])
    else:
        name = _clark(element, attribute)
        assert name in element.attrib, f"{attribute} is no attribute of the vector's element"
        where = f"{_element_path(element)}/@{qualified(name)}"
    assert where == vector["where"]


@pytest.mark.parametrize("vector", VECTORS["qualified"], ids=lambda vector: vector["name"])
def test_a_name_is_qualified_as_the_reader_qualifies_it(vector):
    namespace = vector["namespace"]
    name = vector["local"] if namespace is None else f"{{{namespace}}}{vector['local']}"
    assert qualified(name) == vector["name"]


@pytest.mark.parametrize("vector", VECTORS["pointerTokens"], ids=lambda vector: vector["token"] or "empty")
def test_a_key_is_the_reader_s_pointer_token(vector):
    assert pointer_token(vector["key"]) == vector["token"]
