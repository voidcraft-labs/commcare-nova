"""Where HQ gates app content on the app's CommCare version.

Keys:

- ``version-gate:<property>``: each public property of
  ``app_manager/feature_support.py::CommCareFeatureSupportMixin``
  (``version-gate:support_document_upload``), with the minimum versions its
  ``_require_minimum_version`` calls name (sorted as ``LooseVersion`` sorts
  them, never as numbers), the toggles it also requires, the other ``self.``
  properties it reads, and its return expression as the syntax tree prints it.
- ``version-gate:<path>::<qualname>``: each function elsewhere in
  ``corehq/apps/app_manager`` (tests and migrations aside) that compares a
  ``build_version`` directly, with each comparison as printed, the versions it
  names (the literal a ``LooseVersion(...)`` it compares with is given, as the
  file's imports resolve the name, or a string it compares with directly), and
  the expressions it compares with that are not literal versions
  (``yaml_setting.get('since', '0')``).
- ``version-gate:<template path>``: each app-manager template holding elements
  with ``data-since-version``, read with Python's HTML parser, with each
  element's tag, id and version in document order.
- ``version-gate:<script path>``: each app-manager script that reads those
  attributes or a setting's ``since`` (``app_manager.js`` and
  ``commcare_settings.js``, both Bootstrap flavours), with the setting fields
  or attributes it reads, read by the JavaScript helper's syntax tree.
"""

from __future__ import annotations

import ast
from html.parser import HTMLParser
from pathlib import Path

from proof.surface import pyast
from proof.surface.model import Item, Sources, SurfaceError, item
from proof.surface.node import run_node

FEATURE_SUPPORT = "corehq/apps/app_manager/feature_support.py"
APP_MANAGER = "corehq/apps/app_manager"
TEMPLATES = "corehq/apps/app_manager/templates"
SCRIPTS = (
    "corehq/apps/app_manager/static/app_manager/js/bootstrap3/app_manager.js",
    "corehq/apps/app_manager/static/app_manager/js/bootstrap5/app_manager.js",
    "corehq/apps/app_manager/static/app_manager/js/settings/bootstrap3/commcare_settings.js",
    "corehq/apps/app_manager/static/app_manager/js/settings/bootstrap5/commcare_settings.js",
)


def _loose(version: str):
    from looseversion import LooseVersion

    return LooseVersion(version)


def extract(sources: Sources) -> list[Item]:
    return [
        *feature_support(sources, sources.hq / FEATURE_SUPPORT),
        *direct_comparisons(sources, sources.hq / APP_MANAGER),
        *template_gates(sources, sources.hq / TEMPLATES),
        *script_gates(sources, [sources.hq / script for script in SCRIPTS]),
    ]


def feature_support(sources: Sources, path: Path) -> list[Item]:
    mixin = pyast.find_in(path, "CommCareFeatureSupportMixin")
    relative = sources.relative(path)
    items = []
    for function in mixin.body:
        if not isinstance(function, ast.FunctionDef) or function.name.startswith("_"):
            continue
        minimums = []
        toggles = set()
        reads = set()
        for node in ast.walk(function):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr == "_require_minimum_version":
                    version = pyast.string(node.args[0]) if node.args else None
                    if version is None:
                        raise SurfaceError(
                            f"{FEATURE_SUPPORT}::{function.name} passes {ast.unparse(node)}, whose version is not a "
                            "string literal, so its minimum cannot be read."
                        )
                    minimums.append(version)
                elif node.func.attr == "enabled":
                    chain = pyast.dotted(node.func.value)
                    if chain and chain.startswith("toggles."):
                        toggles.add(chain.split(".", 1)[1])
            elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "self":
                if node.attr not in ("_require_minimum_version", "domain"):
                    reads.add(node.attr)
        returns = [
            ast.unparse(node.value) for node in ast.walk(function) if isinstance(node, ast.Return) and node.value
        ]
        items.append(
            item(
                f"version-gate:{function.name}",
                f"{relative}::CommCareFeatureSupportMixin.{function.name}",
                minimum=sorted(set(minimums), key=_loose),
                toggles=sorted(toggles),
                reads=sorted(reads),
                returns=returns,
            )
        )
    return items


