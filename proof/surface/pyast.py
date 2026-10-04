"""Reading HQ's Python by its syntax tree.

Every Python-source fact the surface records comes through these helpers:
the standard library's ``ast`` over the file, never a pattern over its text.
A file is parsed once per process.
"""

from __future__ import annotations

import ast
import importlib.util
from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from proof.surface.model import SurfaceError


@lru_cache(maxsize=None)
def parse(path: Path | str) -> ast.Module:
    path = Path(path)
    try:
        return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError) as error:
        raise SurfaceError(f"The surface extractor could not parse {path} as Python ({error}).") from error


def module_path(module: str) -> Path:
    """The source file Python imports ``module`` from."""
    spec = importlib.util.find_spec(module)
    if spec is None or not spec.origin or not spec.origin.endswith(".py"):
        raise SurfaceError(f"The surface extractor could not find the Python source of the module {module}.")
    return Path(spec.origin)


def loaded_root() -> Path:
    """The checkout the booted HQ imports its code from (the directory holding ``corehq``)."""
    import corehq

    return Path(corehq.__file__).resolve().parent.parent


def in_checkout(checkout: Path, path: Path | str) -> Path:
    """The file ``checkout`` holds at the place the booted HQ imported ``path`` from.

    The families discover HQ's readers through the booted HQ and read their source from the
    checkout they are given, so a test can hand them a temporary copy of a file. A checkout that
    lacks the file (a test's partial copy) leaves the imported file in place.
    """
    real = Path(path).resolve()
    try:
        candidate = Path(checkout) / real.relative_to(loaded_root())
    except ValueError:
        return real
    return candidate if candidate.is_file() else real


def find_function(path: Path, qualname: str) -> ast.FunctionDef | ast.AsyncFunctionDef:
    """The function whose qualname (``Class.method``, ``outer.<locals>.inner``) is ``qualname``."""
    for found, node in walk_functions(parse(path)):
        if found == qualname:
            return node
    raise SurfaceError(f"The surface extractor found no function {qualname} in {path}.")


def guarded(body: list[ast.stmt], wanted, conditions: tuple[str, ...] = ()) -> Iterator[tuple[ast.stmt, list[str]]]:
    """Each statement of ``body`` (at any depth, outside nested functions and classes) that ``wanted``
    accepts, with the conditions it runs under, printed from the syntax tree: an ``if``'s test (``not
    (...)`` in its ``else``), a loop's header, an ``except`` clause, a ``case`` pattern."""
    for statement in body:
        if wanted(statement):
            yield statement, list(conditions)
        if isinstance(statement, ast.If):
            test = ast.unparse(statement.test)
            yield from guarded(statement.body, wanted, (*conditions, test))
            yield from guarded(statement.orelse, wanted, (*conditions, f"not ({test})"))
        elif isinstance(statement, (ast.For, ast.AsyncFor)):
            loop = f"for {ast.unparse(statement.target)} in {ast.unparse(statement.iter)}"
            yield from guarded(statement.body, wanted, (*conditions, loop))
            yield from guarded(statement.orelse, wanted, (*conditions, f"after {loop}"))
        elif isinstance(statement, ast.While):
            loop = f"while {ast.unparse(statement.test)}"
            yield from guarded(statement.body, wanted, (*conditions, loop))
            yield from guarded(statement.orelse, wanted, (*conditions, f"after {loop}"))
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            yield from guarded(statement.body, wanted, conditions)
        elif isinstance(statement, (ast.Try, ast.TryStar)):
            yield from guarded(statement.body, wanted, conditions)
            for handler in statement.handlers:
                clause = "except" if handler.type is None else f"except {ast.unparse(handler.type)}"
                yield from guarded(handler.body, wanted, (*conditions, clause))
            yield from guarded(statement.orelse, wanted, conditions)
            yield from guarded(statement.finalbody, wanted, conditions)
        elif isinstance(statement, ast.Match):
            subject = ast.unparse(statement.subject)
            for case in statement.cases:
                yield from guarded(
                    case.body, wanted, (*conditions, f"match {subject}: case {ast.unparse(case.pattern)}")
                )


def exits(function: ast.FunctionDef | ast.AsyncFunctionDef) -> list[dict]:
    """Every ``return``, ``raise``, ``continue`` and ``break`` of a function, printed, with the conditions
    it runs under."""
    kinds = (ast.Return, ast.Raise, ast.Continue, ast.Break)
    return [
        {"exit": ast.unparse(statement), "when": conditions}
        for statement, conditions in guarded(function.body, lambda statement: isinstance(statement, kinds))
    ]


def find(tree: ast.AST, qualname: str) -> ast.AST:
    """The class or function ``qualname`` (``Class.method``) defines at module level."""
    node: ast.AST = tree
    for part in qualname.split("."):
        body = getattr(node, "body", [])
        matches = [
            child
            for child in body
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and child.name == part
        ]
        if not matches:
            raise SurfaceError(f"The surface extractor looked for {qualname} and found no {part} there.")
        # A later definition of the same name wins, as it does when Python runs the module.
        node = matches[-1]
    return node


def find_in(path: Path, qualname: str) -> ast.AST:
    return find(parse(path), qualname)


