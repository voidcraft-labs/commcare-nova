"""Prove an added native instance node is the reviewed validation's own hidden helper."""

import json
from dataclasses import dataclass, replace
from functools import cache, cached_property

from lxml import etree

from proof.checks import (
    changes,
    formplayer_message_carriers,
    native_question_split,
    xpath_tree,
)
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.formplayer_case_names import CASE, absolute_ref, bindings_at, children_named, setvalue_targets
from proof.checks.formplayer_places import XML_CHILD
from proof.checks.manifest_value_classes import (
    JAVAROSA,
    QUESTION_CONTROLS,
    XFORMS,
    XHTML,
    Form,
    _constraint_carrier_name,
    _protected_message_values,
)
from proof.checks.xform_parts import itext_id, node_steps

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


SESSION_CASE = "instance('commcaresession')/session/data/case_id"
CASE_NAME = f"instance('casedb')/casedb/case[@case_id = {SESSION_CASE}]/case_name"


@dataclass(frozen=True)
class MessageOutput:
    steps: tuple[str, ...]
    selected_case: bool = False


def _case_name_field(form, targets):
    """Where this opening records the selected case name from the same two external instances."""
    for identifier, src in (("casedb", "jr://instance/casedb"), ("commcaresession", "jr://instance/session")):
        node = _one([i for i in form.model.findall("{*}instance") if i.get("id") == identifier])
        if (
            node is None
            or node.tag != XF + "instance"
            or dict(node.attrib) != {"id": identifier, "src": src}
            or len(node)
        ):
            return None
    case_id = "/data/case/@case_id"
    bind = _one(bindings_at(form.model, case_id))
    if bind is None or bind.get("calculate") != SESSION_CASE or case_id in targets:
        return None
    action = _one([v for v in form.model.findall(XF + "setvalue") if xpath_tree.same(v.get("value") or "", CASE_NAME)])
    if action is None or action.get("event") != "xforms-ready" or set(action.attrib) != {"event", "ref", "value"}:
        return None
    field = action.get("ref")
    steps = node_steps(field)
    if (
        not steps
        or steps[-1].startswith("@")
        or targets[field] != 1
        or form.in_repeat(field)
        or form.question_controls(field)
    ):
        return None
    bind = _one(bindings_at(form.model, field))
    if (
        bind is None
        or set(bind.attrib) - {"type", "nodeset"}
        or (bind.get("type") is not None and (bind.get("type") != "xsd:string" or bind.nsmap.get("xsd") != XSD))
        or not _leaf(_node(form.data_root, steps[1:]), "")
    ):
        return None
    return steps[1:]


def _has_long_alert(translation, identifier):
    # FormEntryPrompt.localizeText calls getQuestionText, which prefers the long form.
    # Core keys itext by the flattened ID, including a separate text named "<id>;long".
    long_id = identifier + ";long"
    for text in translation.findall("{*}text"):
        base = text.get("id")
        for value in text.findall("{*}value"):
            form = value.get("form")
            if (f"{base};{form}" if form else base) == long_id:
                return True
    return False


def _message(old, new, source, path, old_bind, new_bind, helper, targets):
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
    if label.tag != XF + "label" or set(label.attrib) != {"ref"} or len(label) or (label.text or "").strip():
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
    old_id, base = itext_id(message), itext_id(label.get("ref"))
    if not old_id or not base or "'" in base or not _protected_message_values(new, base):
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
        if old_alerts and _has_long_alert(translation, old_id):
            return False
        groups = [
            _one([x for x in t.findall("{*}text") if x.get("id") == identifier])
            for t, identifier in ((translation, old_id), (new_languages[translation.get("lang")], base))
        ]
        if any(g is None for g in groups):
            return False
        originals = [_one([v for v in group.findall("{*}value") if v.get("form") is None]) for group in groups]
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
                v = _one([v for v in groups[1].findall("{*}value") if v.get("form") == f"__nova_piece_{i}{suffix}"])
                if v is None or json.loads(v.text) != {"v": text}:
                    return False
    # A message can show a sibling's value, such as a previous meter reading. All
    # translations and the protected expression must still read the same single scalar.
    if len(references) != 1:
        return False
    reference = references.pop()
    steps = node_steps(reference)
    if xpath_tree.same(reference, CASE_NAME):
        a, b = (_case_name_field(form, held) for form, held in zip((old, new), targets, strict=True))
        if not a or a != b:
            return False
        output = MessageOutput(a, selected_case=True)
    elif steps and len(steps) == 2 and not steps[-1].startswith("@"):
        for form in (old, new):
            node = _node(form.data_root, steps[1:])
            if node is None or node.attrib or len(node) or form.in_repeat(reference):
                return False
        output = MessageOutput(steps[1:])
    else:
        return False
    expect = (
        f"if(jr:itext('{base};__nova_mode') = 'media', jr:itext('{base}'), if(count({reference}) > 1, '', "
        f"concat(json-property(jr:itext('{base};__nova_piece_0'), 'v'), {reference}, "
        f"json-property(jr:itext('{base};__nova_piece_2'), 'v'))))"
    )
    return output if xpath_tree.same(expect, new_bind.get(MSG) or "") else None


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


