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
  ``hint``, ``help``, ``alert``), each choice by its value (``.../:control/item/<value>``), its itemset's
  attributes and each attribute and text of what the itemset holds (``.../:control/itemset/@nodeset``,
  ``.../:control/itemset/label/@ref``), and the order of the controls and choices it holds that both forms
  hold (``.../:control/order()``): one that only one form holds is that form's own part at its own node;
- each itext text by what reads it: a control's label, hint, help or alert, a choice's label, or a bind's
  ``jr:constraintMsg``, at that node and role, by language and form
  (``/data/a/b/:itext/label/<lang>/<form>``), so a text Nova keeps under another id is the same part; a text
  nothing reads by its id (``/:itext/<id>/<lang>/<form>``), and each translation's own attributes
  (``/:translation/<lang>/@<name>``). A translation in a language the app does not hold is one part,
  ``/:unlisted-translation/<lang>``: CommCare HQ's build leaves it out (``xform.py::XForm.exclude_languages``,
  from ``FormBase.add_stuff_to_xform``) and HQ's form builder drops it as it loads the form
  (``Vellum/src/javaRosa/plugin.js``, a language not in the app's), so no reader reads any text of it;
- a secondary instance by its id (``/:instance/<id>``), and every other part of the head, the model or a
  container that names no node at the node it stands in (``/:head/...``, ``/:model/...``, ``.../:group/...``).

A node is named by its path only where it is a plain absolute path (``proof.rules._xpath.plain_path``, Core's
lexer); a bind, setvalue or control naming one any other way is keyed by its text under ``/:by-text/``. A text
reference is read through Core's lexer too: ``jr:itext('<id>')`` and nothing else. Two values are equal where
their parsed content is: an element's text and its children serialized in document order, attributes by name
in name order, and no whitespace that only stands between elements (an element's own tail, the indentation of
what holds only elements), which no reader of a form reads. Inside a text, a run of text Java's ``trim`` leaves
empty is no part of it, as Core drops every such run when it parses a form (``XFormParser.getXMLDocument``).

An attribute in the form builder's namespace (``vellum:``) is HQ's form builder's own copy of what it stands
beside, which HQ's build strips (``xform.py::XForm.strip_vellum_ns_attributes``) and no runtime reads. One on an
element inside a text (an ``<output>``'s ``vellum:value``) is a part of its own beside the text
(``.../:itext/label/<lang>/<form>/output/<n>/@vellum:value``), so the text is compared without it. The form
builder writes an attribute of its namespace it does not read back again under its name with one more
``vellum__`` before it on every save (``Vellum/src/util.js::writeHashtags``), so how many it carries tells how
often the form was saved, never a symptom: the path writes such a name ``@vellum:vellum__*``, ``at`` keeps it.

Pure, standard library only: it reads the two texts it is given.
"""

from __future__ import annotations

import hashlib
import xml.etree.ElementTree as ElementTree

from proof.checks import xpath_tree
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
VELLUM = "http://commcarehq.org/xforms/vellum"
TEXT_ROLES = ("label", "hint", "help", "alert")
DATA = "data"
NOT_WELL_FORMED = ":not-well-formed"
UNLISTED = ":unlisted-translation"
# The form builder's escape of a name of its namespace it keeps unread, one more each save.
ESCAPE = "vellum__"


def name(qname: str) -> str:
    """``{uri}local`` as its prefix writes it (``PREFIXES``), a name in no namespace as it stands."""
    if not qname.startswith("{"):
        return qname
    uri, _, local = qname[1:].partition("}")
    prefix = PREFIXES.get(uri)
    if prefix is None:
        return qname
    return local if prefix == "" else f"{prefix}:{local}"


def structural_name(qname: str) -> str:
    """An attribute's name as a structural path writes it: ``name``'s, but ``vellum:vellum__*`` for a name of the
    form builder's namespace it escaped on a save (the module's docstring)."""
    if _vellum(qname) and local(qname).startswith(ESCAPE):
        return f"vellum:{ESCAPE}*"
    return name(qname)


def local(qname: str) -> str:
    return qname.rpartition("}")[2]


def _vellum(qname) -> bool:
    return isinstance(qname, str) and qname.startswith("{" + VELLUM + "}")


def _canonical(element, shadows=None, counts=None):
    """A copy of ``element`` with its attributes in name order, no whitespace that stands only between elements,
    and its own tail kept as it is; where ``shadows`` is a list, every attribute of the form builder's namespace
    taken off into it as ``(local name, its number among the elements of that name, attribute, value)``, and every
    text and tail kept, since inside a text each is what the text shows."""
    attributes = sorted(element.attrib.items())
    text = shadows is not None
    if text:
        tag = local(element.tag)
        counts[tag] = counts.get(tag, 0) + 1
        for attribute, value in attributes:
            if _vellum(attribute):
                shadows.append((tag, counts[tag], attribute, value))
        attributes = [(attribute, value) for attribute, value in attributes if not _vellum(attribute)]
    copy = ElementTree.Element(element.tag, dict(attributes))
    children = [child for child in element if isinstance(child.tag, str)]
    copy.text = _run(element.text) if text else element.text if not children or (element.text or "").strip() else None
    for child in children:
        held = _canonical(child, shadows, counts)
        held.tail = _run(child.tail) if text else child.tail if (child.tail or "").strip() else None
        copy.append(held)
    copy.tail = _run(element.tail) if text else element.tail
    return copy


# What Java's ``String.trim`` takes off either end of a text: every character up to U+0020.
JAVA_TRIM = "".join(chr(code) for code in range(0x21))


def _run(text):
    """A run of text inside a text as Core reads it: none where Java's ``trim`` leaves nothing of it, since Core
    drops such a run as it parses a form (``XFormParser.getXMLDocument``), else the run as it stands."""
    return text if text and text.strip(JAVA_TRIM) else None


def serialized(element) -> str:
    """``element`` as one value: its canonical copy (``_canonical``) without its own tail."""
    copy = _canonical(element)
    copy.tail = None
    return ElementTree.tostring(copy, encoding="unicode")


def text_of(element):
    """``(text, shadows)``: an element's text and its children serialized in document order, each child's
    attributes in name order and those of the form builder's namespace taken off into ``shadows``
    (``_canonical``), and no run of text Core drops (``_run``)."""
    shadows, counts = [], {}
    found = [_run(element.text) or ""]
    for child in element:
        if isinstance(child.tag, str):
            found.append(ElementTree.tostring(_canonical(child, shadows, counts), encoding="unicode"))
        else:
            found.append(_run(child.tail) or "")
    return "".join(found), shadows


def content(element) -> str:
    """An element's text and its children serialized, in document order, without the form builder's attributes."""
    return text_of(element)[0]


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

    def __init__(self, languages=None):
        self.found: dict[str, tuple[str, object]] = {}
        # The app's languages, or None where the caller names none (every translation is then one of them).
        self.languages = languages
        # What reads each itext id: the node and the role, from the body and the binds.
        self.texts: dict[str, list[tuple[tuple[str, ...], str]]] = {}
        # Each itext text, ``(id, lang, form, value element)``, placed once what reads it is known (``_texts``).
        self.itext: list[tuple[str, str, str, object]] = []
        # Each secondary instance's source by its id, which an expression's ``instance('<id>')`` reads.
        self.instances: dict[str, str] = {}

    def text(self, steps, reference, facet, structural, element):
        """A text at ``facet``, and each attribute of the form builder's namespace inside it as a part of its own
        under it (``text_of``)."""
        value, shadows = text_of(element)
        self.at_node(steps, reference, facet, structural, value)
        for tag, number, attribute, shadow in shadows:
            self.at_node(
                steps,
                reference,
                (*facet, tag, str(number), f"@{name(attribute)}"),
                (*structural, tag, "*", f"@{structural_name(attribute)}"),
                shadow,
            )

    def attribute(self, steps, reference, facet, attribute, value):
        """An attribute at ``facet``, ``at`` by its name and the path by its structural name."""
        self.at_node(
            steps,
            reference,
            (*facet, f"@{name(attribute)}"),
            (*facet, f"@{structural_name(attribute)}"),
            value,
        )

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
        parts.attribute(steps, None, (), attribute, value)
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
        parts.attribute(steps, reference, facet, attribute, value)
    order = []
    for child in element:
        if not isinstance(child.tag, str):
            continue
        child_tag = local(child.tag)
        if child_tag in TEXT_ROLES:
            if not _reference(parts, child.get("ref"), steps, child_tag):
                parts.text(steps, reference, (*facet, child_tag), (*facet, child_tag), child)
            for attribute, value in sorted(child.attrib.items()):
                if attribute != "ref" or itext_id(value) is None:
                    parts.attribute(steps, reference, (*facet, child_tag), attribute, value)
        elif child_tag == "item":
            value_element = next((one for one in child if local(str(one.tag)) == "value"), None)
            value = "" if value_element is None else (value_element.text or "")
            label = next((one for one in child if local(str(one.tag)) == "label"), None)
            role = f"item/{value}"
            if label is None:
                at(steps, reference, (*facet, "item", value), (*facet, "item", "*"), "")
            elif not _reference(parts, label.get("ref"), steps, role):
                parts.text(steps, reference, (*facet, "item", value), (*facet, "item", "*"), label)
            order.append(f"item:{value}")
        elif child_tag == "itemset":
            _itemset(parts, child, steps, reference, (*facet, "itemset"))
        else:
            named = _control(parts, child, steps)
            order.append(named if named is not None else f"{child_tag}")
    at(steps, reference, (*facet, "order()"), (*facet, "order()"), tuple(order))
    return reference


def _itemset(parts: _Parts, itemset, steps, reference, facet):
    """An itemset's attributes, and each attribute and text of each element it holds by its name (a second of one
    name numbered from 2): the rows' expression, a label's and a value's reference, as Core reads each
    (``XFormParser.parseItemset``)."""
    for attribute, value in sorted(itemset.attrib.items()):
        parts.attribute(steps, reference, facet, attribute, value)
    seen: dict[str, int] = {}
    for child in itemset:
        if not isinstance(child.tag, str):
            continue
        tag = local(child.tag)
        seen[tag] = seen.get(tag, 0) + 1
        step = tag if seen[tag] == 1 else f"{tag}[{seen[tag]}]"
        for attribute, value in sorted(child.attrib.items()):
            parts.attribute(steps, reference, (*facet, step), attribute, value)
        if (child.text or "").strip() or len(child):
            parts.text(steps, reference, (*facet, step), (*facet, step), child)


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
            parts.instances[identity] = child.get("src") or ""
            parts.add(None, (":instance", identity), (":instance", "*"), serialized(child))
        elif tag == "bind":
            reference = child.get("nodeset")
            steps = node_steps(reference)
            for attribute, value in sorted(child.attrib.items()):
                if attribute == "nodeset":
                    continue
                if name(attribute) == "jr:constraintMsg" and _reference(parts, value, steps, "constraintMsg"):
                    continue
                parts.attribute(steps, reference, (":bind",), attribute, value)
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
                serialized(child),
            )


def _itext(parts: _Parts, itext):
    """Each translation's texts, held until the body has said what reads each id (``_texts``)."""
    for translation in itext:
        if not isinstance(translation.tag, str) or local(translation.tag) != "translation":
            continue
        lang = translation.get("lang") or ""
        if parts.languages is not None and lang not in parts.languages:
            parts.add(None, (UNLISTED, lang), (UNLISTED, "*"), _whole(translation))
            continue
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
                parts.itext.append((identity, lang, form_key, value))