def function_starting_at(path: Path, first_line: int) -> tuple[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    """The function whose definition (decorators included) starts at ``first_line``, with its qualname."""
    for qualname, node in walk_functions(parse(path)):
        start = min([node.lineno] + [decorator.lineno for decorator in node.decorator_list])
        if start == first_line or node.lineno == first_line:
            return qualname, node
    raise SurfaceError(f"The surface extractor found no function starting at line {first_line} of {path}.")


def walk_functions(tree: ast.AST, prefix: str = "") -> Iterator[tuple[str, ast.FunctionDef | ast.AsyncFunctionDef]]:
    """Every function in ``tree`` with its qualname, nested ones included (``outer.<locals>.inner``)."""
    for child in ast.iter_child_nodes(tree):
        if isinstance(child, ast.ClassDef):
            yield from walk_functions(child, f"{prefix}{child.name}.")
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            qualname = f"{prefix}{child.name}"
            yield qualname, child
            yield from walk_functions(child, f"{qualname}.<locals>.")
        else:
            yield from walk_functions(child, prefix)


def enclosing(tree: ast.AST) -> Iterator[tuple[ast.AST, str]]:
    """Every node of ``tree`` with the qualname of the function or class around it ('' at module level)."""

    def visit(node: ast.AST, scope: str) -> Iterator[tuple[ast.AST, str]]:
        for child in ast.iter_child_nodes(node):
            inner = scope
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                inner = f"{scope}.{child.name}" if scope else child.name
            yield child, inner
            yield from visit(child, inner)

    yield from visit(tree, "")


def dotted(node: ast.AST) -> str | None:
    """``a.b.c`` for a chain of attributes over a name, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def string(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def module_constants(tree: ast.Module) -> dict[str, object]:
    """Module-level names bound once to a literal (``NAME = 'text'``)."""
    constants: dict[str, object] = {}
    rebound: set[str] = set()
    for statement in tree.body:
        targets = []
        value = None
        if isinstance(statement, ast.Assign):
            targets, value = statement.targets, statement.value
        elif isinstance(statement, ast.AnnAssign) and statement.value is not None:
            targets, value = [statement.target], statement.value
        for target in targets:
            if not isinstance(target, ast.Name):
                continue
            if target.id in constants or target.id in rebound:
                rebound.add(target.id)
                constants.pop(target.id, None)
                continue
            try:
                constants[target.id] = ast.literal_eval(value)
            except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
                rebound.add(target.id)
    return constants


@dataclass(frozen=True)
class Binding:
    """Where a module-level name is bound, following ``from x import name`` inside the given roots."""

    module: str
    name: str
    path: Path | None
    kind: str  # "def", "class", "assign", "external" or "unknown"
    node: ast.AST | None = None

    @property
    def symbol(self) -> str:
        return f"{self.module}.{self.name}"


def binding(
    module: str, name: str, roots: tuple[str, ...], locate=module_path, _seen: frozenset = frozenset()
) -> Binding:
    """Where ``name`` in ``module`` is defined, through the module's own imports, reading each module's source
    from ``locate(module)``."""
    if (module, name) in _seen:
        return Binding(module, name, None, "unknown")
    seen = _seen | {(module, name)}
    if not module.startswith(roots):
        return Binding(module, name, None, "external")
    try:
        path = locate(module)
    except SurfaceError:
        return Binding(module, name, None, "unknown")
    tree = parse(path)
    found: Binding | None = None
    for statement in tree.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)) and statement.name == name:
            found = Binding(module, name, path, "def", statement)
        elif isinstance(statement, ast.ClassDef) and statement.name == name:
            found = Binding(module, name, path, "class", statement)
        elif isinstance(statement, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == name for target in statement.targets
        ):
            found = Binding(module, name, path, "assign", statement)
        elif isinstance(statement, ast.ImportFrom):
            for alias in statement.names:
                if (alias.asname or alias.name) == name:
                    source = _absolute(module, path, statement)
                    found = binding(source, alias.name, roots, locate, seen)
    return found or Binding(module, name, path, "unknown")


def _absolute(module: str, path: Path, statement: ast.ImportFrom) -> str:
    if not statement.level:
        return statement.module or ""
    package = module if path.name == "__init__.py" else module.rpartition(".")[0]
    for _ in range(statement.level - 1):
        package = package.rpartition(".")[0]
    return f"{package}.{statement.module}" if statement.module else package


def imported_names(tree: ast.Module) -> dict[str, str]:
    """Each name a file's absolute imports bind, anywhere in the file, with the dotted name it stands for
    (``from looseversion import LooseVersion`` binds ``LooseVersion`` to ``looseversion.LooseVersion``)."""
    names: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and not node.level and node.module:
            for alias in node.names:
                names[alias.asname or alias.name] = f"{node.module}.{alias.name}"
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    names[alias.asname] = alias.name
                else:
                    head = alias.name.split(".", 1)[0]
                    names[head] = head
    return names


def calls(node: ast.AST) -> list[str]:
    """Every call inside ``node`` (a function's body, not its decorators), printed from its syntax tree,
    in source order, each once."""
    roots = node.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)) else [node]
    if isinstance(roots, ast.AST):
        roots = [roots]
    found = sorted(
        (child for root in roots for child in ast.walk(root) if isinstance(child, ast.Call)),
        key=lambda child: (child.lineno, child.col_offset),
    )
    seen: list[str] = []
    for child in found:
        text = ast.unparse(child)
        if text not in seen:
            seen.append(text)
    return seen
