"""What a case search request carries: the request keys HQ's search reads, and the prompt inputs
and appearances each runtime acts on.

Keys:

- ``csql-key:<key>``: each request key HQ's case search treats as something
  other than a case property to match, read from HQ's loaded constants
  (``case_search/models.py``: ``CONFIG_KEYS_MAPPING``, ``CASE_SEARCH_TAGS_MAPPING``,
  ``UNSEARCHABLE_KEYS``, ``CASE_SEARCH_XPATH_QUERY_KEY``,
  ``CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY``, ``CASE_SEARCH_INDEX_KEY_PREFIX``;
  ``case_search/const.py::COMMCARE_PROJECT``) and from the branches of
  ``utils.py::CaseSearchQueryBuilder._apply_filter`` (each key it compares a
  criterion's key with, in order, with the filter the branch applies). Each
  item records its roles (``configuration`` with the request configuration
  field it fills, ``tag``, ``unsearchable``, ``filter``), and the index key
  prefix is ``csql-key:indices.*``.
- ``prompt-input:<value>`` and ``prompt-appearance:<value>``: each value of a
  search prompt's ``input`` or ``appearance`` a runtime compares or lists as
  supported (Core and its command line, read by the Java helper; Android in
  Java and Kotlin; Web Apps' ``query.js`` and its query templates, read by
  ``js/prompts.mjs``), and each value HQ stores for it from its editor
  (``views/modules.py::_update_search_properties``) or writes into the suite
  (``suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_query_prompts``),
  with the conditions it does so under.
"""

from __future__ import annotations

import ast
import inspect
import json
import os
from pathlib import Path

from proof.surface import pyast
from proof.surface.families.data import name
from proof.surface.families.runtime import _without_template_tags
from proof.surface.java import run_java
from proof.surface.model import Item, Sources, SurfaceError, item
from proof.surface.node import run_node

# The HQ checkout whose node_modules hold the Underscore HQ's build ships (the image keeps it for HQ's own use).
HQ_NODE = Path(os.environ.get("PROOF_HQ", "/opt/hq"))
QUERY_SCRIPT = "corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views/query.js"
QUERY_TEMPLATES = "corehq/apps/cloudcare/templates/cloudcare/partials/query"
EDITOR = ("corehq/apps/app_manager/views/modules.py", "_update_search_properties", "ret", {"input_", "appearance"})
BUILD = (
    "corehq/apps/app_manager/suite_xml/post_process/remote_requests.py",
    "RemoteRequestFactory.build_query_prompts",
    "kwargs",
    {"input_", "appearance"},
)


def extract(sources: Sources) -> list[Item]:
    return [*request_keys(sources), *prompts(sources)]


def request_keys(sources: Sources) -> list[Item]:
    from corehq.apps.case_search import const, models, utils

    models_path = sources.relative(inspect.getsourcefile(models))
    keys: dict[str, dict] = {}

    def role(key: str, where: str, **facts) -> None:
        entry = keys.setdefault(key, {"source": set(), "roles": set()})
        entry["source"].add(where)
        entry["roles"].add(facts.pop("role"))
        for fact, value in facts.items():
            entry[fact] = value

    for key, config in models.CONFIG_KEYS_MAPPING.items():
        role(key, f"{models_path}::CONFIG_KEYS_MAPPING", role="configuration", configField=config)
    for key, tag in models.CASE_SEARCH_TAGS_MAPPING.items():
        role(key, f"{models_path}::CASE_SEARCH_TAGS_MAPPING", role="tag", tag=tag)
    for key in models.UNSEARCHABLE_KEYS:
        role(key, f"{models_path}::UNSEARCHABLE_KEYS", role="unsearchable")
    role(models.CASE_SEARCH_XPATH_QUERY_KEY, f"{models_path}::CASE_SEARCH_XPATH_QUERY_KEY", role="xpath-query")
    role(
        models.CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY,
        f"{models_path}::CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY",
        role="blacklisted-owner-ids",
    )
    role(
        f"{models.CASE_SEARCH_INDEX_KEY_PREFIX}*",
        f"{models_path}::CASE_SEARCH_INDEX_KEY_PREFIX",
        role="index-prefix",
        prefix=models.CASE_SEARCH_INDEX_KEY_PREFIX,
    )
    role(const.COMMCARE_PROJECT, f"{sources.relative(inspect.getsourcefile(const))}::COMMCARE_PROJECT", role="project")

    # The keys `_apply_filter` handles itself, in the order it tests them.
    builder = utils.CaseSearchQueryBuilder._apply_filter
    path = pyast.in_checkout(sources.hq, inspect.getsourcefile(builder))
    function = pyast.find_function(path, builder.__qualname__)
    where = f"{sources.relative(path)}::{builder.__qualname__}"
    order = 0
    for branch in _chain(function):
        test = branch.test
        if not (
            isinstance(test, ast.Compare)
            and len(test.ops) == 1
            and isinstance(test.ops[0], ast.Eq)
            and pyast.dotted(test.left) == "criteria.key"
        ):
            continue
        order += 1
        compared = test.comparators[0]
        key = pyast.string(compared)
        if key is None and isinstance(compared, ast.Name):
            key = builder.__globals__.get(compared.id)
        if not isinstance(key, str):
            raise SurfaceError(
                f"{where} compares a criterion's key with {ast.unparse(compared)}, which is not a constant."
            )
        applied = []
        for statement in branch.body:
            applied += [call for call in pyast.calls(statement) if call not in applied]
        role(key, where, role="filter", filterOrder=order, filterCalls=applied)
    if not keys:
        raise SurfaceError("The surface extractor found no case search request keys.")
    return [
        item(f"csql-key:{name(key)}", sorted(facts.pop("source")), roles=sorted(facts.pop("roles")), **facts)
        for key, facts in sorted(keys.items())
    ]


