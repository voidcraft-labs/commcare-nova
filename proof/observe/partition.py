"""The observation partition: the files whose code or data decides what a record holds.

A part's key names its inputs and the observation fingerprint
(``proof.observe.record.part_key``), which the evidence store computes over
the files this partition holds (``observes``). So a change to any of them
observes every part again, and a change to none of them keeps every stored
part: exact only while the observation runs no code outside them.
``test_judge_purity`` holds the observation's import closure
(``import_closure`` from ``OBSERVATION_ROOTS``) to the partition.

The partition is the observation's directories and files, and three files of
the checks it runs but does not own: the corpus reader, whose objects the
observation is handed and calls (``Captured.upload``, ``Export``,
``Document``); the ``Difference`` its raw build comparison makes
(``proof.observe.builds``, through the comparators); and the shard parsing
``proof/hq/database.py`` names its databases by.

Standard library only, so the lane's queue builder can read it without the
image.
"""

from __future__ import annotations

import ast
from pathlib import Path, PurePosixPath

WORKTREE = Path(__file__).resolve().parents[2]

# Every file under these directories (repository-relative, ``/``-terminated), but under an excluded one.
OBSERVATION_DIRECTORIES = (
    "proof/checks/compare/",
    "proof/core/",
    "proof/editors/",
    "proof/hq/",
    "proof/lane/",
    "proof/observe/",
    "proof/store/",
)
# The browser's own partition (the editor driver's code), fingerprinted apart.
OBSERVATION_EXCLUDED = ("proof/editors/driver/",)
OBSERVATION_FILES = frozenset(
    {
        "lib/commcare/surface/entries/gates.json",
        "proof/checks/configurations.py",
        "proof/checks/corpus.py",
        "proof/checks/differences.py",
        "proof/checks/sharding.py",
        "proof/conftest.py",
        "proof/processes.py",
        "proof/pytest.ini",
    }
)
# Where the observation starts: every module of ``proof.observe``, the corpus reader whose documents it is
# handed, and the lane's fixtures that start HQ, the Core runner and the editor driver for it.
OBSERVATION_ROOTS = ("proof.observe.*", "proof.checks.corpus", "proof.conftest")


def observes(path) -> bool:
    """Whether a repository-relative path is in the observation partition."""
    path = PurePosixPath(path).as_posix()
    if any(path.startswith(excluded) for excluded in OBSERVATION_EXCLUDED):
        return False
    return path in OBSERVATION_FILES or any(path.startswith(directory) for directory in OBSERVATION_DIRECTORIES)


def _module_file(root, name):
    base = Path(root, *name.split("."))
    if (base / "__init__.py").is_file():
        return base / "__init__.py"
    if base.with_suffix(".py").is_file():
        return base.with_suffix(".py")
    return None


def _runs_nothing(tree):
    """Whether a module holds nothing but its docstring, so importing it runs no code."""
    return all(isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) for node in tree.body)


def _imported(tree, name, is_package):
    """Every module name an import in ``tree`` may load (each ``from`` import's names too, which may be modules)."""
    package = name if is_package else name.rpartition(".")[0]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                parts = package.split(".")
                parts = parts[: len(parts) - node.level + 1]
                module = ".".join([*parts, *([node.module] if node.module else [])])
            else:
                module = node.module
            yield module
            yield from (f"{module}.{alias.name}" for alias in node.names)


def _roots(root, roots):
    for name in roots:
        if name.endswith(".*"):
            package = name.removesuffix(".*")
            directory = Path(root, *package.split("."))
            yield from (f"{package}.{path.stem}" for path in sorted(directory.glob("*.py")) if path.stem != "__init__")
        else:
            yield name


def import_closure(roots=OBSERVATION_ROOTS, root=WORKTREE):
    """The repository-relative files of every ``proof`` module the roots may import, transitively.

    Every import statement counts, at module level or inside a function, so
    a module a function imports when it runs is in the closure. A package's
    ``__init__.py`` runs when a module under it is imported, so it counts
    too, unless it holds nothing but its docstring.
    """
    found, pending = {}, list(_roots(root, roots))
    while pending:
        name = pending.pop()
        if name.split(".")[0] != "proof" or name in found:
            continue
        path = _module_file(root, name)
        if path is None:
            continue
        tree = ast.parse(path.read_bytes(), filename=str(path))
        is_package = path.name == "__init__.py"
        found[name] = None if is_package and _runs_nothing(tree) else path.relative_to(root).as_posix()
        parts = name.split(".")
        pending += [".".join(parts[:index]) for index in range(1, len(parts))]
        pending += [module for module in _imported(tree, name, is_package) if module]
    return sorted(path for path in found.values() if path is not None)
