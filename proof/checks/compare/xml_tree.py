"""Two XML documents compared as parsed trees, reporting every difference.

Each document is parsed by lxml first (a document that does not parse is
itself the difference, never a text comparison). Of the parsed tree the
comparison reads what an XML consumer reads: each element's namespace and
local name, its attributes as a map keyed by namespace and local name, its
text, and its child elements. Comments and processing instructions carry
nothing a consumer reads, so they are not part of it (the text around them
is joined as the parser's consumer sees it).

Whitespace-only text between elements is HQ's indentation in everything HQ
builds (``xform.py::XForm.render`` runs lxml's ``indent`` over every form
before it serializes it, which overwrites each whitespace-only text; the
suite and profile are pretty-printed by their serializer and template), so
by default it is read as no text (``blank_text="ignore"``); a caller comparing
documents no such serializer wrote passes ``blank_text="exact"``.

Children are paired by identity where an attribute is the element's identity
(``IDENTITY_ATTRIBUTES``) and that value is unique among the siblings with
the same name, and by position among the same-named siblings otherwise. The
structural ``path`` writes an identity step as ``name[@attr=*]`` and a
position as ``name[*]``, and ``at`` holds the concrete value or position:
an identity's value is the app's data (a menu's or detail's id holds its
module's position, an xform resource's id is the form's ``unique_id``,
which HQ's create re-mints), so one symptom on several elements, or on
several documents, has one path. A profile property's ``key`` is the
exception: Core reads each property by it as CommCare's setting name
(``ProfileParser``'s ``property`` reader, ``Profile.addPropertySetter``), so
it is vocabulary, not data, and the path keeps it
(``property[@key=cc-show-saved]``). A child present on one side only is
``added`` or ``removed`` whole; when the children both sides hold come in a
different order, one ``/order()`` difference names both orders. An element
whose namespace differs from its counterpart's is reported at
``/namespace()`` only where its parent's namespaces did not already differ
the same way (a data node's ``xmlns`` changes every element under it; that
is one difference).

What a document's element names are is its kind's (``compare.names``),
read from its root unless the caller names it (``naming``):

- an XForm (``h:html``): its main instance's data (the first ``instance``
  of its model) writes each name the app authored as ``*`` and keeps the
  names a reader finds elements by (a case block and its parts, the
  metadata, Nova's reserved names without their minted part); a bind is
  keyed by its ``nodeset`` and a ``setvalue`` by its ``event`` and ``ref``
  (Core reads a bind for the node it names and a setvalue for its event
  and target, ``XFormParser.parseBind``, ``parseSetValueAction``, never by
  their order), each path written with the data's names
  (``bind[@nodeset=/data/*/case/@case_id]``);
- a submission (``naming="data"``, as the trace names a run's): the form's
  data, named as above;
- Core's case database (``casedb``): each case keyed by its ``@case_id``,
  its properties, index identifiers and attachment names ``*``;
- anything else: every element name kept.

Attribute values, XPath expressions included, are compared exactly as
strings: two spellings of one expression are two values unless a registered
spelling rule (``proof.rules``) normalized them first, through a parser.
"""

from __future__ import annotations

import functools

from lxml import etree

from proof.checks.compare import names
from proof.checks.differences import Difference

# Attributes that identify an element among its same-named siblings: a
# suite's menus, commands, details and resources by id, a profile's
# properties by key, a suite's locales by language, an XForm's translations
# by language, its binds by node set, its itext texts by id and each text's
# values by form (``image``, ``audio``, ``markdown``...: JavaRosa reads a
# text's value for a form by that attribute, ``XFormParser.parseTextHandle``,
# so the order of a text's values is not content).
IDENTITY_ATTRIBUTES = {
    "property": "key",
    "locale": "language",
    "translation": "lang",
    "bind": "nodeset",
    "value": "form",
}
DEFAULT_IDENTITY_ATTRIBUTE = "id"
# Identities whose values are CommCare's vocabulary rather than the app's
# data, kept in the structural path: (element, attribute).
VOCABULARY_IDENTITIES = frozenset({("property", "key"), ("value", "form")})
# Identities whose values are paths into the form's data, written with the data's names (``names.data_path``).
DATA_PATH_IDENTITIES = frozenset({("bind", "nodeset"), ("setvalue", "ref")})
# The kinds of document a comparison names by (``compare.names``).
NAMINGS = ("auto", "generic", "xform", "data", "casedb")