def _chain(function: ast.FunctionDef) -> list[ast.If]:
    """The `if` / `elif` branches of the first `if` chain in a function's body."""
    for statement in function.body:
        if isinstance(statement, ast.If):
            chain = []
            current = statement
            while isinstance(current, ast.If):
                chain.append(current)
                current = current.orelse[0] if len(current.orelse) == 1 else None
            return chain
    return []


def prompts(sources: Sources, core: Path | None = None, android: Path | None = None) -> list[Item]:
    reads = list(run_java(sources, "wide", core, android)["prompts"])
    reads += web_apps(sources, sources.hq / QUERY_SCRIPT, sources.hq / QUERY_TEMPLATES)
    for relative, qualname, holder, fields in (EDITOR, BUILD):
        reads += hq_writes(sources, sources.hq / relative, qualname, holder, fields)
    found: dict[str, list[dict]] = {}
    for read in reads:
        family = "prompt-input" if read["property"] in ("input", "input_") else "prompt-appearance"
        entry = {key: read[key] for key in ("reader", "how", "at", "when") if key in read}
        found.setdefault(f"{family}:{name(read['value'])}", []).append(entry)
    return [
        item(
            key,
            sorted({one["at"] for one in entries}),
            reads=sorted(entries, key=lambda one: json.dumps(one, sort_keys=True)),
        )
        for key, entries in sorted(found.items())
    ]


def web_apps(sources: Sources, script: Path, templates: Path) -> list[dict]:
    from html.parser import HTMLParser

    class Scripts(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.bodies: list[str] = []
            self._inside = False

        def handle_starttag(self, tag, attrs):
            self._inside = tag == "script" and dict(attrs).get("type") == "text/template"
            if self._inside:
                self.bodies.append("")

        def handle_data(self, data):
            if self._inside:
                self.bodies[-1] += data

        def handle_endtag(self, tag):
            if tag == "script":
                self._inside = False

    bodies = []
    for template in sorted(templates.glob("*.html")):
        parser = Scripts()
        parser.feed(_without_template_tags(template.read_text(encoding="utf-8")))
        parser.close()
        bodies += [{"file": sources.relative(template), "text": body} for body in parser.bodies]
    read = run_node(
        str(HQ_NODE),
        [],
        script="prompts.mjs",
        stdin={"root": str(sources.hq), "scripts": [str(script)], "templates": bodies},
    )
    return [{**entry, "reader": "web-apps"} for entry in read["reads"]]


def hq_writes(sources: Sources, path: Path, qualname: str, holder: str, fields: set[str]) -> list[dict]:
    """Each value HQ assigns to ``holder['input_']`` or ``holder['appearance']`` in a function: a literal, or
    the value an enclosing test compares the assigned expression with (``== 'address'``, ``in ('date', ...)``)."""
    function = pyast.find_in(path, qualname)
    where = f"{sources.relative(path)}::{qualname}"
    out = []

    def visit(statements: list[ast.stmt], tests: list[ast.expr]) -> None:
        for statement in statements:
            if isinstance(statement, ast.If):
                visit(statement.body, [*tests, statement.test])
                visit(statement.orelse, [*tests, ast.UnaryOp(op=ast.Not(), operand=statement.test)])
            elif isinstance(statement, (ast.For, ast.While, ast.With, ast.Try)):
                visit(getattr(statement, "body", []), tests)
            elif isinstance(statement, ast.Assign):
                for target in statement.targets:
                    if (
                        isinstance(target, ast.Subscript)
                        and isinstance(target.value, ast.Name)
                        and target.value.id == holder
                        and pyast.string(target.slice) in fields
                    ):
                        field = pyast.string(target.slice)
                        for value in _assigned_values(statement.value, tests):
                            out.append(
                                {
                                    "property": field,
                                    "value": value,
                                    "reader": "hq",
                                    "how": f"writes {field}",
                                    "at": where,
                                    "when": [ast.unparse(test) for test in tests],
                                }
                            )

    visit(function.body, [])
    if not out:
        raise SurfaceError(f"The surface extractor found no prompt input or appearance written in {where}.")
    return out


def _assigned_values(value: ast.expr, tests: list[ast.expr]) -> list[str]:
    literal = pyast.string(value)
    if literal is not None:
        return [literal]
    assigned = ast.unparse(value)
    found = []
    # Only a test that holds where the value is assigned names its values; an `else`'s negated test does not.
    for test in (test for test in tests if not (isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not))):
        for node in ast.walk(test):
            if not isinstance(node, ast.Compare) or len(node.ops) != 1:
                continue
            left = ast.unparse(node.left)
            # `prop['appearance']` compared through `prop.get('appearance', '')` is the same field.
            if left != assigned and not _same_field(node.left, value):
                continue
            if isinstance(node.ops[0], ast.Eq):
                text = pyast.string(node.comparators[0])
                if text is not None:
                    found.append(text)
            elif isinstance(node.ops[0], ast.In) and isinstance(node.comparators[0], (ast.Tuple, ast.List, ast.Set)):
                found += [pyast.string(element) for element in node.comparators[0].elts if pyast.string(element)]
    return found


def _same_field(read: ast.expr, value: ast.expr) -> bool:
    """`x.get('f', ...)` and `x['f']` (or `x.f`) read the same field."""

    def field(node):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and node.args
        ):
            return pyast.dotted(node.func.value), pyast.string(node.args[0])
        if isinstance(node, ast.Subscript):
            return pyast.dotted(node.value), pyast.string(node.slice)
        if isinstance(node, ast.Attribute):
            return pyast.dotted(node.value), node.attr
        return None

    return field(read) is not None and field(read) == field(value)
