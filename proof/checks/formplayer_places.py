"""Locate observations of Formplayer in the form the worker actually opened.

A response carries that form's main instance; the next fill step carries the same form's last answered
question tree. Neither a run number nor a question's ordinal identifies a Nova form or question.
"""

from __future__ import annotations

import re

from lxml import etree

from proof.checks.changes import command_place, unescaped
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.served import comparable_trace

XML_CHILD = re.compile(r"([^\[\]/]+)\[([1-9]\d*)\]")


def _instance(xml, namespaces):
    if not isinstance(xml, str):
        return None, None
    try:
        root = parse_xml(xml)
    except XmlNotWellFormed:
        return None, None
    return root, namespaces.get(etree.QName(root).namespace)


def _node(steps, path):
    """Walk only the tree/children indices the native comparison actually reports."""
    node = steps
    while len(path) >= 2 and path[0] in ("tree", "children") and path[1].isdigit():
        if not isinstance(node, dict):
            return None
        children = node.get(path[0])
        index = int(path[1])
        if not isinstance(children, list) or index >= len(children):
            return None
        node, path = children[index], path[2:]
    return node if isinstance(node, dict) and not path else None


def _xml_place(xml, path, namespaces):
    """Resolve the concrete XML path on this side. A child the other side alone holds gives no evidence here."""
    node, position = _instance(xml, namespaces)
    if position is None or not path or path[0] != etree.QName(node).localname:
        return None
    names = [path[0]]
    for token in path[1:]:
        if token.startswith("@") or token in ("text()", "tail()", "order()", "namespace()"):
            break
        matched = XML_CHILD.fullmatch(token)
        if matched is None:
            return None
        name, index = matched.groups()
        children = [child for child in node if isinstance(child.tag, str) and etree.QName(child).localname == name]
        if int(index) > len(children):
            return None
        node = children[int(index) - 1]
        names.append(name)
    return ("form", position, "xform", *names)


def _place(step, previous, rest, namespaces):
    response = step.get("response") or {}
    xml = (response.get("instanceXml") or {}).get("output")
    if rest[:3] == ["response", "instanceXml", "output"]:
        return _xml_place(xml, rest[3:], namespaces)
    if len(rest) > 3 and rest[0] == "submissions" and rest[1].isdigit() and rest[2] == "instance":
        submissions = step.get("submissions") or ()
        if int(rest[1]) < len(submissions):
            return _xml_place(submissions[int(rest[1])].get("instance"), rest[3:], namespaces)
        return None
    if len(rest) == 4 and rest[:2] == ["response", "commands"] and rest[2].isdigit() and rest[-1] == "displayText":
        commands = response.get("commands") or ()
        if int(rest[2]) < len(commands):
            opened = command_place(commands[int(rest[2])].get("id"))
            if opened:
                return (*opened, "name")
        return None
    if not rest or rest[-1] not in ("caption", "caption_image"):
        return None
    if rest[:2] == ["response", "tree"]:
        node = _node(response, rest[1:-1])
    elif rest[0] == "tree" and "answers" in step:
        node = _node(step, rest[:-1])
        xml = (((previous or {}).get("response") or {}).get("instanceXml") or {}).get("output")
    else:
        return None
    binding = (node or {}).get("binding")
    instance, position = _instance(xml, namespaces)
    if not position or not isinstance(binding, str) or not binding.startswith("/"):
        return None
    path = binding[1:].split("/")
    if path[0] != etree.QName(instance).localname or any(not name or "[" in name for name in path):
        return None
    return ("form", position, "xform", *path, *((":itext",) if rest[-1] == "caption" else ()))


def locations(differences, trace, form_namespaces):
    """Concrete native differences by (artifact, at), located in this side's instance and question bindings.
    A missing or ambiguous namespace cannot locate a form. The caller merges agreement across sides and
    configurations. An added XML child is located by the side that actually contains it."""
    found = {}
    runs = comparable_trace(trace).get("runs") or ()
    for difference in differences:
        pointer = unescaped(difference.at)
        if (
            not difference.artifact.startswith("formplayer@")
            or len(pointer) < 5
            or pointer[0] != "runs"
            or pointer[2] != "steps"
            or not pointer[1].isdigit()
            or not pointer[3].isdigit()
        ):
            continue
        run, number = int(pointer[1]), int(pointer[3])
        if run >= len(runs):
            continue
        steps = runs[run].get("steps") or ()
        if number >= len(steps):
            continue
        place = _place(steps[number], steps[number - 1] if number else None, pointer[4:], form_namespaces)
        if place and place[-1] == ":itext":
            # The walker changes Web Apps' locale on an explicit navigation, retaining it until the next one.
            locale = next(
                (
                    (step.get("request") or {})["locale"]
                    for step in reversed(steps[: number + 1])
                    if isinstance((step.get("request") or {}).get("locale"), str) and step["request"]["locale"]
                ),
                None,
            )
            if locale:
                place = (*place, "label", locale, "default")
        if place:
            found[difference.artifact, difference.at] = place
    return found