def _texts(parts: _Parts):
    """Each itext text at what reads it (the module's docstring)."""
    for identity, lang, form, value in parts.itext:
        readers = parts.texts.get(identity)
        if not readers:
            parts.text(None, None, (":itext", identity, lang, form), (":itext", "*", "*", form), value)
            continue
        for steps, role in readers:
            role_steps = tuple(role.split("/", 1))
            structural = ("item", "*") if role_steps[0] == "item" else role_steps
            parts.text(
                steps or None, None, (":itext", *role_steps, lang, form), (":itext", *structural, "*", form), value
            )


def _whole(translation) -> str:
    """A translation the app's languages do not hold, as one value: how many texts it holds and the digest of its
    canonical serialization (``serialized``)."""
    count = sum(1 for one in translation if isinstance(one.tag, str) and local(one.tag) == "text")
    digest = hashlib.sha256(serialized(translation).encode("utf-8")).hexdigest()
    return f"{count} texts, sha256:{digest}"


def parts(text: str, languages=None) -> dict[str, tuple[str, object]] | None:
    """Every part of the form ``text`` holds, ``{at: (path, value)}``, ``at`` and ``path`` after the attachment;
    None where the text is no well-formed XML. ``languages`` is the app's, where the caller knows them: a
    translation in any other is one part (the module's docstring)."""
    found = _parsed(text, languages)
    return None if found is None else found.found


