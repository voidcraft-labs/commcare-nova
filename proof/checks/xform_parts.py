"""A form's XForm source as the parts its readers key it by, each at the data node it is about, for the stored-app
comparison (``proof.checks.source``).

The first-publish judge holds each difference to the places the changes Nova's review lists stand at
(``proof.checks.changes``), and a change of a form stands at a node of its data. So a form's source is compared
part by part, each part keyed the way Core and HQ's form builder find it, and each placed under the node it
belongs to (``at`` after the attachment, ``path`` with the app's own names ``*``):

- the title, ``/title`` (``h:head/h:title``, its text);
- each node of the primary instance by its path from the data root, ``/data/a/b``: that it is there, each
  attribute (``/data/a/b/@<name>``) and a leaf's text (``/data/a/b/text()``); the data root's own attributes
  at ``/data/@<name>``;
- each bind by its node set, at the node it names: each attribute but the node set
  (``/data/a/b/:bind/@<name>``);
- each setvalue by its event and the node it sets: ``/data/a/b/:setvalue/<event>/@value``;
- each control of the body by the node it names: its element (``/data/a/b/:control``), each attribute but its
  ``ref`` or ``nodeset`` (``.../:control/@<name>``), each text it holds inline (``.../:control/label``,
  ``hint``, ``help``, ``alert``), each choice by its value (``.../:control/item/<value>``), its itemset's parts
  (``.../:control/itemset/...``), and the order of the controls it holds (``.../:control/order()``);
- each itext text by what reads it: a control's label, hint, help or alert, a choice's label, or a bind's
  ``jr:constraintMsg``, at that node and role, by language and form
  (``/data/a/b/:itext/label/<lang>/<form>``), so a text Nova keeps under another id is the same part; a text
  nothing reads by its id (``/:itext/<id>/<lang>/<form>``), and each translation's own attributes
  (``/:translation/<lang>/@<name>``);
- a secondary instance by its id (``/:instance/<id>``), and every other part of the head, the model or a
  container that names no node at the node it stands in (``/:head/...``, ``/:model/...``, ``.../:group/...``).

A node is named by its path only where it is a plain absolute path (``proof.rules._xpath.plain_path``, Core's
lexer); a bind, setvalue or control naming one any other way is keyed by its text under ``/:by-text/``. A text
reference is read through Core's lexer too: ``jr:itext('<id>')`` and nothing else. Two values are equal where
their parsed content is: an element's text and its children serialized in document order, attributes by name.

Pure, standard library only: it reads the two texts it is given.
"""

from __future__ import annotations

import xml.etree.ElementTree as ElementTree

from proof.checks.differences import pointer_token
from proof.rules import _xpath

XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"
# The prefix each namespace a form's readers name attributes in is written with; one not listed keeps ``{uri}``.
PREFIXES = {
    XFORMS: "",
    XHTML: "h",
    "http://openrosa.org/javarosa": "jr",
    "http://commcarehq.org/xforms/vellum": "vellum",
    "http://openrosa.org/xforms": "orx",
    "http://www.w3.org/2001/XMLSchema": "xsd",
    "http://commcarehq.org/xforms": "cc",
    "http://www.w3.org/XML/1998/namespace": "xml",
}
TEXT_ROLES = ("label", "hint", "help", "alert")
DATA = "data"
NOT_WELL_FORMED = ":not-well-formed"


def name(qname: str) -> str:
    """``{uri}local`` as its prefix writes it (``PREFIXES``), a name in no namespace as it stands."""
    if not qname.startswith("{"):
        return qname
    uri, _, local = qname[1:].partition("}")
    prefix = PREFIXES.get(uri)
    if prefix is None:
        return qname
    return local if prefix == "" else f"{prefix}:{local}"


def local(qname: str) -> str:
    return qname.rpartition("}")[2]


def content(element) -> str:
    """An element's text and its children serialized, in document order."""
    return (element.text or "") + "".join(ElementTree.tostring(child, encoding="unicode") for child in element)


