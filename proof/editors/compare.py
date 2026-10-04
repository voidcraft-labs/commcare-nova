"""What HQ builds from an app, and what Core makes of a form, compared after parsing.

An editor save is judged by what it changes in HQ's build, not in HQ's
stored document: ``build`` runs HQ's own build (``proof.hq.operations.build``)
of the app HQ holds, and ``differences`` compares two builds file by file,
each file parsed first (an XML file by lxml into its canonical form, an app
strings file into its keys and values). A save bumps the app's version, which
HQ writes into the profile, the suite's resources and every form; ``build``
takes the version to build at, so a build after a save can be made at the
version of the build before it and differ only where content differs.

A build is compared as Core runs it (``core_trace``): Core admits HQ's
built files as its archive installer admits an app, then runs the scripted
sessions it derives from the build (every menu command, every reachable form
answered from the runner's fixed table) and returns the trace: each screen,
each form's questions and prompts, and each submission Core serializes. Two
builds whose forms Core parses and runs alike give equal traces. The case
data a trace runs over is a restore Core reads (``case_restore``: Core's own
template restore, one user, holding the cases a check names).

``profile_settings`` reads what a built profile sets: its properties and
features, each by its key, as HQ's profile template writes them.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE
from proof.hq import operations
from proof.hq.seams import build_seams

CASE_XMLNS = "http://commcarehq.org/case/transaction/v2"


def build(state, app_id, record, *, version=None, previous=None):
    """HQ's build of the app HQ holds, at ``version`` when given (the held app's otherwise)."""
    app = operations.held_app(state, app_id)
    if version is not None:
        app.version = version
    with build_seams(previous=previous):
        return operations.build(app, record)


def _canonical_xml(content):
    return etree.tostring(etree.fromstring(content), method="c14n2")


def _app_strings(content):
    strings = {}
    for line in content.decode("utf-8").splitlines():
        if line.strip():
            key, _, value = line.partition("=")
            strings[key] = value
    return strings


def _parsed(path, content):
    if isinstance(content, str):
        content = content.encode("utf-8")
    if path.endswith(".xml") or path.endswith(".ccpr"):
        return _canonical_xml(content)
    if path.endswith(".txt"):
        return _app_strings(content)
    raise ValueError(f"The harness has no parser for the built file {path}; teach proof/editors/compare.py one.")


def differences(before, after):
    """Every file two builds disagree on, after parsing, as (path, what differs)."""
    found = []
    for path in sorted(set(before) | set(after)):
        if path not in after:
            found.append((path, "missing after"))
        elif path not in before:
            found.append((path, "added after"))
        else:
            a, b = _parsed(path, before[path]), _parsed(path, after[path])
            if a != b:
                if isinstance(a, dict):
                    keys = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
                    found.append((path, f"app strings differ at {keys}"))
                else:
                    found.append((path, "XML differs"))
    return found


def file_diff(before, after, path, *, limit=200):
    """Where one built file differs between two builds, as unified diff lines of its parsed form."""
    import difflib

    def lines(content):
        parsed = _parsed(path, content)
        if isinstance(parsed, dict):
            return [f"{key}={value}" for key, value in sorted(parsed.items())]
        tree = etree.fromstring(parsed)
        etree.indent(tree)
        return etree.tostring(tree, encoding="unicode").splitlines()

    diff = difflib.unified_diff(lines(before[path]), lines(after[path]), "before", "after", lineterm="", n=2)
    return list(diff)[:limit]


def core_trace(core_runner, built, restore):
    """Core's scripted sessions over HQ's build, after Core admits it as an archive."""
    with tempfile.TemporaryDirectory(prefix="proof-editors-build-") as directory:
        for path, content in built.files.items():
            target = Path(directory, path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
        report = core_runner.admit(directory)
        if not report["admitted"]:
            raise AssertionError(f"Core did not admit HQ's build: {report['problems']}")
        try:
            return core_runner.session(report["app"], restore=restore)
        finally:
            if core_runner.holds(report["app"]):
                core_runner.release(report["app"])


def listed_cases(trace):
    """The ids of the cases a trace's case lists showed."""
    return {row["caseId"] for run in trace["runs"] for step in run["trace"] for row in step.get("rows", [])}


def first_difference(a, b, path="trace"):
    """Where two JSON values first differ, or None when they are equal."""
    if type(a) is not type(b):
        return path
    if isinstance(a, dict):
        for key in sorted(set(a) | set(b)):
            found = first_difference(a.get(key), b.get(key), f"{path}.{key}")
            if found:
                return found
        return None
    if isinstance(a, list):
        for index, (x, y) in enumerate(zip(a, b, strict=False)):
            found = first_difference(x, y, f"{path}[{index}]")
            if found:
                return found
        return None if len(a) == len(b) else f"{path} (length {len(a)} and {len(b)})"
    return None if a == b else path


def restore_user_id():
    """The id of the user Core's template restore signs in."""
    tree = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
    return tree.find(f"{{{CASE_XMLNS}}}case").get("user_id")


def case_restore(cases, fixtures=()):
    """Core's template restore with its user, holding ``cases`` in place of its own case.

    Each case is ``(case_id, case_type, name, properties)``; every case is
    owned by the restore's user, as the template's own case is. ``fixtures``
    are the XML of fixtures the restore carries for that user, as HQ's fixture
    providers write them.
    """
    tree = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
    template = tree.find(f"{{{CASE_XMLNS}}}case")
    owner = template.get("user_id")
    for existing in tree.findall(f"{{{CASE_XMLNS}}}case"):
        tree.remove(existing)

    def child(parent, name, text=None):
        element = etree.SubElement(parent, f"{{{CASE_XMLNS}}}{name}")
        element.text = text
        return element

    for case_id, case_type, name, properties in cases:
        case = etree.SubElement(
            tree,
            f"{{{CASE_XMLNS}}}case",
            case_id=case_id,
            date_modified=template.get("date_modified"),
            user_id=owner,
            nsmap={None: CASE_XMLNS},
        )
        create = child(case, "create")
        child(create, "case_type", case_type)
        child(create, "case_name", name)
        child(create, "owner_id", owner)
        update = child(case, "update")
        for key, value in properties.items():
            child(update, key, value)
    for fixture in fixtures:
        tree.append(etree.fromstring(fixture))
    return etree.tostring(tree, xml_declaration=True, encoding="utf-8")


def profile_settings(built_files, path="profile.xml"):
    """What a built profile sets: ``{"properties": {key: value}, "features": {name: active}}``."""
    root = etree.fromstring(_as_bytes(built_files[path]))
    properties = {element.get("key"): element.get("value") for element in root.findall("property")}
    features = {element.tag: element.get("active") for element in root.find("features")}
    return {"properties": properties, "features": features}


def _as_bytes(content):
    return content if isinstance(content, bytes) else content.encode("utf-8")
