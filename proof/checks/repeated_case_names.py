"""Place the checked name of a case created inside a named repeat in its original source question."""

from collections import Counter
from dataclasses import dataclass, replace
from functools import cache

from proof.checks import changes, served_places
from proof.checks.compare.trace import generated_labels
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.differences import pointer_token
from proof.checks.formplayer_case_names import (
    CASE,
    XF,
    bound_answer,
    calculation_at,
    children_named,
    leaves,
    setvalue_targets,
)
from proof.rules import _xpath

TRACE = "/runs/*/trace/*/submission/data/*/case[*]/create[*]/case_name[*]/text()"
BLOCK = "/runs/*/blocks/*/*~1case/*/create/case_name"
TRIMMED = ":trimmed"


def candidate(d):
    return (d.artifact.startswith("trace@") and d.path == TRACE) or (
        d.artifact.startswith("case_blocks@") and d.path == BLOCK
    )


@dataclass(frozen=True)
class Write:
    field: tuple
    repeat: str
    ordinal: int
    case_type: str
    raw: str
    name: str


def writes(submission, form_file, form, position, *, before, labels=None):
    """Each uniquely identified case create directly under its declared repeat, reading that occurrence's name."""
    if not form_file or not submission:
        return {}
    try:
        root, installed = parse_xml(submission), parse_xml(form_file)
    except XmlNotWellFormed:
        return {}
    model = installed.find(".//" + XF + "model")
    instance = model.find(XF + "instance") if model is not None else None
    namespace = form.get("xmlns")
    if (
        not namespace
        or root.tag != f"{{{namespace}}}data"
        or instance is None
        or len(instance) != 1
        or instance[0].tag != root.tag
    ):
        return {}
    targets = setvalue_targets(installed, model)
    if targets is None:
        return {}
    actions = {}
    for action in (form.get("actions") or {}).get("subcases") or []:
        path, kind = action.get("repeat_context"), action.get("case_type")
        if path and kind:
            key = (path, kind)
            actions[key] = None if key in actions else (action.get("name_update") or {}).get("question_path")
    repeats = Counter(node.get("nodeset") for node in installed.iter(XF + "repeat"))
    labels = labels or {}
    identities = Counter(labels.get(c.get("case_id"), c.get("case_id")) for c in root.iter(CASE + "case"))
    found = {}
    for (path, kind), field in actions.items():
        # The compared structural classes are for one authored instance node between data and the case block.
        if (
            not field
            or not _xpath.plain_path(path)
            or not path.startswith("/data/")
            or path.count("/") != 2
            or repeats[path] != 1
        ):
            continue
        repeat = path.split("/")[-1]
        case_path = ("data", repeat, "case", "create", "case_name")
        target = "/" + "/".join(case_path)
        if target in targets or (not before and calculation_at(model, target) in targets):
            continue
        for ordinal, occurrence in enumerate(children_named(root, f"{{{namespace}}}{repeat}") or [], 1):
            cases = children_named(occurrence, CASE + "case") or []
            if len(cases) != 1:
                continue
            case = cases[0]
            case_id = labels.get(case.get("case_id"), case.get("case_id"))
            creates = children_named(case, CASE + "create") or []
            if not case_id or identities[case_id] != 1 or len(creates) != 1:
                continue
            names, types = (
                children_named(creates[0], CASE + "case_name") or [],
                children_named(creates[0], CASE + "case_type") or [],
            )
            if len(types) != 1 or types[0].text != kind or len(names) != 1 or len(names[0]) or not names[0].text:
                continue
            name = names[0].text
            answer = bound_answer(model, case_path, leaves(occurrence, ("data",)), name, before=before)
            if answer and "/" + "/".join(answer[0]) == field:
                found[case_id] = Write(("form", position, "xform", *answer[0]), repeat, ordinal, kind, answer[1], name)
    return found