def unshown_media_sites(text, artifact):
    """A built itext value can stand only at its one source slot. Never assign a shared text to one of its readers."""
    parsed = _parsed(text)
    if parsed is None:
        return {}
    sites = {}
    for identity, language, kind, value in parsed.itext:
        readers = parsed.texts.get(identity) or []
        if kind not in ("image", "audio", "video") or len(readers) != 1 or len(value):
            continue
        steps, role = readers[0]
        if not steps or steps[0] != "data":
            continue
        if role == "label":
            pointer = "".join("/" + pointer_token(step) for step in steps)
            control = parsed.found.get(pointer + "/:control")
            if not control or control[1] not in ("group", "repeat"):
                continue
        elif role not in ("hint", "constraintMsg"):
            continue
        uri = (value.text or "").strip()
        if not uri.startswith("jr://file/"):
            continue
        key = artifact, language, identity, kind, uri
        place = ("form", artifact.rpartition("/")[2][5:], "xform", *steps, ":itext", role, language, kind)
        sites[key] = place if key not in sites else None
    return sites


def _parsed(text: str, languages=None):
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return None
    found = _Parts(None if languages is None else frozenset(languages))
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
                serialized(child),
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
    return found


ORDER = "order()"


def _shared(before, after):
    """The entries of two orders that both hold, each in its own order: an entry one order holds more often than
    the other keeps as many of its occurrences, the first, as the other holds."""
    count_a, count_b = {}, {}
    for entry in before:
        count_a[entry] = count_a.get(entry, 0) + 1
    for entry in after:
        count_b[entry] = count_b.get(entry, 0) + 1

    def kept(order, other):
        seen, found = {}, []
        for entry in order:
            seen[entry] = seen.get(entry, 0) + 1
            if seen[entry] <= other.get(entry, 0):
                found.append(entry)
        return found

    return kept(before, count_b), kept(after, count_a)