# The prefixes paths use for the namespaces CommCare documents declare, so a
# path reads the same whichever prefix a serializer chose.
KNOWN_PREFIXES = {
    "http://www.w3.org/XML/1998/namespace": "xml",
    "http://www.w3.org/1999/xhtml": "h",
    "http://www.w3.org/2002/xforms": "xf",
    "http://openrosa.org/javarosa": "jr",
    "http://dev.commcarehq.org/jr/xforms": "jrm",
    "http://openrosa.org/jr/xforms": "orx",
    "http://commcarehq.org/xforms": "cc",
    "http://commcarehq.org/xforms/vellum": "vellum",
    "http://www.w3.org/2001/XMLSchema": "xsd",
    "http://commcarehq.org/case/transaction/v2": "case",
}


class XmlNotWellFormed(ValueError):
    """A document the comparison was given does not parse as XML."""


def parse_xml(content):
    """The parsed document, by a parser that reads no DTD, entity or network resource."""
    if isinstance(content, str):
        content = content.encode("utf-8")
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=True)
    try:
        return etree.fromstring(content, parser)
    except etree.XMLSyntaxError as error:
        raise XmlNotWellFormed(str(error)) from error


def qname(tag):
    """(namespace, local name) of an element's or attribute's name."""
    name = etree.QName(tag)
    return name.namespace, name.localname


def _attribute_name(key):
    namespace, local = _tag(key)
    if namespace is None:
        return local
    prefix = KNOWN_PREFIXES.get(namespace)
    return f"{prefix}:{local}" if prefix else f"{{{namespace}}}{local}"


def _is_element(node):
    return isinstance(node.tag, str)


def element_content(element, blank_text):
    """(text, [(child, tail)]) as a consumer reads them: comments and PIs dropped, their tails joined.

    ``blank_text`` ``"ignore"`` reads whitespace-only text as none. What this
    reads, with ``qname``, is everything a comparison reads of an element, so
    a digest over it (proof 5's) changes exactly when the comparison finds a
    difference.
    """
    text = element.text or ""
    children = []
    for node in element:
        if _is_element(node):
            children.append([node, node.tail or ""])
        elif children:
            children[-1][1] += node.tail or ""
        else:
            text += node.tail or ""

    def keep(value):
        return "" if blank_text == "ignore" and not value.strip() else value

    return keep(text), [(child, keep(tail)) for child, tail in children]


class _Naming:
    """How one side of a comparison names its elements: by its kind (``NAMINGS``) and, in an XForm, its data."""

    def __init__(self, kind, root):
        self.kind = kind
        self.data_root = None
        self.data_namespace = None
        self._paths = {}
        self._names = None
        if kind == "xform":
            self.data_root = _xform_data(root)
        elif kind == "data":
            self.data_root = root
        if self.data_root is not None:
            self.data_namespace = _tag(self.data_root.tag)[0]

    def root_context(self):
        """The context of the root's children."""
        return {"data": names.DATA, "casedb": names.CASEDB, "xform": XFORM_ROOT}.get(self.kind, GENERIC)

    def data_path(self, text):
        """A path into the form's data, written with its names (``names.data_path``), read once per path."""
        found = self._paths.get(text)
        if found is None:
            if self._names is None:
                self._names = names.data_names(self.data_root)
            found = self._paths[text] = names.data_path(text, self.data_root, self._names)
        return found

    def describe(self, context, child, namespace, local):
        """How a path names one child of an element in ``context``: (the name a path writes, the child's own
        context, its identity as a path writes it and as ``at`` does: ``[@attr=*]`` and ``[@attr=value]``, or
        None for a child no attribute identifies)."""
        if context == GENERIC:
            shown, own = local, GENERIC
        elif context == XFORM_ROOT:
            shown, own = local, names.DATA if child is self.data_root else XFORM_ROOT
        else:
            shown, own = names.child_name(context, local, namespace, self.data_namespace)
        if context == names.CASEDB and local == "case":
            value = child.get("case_id")
            if value is None:
                return shown, own, None, None
            return shown, own, "[@case_id=*]", f"[@case_id={value}]"
        if context == XFORM_ROOT and local == "setvalue":
            event, ref = child.get("event"), child.get("ref")
            if event is None or ref is None:
                return shown, own, None, None
            return shown, own, f"[@event={event}][@ref={self.data_path(ref)}]", f"[@event={event}][@ref={ref}]"
        attribute = IDENTITY_ATTRIBUTES.get(local, DEFAULT_IDENTITY_ATTRIBUTE)
        value = child.get(attribute)
        if value is None:
            return shown, own, None, None
        if (local, attribute) in VOCABULARY_IDENTITIES:
            written = value
        elif context == XFORM_ROOT and (local, attribute) in DATA_PATH_IDENTITIES:
            written = self.data_path(value)
        else:
            written = "*"
        return shown, own, f"[@{attribute}={written}]", f"[@{attribute}={value}]"