class _InstalledForm(Form):
    """The locale source and control bindings that Core reads from this installed form."""

    @cached_property
    def model(self):
        # Core uses the first model. Every bind it applies must name a fixed path we can place:
        # even a bind without a calculation can override a carrier's relevance or readonly flag.
        model = super().model
        if model is not next(self.root.iter("{*}model"), None) or model is None:
            return None
        if any(absolute_ref(b.get("nodeset") or "", "/data") is None for b in model.findall("{*}bind")):
            return None
        return model

    @cached_property
    def translations(self):
        # Each direct itext installs a new Localizer. Admit only one source.
        itext = _one(self.model.findall("{*}itext"))
        return tuple(itext.findall("{*}translation")) if itext is not None else ()

    @cached_property
    def controls(self):
        body = self.root.find(f"{{{XHTML}}}body")
        if body is None:
            return None
        contexts, found = {body: "/data"}, {}
        for control in body.iterdescendants():
            if not isinstance(control.tag, str):
                continue
            kind = etree.QName(control).localname
            context = contexts[control.getparent()]
            contexts[control] = context
            if kind not in QUESTION_CONTROLS:
                continue
            if (identifier := control.get("bind")) is not None:
                bind = _one([b for b in self.model.findall("{*}bind") if b.get("id") == identifier])
                if bind is None:
                    return None
                ref, context = bind.get("nodeset"), "/data"
            else:
                ref = control.get("nodeset" if kind == "repeat" else "ref")
                if ref is None and kind != "repeat":
                    continue  # An unbound group passes its parent's context to its children.
            resolved = context if ref == "." else absolute_ref(ref or "", context)
            if resolved is None:
                return None
            found.setdefault(resolved, []).append(control)
            if kind in {"group", "repeat"}:
                contexts[control] = resolved
        return found

    @cached_property
    def repeat_paths(self):
        return {self.paths[node] for node in self.model_repeats} | {
            path
            for path, controls in self.controls.items()
            if any(etree.QName(c).localname == "repeat" for c in controls)
        }


def _definitions(files, differing, positions):
    installed = native_question_split.installed_paths(files, differing)
    forms = {}
    for pos in positions & installed.keys():
        namespace, path = installed[pos]
        root = _xml(files.get(path))
        if root is not None:
            form = _InstalledForm(root, path)
            if form.xmlns == namespace and form.data_root.tag == f"{{{namespace}}}data" and form.controls is not None:
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
        len(at) < 9
        or (family == COUNT and len(at) != 9)
        or at[0] != "runs"
        or at[2] != "steps"
        or at[7] != "data"
        or not at[1].isdigit()
        or not at[3].isdigit()
    ):
        return None
    children = [XML_CHILD.fullmatch(token) for token in at[8:]]
    if any(child is None or child[2] != "1" for child in children):
        return None
    if d.path.startswith(OPEN) and at[4:7] == ["response", "instanceXml", "output"]:
        sub = None
    elif d.path.startswith(SENT) and at[4] == "submissions" and at[5].isdigit() and at[6] == "instance":
        sub = int(at[5])
    else:
        return None
    return family, tuple(child[1] for child in children), int(at[1]), int(at[3]), sub


def _cardinality(root, counted):
    ns = etree.QName(root).namespace
    target = "/".join(f"{{{ns}}}{n}" for n in counted[1:])
    return sum(bool("".join(n.itertext())) for n in root.findall(target))


