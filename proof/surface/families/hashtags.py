"""The hashtags HQ's editors and build read and write in an app's expressions.

Keys:

- ``hashtag:<hashtag>``: each hashtag HQ defines (``hashtag:#form/``,
  ``hashtag:#case/``, ``hashtag:#case/parent``, ``hashtag:#user``,
  ``hashtag:#session/``), read from where HQ defines it:

  - ``xform.py::hashtag_replacements`` (loaded after the boot): the hashtag and
    the path pattern it replaces when HQ gives Vellum a question's path;
  - ``xpath.py::interpolate_xpath`` (its syntax tree): each shortcut its
    ``replacements`` table holds, with the expression it is replaced by and the
    conditions it is added under, and the shortcuts
    ``_ensure_no_case_references`` refuses where no case is in scope;
  - ``app_schemas/casedb_schema.py`` and ``app_schemas/session_schema.py`` (their
    syntax trees): every hashtag a data source schema HQ gives Vellum carries,
    a literal or the literal start of an f-string under a ``"hashtag"`` key, a
    ``hashtag=`` argument, or a ``hashtag`` parameter's default, with the
    related-case hashtags ``_get_case_schema_subsets`` composes from its literal
    ``generation_names``.

  - ``util.py``'s ``CASE_XPATH_SUBSTRING_MATCHES`` and
    ``USERCASE_XPATH_SUBSTRING_MATCHES`` (their syntax trees): each hashtag
    literal the lists hold, which HQ looks for as a substring of an expression
    to decide it reads a case (after removing the usercase ones) or the
    usercase. ``substringOf`` records the list, every function of HQ's
    ``corehq`` (outside tests) whose syntax tree names it, the page context key
    a function hands it to a page under (``form_filter_patterns.case_substring``,
    read by the form settings page), and the functions that call each reader
    (``suite_xml/sections/menus.py``'s and ``helpers/validators.py``'s case
    checks call ``xpath_references_case``).

  Each records where it is defined and how (``replaces``, ``replacedBy``,
  ``refusedWithoutCase``, ``schema``, ``composedAs``, ``substringOf``).
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

from proof.surface import pyast
from proof.surface.families.data import _pattern, name
from proof.surface.model import Item, Sources, SurfaceError, item

INTERPOLATE = ("corehq/apps/app_manager/xpath.py", "interpolate_xpath")
CASE_GUARD = ("corehq/apps/app_manager/xpath.py", "_ensure_no_case_references")
SCHEMAS = (
    "corehq/apps/app_manager/app_schemas/casedb_schema.py",
    "corehq/apps/app_manager/app_schemas/session_schema.py",
)
SUBSTRING_LISTS = (
    "corehq/apps/app_manager/util.py",
    ("CASE_XPATH_SUBSTRING_MATCHES", "USERCASE_XPATH_SUBSTRING_MATCHES"),
)
# Where the substring lists' readers are looked for: HQ's own code, outside its tests.
READERS = "corehq"


def extract(sources: Sources) -> list[Item]:
    found: dict[str, dict] = {}

    def add(hashtag: str, where: str, fact: str, value) -> None:
        entry = found.setdefault(hashtag, {"source": set()})
        entry["source"].add(where)
        entry.setdefault(fact, [])
        if value not in entry[fact]:
            entry[fact].append(value)

    from corehq.apps.app_manager import xform

    where = f"{sources.relative(inspect.getsourcefile(xform))}::hashtag_replacements"
    for replacement in xform.hashtag_replacements:
        add(replacement.hashtag, where, "replaces", replacement.replaces)

    for hashtag, facts in interpolations(sources, sources.hq / INTERPOLATE[0]).items():
        for fact in facts:
            add(hashtag, fact.pop("at"), "replacedBy", fact)
    for hashtag, where in case_guards(sources, sources.hq / CASE_GUARD[0]):
        add(hashtag, where, "refusedWithoutCase", True)
    for relative in SCHEMAS:
        for hashtag, where, fact in schema_hashtags(sources, sources.hq / relative):
            add(hashtag, where, fact[0], fact[1])
    for hashtag, where, read in substring_lists(sources, sources.hq / SUBSTRING_LISTS[0]):
        add(hashtag, where, "substringOf", read)
        entry = found[hashtag]
        entry["source"].update(reader["at"] for reader in read["readBy"])
    if not found:
        raise SurfaceError("The surface extractor found no hashtag HQ defines.")
    return [
        item(f"hashtag:{name(hashtag)}", sorted(facts.pop("source")), **facts)
        for hashtag, facts in sorted(found.items())
    ]


def interpolations(sources: Sources, path: Path) -> dict[str, list[dict]]:
    """Each key of `interpolate_xpath`'s `replacements` table: its dict literal's and each later
    `replacements[k] = v`'s."""
    function = pyast.find_in(path, INTERPOLATE[1])
    where = f"{sources.relative(path)}::{INTERPOLATE[1]}"
    out: dict[str, list[dict]] = {}

    def wanted(statement):
        return isinstance(statement, ast.Assign) and any(
            (isinstance(t, ast.Name) and t.id == "replacements")
            or (isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == "replacements")
            for t in statement.targets
        )

    for statement, conditions in pyast.guarded(function.body, wanted):
        for target in statement.targets:
            if isinstance(target, ast.Name) and isinstance(statement.value, ast.Dict):
                for key, value in zip(statement.value.keys, statement.value.values, strict=True):
                    text = pyast.string(key)
                    if text is not None:
                        out.setdefault(text, []).append({"at": where, "as": ast.unparse(value), "when": conditions})
            elif isinstance(target, ast.Subscript):
                text = pyast.string(target.slice)
                if text is not None:
                    out.setdefault(text, []).append(
                        {"at": where, "as": ast.unparse(statement.value), "when": conditions}
                    )
    if not out:
        raise SurfaceError(f"The surface extractor found no replacements table in {where}.")
    return out