# The contexts of a document named by no reader's rules (every name kept), and of an XForm outside its data.
GENERIC = "generic"
XFORM_ROOT = "xform"


@functools.lru_cache(maxsize=4096)
def _tag(tag):
    """(namespace, local name) of an element's tag, read once per distinct tag."""
    return names.split_tag(tag)


def _children_named(element, namespace, local):
    return [child for child in element if isinstance(child.tag, str) and _tag(child.tag) == (namespace, local)]


def _xform_data(root):
    """The XForm's data node: the first element of its model's first ``instance`` (XForms' main instance)."""
    for head in _children_named(root, names.XHTML, "head"):
        for model in _children_named(head, names.XFORMS, "model"):
            for instance in _children_named(model, names.XFORMS, "instance"):
                return next((child for child in instance if isinstance(child.tag, str)), None)
    return None


def naming_of(root, naming="auto"):
    """The naming kind of a document: ``naming`` where it is not ``auto``, else read from its root."""
    if naming not in NAMINGS:
        raise ValueError(f"naming is one of {NAMINGS}, not {naming!r}.")
    if naming != "auto":
        return naming
    namespace, local = _tag(root.tag)
    if (namespace, local) == (names.XHTML, "html"):
        return "xform"
    if local == "casedb":
        return "casedb"
    return "generic"


def _steps(children, naming, context, parent_written):
    """Each child's (structural, concrete) path step, its place in a run of the app's names, and its own context.

    ``name[@attr=*]`` and ``name[@attr=value]`` where its identity is unique
    among its same-named siblings (the value kept in both where it is
    vocabulary, written with the form's data names where it is a path into
    it), ``name[*]`` and ``name[n]`` otherwise; ``name`` is the concrete
    element name in ``at``, and the path's name for it (``_Naming.describe``)
    in ``path``. A name the app authored is ``*`` alone in ``path`` (its
    identity and position are the app's too), its place ``APP_STEP``; a
    query-bound row under one (``names.is_row``, the parent written
    ``parent_written``) is ``ROW_STEP``.
    """
    described = []
    identities = {}
    for child, tail in children:
        namespace, local = _tag(child.tag)
        shown, own, written, concrete = naming.describe(context, child, namespace, local)
        if concrete is not None:
            key = local + concrete
            identities[key] = identities.get(key, 0) + 1
        described.append((child, tail, local, shown, own, written, concrete))
    positions = {}
    steps = []
    for child, tail, local, shown, own, written, concrete in described:
        app = shown == names.APP
        place = APP_STEP if app else ROW_STEP if names.is_row(shown, own, parent_written) else None
        if concrete is not None and identities[local + concrete] == 1:
            step = (names.APP if app else f"{shown}{written}", f"{local}{concrete}")
        else:
            position = positions[local] = positions.get(local, 0) + 1
            step = (names.APP if app else f"{shown}[*]", f"{local}[{position}]")
        steps.append((step, child, tail, own, place, shown))
    return steps


# A child's place in a run of the app's own names (``_steps``): an app element, or a query-bound row under one.
APP_STEP = "app"
ROW_STEP = "row"


def _serialized(element):
    return etree.tostring(element, encoding="unicode", with_tail=False)