def _children(root, name):
    return children_named(root, f"{{{etree.QName(root).namespace}}}{name}") if root is not None else None


def _node(root, steps):
    """Every named step must exist exactly once in the primary instance's namespace."""
    for step in steps:
        root = _one(_children(root, step) or [])
    return root


def _value(d, a, b, script, name, source, counted, output):
    # The count bind only applies when its source exists. Both this worker's instances must
    # contain that very question exactly once, as in the respective installed templates.
    left, right = (_node(root, source) for root in (a, b))
    if (
        left is None
        or right is None
        or (output and not (_leaf(left, left.text or "") and _leaf(right, left.text or "")))
    ):
        return False
    tags = [f"{{{etree.QName(root).namespace}}}{name[-1]}" for root in (a, b)]
    actual = _node(b, name)
    reported = _xml(d.after)
    if _children(_node(a, name[:-1]), name[-1]) != [] or actual is None or reported is None or reported.tag not in tags:
        return False
    if output:
        old, new = (_node(r, output.steps) for r in (a, b))
        if old is None or not _leaf(old, old.text or "") or not _leaf(new, old.text or ""):
            return False
        if output.selected_case:
            selected = _one([s["entity"] for s in script if isinstance(s, dict) and "entity" in s])
            cases = [_one(children_named(root, CASE + "case") or []) for root in (a, b)]
            # Its installed preload starts empty. A filled scalar witnesses the ready action.
            if not old.text or not selected or any(case is None or case.get("case_id") != selected for case in cases):
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
                len(who) >= 5
                and (family == MESSAGE or len(who) == 5)
                and who[0] == "form"
                and who[2:4] == ["xform", "data"]
                and node_steps("/" + "/".join(who[3:])) == tuple(who[3:])
                and not who[-1].startswith("@")
            ):
                pos = who[1].split(".")
                if len(pos) == 2 and all(v.isascii() and v.isdigit() for v in pos):
                    places.setdefault((family, who[1]), set()).add(tuple(who[4:]))
    if not places or not any(d.kind == "added" and d.path in CANDIDATES for d in differences):
        return {}, differences
    positions = {p for _, p in places}
    old_forms, new_forms = (
        _definitions(f, dif, positions) for f, dif in ((before_files, before_differing), (after_files, after_differing))
    )

    @cache
    def definition(family, pos, name):
        old, new = old_forms[pos], new_forms[pos]
        path = "/data/" + "/".join(name)
        template = _node(new.data_root, name)
        if (
            any(form.in_repeat(path) for form in (old, new))
            or _children(_node(old.data_root, name[:-1]), name[-1]) != []
            or bindings_at(old.model, path)
            or old.question_controls(path)
            or not _leaf(template, "")
            or template.tag != f"{{{new.xmlns}}}{name[-1]}"
        ):
            return None
        helper = _one(bindings_at(new.model, path))
        targets = [setvalue_targets(form.root, form.model) for form in (old, new)]
        if helper is None or helper.nsmap.get("xsd") != XSD or any(held is None or path in held for held in targets):
            return None
        matches = []
        for other in places[family, pos] - {name}:
            if other[:-1] != name[:-1]:
                continue
            source = "/data/" + "/".join(other)
            a, b = (_one(bindings_at(form.model, source)) for form in (old, new))
            if (
                a is None
                or b is None
                or any(source in held for held in targets)
                or any(_node(form.data_root, other) is None for form in (old, new))
                or len(old.question_controls(source)) != 1
                or len(new.question_controls(source)) != 1
            ):
                continue
            if family == COUNT:
                counted = _count(old, new, source, path, a, b, helper)
                if counted:
                    matches.append((other, counted, None))
            elif output := _message(old, new, source, path, a, b, helper, targets):
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
        if witness is None or not _value(d, a, b, script_a, name, *witness):
            return None
        return (":reviewed-count" if family == COUNT else ":reviewed-message"), (
            "form",
            pos,
            "xform",
            "data",
            *name,
        )

    found, sites = [], {}
    for d in differences:
        hit = witness(d)
        if hit:
            suffix, sites[d.artifact, d.at] = hit
            d = replace(d, path=d.path + suffix)
        found.append(d)
    return formplayer_message_carriers.shifted_triggers(found, sites, old_forms, new_forms, before_trace, after_trace)