def case_guards(sources: Sources, path: Path) -> list[tuple[str, str]]:
    """The shortcuts `_ensure_no_case_references` refuses: each literal it tests `in string`."""
    function = pyast.find_in(path, CASE_GUARD[1])
    where = f"{sources.relative(path)}::{CASE_GUARD[1]}"
    found = []
    for node in ast.walk(function):
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.In):
            text = pyast.string(node.left)
            if text is not None:
                found.append((text, where))
    return found


def schema_hashtags(sources: Sources, path: Path) -> list[tuple[str, str, tuple[str, object]]]:
    """The hashtags a schema module's functions give Vellum."""
    tree = pyast.parse(path)
    relative = sources.relative(path)
    found = []
    for qualname, function in pyast.walk_functions(tree):
        where = f"{relative}::{qualname}"
        parameters = function.args.args
        defaults = function.args.defaults
        for parameter, default in zip(parameters[len(parameters) - len(defaults) :], defaults, strict=True):
            text = pyast.string(default)
            if parameter.arg == "hashtag" and text is not None:
                found.append((text, where, ("schema", "default of the hashtag parameter")))
                found += _composed(function, text, where)
        for node in ast.walk(function):
            if isinstance(node, ast.Call):
                for keyword in node.keywords:
                    text = pyast.string(keyword.value)
                    if keyword.arg == "hashtag" and text is not None:
                        callee = pyast.dotted(node.func) or ast.unparse(node.func)
                        found.append((text, where, ("schema", f"passed to {callee}")))
                        target = _function(tree, callee)
                        if target is not None:
                            found += _composed(target, text, where)
            elif isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values, strict=True):
                    if key is None or pyast.string(key) != "hashtag":
                        continue
                    # A conditional value gives a hashtag in each branch.
                    for one in (value.body, value.orelse) if isinstance(value, ast.IfExp) else (value,):
                        text = pyast.string(one)
                        if text is not None:
                            found.append((text, where, ("schema", "literal")))
                        elif isinstance(one, ast.JoinedStr):
                            start = one.values[0] if one.values else None
                            if isinstance(start, ast.Constant) and isinstance(start.value, str):
                                found.append((start.value, where, ("schema", f"f-string {_pattern(one)}")))
    return found


def substring_lists(sources: Sources, path: Path) -> list[tuple[str, str, dict]]:
    """Each hashtag literal ``util.py``'s substring lists hold, with the list's readers."""
    tree = pyast.parse(path)
    relative = sources.relative(path)
    names = SUBSTRING_LISTS[1]
    held: dict[str, list[str]] = {}
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and isinstance(statement.value, (ast.List, ast.Tuple)):
            for target in statement.targets:
                if isinstance(target, ast.Name) and target.id in names:
                    held[target.id] = [
                        text for text in map(pyast.string, statement.value.elts) if text and text.startswith("#")
                    ]
    if set(held) != set(names):
        raise SurfaceError(
            f"The surface extractor found no list bound to {', '.join(sorted(set(names) - set(held)))} in {path}."
        )
    readers = _readers(sources, names)
    found = []
    for list_name, hashtags in sorted(held.items()):
        read = {"list": list_name, "readBy": readers.get(list_name, [])}
        for hashtag in hashtags:
            found.append((hashtag, f"{relative}::{list_name}", read))
    return found