def compare_xml_trees(before, after, *, check, document, artifact, blank_text="ignore", naming="auto"):
    """Every difference between two parsed XML elements (the roots of two documents).

    ``naming`` is the kind of document whose rules name its elements in a
    path (``NAMINGS``: ``auto`` reads it from each root). A run of the app's
    own elements (a question in a group in a repeat) is one ``*`` in a path,
    a query-bound row inside the run part of it (``names.Written``): how deep
    the app nests its data is the document's, not the symptom's.
    """
    if blank_text not in ("ignore", "exact"):
        raise ValueError(f"blank_text is 'ignore' or 'exact', not {blank_text!r}.")
    naming_a = _Naming(naming_of(before, naming), before)
    naming_b = _Naming(naming_of(after, naming), after)
    found = []

    def report(path, at, kind, a, b):
        found.append(Difference(check, document, artifact, path, at, kind, a, b))

    def below(path, run, structural, place):
        """A child's path and the run it continues: an app element in a run is the run (its row folded into it,
        ``names.Written``), a row is kept after the run, anything else is a step of its own. ``run`` is the
        parent's: None, ``(APP_STEP, path)`` or ``(ROW_STEP, the run's path before the row)``."""
        if place == APP_STEP:
            if run is not None:
                return run[1], (APP_STEP, run[1])
            child = f"{path}/{structural}"
            return child, (APP_STEP, child)
        child = f"{path}/{structural}"
        if place == ROW_STEP and run is not None and run[0] == APP_STEP:
            return child, (ROW_STEP, path)
        return child, None

    def walk(a, b, path, at, parent_namespaces, context_a, context_b, run):
        namespace_a, _ = _tag(a.tag)
        namespace_b, _ = _tag(b.tag)
        if namespace_a != namespace_b and (namespace_a, namespace_b) != parent_namespaces:
            report(f"{path}/namespace()", f"{at}/namespace()", "changed", namespace_a, namespace_b)

        attributes_a = {_attribute_name(key): value for key, value in a.attrib.items()}
        attributes_b = {_attribute_name(key): value for key, value in b.attrib.items()}
        for name in sorted(set(attributes_a) | set(attributes_b)):
            if name not in attributes_b:
                report(f"{path}/@{name}", f"{at}/@{name}", "removed", attributes_a[name], None)
            elif name not in attributes_a:
                report(f"{path}/@{name}", f"{at}/@{name}", "added", None, attributes_b[name])
            elif attributes_a[name] != attributes_b[name]:
                report(f"{path}/@{name}", f"{at}/@{name}", "changed", attributes_a[name], attributes_b[name])

        text_a, children_a = element_content(a, blank_text)
        text_b, children_b = element_content(b, blank_text)
        if text_a != text_b:
            report(f"{path}/text()", f"{at}/text()", "changed", text_a, text_b)

        written = names.APP if run is not None and run[0] == APP_STEP else None
        steps_a = _steps(children_a, naming_a, context_a, written)
        steps_b = _steps(children_b, naming_b, context_b, written)
        by_step_b = {concrete: entry for entry in steps_b for concrete in (entry[0][1],)}
        concrete_a = [entry[0][1] for entry in steps_a]
        concrete_b = [entry[0][1] for entry in steps_b]
        for (structural, concrete), child, tail, own, place, _ in steps_a:
            child_path, child_run = below(path, run, structural, place)
            if concrete not in by_step_b:
                report(child_path, f"{at}/{concrete}", "removed", _serialized(child), None)
                continue
            _, other, other_tail, other_own, _, _ = by_step_b[concrete]
            walk(child, other, child_path, f"{at}/{concrete}", (namespace_a, namespace_b), own, other_own, child_run)
            if tail != other_tail:
                report(f"{child_path}/tail()", f"{at}/{concrete}/tail()", "changed", tail, other_tail)
        present_a = set(concrete_a)
        for (structural, concrete), child, _, _, place, _ in steps_b:
            if concrete not in present_a:
                report(below(path, run, structural, place)[0], f"{at}/{concrete}", "added", None, _serialized(child))
        common = present_a & set(concrete_b)
        order_a = [step for step in concrete_a if step in common]
        order_b = [step for step in concrete_b if step in common]
        if order_a != order_b:
            report(f"{path}/order()", f"{at}/order()", "changed", order_a, order_b)

    _, local_a = _tag(before.tag)
    _, local_b = _tag(after.tag)
    if local_a != local_b:
        report("/", "/", "changed", _serialized(before), _serialized(after))
        return found
    walk(
        before,
        after,
        f"/{local_a}",
        f"/{local_a}",
        (None, None),
        naming_a.root_context(),
        naming_b.root_context(),
        None,
    )
    return found


# Where a refusal names that a side is not XML: the cause, as a path from the document's root.
NOT_WELL_FORMED = "/not-well-formed"


def compare_xml(before, after, *, check, document, artifact, blank_text="ignore", normalize=(), naming="auto"):
    """Every difference between two XML documents given as bytes, each parsed first.

    ``normalize`` is a sequence of functions over a parsed root (the spelling
    rules registered for the artifact), applied to both sides before the
    comparison. A side that does not parse is reported as a ``refused``
    difference at ``/not-well-formed`` (its cause) with the parser's message.
    """
    roots = []
    found = []
    for side, content in (("before", before), ("after", after)):
        try:
            roots.append(parse_xml(content))
        except XmlNotWellFormed as error:
            roots.append(None)
            found.append(
                Difference(
                    check,
                    document,
                    artifact,
                    NOT_WELL_FORMED,
                    NOT_WELL_FORMED,
                    "refused",
                    str(error) if side == "before" else None,
                    str(error) if side == "after" else None,
                )
            )
    if found:
        return found
    before_root, after_root = roots
    for rule in normalize:
        before_root = rule(before_root)
        after_root = rule(after_root)
    return compare_xml_trees(
        before_root,
        after_root,
        check=check,
        document=document,
        artifact=artifact,
        blank_text=blank_text,
        naming=naming,
    )
