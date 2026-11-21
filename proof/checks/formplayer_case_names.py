"""Locate a submitted create/case_name in the question that the installed form binds to that exact case block."""

from lxml import etree

from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.xform_parts import XFORMS

SUBMISSION = "/runs/*/steps/*/submissions/*/instance/data/"
CREATE = "case[*]/create[*]/case_name[*]/text()"
NAMES = {SUBMISSION + CREATE, SUBMISSION + "subcase_*[*]/" + CREATE}
CASE = "{http://commcarehq.org/case/transaction/v2}"
XF = f"{{{XFORMS}}}"


def _one(elements):
    return elements[0] if len(elements) == 1 else None


def _leaves(node, parent):
    path = (*parent, etree.QName(node).localname)
    if not len(node):
        yield path, node.text
    for child in node:
        if isinstance(child.tag, str) and etree.QName(child).namespace == etree.QName(node).namespace:
            yield from _leaves(child, path)


def _calculation(model, target):
    bind = _one([node for node in model.findall(XF + "bind") if node.get("nodeset") == target])
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
    calculation = _calculation(model, "/" + "/".join(case_path))
    leaves = {}
    for path, value in _leaves(instance, ()):
        leaves[path] = None if path in leaves else value
    if not before:
        helper = _one(
            [
                path
                for path, value in leaves.items()
                if "/" + "/".join(path) == calculation
                and path[-1].startswith("nova_trimmed_")
                and value == difference.after
            ]
        )
        if helper is None:
            return None
        calculation = _calculation(model, "/" + "/".join(helper))
    answers = []
    for path, value in leaves.items():
        pointer = "/" + "/".join(path)
        expected = pointer if before else rf"replace({pointer}, '^[\x00-\x20]+|[\x00-\x20]+$', '')"
        if calculation == expected and value == difference.before:
            answers.append(path)
    answer = _one(answers)
    return (*location[:3], *answer) if answer is not None else None