def _readers(sources: Sources, names: tuple[str, ...]) -> dict[str, list[dict]]:
    """Every function under ``READERS`` (outside tests) whose syntax tree names one of ``names``, with the
    page context keys it puts the name under and the functions calling it. A file is parsed only when its text
    holds the name, which every reference to it does."""
    out: dict[str, list[dict]] = {}
    for module, tree in _modules_naming(sources, names):
        relative = sources.relative(module)
        for qualname, function in pyast.walk_functions(tree):
            for list_name in names:
                if not any(_names(node, list_name) for node in ast.walk(function)):
                    continue
                reader = {"at": f"{relative}::{qualname}"}
                dicts = [node for node in ast.walk(function) if isinstance(node, ast.Dict)]
                nested = {id(value) for node in dicts for value in node.values if isinstance(value, ast.Dict)}
                keys = sorted(path for node in dicts if id(node) not in nested for path in _dict_keys(node, list_name))
                if keys:
                    reader["pageContext"] = keys
                if "." not in qualname:
                    callers = sorted(
                        f"{sources.relative(caller_module)}::{caller}"
                        for caller_module, caller_tree in _modules_naming(sources, (qualname,))
                        for caller, body in pyast.walk_functions(caller_tree)
                        if caller != qualname
                        and any(isinstance(node, ast.Call) and _names(node.func, qualname) for node in ast.walk(body))
                    )
                    if callers:
                        reader["calledBy"] = callers
                out.setdefault(list_name, []).append(reader)
    return {list_name: sorted(readers, key=lambda reader: reader["at"]) for list_name, readers in out.items()}


def _modules_naming(sources: Sources, names: tuple[str, ...]):
    for module in sorted((sources.hq / READERS).rglob("*.py")):
        if "tests" in module.parts:
            continue
        text = module.read_text(encoding="utf-8")
        if any(name in text for name in names):
            yield module, pyast.parse(module)


def _names(node: ast.AST, name: str) -> bool:
    return (isinstance(node, ast.Name) and node.id == name) or (isinstance(node, ast.Attribute) and node.attr == name)


def _dict_keys(node: ast.Dict, name: str, prefix: str = "") -> list[str]:
    """The keys, dotted through nested dict literals, under which ``node`` holds ``name``."""
    found = []
    for key, value in zip(node.keys, node.values, strict=True):
        text = pyast.string(key) if key is not None else None
        if text is None:
            continue
        if _names(value, name):
            found.append(prefix + text)
        elif isinstance(value, ast.Dict):
            found.extend(_dict_keys(value, name, f"{prefix}{text}."))
    return found


def _function(tree: ast.Module, dotted: str) -> ast.FunctionDef | None:
    for qualname, function in pyast.walk_functions(tree):
        if qualname == dotted:
            return function
    return None


def _composed(function: ast.FunctionDef, base: str, where: str) -> list[tuple[str, str, tuple[str, object]]]:
    """The related-case hashtags a schema function composes as `hashtag + <literal list>[i + 1]`."""
    lists: dict[str, list[str]] = {}
    for node in ast.walk(function):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.List):
            values = [pyast.string(element) for element in node.value.elts]
            if values and None not in values:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        lists[target.id] = values
    found = []
    for node in ast.walk(function):
        if not (isinstance(node, ast.Dict)):
            continue
        for key, value in zip(node.keys, node.values, strict=True):
            if key is None or pyast.string(key) != "hashtag":
                continue
            if (
                isinstance(value, ast.BinOp)
                and isinstance(value.op, ast.Add)
                and isinstance(value.left, ast.Name)
                and value.left.id == "hashtag"
                and isinstance(value.right, ast.Subscript)
                and isinstance(value.right.value, ast.Name)
                and value.right.value.id in lists
            ):
                for generation in lists[value.right.value.id][1:]:
                    found.append((base + generation, where, ("composedAs", ast.unparse(value))))
    return found
