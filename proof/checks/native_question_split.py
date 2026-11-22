"""The date and time questions a reviewed split actually installed, in their suite form.

The same three data paths must be listed by the review and linked by the installed typed join.
Names are taken from the controls and binds; an unrelated date/time pair, including one with
the usual generated names, cannot stand for the original question.
"""

from dataclasses import dataclass
from itertools import pairwise

from proof.checks import android_titles, changes
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml, qname
from proof.checks.xform_parts import node_steps

CHANGE = "date-and-time-questions-split"
NS = android_titles.NS
XSD = "http://www.w3.org/2001/XMLSchema"


@dataclass(frozen=True)
class Split:
    original: str
    date: str
    time: str


@dataclass(frozen=True)
class FormSplit:
    before_namespace: str
    after_namespace: str
    questions: tuple[Split, ...]


def installed_paths(files, differing):
    found = {}
    for position, resource in android_titles.installed_resources(files, differing).items():
        if resource:
            path, form = resource
            found[position] = (form[0], path)
    return found


def _installed(files, differing, declared):
    suite = installed_paths(files, differing)
    found = {}
    for position, paths in declared.items():
        if position not in suite:
            continue
        namespace, path = suite[position]
        try:
            root = parse_xml(files[path])
        except XmlNotWellFormed:
            continue
        instance = root.find("h:head/f:model/f:instance", NS)
        if instance is None or len(instance) != 1 or qname(instance[0].tag)[0] != namespace:
            continue
        bindings = {}
        for bind in root.findall("h:head/f:model/f:bind", NS):
            key = bind.get("nodeset")
            if key in paths:
                prefix, separator, type_name = (bind.get("type") or "").partition(":")
                if not separator or bind.nsmap.get(prefix) != XSD:
                    type_name = None
                bindings[key] = (type_name, bind.get("calculate")) if key not in bindings else (None, None)
        inputs = [i.get("ref") for i in root.findall("h:body//f:input", NS)]
        found[position] = (namespace, bindings, inputs, instance[0])
    return found


def _join(date, time):
    # The compiler's clock-preserving join of the two answers. Only match the complete expression.
    return (
        f"date(format-date(if({date} = '' or {time} = '', '', concat({date}, 'T', {time})), '%Y-%m-%dT%H:%M:%S.%3%Z'))"
    )


def unique_node(root, path):
    namespace = qname(root.tag)[0]
    if not namespace:
        return None
    found = root.findall("/".join(f"{{{namespace}}}{part}" for part in path.split("/")[2:]))
    return found[0] if len(found) == 1 else None


def joined_nodes(root, original, date, time):
    day, clock, joined = (unique_node(root, path) for path in (date, time, original))
    if day is None or clock is None or joined is None or day.getnext() is not clock or clock.getnext() is not joined:
        return None
    return day, clock, joined


def installed(document, before_files, after_files, before_differing=(), after_differing=()):
    places = dict(document.first_publish_places).get(CHANGE, ())
    paths = {}
    for place in places:
        atoms = changes.unescaped(place)
        if len(atoms) >= 5 and atoms[0] == "form" and atoms[2] == "xform":
            pos = atoms[1].split(".")
            path = "/" + "/".join(atoms[3:])
            if len(pos) == 2 and all(part.isdigit() for part in pos) and node_steps(path):
                paths.setdefault(atoms[1], set()).add(path)
    if not paths:
        return {}
    old = _installed(before_files, before_differing, paths)
    new = _installed(after_files, after_differing, paths)
    result = {}
    for pos in old.keys() & new.keys():
        ns_a, binds_a, inputs_a, source_data = old[pos]
        ns_b, binds_b, inputs_b, data = new[pos]
        candidates = [
            (d, t)
            for d, t in pairwise(inputs_b)
            if binds_b.get(d) == ("date", None)
            and binds_b.get(t) == ("time", None)
            and d not in binds_a
            and t not in binds_a
            and inputs_b.count(d) == inputs_b.count(t) == 1
        ]
        splits = tuple(
            Split(path, day, clock)
            for path, binding in binds_a.items()
            for day, clock in candidates
            if binding == ("dateTime", None)
            and inputs_a.count(path) == 1
            and unique_node(source_data, path) is not None
            and path not in inputs_b
            and binds_b.get(path) == ("dateTime", _join(day, clock))
            and joined_nodes(data, path, day, clock) is not None
        )
        owners = [path for split in splits for path in (split.original, split.date, split.time)]
        if splits and len(owners) == len(set(owners)):
            result[pos] = FormSplit(ns_a, ns_b, splits)
    return result