def _processed_names(applied, labels):
    """The unique block HQ processed for each id, with its original path, type and written name."""
    found = {}
    if not applied or applied.get("submitted") is not True or applied.get("refusal"):
        return found
    blocks, paths = applied.get("blocks") or [], applied.get("blockPaths") or []
    if len(blocks) != len(paths):
        return found
    for block, path in zip(blocks, paths, strict=True):
        key = labels.get(block.get("@case_id"), block.get("@case_id"))
        create = block.get("create") or {}
        if key in found or block.get("@xmlns") != CASE[1:-1]:
            found[key] = None
        else:
            found[key] = (path, create.get("case_type"), create.get("case_name"))
    return found


def _at(run, applied, files, namespaces, source, labels, before):
    """Concrete pointers to eligible writes in Core's submitted form and the blocks HQ actually processed."""
    commands = [changes.command_place(s.get("command")) for s in run.get("script") or () if "command" in s]
    submissions = [(n, s) for n, s in enumerate(run.get("trace") or ()) if s.get("submission")]
    if run.get("end") != "submitted" or len(submissions) != 1 or not commands:
        return {}
    index, step = submissions[0]
    position = namespaces.get(step.get("xmlns"))
    if not position or commands[-1] != ("form", position) or step.get("screen") != "form":
        return {}
    module, form = map(int, position.split("."))
    modules = source.get("modules") or []
    if module >= len(modules) or form >= len(modules[module].get("forms") or []):
        return {}
    held = writes(
        step["submission"],
        files.get(f"modules-{module}/forms-{form}.xml"),
        modules[module]["forms"][form],
        position,
        before=before,
        labels=labels,
    )
    processed = _processed_names(applied, labels)
    found = {}
    for key, write in held.items():
        name = write.repeat
        path = f"/trace/{index}/submission/data/{name}[{write.ordinal}]/case[1]/create[1]/case_name[1]/text()"
        found[("trace", path)] = (key, write)
        if processed.get(key) == ([name], write.case_type, write.name):
            found[("case_blocks", f"/blocks/{pointer_token(key)}/{name}~1case/0/create/case_name")] = (key, write)
    return found


def classify(rows, *, records, configuration, observed, local_files, source):
    """Use only the two builds, runs, case IDs and repeat occurrences that actually produced each difference."""
    sessions = (records.configurations[configuration].b_aligned or {}).get("sessions") or {}
    files = {
        "baseline": observed.a.build.files if observed.a else {},
        "b": observed.b_aligned.files if observed.b_aligned else {},
        "local": local_files,
    }
    get = cache(records.blobs.get_json)

    @cache
    def namespaces(side):
        return served_places.form_namespaces(files[side] or {})

    @cache
    def paired(side, index):
        raw = []
        for who in ("baseline", side):
            record = sessions.get(who) or {}
            if not files[who] or not record.get("trace"):
                return {}, {}
            runs = get(record["trace"]).get("runs") or []
            processed = get(record["processed"]).get("runs") if record.get("processed") else []
            if index >= len(runs):
                return {}, {}
            raw.append((runs[index], processed[index] if index < len(processed) else None))
        labels = generated_labels(*({"runs": [run]} for run, _ in raw))[0]
        return tuple(
            _at(run, processed, files[who], namespaces(who), source, ids, before=who == "baseline")
            for who, (run, processed), ids in zip(("baseline", side), raw, labels, strict=True)
        )

    locations = {}
    results = []
    for d in rows:
        if candidate(d) and d.kind == "changed" and changes.trimmed_case_name(d.before, d.after):
            prefix, _, where = d.at.removeprefix("/runs/").partition("/")
            reader, side = d.artifact.split("@")
            key = (reader, "/" + where)
            if prefix.isdigit() and side in ("B", "local.ccz"):
                old, new = paired("b" if side == "B" else "local", int(prefix))
                left, right = old.get(key), new.get(key)
                if left and right:
                    old_id, a = left
                    new_id, b = right
                    if (
                        old_id == new_id
                        and a.name == a.raw == d.before
                        and b.name == d.after
                        and replace(a, name=b.name) == b
                    ):
                        d = replace(d, path=d.path + TRIMMED)
                        locations[(d.artifact, d.at)] = b.field
        results.append(d)
    return results, changes.Sites(served=locations)
