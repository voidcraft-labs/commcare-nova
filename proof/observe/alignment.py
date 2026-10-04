"""Proof 2's alignment: B's module and form ids and form ``xmlns`` mapped to A's by position.

Proof 1 judges identity; proof 2 judges everything else, so it compares
``build(A)`` with the build of B after B's identities are replaced by A's
at the same positions: module ``i``'s ``unique_id``, and form ``(i, j)``'s
``unique_id`` and ``xmlns``. The replacement is made in memory on a copy of
the app HQ holds for B, before HQ builds it, so HQ's own
``Application.set_form_versions`` finds each form of ``build(A)`` by its id
and decides its version from its content, as it would had the ids been
kept. Nothing is saved.

The copy is B's stored document with every value equal to one of B's
mapped identities replaced by A's (the identities are HQ ids and
``xmlns`` URIs, so a value equal to one is a reference to it: a form link's
``form_id``, a child menu's ``root_module_id``), and each form's source with
its data node moved into A's namespace, element by element, through lxml,
keeping every other namespace declaration where and in the order it was.
``leftover_identities`` confirms nothing of B's identities survived into
what HQ built from the copy.

The aligned build is observed (``proof.observe.unit``: the ``b_aligned``
record holds the alignment and HQ's build of the copy), so this module is
the observation's; the judges read the same mapping from it (proof 2's
leftover check, proof 5's mapping of D''s ids to D's).
"""

from __future__ import annotations

import copy
from dataclasses import dataclass

from lxml import etree

XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"
_MISSING = object()


class AlignmentIncomplete(AssertionError):
    """An identity of B was still present after alignment, so proof 2 would judge identity twice."""


@dataclass(frozen=True)
class Alignment:
    # (position, B's value, A's value), by position: "module:<i>", "form:<i>.<j>".
    module_ids: tuple
    form_ids: tuple
    xmlns: tuple
    # Positions only one of the two apps holds.
    unmatched: tuple

    def value_map(self):
        """Each of B's identities that differs from A's at its position, mapped to A's."""
        mapping = {}
        for _, b, a in (*self.module_ids, *self.form_ids, *self.xmlns):
            if b and a and b != a:
                mapping[b] = a
        return mapping

    def xmlns_at(self, position):
        for at, _, a in self.xmlns:
            if at == position:
                return a
        return None


def _forms(doc):
    for m, module in enumerate(doc.get("modules", [])):
        for f, form in enumerate(module.get("forms", [])):
            yield (m, f), form


def align_positions(a_doc, b_doc) -> Alignment:
    """B's identities paired with A's by position, from the two stored app documents."""
    module_ids, unmatched = [], []
    modules_a, modules_b = a_doc.get("modules", []), b_doc.get("modules", [])
    for m in range(max(len(modules_a), len(modules_b))):
        if m >= len(modules_a) or m >= len(modules_b):
            unmatched.append(f"module:{m}")
            continue
        module_ids.append((f"module:{m}", modules_b[m].get("unique_id"), modules_a[m].get("unique_id")))
    forms_a, forms_b = dict(_forms(a_doc)), dict(_forms(b_doc))
    form_ids, xmlns = [], []
    for position in sorted(set(forms_a) | set(forms_b)):
        name = f"form:{position[0]}.{position[1]}"
        if position not in forms_a or position not in forms_b:
            unmatched.append(name)
            continue
        form_ids.append((name, forms_b[position].get("unique_id"), forms_a[position].get("unique_id")))
        xmlns.append((name, forms_b[position].get("xmlns"), forms_a[position].get("xmlns")))
    return Alignment(tuple(module_ids), tuple(form_ids), tuple(xmlns), tuple(unmatched))


def map_values(value, mapping):
    """``value`` with every string equal to a key of ``mapping`` replaced by its mapped value."""
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [map_values(item, mapping) for item in value]
    if isinstance(value, dict):
        return {key: map_values(item, mapping) for key, item in value.items()}
    return value


def _data_node(root):
    for head in root:
        if isinstance(head.tag, str) and etree.QName(head).localname == "head":
            for model in head:
                if isinstance(model.tag, str) and etree.QName(model).localname == "model":
                    for instance in model:
                        if isinstance(instance.tag, str) and etree.QName(instance).localname == "instance":
                            for child in instance:
                                if isinstance(child.tag, str):
                                    return instance, child
                            return instance, None
    return None, None


def _rebuilt(element, parent, old, new, inherited):
    """``element``'s subtree under ``parent``, with ``old`` namespace names moved to ``new``.

    Each element keeps the namespace declarations it made itself, in their
    order, with ``old`` declared as ``new``; text, tails, comments and
    processing instructions are copied as they were.
    """
    own = {
        prefix: (new if uri == old else uri)
        for prefix, uri in element.nsmap.items()
        if inherited.get(prefix, _MISSING) != uri
    }

    def moved(name):
        qname = etree.QName(name)
        return f"{{{new}}}{qname.localname}" if qname.namespace == old else name

    attributes = {moved(key): value for key, value in element.attrib.items()}
    if parent is None:
        rebuilt = etree.Element(moved(element.tag), attributes, nsmap=own)
    else:
        rebuilt = etree.SubElement(parent, moved(element.tag), attributes, nsmap=own)
    rebuilt.text = element.text
    rebuilt.tail = element.tail
    for child in element:
        if isinstance(child.tag, str):
            _rebuilt(child, rebuilt, old, new, element.nsmap)
        else:
            rebuilt.append(copy.copy(child))
    return rebuilt


def renamespace_xform(source, new_xmlns):
    """The XForm source with its data node (and every element in its namespace) in ``new_xmlns``."""
    if isinstance(source, str):
        source = source.encode("utf-8")
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=True)
    root = etree.fromstring(source, parser)
    instance, data = _data_node(root)
    if data is None:
        raise AlignmentIncomplete("The form's source has no data node under its model's first instance.")
    old = etree.QName(data).namespace
    if old == new_xmlns:
        return source
    replacement = _rebuilt(data, None, old, new_xmlns, instance.nsmap)
    instance.replace(data, replacement)
    return etree.tostring(root, encoding="utf-8", xml_declaration=True)


def aligned_app(b_app, alignment: Alignment):
    """A copy of B, never saved, holding A's module ids, form ids and ``xmlns`` at each position."""
    mapping = alignment.value_map()
    sources = [form.source for form in b_app.get_forms()]
    copy_doc = map_values(copy.deepcopy(b_app.to_json()), mapping)
    app = type(b_app).wrap(copy_doc)
    for form, source in zip(app.get_forms(), sources, strict=True):
        target = alignment.xmlns_at(f"form:{form.get_module().id}.{form.id}")
        form.source = renamespace_xform(source, target).decode("utf-8") if target and source else source
    return app


def leftover_identities(parsed_files, alignment: Alignment):
    """Where any of B's replaced identities still appears in the parsed files HQ built from the copy.

    Every attribute value, text and namespace of each XML file, and every key
    and value of each app strings file, is looked at for an exact value.
    """
    replaced = set(alignment.value_map())
    found = []
    for path, built in sorted(parsed_files.items()):
        if built.parsed is None:
            continue
        if built.kind == "xml":
            for element in built.parsed.iter():
                if not isinstance(element.tag, str):
                    continue
                values = [etree.QName(element).namespace, *(element.attrib.values())]
                values += [text.strip() for text in (element.text, element.tail) if text]
                for value in values:
                    if value in replaced:
                        found.append((path, element.getroottree().getpath(element), value))
        else:
            for key, value in built.parsed.items():
                if key in replaced or value in replaced:
                    found.append((path, key, value))
    return found
