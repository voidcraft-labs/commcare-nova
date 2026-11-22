"""Prove an added native instance node is the reviewed validation's own hidden helper."""

import json
from dataclasses import replace
from functools import cache

from lxml import etree

from proof.checks import (
    changes,
    formplayer_message_carriers,
    native_question_split,
    xpath_tree,
)
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.formplayer_case_names import bindings_at, children_named, setvalue_targets
from proof.checks.formplayer_places import XML_CHILD
from proof.checks.manifest_value_classes import (
    JAVAROSA,
    XFORMS,
    Form,
    _constraint_carrier_name,
    _protected_message_values,
)
from proof.checks.xform_parts import node_steps

COUNT = "validation-counts-moved"
MESSAGE = "validation-messages-composed"
OPEN = "/runs/*/steps/*/response/instanceXml/output/data/"
SENT = "/runs/*/steps/*/submissions/*/instance/data/"
CANDIDATES = {
    OPEN + "nova_constraint_*[*]": COUNT,
    SENT + "nova_constraint_*[*]": COUNT,
    OPEN + "*": MESSAGE,
}
XF = f"{{{XFORMS}}}"
MSG = f"{{{JAVAROSA}}}constraintMsg"
XSD = "http://www.w3.org/2001/XMLSchema"


def _one(nodes):
    return nodes[0] if len(nodes) == 1 else None


def _xml(value):
    if not isinstance(value, (str, bytes)):
        return None
    try:
        return parse_xml(value)
    except XmlNotWellFormed:
        return None


def _leaf(node, value):
    return node is not None and not node.attrib and not len(node) and (node.text or "") == value


def _count_path(expression):
    """The finite collection counted here: named child steps whose final leaf holds nonempty text."""
    if not expression or expression[:2] != ("call", "count") or len(expression[2]) != 1:
        return None
    (path,) = expression[2]
    if path[:3] != ("path", "SLASH", None):
        return None
    steps = path[3]
    if len(steps) < 2 or any(s[:2] != ("step", "child") or not s[2].isidentifier() or s[3] for s in steps[:-1]):
        return None
    last = steps[-1]
    if last[:2] != ("step", "child") or not last[2].isidentifier():
        return None
    if last[3] not in ((xpath_tree.tree(". != ''"),), (xpath_tree.tree("./. != ''"),)):
        return None
    names = tuple(s[2] for s in steps)
    return names if names[0] == "data" else None


def _count(old, new, source, path, old_bind, new_bind, helper):
    expression = xpath_tree.tree(helper.get("calculate") or "")
    collection = _count_path(expression)
    if collection is None or new.question_controls(path):
        return None
    if dict(helper.attrib) != {
        "nodeset": path,
        "type": "xsd:int",
        "calculate": helper.get("calculate"),
        "relevant": f"count({source}) > 0",
    }:
        return None
    # A's original comparison must now read the new helper at the same operand, and count
    # the same collection from the primary data. Never execute an arbitrary XPath on the host.
    a = xpath_tree.tree(old_bind.get("constraint") or "")
    b = xpath_tree.tree(new_bind.get("constraint") or "")
    if not a or not b or len(a) != 3 or len(b) != 3 or a[0] not in {"EQ", "NEQ", "LT", "LTE", "GT", "GTE"}:
        return None
    if a[:2] != b[:2] or _count_path(a[2]) != collection or b[2] != xpath_tree.tree(path):
        return None
    return collection


