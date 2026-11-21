"""Locate Formplayer's nested checked case-name helper beside its source in the very same form occurrence."""

from collections import Counter
from functools import cache

from lxml import etree

from proof.checks import changes
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.formplayer_case_names import (
    CASE,
    XF,
    bindings_at,
    children_named,
    setvalue_targets,
)
from proof.checks.formplayer_places import XML_CHILD
from proof.rules import _xpath

OPEN = "/runs/*/steps/*/response/instanceXml/output/data/*/nova_trimmed_*[*]"
SENT = "/runs/*/steps/*/submissions/*/instance/data/*/nova_trimmed_*[*]"
UPDATE = "/runs/*/steps/*/submissions/*/instance/data/case[*]/update[*]/case_name[*]/text()"
SUFFIX = ":checked-name"


def candidate(d):
    return d.artifact.startswith("formplayer@") and (
        (d.kind == "added" and d.path in (OPEN, SENT)) or (d.kind == "changed" and d.path == UPDATE)
    )


def _one(items):
    return items[0] if len(items) == 1 else None


def _writers(form, module_type):
    actions = form.get("actions") or {}
    opened = actions.get("open_case") or {}
    if (opened.get("condition") or {}).get("type") == "always":
        yield (), "create", opened.get("name_update") or {}, module_type
    update = actions.get("update_case") or {}
    if (update.get("condition") or {}).get("type") == "always":
        yield (), "update", (update.get("update") or {}).get("name") or {}, None
    for subcase in actions.get("subcases") or []:
        repeat = subcase.get("repeat_context") or ""
        if _xpath.plain_path(repeat) and (subcase.get("condition") or {}).get("type") in ("always", "if"):
            yield tuple(repeat.split("/")[2:]), "create", subcase.get("name_update") or {}, subcase.get("case_type")


def _drawn(nodes, source):
    return any(n.get("binding") == source or _drawn(n.get("children") or [], source) for n in nodes)


def _child(parent, tag):
    return _one(children_named(parent, tag) or [])


def _leaf(node):
    return (node.text or "") if node is not None and not len(node) and not node.attrib else None


def sites(differences, declared, sides):
    """Both sent instances/opening responses must identify one source action, raw value, case and occurrence."""
    sites = {}
    for d in differences:
        at = changes.unescaped(d.at)
        if len(at) < 10 or at[0] != "runs" or at[2] != "steps" or not at[1].isdigit() or not at[3].isdigit():
            continue
        opening = d.path == OPEN
        if opening and at[4:7] == ["response", "instanceXml", "output"]:
            sub = None
        elif not opening and at[4] == "submissions" and at[5].isdigit() and at[6] == "instance":
            sub = int(at[5])
        else:
            continue
        if d.path == UPDATE and at[-1] != "text()":
            continue
        tokens = at[8:-1] if d.path == UPDATE else at[8:]
        matches = [XML_CHILD.fullmatch(s) for s in tokens]
        if at[7] != "data" or not all(matches):
            continue
        path = tuple(m[1] for m in matches)
        indices = tuple(int(m[2]) for m in matches)
        evidence = [read(d, int(at[1]), int(at[3]), sub, path, indices) for read in sides]
        if None in evidence:
            continue
        old_witness, new_witness = evidence
        if old_witness[:-1] != new_witness[:-1]:
            continue
        position, source = old_witness[:2]
        old, new = old_witness[-1], new_witness[-1]
        trimmed = old.strip(changes.CASE_SCALAR_TRIM)
        if new != trimmed or (sub is not None and not (0 < len(new.encode("utf-16-le", "surrogatepass")) <= 510)):
            continue
        if d.path == UPDATE and (d.before != old or d.after != new):
            continue
        field = ("form", position, "xform", *source)
        helper = (*field[:-1], "nova_trimmed_" + field[-1])
        if all("/" + "/".join(place) in declared for place in (field, helper)):
            sites[d.artifact, d.at] = field if d.path == UPDATE else helper
    return sites


