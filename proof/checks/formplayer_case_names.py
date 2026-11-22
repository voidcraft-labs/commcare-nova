"""Locate a submitted create/case_name in the question that the installed form binds to that exact case block."""

from collections import Counter

from lxml import etree

from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.xform_parts import XFORMS
from proof.rules import _xpath

SUBMISSION = "/runs/*/steps/*/submissions/*/instance/data/"
CREATE = "case[*]/create[*]/case_name[*]/text()"
NAMES = {SUBMISSION + CREATE, SUBMISSION + "subcase_*[*]/" + CREATE}
CASE = "{http://commcarehq.org/case/transaction/v2}"
XF = f"{{{XFORMS}}}"


def _one(elements):
    return elements[0] if len(elements) == 1 else None


def children_named(parent, tag):
    """Native XML pointers number all local-name siblings. A namesake in a different namespace is ambiguous."""
    if parent is None:
        return None
    local = etree.QName(tag).localname
    found = [child for child in parent if isinstance(child.tag, str) and etree.QName(child).localname == local]
    return found if all(child.tag == tag for child in found) else None


def leaves(node, parent):
    path = (*parent, etree.QName(node).localname)
    if not len(node):
        yield path, node.text
    for child in node:
        if isinstance(child.tag, str) and etree.QName(child).namespace == etree.QName(node).namespace:
            yield from leaves(child, path)


def absolute_ref(ref, context):
    """A fixed path from the binding context Core supplies, or None for a path we cannot place."""
    if _xpath.plain_path(ref):
        return ref
    step = ref.removeprefix("./")
    if step and not ref.startswith("/") and _xpath.plain_path("/" + step):
        return context + "/" + step
    return None


def _context(model):
    instance = model.find(XF + "instance")
    return "/" + etree.QName(instance[0]).localname if instance is not None and len(instance) == 1 else ""


def bindings_at(model, target):
    """XFormParser.parseModel dispatches direct model children by local name, including a foreign bind."""
    context = _context(model)
    return [b for b in model.findall("{*}bind") if absolute_ref(b.get("nodeset") or "", context) == target]


def setvalue_targets(form, model):
    """Number of native actions writing each fixed target. An unresolved write could replace the observed calculation.

    XFormParser.parseModel and parseControlChildren both dispatch actions by local name. A data element
    called setvalue inside the instance is ordinary data. parseSetValueAction uses the bind ID before ref.
    """
    context = _context(model)
    binds = model.findall("{*}bind")
    if any(b.get("calculate") is not None and absolute_ref(b.get("nodeset") or "", context) is None for b in binds):
        return None
    targets = Counter()
    for action in form.iter("{*}setvalue"):
        parent = action.getparent()
        if parent is not model and (
            model in action.iterancestors()
            or etree.QName(parent).localname not in {"input", "secret", "select", "select1", "trigger", "upload"}
        ):
            continue
        if (identifier := action.get("bind")) is not None:
            bind = _one([b for b in binds if b.get("id") == identifier])
            target = absolute_ref(bind.get("nodeset") or "", context) if bind is not None else None
        else:
            target = absolute_ref(action.get("ref") or "", "")
        if target is None:
            return None
        targets[target] += 1
    return targets


def calculation_at(model, target):
    bind = _one(bindings_at(model, target))
    return bind.get("calculate") if bind is not None else None


def question(difference, location, submission, form_file, *, before):
    """A writes the raw answer. The republish writes the same answer through a Java-trimming generated bind.

    Return the source question so both sides must independently point to the same declared field. A duplicate
    question path in a repeated group, an unknown calculation, or a differing served form gives no evidence.
    """
    if not form_file:
        return None
    try:
        instance = parse_xml(submission)
        form = parse_xml(form_file)
    except XmlNotWellFormed:
        return None
    model = form.find(".//" + XF + "model")
    declared = model.find(XF + "instance") if model is not None else None
    if declared is None or len(declared) != 1 or declared[0].tag != instance.tag:
        return None
    case_path = location[3:]
    ns = etree.QName(instance).namespace
    # The observed branch belongs to this form; the three case elements belong to the transaction namespace.
    branch = [f"{{{ns}}}{step}" for step in case_path[1:-3]] + [CASE + step for step in case_path[-3:]]
    name = _one(instance.findall("/".join(branch)))
    if name is None or name.text != (difference.before if before else difference.after):
        return None
    target = "/" + "/".join(case_path)
    targets = setvalue_targets(form, model)
    if targets is None or target in targets or (not before and calculation_at(model, target) in targets):
        return None
    answer = bound_answer(model, case_path, leaves(instance, ()), name.text, before=before)
    if answer is None or answer[1] != difference.before:
        return None
    return (*location[:3], *answer[0])


def bound_answer(model, case_path, instance_leaves, name, *, before):
    """The original field and raw text of this create bind, from the leaves in the same submission occurrence."""
    calculation = calculation_at(model, "/" + "/".join(case_path))
    leaves = {}
    for path, value in instance_leaves:
        leaves[path] = None if path in leaves else value
    if not before:
        helper = _one(
            [
                path
                for path, value in leaves.items()
                if "/" + "/".join(path) == calculation and path[-1].startswith("nova_trimmed_") and value == name
            ]
        )
        if helper is None:
            return None
        calculation = calculation_at(model, "/" + "/".join(helper))
    answers = []
    for path, value in leaves.items():
        pointer = "/" + "/".join(path)
        expected = pointer if before else rf"replace({pointer}, '^[\x00-\x20]+|[\x00-\x20]+$', '')"
        if calculation == expected and isinstance(value, str) and (not before or value == name):
            answers.append((path, value))
    return _one(answers)