def _message(old, new, source, path, old_bind, new_bind, helper):
    # Only the empty, permanently irrelevant/readonly carrier for the exact old message.
    if dict(helper.attrib) != {
        "nodeset": path,
        "type": "xsd:string",
        "relevant": "false()",
        "readonly": "true()",
    }:
        return False
    if not _constraint_carrier_name(path.rsplit("/", 1)[1], source.rsplit("/", 1)[1]):
        return False
    src = _one(new.question_controls(source))
    control = _one(new.question_controls(path))
    if (
        src is None
        or control is None
        or control.tag != XF + "input"
        or dict(control.attrib) != {"ref": path}
        or src.getparent() is not control.getparent()
        or len(control) != 1
    ):
        return False
    label = control[0]
    message = old_bind.get(MSG)
    if label.tag != XF + "label" or dict(label.attrib) != {"ref": message} or len(label) or (label.text or "").strip():
        return False
    # A control alert takes precedence over its bind (Core FormEntryPrompt.getConstraintText).
    # The original can show this same itext directly. A protected message uses its bind alone.
    old_alerts = _one(old.question_controls(source)).findall("{*}alert")
    if src.findall("{*}alert") or (
        old_alerts
        and (
            len(old_alerts) != 1
            or old_alerts[0].tag != XF + "alert"
            or dict(old_alerts[0].attrib) != {"ref": message}
            or len(old_alerts[0])
            or (old_alerts[0].text or "").strip()
        )
    ):
        return False
    read = xpath_tree.tree(message or "")
    if not read or read[:2] != ("call", "jr:itext") or len(read[2]) != 1 or read[2][0][0] != "str":
        return False
    base = read[2][0][1]
    if "'" in base or not _protected_message_values(new, base):
        return False
    if not old_bind.get("constraint") or not xpath_tree.same(
        old_bind.get("constraint"), new_bind.get("constraint") or ""
    ):
        return False
    # The simple translated text–output–text message. Its literal fragments in the protected
    # translations and the runtime reference to the original answer must agree in every language.
    for form in (old, new):
        languages = [node.get("lang") for node in form.translations]
        if (
            not languages
            or not all(languages)
            or len(languages) != len(set(languages))
            or sum(t.get("default") is not None for t in form.translations) > 1
        ):
            return False
    new_languages = {node.get("lang"): node for node in new.translations}
    if {node.get("lang") for node in old.translations} != set(new_languages) or (
        old.default_translation.get("lang") != new.default_translation.get("lang")
    ):
        return False
    references = set()
    for translation in old.translations:
        groups = [
            _one([x for x in t.findall(XF + "text") if x.get("id") == base])
            for t in (translation, new_languages[translation.get("lang")])
        ]
        if any(g is None for g in groups):
            return False
        originals = [_one([v for v in group.findall(XF + "value") if v.get("form") is None]) for group in groups]
        for v in originals:
            if (
                v is None
                or v.attrib
                or len(v) != 1
                or v[0].tag != XF + "output"
                or set(v[0].attrib) != {"value"}
                or len(v[0])
                or v[0].text
                or not v.text
                or not v[0].tail
            ):
                return False
        a, b = originals
        references.update(v[0].get("value") for v in originals)
        if (a.text, a[0].tail) != (b.text, b[0].tail):
            return False
        for i, text in ((0, a.text), (2, a[0].tail)):
            for suffix in ("", ";markdown"):
                v = _one([v for v in groups[1].findall(XF + "value") if v.get("form") == f"__nova_piece_{i}{suffix}"])
                if v is None or json.loads(v.text) != {"v": text}:
                    return False
    # A message can show a sibling's value, such as a previous meter reading. All
    # translations and the protected expression must still read the same single scalar.
    if len(references) != 1:
        return False
    reference = references.pop()
    steps = node_steps(reference)
    if not steps or len(steps) != 2:
        return False
    for form in (old, new):
        node = _one(_children(form.data_root, steps[1]) or [])
        if node is None or node.attrib or len(node):
            return False
    expect = (
        f"if(jr:itext('{base};__nova_mode') = 'media', jr:itext('{base}'), if(count({reference}) > 1, '', "
        f"concat(json-property(jr:itext('{base};__nova_piece_0'), 'v'), {reference}, "
        f"json-property(jr:itext('{base};__nova_piece_2'), 'v'))))"
    )
    return steps[1] if xpath_tree.same(expect, new_bind.get(MSG) or "") else None


def _native(trace, run, step, sub):
    runs = trace.get("runs") or []
    if run >= len(runs):
        return None
    steps = runs[run].get("steps") or []
    if step >= len(steps):
        return None
    current = steps[step]
    if sub is None:
        root = _xml(((current.get("response") or {}).get("instanceXml") or {}).get("output"))
    else:
        subs = current.get("submissions") or []
        root = _xml(subs[sub].get("instance")) if sub < len(subs) else None
    if root is None or etree.QName(root).localname != "data":
        return None
    return root, runs[run].get("script")


def _definitions(files, differing, positions):
    installed = native_question_split.installed_paths(files, differing)
    forms = {}
    for pos in positions & installed.keys():
        namespace, path = installed[pos]
        root = _xml(files.get(path))
        if root is not None:
            form = Form(root, path)
            if form.xmlns == namespace:
                forms[pos] = form
    return forms


def _address(d):
    if d.kind != "added" or d.before is not None or not d.artifact.startswith("formplayer@"):
        return None
    family = CANDIDATES.get(d.path)
    if not family:
        return None
    at = changes.unescaped(d.at)
    if (
        len(at) != 9
        or at[0] != "runs"
        or at[2] != "steps"
        or at[7] != "data"
        or not at[1].isdigit()
        or not at[3].isdigit()
    ):
        return None
    child = XML_CHILD.fullmatch(at[8])
    if child is None or child[2] != "1":
        return None
    if d.path.startswith(OPEN) and at[4:7] == ["response", "instanceXml", "output"]:
        sub = None
    elif d.path.startswith(SENT) and at[4] == "submissions" and at[5].isdigit() and at[6] == "instance":
        sub = int(at[5])
    else:
        return None
    return family, child[1], int(at[1]), int(at[3]), sub