def side(trace, files, namespaces, differing, reviewed, *, before):
    binds_at = cache(bindings_at)

    @cache
    def installed(position):
        m, f = map(int, position.split("."))
        modules = reviewed.get("modules") or []
        forms = (modules[m].get("forms") or []) if m < len(modules) else []
        file = f"modules-{m}/forms-{f}.xml"
        if f >= len(forms) or file in differing or not files.get(file):
            return None
        try:
            doc = parse_xml(files[file])
        except XmlNotWellFormed:
            return None
        model = _one(doc.findall(".//" + XF + "model"))
        if model is None:
            return None
        instance = model.find(XF + "instance")
        if instance is None or len(instance) != 1:
            return None
        targets = setvalue_targets(doc, model)
        if targets is None:
            return None
        return forms[f], modules[m].get("case_type"), doc, model, instance[0].tag, targets

    @cache
    def observation(run, step, sub):
        runs = trace.get("runs") or []
        steps = runs[run].get("steps") or [] if run < len(runs) else []
        if step >= len(steps):
            return None
        response = steps[step].get("response") or {}
        submissions = steps[step].get("submissions") or []
        xml = (
            (response.get("instanceXml") or {}).get("output")
            if sub is None
            else (submissions[sub].get("instance") if sub < len(submissions) else None)
        )
        if not xml:
            return None
        try:
            root = parse_xml(xml)
        except XmlNotWellFormed:
            return None
        namespace = etree.QName(root).namespace
        position = namespaces.get(namespace)
        if not position or not (built := installed(position)):
            return None
        form, module_type, doc, model, tag, targets = built
        if root.tag != tag or root.tag != f"{{{form.get('xmlns')}}}data":
            return None
        ids = Counter(c.get("case_id") for c in root.iter(CASE + "case"))
        return root, response.get("tree") or [], position, form, module_type, doc, model, targets, ids

    def read(d, run, step, sub, path, indices):
        if not (held := observation(run, step, sub)):
            return None
        root, tree, position, form, module_type, doc, model, targets, ids = held
        ns = f"{{{etree.QName(root).namespace}}}"
        found = []
        for repeat, action, update, case_type in _writers(form, module_type):
            field = update.get("question_path") or ""
            if update.get("update_mode") != "always" or not _xpath.plain_path(field):
                continue
            source = tuple(field.split("/")[1:])
            if any(n.startswith("@") for n in source) or source[: 1 + len(repeat)] != ("data", *repeat):
                continue
            helper = (*source[:-1], "nova_trimmed_" + source[-1])
            writer = ("data", *repeat, "case", action, "case_name")
            if path != (writer[1:] if d.path == UPDATE else helper[1:]) or any(i != 1 for i in indices[len(repeat) :]):
                continue
            # HQ's basic repeated subcase is a single repeat straight below the data root.
            if len(repeat) > 1 or (
                repeat and len([n for n in doc.iter(XF + "repeat") if n.get("nodeset") == "/data/" + repeat[0]]) != 1
            ):
                continue
            occurrence = root
            if repeat:
                children = children_named(root, ns + repeat[0]) or []
                if indices[0] > len(children):
                    continue
                occurrence = children[indices[0] - 1]
            case = _child(occurrence, CASE + "case")
            if case is None or not (identity := case.get("case_id")) or ids[identity] != 1:
                continue
            block = _child(case, CASE + action)
            written = _leaf(_child(block, CASE + "case_name"))
            if written is None or (
                action == "create" and (not case_type or _leaf(_child(block, CASE + "case_type")) != case_type)
            ):
                continue
            parent = occurrence
            for name in source[1 + len(repeat) : -1]:
                parent = _child(parent, ns + name)
            raw = _leaf(_child(parent, ns + source[-1]))
            if raw is None:
                continue
            hp, wp = "/" + "/".join(helper), "/" + "/".join(writer)
            writer_bind = _one(binds_at(model, wp))
            target = field if before else hp
            if (
                writer_bind is None
                or writer_bind.get("calculate") != target
                or (writer_bind.get("relevant") != (f"count({target}) > 0" if action == "update" else None))
                or wp in targets
                or hp in targets
            ):
                continue
            nodes = children_named(parent, ns + helper[-1])
            if nodes is None:
                continue
            binds = binds_at(model, hp)
            if sub is None and not written and raw:
                # The all-data opening includes a formerly filled, currently hidden control. Its case block
                # and the original Formplayer tree must independently confirm it supplies no value now.
                bind = _one(binds_at(model, field))
                if (
                    _drawn(tree, field)
                    or not any(n.get("ref") == field for n in doc.iter(XF + "input"))
                    or (bind is None or not bind.get("relevant"))
                ):
                    continue
            if before:
                if nodes or binds:
                    continue
                if written != raw and not (sub is None and not written):
                    continue
            else:
                bind = _one(binds)
                node = _one(nodes)
                if (
                    bind is None
                    or bind.get("calculate") != rf"replace({field}, '^[\x00-\x20]+|[\x00-\x20]+$', '')"
                    or (bind.get("relevant") != f"count({field}) > 0" or node is None or _leaf(node) != written)
                ):
                    continue
                if d.path != UPDATE:
                    try:
                        parsed = parse_xml(d.after) if isinstance(d.after, str) else None
                    except XmlNotWellFormed:
                        continue
                    if parsed is None or parsed.tag != node.tag or _leaf(parsed) != written:
                        continue
            # The raw source and the active case operation must have identical relevance on the two builds.
            # An empty case cell under a previously filled, gated input is a native observation of that gate.
            ancestors = {"/" + "/".join(p[:i]) for p in (source, writer[:-1]) for i in range(2, len(p) + 1)}
            conditions = []
            for ancestor in sorted(ancestors):
                matching = binds_at(model, ancestor)
                if len(matching) > 1:
                    break
                conditions.append((ancestor, matching[0].get("relevant") if matching else None))
            else:
                found.append((position, source, writer, identity, raw, tuple(conditions), written))
        return _one(found)

    return read