def itext_id(reference: str | None) -> str | None:
    """The id ``jr:itext('<id>')`` names, read through Core's lexer, or None for any other text."""
    if not reference:
        return None
    found = _xpath.tokens(reference)
    if found is None or [token.kind for token in found] != ["QNAME", "LPAREN", "STR", "RPAREN"]:
        return None
    if found[0].text != "jr:itext":
        return None
    return _xpath.string_value(found[2])


def node_steps(reference: str | None) -> tuple[str, ...] | None:
    """The steps of a plain absolute path from the data root (``/data/a/b`` gives ``("data", "a", "b")``), or
    None where ``reference`` is no such path."""
    if not reference or not _xpath.plain_path(reference):
        return None
    steps = tuple(step for step in reference.split("/") if step)
    return steps if steps and steps[0] == DATA else None


class _Parts:
    """The parts of one form: ``{at: (path, value)}``."""

    def __init__(self):
        self.found: dict[str, tuple[str, object]] = {}
        # What reads each itext id: the node and the role, from the body and the binds.
        self.texts: dict[str, list[tuple[tuple[str, ...], str]]] = {}
        # Each itext text, ``(id, lang, form, value)``, placed once what reads it is known (``_texts``).
        self.itext: list[tuple[str, str, str, str]] = []

    def add(self, steps, facet, structural, value):
        """A part at ``steps`` (a node's, or None for the form's own), ``facet`` its tokens after the node and
        ``structural`` the facet as its path writes it."""
        node = "" if steps is None else "".join(f"/{pointer_token(step)}" for step in steps)
        node_path = "" if steps is None else ("/data" if len(steps) == 1 else "/data/*")
        at = node + "".join(f"/{pointer_token(step)}" for step in facet)
        path = node_path + "".join(f"/{step}" for step in structural)
        if at in self.found:  # a second part of one key keeps both, each later one numbered from 2
            count = 2
            while f"{at}/{count}" in self.found:
                count += 1
            at, path = f"{at}/{count}", f"{path}/*"
        self.found[at] = (path, value)

    def at_node(self, steps, reference, facet, structural, value):
        if steps is None and reference is not None:
            self.add(None, (":by-text", reference, *facet), (":by-text", "*", *structural), value)
        else:
            self.add(steps, facet, structural, value)


def _data(parts: _Parts, element, steps):
    for attribute, value in sorted(element.attrib.items()):
        parts.add(steps, (f"@{name(attribute)}",), (f"@{name(attribute)}",), value)
    children = list(element)
    if not children:
        parts.add(steps, ("text()",), ("text()",), element.text or "")
        return
    seen: dict[str, int] = {}
    for child in children:
        if not isinstance(child.tag, str):
            continue
        tag = local(child.tag)
        seen[tag] = seen.get(tag, 0) + 1
        step = tag if seen[tag] == 1 else f"{tag}[{seen[tag]}]"
        child_steps = (*steps, step)
        parts.add(child_steps, (), (), "node")
        _data(parts, child, child_steps)


def _reference(parts: _Parts, reference, steps, role):
    identity = itext_id(reference)
    if identity is not None:
        parts.texts.setdefault(identity, []).append((steps if steps is not None else (), role))
        return True
    return False


def _setvalue(parts: _Parts, element):
    reference = element.get("ref")
    value = element.get("value") if "value" in element.attrib else (element.text or "")
    event = element.get("event") or ""
    parts.at_node(
        node_steps(reference),
        reference,
        (":setvalue", event, "@value"),
        (":setvalue", event, "@value"),
        value,
    )