def _cardinality(root, counted):
    ns = etree.QName(root).namespace
    target = "/".join(f"{{{ns}}}{n}" for n in counted[1:])
    return sum(bool("".join(n.itertext())) for n in root.findall(target))


def _children(root, name):
    return children_named(root, f"{{{etree.QName(root).namespace}}}{name}")


def _value(d, a, b, name, source, counted, output):
    # The count bind only applies when its source exists. Both this worker's instances must
    # contain that very question exactly once, as in the respective installed templates.
    if any(_one(_children(root, source) or []) is None for root in (a, b)):
        return False
    tags = [f"{{{etree.QName(root).namespace}}}{name}" for root in (a, b)]
    actual = _one(_children(b, name) or [])
    reported = _xml(d.after)
    if _children(a, name) != [] or actual is None or reported is None or reported.tag not in tags:
        return False
    if output:
        old, new = (_one(_children(r, output) or []) for r in (a, b))
        if old is None or not _leaf(old, old.text or "") or not _leaf(new, old.text or ""):
            return False
    expected = ""
    if counted:
        old_count = _cardinality(a, counted)
        if old_count != _cardinality(b, counted):
            return False
        expected = str(old_count)
    return _leaf(reported, expected) and _leaf(actual, expected)


def helper_sites(
    differences,
    *,
    before_files,
    after_files,
    before_trace,
    after_trace,
    declared,
    before_differing=(),
    after_differing=(),
):
    """Return the concrete helper sites and the reclassified rows for this one native comparison."""
    places = {}
    for family in (COUNT, MESSAGE):
        for pointer in declared.get(family, ()):
            who = changes.unescaped(pointer)
            if (
                len(who) == 5
                and who[0] == "form"
                and who[2:4] == ["xform", "data"]
                and node_steps("/" + "/".join(who[3:]))
            ):
                pos = who[1].split(".")
                if len(pos) == 2 and all(v.isascii() and v.isdigit() for v in pos):
                    places.setdefault((family, who[1]), set()).add(who[4])
    if not places or not any(d.kind == "added" and d.path in CANDIDATES for d in differences):
        return {}, differences
    positions = {p for _, p in places}
    old_forms, new_forms = (
        _definitions(f, dif, positions) for f, dif in ((before_files, before_differing), (after_files, after_differing))
    )

    @cache
    def definition(family, pos, name):
        old, new = old_forms[pos], new_forms[pos]
        path = "/data/" + name
        template = _one(_children(new.data_root, name) or [])
        if (
            _children(old.data_root, name) != []
            or bindings_at(old.model, path)
            or not _leaf(template, "")
            or template.tag != f"{{{new.xmlns}}}{name}"
        ):
            return None
        helper = _one(bindings_at(new.model, path))
        targets = [setvalue_targets(form.root, form.model) for form in (old, new)]
        if helper is None or helper.nsmap.get("xsd") != XSD or any(held is None or path in held for held in targets):
            return None
        matches = []
        for other in places[family, pos] - {name}:
            source = "/data/" + other
            a, b = (_one(bindings_at(form.model, source)) for form in (old, new))
            if (
                a is None
                or b is None
                or any(source in held for held in targets)
                or any(_one(_children(form.data_root, other) or []) is None for form in (old, new))
                or len(old.question_controls(source)) != 1
                or len(new.question_controls(source)) != 1
            ):
                continue
            if family == COUNT:
                counted = _count(old, new, source, path, a, b, helper)
                if counted:
                    matches.append((other, counted, None))
            elif output := _message(old, new, source, path, a, b, helper):
                matches.append((other, (), output))
        return _one(matches)

    observe = cache(lambda run, step, sub: tuple(_native(t, run, step, sub) for t in (before_trace, after_trace)))

    def witness(d):
        where = _address(d)
        if where is None:
            return None
        family, name, run, step, sub = where
        sides = observe(run, step, sub)
        if not all(sides):
            return None
        (a, script_a), (b, script_b) = sides
        if not isinstance(script_a, list) or script_a != script_b:
            return None
        pos = _one(
            [
                p
                for p in old_forms.keys() & new_forms.keys()
                if old_forms[p].xmlns == etree.QName(a).namespace and new_forms[p].xmlns == etree.QName(b).namespace
            ]
        )
        if not pos or name not in places.get((family, pos), ()):
            return None
        witness = definition(family, pos, name)
        if witness is None or not _value(d, a, b, name, *witness):
            return None
        return (":reviewed-count" if family == COUNT else ":reviewed-message"), (
            "form",
            pos,
            "xform",
            "data",
            name,
        )

    found, sites = [], {}
    for d in differences:
        hit = witness(d)
        if hit:
            suffix, sites[d.artifact, d.at] = hit
            d = replace(d, path=d.path + suffix)
        found.append(d)
    return formplayer_message_carriers.shifted_triggers(found, sites, old_forms, new_forms, before_trace, after_trace)