def _same_order(before, after) -> bool:
    """Whether two orders hold what both hold in one order (``_shared``): an entry only one holds is that form's
    own part at its own node, reported there, so an order that differs by it alone moved nothing."""
    if not isinstance(before, tuple) or not isinstance(after, tuple):
        return before == after
    shared_a, shared_b = _shared(before, after)
    return shared_a == shared_b


def compare(before: str | None, after: str | None, languages=None):
    """``(kind, at, path, before, after)`` for each part the two texts hold differently, ``at`` and ``path``
    after the attachment; one ``refused`` at ``/:not-well-formed`` where either is no well-formed XML. ``languages``
    is the app's, where the caller knows them (``parts``)."""
    first = _Parts() if before is None else _parsed(before, languages)
    second = _Parts() if after is None else _parsed(after, languages)
    if first is None or second is None:
        yield ("refused", f"/{NOT_WELL_FORMED}", f"/{NOT_WELL_FORMED}", first is None, second is None)
        return
    a, b = first.found, second.found
    for at in sorted(set(a) | set(b)):
        if at not in b:
            yield ("removed", at, a[at][0], a[at][1], None)
        elif at not in a:
            if _implied_string(at, a, b):
                yield ("added", f"{at}/{IMPLIED_STRING}", f"{b[at][0]}/{IMPLIED_STRING}", None, b[at][1])
                continue
            yield ("added", at, b[at][0], None, b[at][1])
        elif a[at][1] != b[at][1]:
            path = a[at][0]
            if path.endswith(f"/{ORDER}") and _same_order(a[at][1], b[at][1]):
                continue
            if _expression(path) and xpath_tree.same(
                a[at][1], b[at][1], instances=(first.instances, second.instances), context=_context(at)
            ):
                yield ("changed", f"{at}/{RESPELLED}", f"{path}/{RESPELLED}", a[at][1], b[at][1])
                continue
            yield ("changed", at, path, a[at][1], b[at][1])