# The classes HQ compares versions with, as a file's imports name them.
VERSION_CLASSES = ("looseversion.LooseVersion",)


def direct_comparisons(sources: Sources, root: Path) -> list[Item]:
    found: dict[str, dict] = {}
    for path in sorted(root.rglob("*.py")):
        parts = path.relative_to(root).parts
        if "tests" in parts or "migrations" in parts or path.name == "feature_support.py":
            continue
        relative = sources.relative(path)
        tree = pyast.parse(path)
        imported = pyast.imported_names(tree)
        for node, scope in pyast.enclosing(tree):
            if not isinstance(node, ast.Compare):
                continue
            sides = [node.left, *node.comparators]
            if not any(_mentions_build_version(side) for side in sides):
                continue
            entry = found.setdefault(
                f"{relative}::{scope or '<module>'}", {"comparisons": [], "versions": set(), "expressions": []}
            )
            text = ast.unparse(node)
            if text not in entry["comparisons"]:
                entry["comparisons"].append(text)
            for side in sides:
                if _mentions_build_version(side):
                    continue
                version, expression = _compared_version(side, imported)
                if version is not None:
                    entry["versions"].add(version)
                elif expression not in entry["expressions"]:
                    entry["expressions"].append(expression)
    return [
        item(
            f"version-gate:{where.split('/', 1)[1]}",
            where,
            comparisons=entry["comparisons"],
            versions=sorted(entry["versions"], key=_loose),
            versionExpressions=entry["expressions"],
        )
        for where, entry in sorted(found.items())
    ]


def _mentions_build_version(node: ast.AST) -> bool:
    return any(isinstance(part, ast.Attribute) and part.attr == "build_version" for part in ast.walk(node))


def _compared_version(side: ast.AST, imported: dict[str, str]) -> tuple[str | None, str]:
    """The literal version a comparison's other side holds, else the expression it compares with."""
    literal = pyast.string(side)
    if literal is not None:
        return literal, ast.unparse(side)
    if isinstance(side, ast.Call) and len(side.args) == 1 and not side.keywords:
        callee = pyast.dotted(side.func)
        head, _, rest = (callee or "").partition(".")
        resolved = imported.get(head, head) + (f".{rest}" if rest else "")
        if resolved in VERSION_CLASSES:
            literal = pyast.string(side.args[0])
            if literal is not None:
                return literal, ast.unparse(side)
            return None, ast.unparse(side.args[0])
    return None, ast.unparse(side)


class _SinceVersions(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.elements = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if "data-since-version" in values:
            self.elements.append({"tag": tag, "id": values.get("id"), "since": values["data-since-version"]})

    handle_startendtag = handle_starttag


def template_gates(sources: Sources, root: Path) -> list[Item]:
    items = []
    for path in sorted(root.rglob("*.html")):
        parser = _SinceVersions()
        parser.feed(path.read_text(encoding="utf-8"))
        parser.close()
        if parser.elements:
            relative = sources.relative(path)
            items.append(item(f"version-gate:{relative.split('/', 1)[1]}", relative, elements=parser.elements))
    return items


def script_gates(sources: Sources, scripts: list[Path]) -> list[Item]:
    read = run_node("version-gates", [str(script) for script in scripts])
    items = []
    for script in scripts:
        relative = sources.relative(script)
        facts = read[str(script)]
        if not facts["readers"]:
            raise SurfaceError(
                f"The surface extractor found no reader of `data-since-version` or a setting's `since` in {relative}. "
                "HQ moved its version gate; the version-gate family must follow it."
            )
        items.append(item(f"version-gate:{relative.split('/', 1)[1]}", relative, readers=facts["readers"]))
    return items