def _control(parts: _Parts, element, enclosing):
    """One element of the body: a control naming a node, a container naming none, or a setvalue."""
    tag = local(element.tag) if isinstance(element.tag, str) else ""
    if tag == "setvalue":
        _setvalue(parts, element)
        return None
    reference = element.get("ref") if "ref" in element.attrib else element.get("nodeset")
    steps = node_steps(reference)
    if reference is None:
        steps, facet = enclosing, (":group",)
    else:
        facet = (":control",)
    at = parts.at_node
    at(steps, reference, facet, facet, name(element.tag))
    for attribute, value in sorted(element.attrib.items()):
        if reference is not None and attribute in ("ref", "nodeset"):
            continue
        at(steps, reference, (*facet, f"@{name(attribute)}"), (*facet, f"@{name(attribute)}"), value)
    order = []
    for child in element:
        if not isinstance(child.tag, str):
            continue
        child_tag = local(child.tag)
        if child_tag in TEXT_ROLES:
            if not _reference(parts, child.get("ref"), steps, child_tag):
                at(steps, reference, (*facet, child_tag), (*facet, child_tag), content(child))
            for attribute, value in sorted(child.attrib.items()):
                if attribute != "ref" or itext_id(value) is None:
                    at(
                        steps,
                        reference,
                        (*facet, child_tag, f"@{name(attribute)}"),
                        (*facet, child_tag, f"@{name(attribute)}"),
                        value,
                    )
        elif child_tag == "item":
            value_element = next((one for one in child if local(str(one.tag)) == "value"), None)
            value = "" if value_element is None else (value_element.text or "")
            label = next((one for one in child if local(str(one.tag)) == "label"), None)
            role = f"item/{value}"
            if label is None or not _reference(parts, label.get("ref"), steps, role):
                at(
                    steps,
                    reference,
                    (*facet, "item", value),
                    (*facet, "item", "*"),
                    "" if label is None else content(label),
                )
            order.append(f"item:{value}")
        elif child_tag == "itemset":
            at(steps, reference, (*facet, "itemset"), (*facet, "itemset"), ElementTree.tostring(child, "unicode"))
        else:
            named = _control(parts, child, steps)
            order.append(named if named is not None else f"{child_tag}")
    at(steps, reference, (*facet, "order()"), (*facet, "order()"), tuple(order))
    return reference


def _model(parts: _Parts, model):
    for attribute, value in sorted(model.attrib.items()):
        parts.add(None, (":model", f"@{name(attribute)}"), (":model", f"@{name(attribute)}"), value)
    primary = True
    others: dict[str, int] = {}
    for child in model:
        if not isinstance(child.tag, str):
            continue
        tag = local(child.tag)
        if tag == "instance" and primary and child.get("id") is None:
            primary = False
            roots = [one for one in child if isinstance(one.tag, str)]
            for root in roots:
                steps = (local(root.tag),)
                parts.add(steps, (), (), "node")
                _data(parts, root, steps)
        elif tag == "instance":
            identity = child.get("id") or ""
            parts.add(None, (":instance", identity), (":instance", "*"), ElementTree.tostring(child, "unicode"))
        elif tag == "bind":
            reference = child.get("nodeset")
            steps = node_steps(reference)
            for attribute, value in sorted(child.attrib.items()):
                if attribute == "nodeset":
                    continue
                if name(attribute) == "jr:constraintMsg" and _reference(parts, value, steps, "constraintMsg"):
                    continue
                parts.at_node(
                    steps,
                    reference,
                    (":bind", f"@{name(attribute)}"),
                    (":bind", f"@{name(attribute)}"),
                    value,
                )
        elif tag == "setvalue":
            _setvalue(parts, child)
        elif tag == "itext":
            _itext(parts, child)
        else:
            others[tag] = others.get(tag, 0) + 1
            parts.add(
                None,
                (":model", f"{name(child.tag)}[{others[tag]}]"),
                (":model", name(child.tag)),
                ElementTree.tostring(child, "unicode"),
            )