# The step a slot's expression written another way stands under (the module's docstring).
RESPELLED = ":respelled"
# The step a bind's type stands under where the after form names ``xsd:string`` for a node the before form gave no
# type, and every reader reads the two alike (``_implied_string``).
IMPLIED_STRING = ":implied-string"
BIND_TYPE = "/:bind/@type"
SELECTS = frozenset({"select", "select1"})


def _implied_string(at: str, a, b) -> bool:
    """Whether a bind type the after form adds at ``at`` is the type the before form's node already read as: the
    after form names ``xsd:string``, the before form named none, both forms hold the node, and it is a select in
    both forms or no control's in either. Core turns an untyped or string node a select names into a choice alike
    (``XFormParser.applyControlProperties``), and a node no control asks for is only ever written by a calculation
    or a setvalue, which store an untyped and a string node alike (``Recalculate.wrapData``,
    ``SetValueAction.processAction`` through ``AnswerDataFactory.templateByDataType``) and read back alike as text
    (``XPathPathExpr.unpackValue``). An untyped node a text input asks for is not this: Android counts its question
    answered whether or not it holds an answer (``FormNavigationController``), so it stays at ``@type``."""
    if not at.endswith(BIND_TYPE) or b[at][1] != "xsd:string":
        return False
    node = at[: -len(BIND_TYPE)]
    # A node only the after form holds is a change of its own, whose bind is part of it.
    if node not in a or node not in b:
        return False
    control = f"{node}/:control"
    before, after = a.get(control), b.get(control)
    if before is None and after is None:
        return True
    return before is not None and after is not None and before[1] == after[1] and after[1] in SELECTS


# The parts that hold an expression, by the end of their path: a bind's conditions and calculation, a setvalue's
# value, an itemset's rows, and the label and value an itemset reads of each row (Core parses each as an XPath
# expression over the row, ``XFormParser.parseItemset``'s ``labelRef`` and ``valueRef``).
EXPRESSION_ENDS = (
    ("/:bind/@calculate",),
    ("/:bind/@relevant",),
    ("/:bind/@constraint",),
    ("/:bind/@required",),
    ("/:bind/@readonly",),
    ("/:control/itemset/@nodeset",),
    ("/:control/itemset/label/@ref",),
    ("/:control/itemset/value/@ref",),
)


def _expression(path: str) -> bool:
    steps = path.split("/")
    if len(steps) >= 4 and steps[-3] == ":setvalue" and steps[-1] == "@value":
        return True
    return any(path.endswith(end) for (end,) in EXPRESSION_ENDS)


def _context(at: str):
    """The steps of the node a part at ``at`` is about (``/data/a/:bind/@calculate`` gives ``("data", "a")``), or
    None for a part that names no node."""
    steps = []
    for token in at.split("/")[1:]:
        if token.startswith(":"):
            break
        if token.startswith("@") or token.endswith("()") or "[" in token:
            return None
        steps.append(token.replace("~1", "/").replace("~0", "~"))
    return tuple(steps) if steps and steps[0] == DATA else None