def _itext(parts: _Parts, itext):
    """Each translation's texts, held until the body has said what reads each id (``_texts``)."""
    for translation in itext:
        if not isinstance(translation.tag, str) or local(translation.tag) != "translation":
            continue
        lang = translation.get("lang") or ""
        for attribute, value in sorted(translation.attrib.items()):
            if attribute == "lang":
                continue
            parts.add(
                None,
                (":translation", lang, f"@{name(attribute)}"),
                (":translation", "*", f"@{name(attribute)}"),
                value,
            )
        for text in translation:
            if not isinstance(text.tag, str) or local(text.tag) != "text":
                continue
            identity = text.get("id") or ""
            forms: dict[str, int] = {}
            for value in text:
                if not isinstance(value.tag, str):
                    continue
                form = value.get("form") or "default"
                forms[form] = forms.get(form, 0) + 1
                form_key = form if forms[form] == 1 else f"{form}[{forms[form]}]"
                parts.itext.append((identity, lang, form_key, content(value)))


def _texts(parts: _Parts):
    """Each itext text at what reads it (the module's docstring)."""
    for identity, lang, form, value in parts.itext:
        readers = parts.texts.get(identity)
        if not readers:
            parts.add(None, (":itext", identity, lang, form), (":itext", "*", "*", form), value)
            continue
        for steps, role in readers:
            role_steps = tuple(role.split("/", 1))
            structural = ("item", "*") if role_steps[0] == "item" else role_steps
            parts.add(
                steps or None,
                (":itext", *role_steps, lang, form),
                (":itext", *structural, "*", form),
                value,
            )


def parts(text: str) -> dict[str, tuple[str, object]] | None:
    """Every part of the form ``text`` holds, ``{at: (path, value)}``, ``at`` and ``path`` after the attachment;
    None where the text is no well-formed XML."""
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return None
    found = _Parts()
    head = next((one for one in root if isinstance(one.tag, str) and local(one.tag) == "head"), None)
    body = next((one for one in root if isinstance(one.tag, str) and local(one.tag) == "body"), None)
    for attribute, value in sorted(root.attrib.items()):
        found.add(None, (":html", f"@{name(attribute)}"), (":html", f"@{name(attribute)}"), value)
    heads: dict[str, int] = {}
    for child in [] if head is None else head:
        if not isinstance(child.tag, str):
            continue
        tag = local(child.tag)
        if tag == "title":
            found.add(None, ("title",), ("title",), "".join(child.itertext()))
        elif tag == "model":
            _model(found, child)
        else:
            heads[tag] = heads.get(tag, 0) + 1
            found.add(
                None,
                (":head", f"{name(child.tag)}[{heads[tag]}]"),
                (":head", name(child.tag)),
                ElementTree.tostring(child, "unicode"),
            )
    if body is not None:
        for attribute, value in sorted(body.attrib.items()):
            found.add(None, (":body", f"@{name(attribute)}"), (":body", f"@{name(attribute)}"), value)
        order = []
        for child in body:
            if isinstance(child.tag, str):
                named = _control(found, child, None)
                order.append(named if named is not None else local(child.tag))
        found.add(None, (":body", "order()"), (":body", "order()"), tuple(order))
    _texts(found)
    return found.found


def compare(before: str | None, after: str | None):
    """``(kind, at, path, before, after)`` for each part the two texts hold differently, ``at`` and ``path``
    after the attachment; one ``refused`` at ``/:not-well-formed`` where either is no well-formed XML."""
    a = {} if before is None else parts(before)
    b = {} if after is None else parts(after)
    if a is None or b is None:
        yield ("refused", f"/{NOT_WELL_FORMED}", f"/{NOT_WELL_FORMED}", a is None, b is None)
        return
    for at in sorted(set(a) | set(b)):
        if at not in b:
            yield ("removed", at, a[at][0], a[at][1], None)
        elif at not in a:
            yield ("added", at, b[at][0], None, b[at][1])
        elif a[at][1] != b[at][1]:
            yield ("changed", at, a[at][0], a[at][1], b[at][1])
