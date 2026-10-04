"""HQ's feature flags, feature previews, plan privileges and plan allocations.

Keys:

- ``toggle:<SYMBOL>``: each toggle bound in ``corehq/toggles/__init__.py``
  (``toggle:SESSION_ENDPOINTS``), read after the boot: its class
  (``StaticToggle``, ``FrozenPrivilegeToggle``, ``FeatureRelease``,
  ``DynamicallyPredictablyRandomToggle``, ...), slug, tag (the ``TAG_*``
  symbol), namespaces as the toggle holds them at runtime (``NAMESPACE_USER``
  and an omitted list both become ``null``), parents (the transitive closure
  ``StaticToggle.__init__`` builds, as symbols), the privilege a
  ``FrozenPrivilegeToggle`` stands for, and the rollout facts that decide who
  has it (``relevant_environments``, the enable-after dates and a random
  toggle's default randomness). Every ``StaticToggle`` instance alive after
  the boot is found, not only those ``toggles.all_toggles()`` lists (which
  leaves out ``FrozenPrivilegeToggle``).
- ``feature-preview:<SYMBOL>``: each ``FeaturePreview`` in
  ``corehq/feature_previews.py``, with the same facts and its privilege.
- ``privilege:<CONSTANT>``: each string constant of ``corehq/privileges.py``
  (``privilege:VELLUM_SAVE_TO_CASE``), read from its syntax tree, with its slug
  and the plan allocations that grant it.
- ``plan:<name>``: each plan allocation list of
  ``corehq/apps/accounting/bootstrap/features.py`` (``plan:advanced_v0``),
  evaluated from its syntax tree (list literals of ``privileges.X`` joined
  with ``+``), as the privilege symbols it grants.
"""

from __future__ import annotations

import ast
import datetime
import inspect
import sys
from pathlib import Path

from proof.hq.boot import tracked_objects
from proof.surface import pyast
from proof.surface.model import Item, Sources, SurfaceError, item

TOGGLES = "corehq/toggles/__init__.py"
PREVIEWS = "corehq/feature_previews.py"
PRIVILEGES = "corehq/privileges.py"
PLANS = "corehq/apps/accounting/bootstrap/features.py"


def extract(sources: Sources) -> list[Item]:
    privileges = privilege_constants(sources.hq / PRIVILEGES)
    plans = plan_allocations(sources.hq / PLANS)
    slug_to_symbol = {slug: symbol for symbol, slug in privileges.items()}
    items = _flags(sources, slug_to_symbol)
    for symbol, slug in sorted(privileges.items()):
        granted = sorted(plan for plan, members in plans.items() if symbol in members)
        items.append(
            item(
                f"privilege:{symbol}",
                f"{sources.relative(sources.hq / PRIVILEGES)}::{symbol}",
                slug=slug,
                plans=granted,
            )
        )
    for plan, members in sorted(plans.items()):
        unknown = sorted(set(members) - set(privileges))
        if unknown:
            raise SurfaceError(
                f"The plan allocation {plan} grants {unknown}, which corehq/privileges.py does not define as a "
                "string constant. The privilege family reads privileges.py's module-level string constants."
            )
        items.append(
            item(f"plan:{plan}", f"{sources.relative(sources.hq / PLANS)}::{plan}", privileges=sorted(set(members)))
        )
    return items


def privilege_constants(path: Path) -> dict[str, str]:
    """Each module-level ``NAME = 'slug'`` of privileges.py."""
    return {
        name: value
        for name, value in pyast.module_constants(pyast.parse(path)).items()
        if isinstance(value, str) and name.isupper()
    }


def plan_allocations(path: Path) -> dict[str, list[str]]:
    """Each module-level list of privilege symbols, following ``+`` joins of earlier lists."""
    lists: dict[str, list[str]] = {}

    def evaluate(node: ast.AST, name: str) -> list[str]:
        if isinstance(node, ast.List):
            members = []
            for element in node.elts:
                chain = pyast.dotted(element)
                if chain is None or not chain.startswith("privileges.") or chain.count(".") != 1:
                    raise SurfaceError(
                        f"The plan allocation {name} lists {ast.unparse(element)}, which is not a "
                        "`privileges.X` constant, so the plan family cannot read it statically."
                    )
                members.append(chain.split(".", 1)[1])
            return members
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return evaluate(node.left, name) + evaluate(node.right, name)
        if isinstance(node, ast.Name) and node.id in lists:
            return list(lists[node.id])
        raise SurfaceError(
            f"The plan allocation {name} is built as {ast.unparse(node)}, which the plan family does not "
            "evaluate (it reads list literals of privileges joined with +)."
        )

    for statement in pyast.parse(path).body:
        if (
            isinstance(statement, ast.Assign)
            and len(statement.targets) == 1
            and isinstance(statement.targets[0], ast.Name)
        ):
            name = statement.targets[0].id
            lists[name] = evaluate(statement.value, name)
    return lists


def _flags(sources: Sources, slug_to_symbol: dict[str, str]) -> list[Item]:
    import corehq.feature_previews as previews
    import corehq.toggles as toggles

    # The boot freezes its heap (gc.freeze), and gc.get_objects() lists no frozen object.
    instances = [value for value in tracked_objects() if isinstance(value, toggles.StaticToggle)]
    # Each instance's module-level names, in any module the boot imported.
    names: dict[int, list[tuple[str, str]]] = {}
    for module_name, module in sorted(sys.modules.items()):
        namespace = getattr(module, "__dict__", None)
        if not isinstance(namespace, dict):
            continue
        for name, value in list(namespace.items()):
            if isinstance(value, toggles.StaticToggle):
                names.setdefault(id(value), []).append((module_name, name))
    tags = {id(value): name for name, value in vars(toggles).items() if isinstance(value, toggles.Tag)}
    homes = {toggles.__name__: "toggle", previews.__name__: "feature-preview"}
    for module_name in toggles.custom_toggle_modules() or []:
        homes[module_name] = "toggle"
    by_symbol = {}
    for instance in instances:
        bound = sorted((module, name) for module, name in names.get(id(instance), []) if module in homes)
        if not bound:
            where = names.get(id(instance)) or "no module"
            raise SurfaceError(
                f"The toggle {instance.slug!r} is not bound in {sorted(homes)} (it is bound in {where}). "
                "The toggle family keys toggles by the symbol their registry binds."
            )
        by_symbol[id(instance)] = bound
    symbol_of = {key: bound[0][1] for key, bound in by_symbol.items()}

    items = []
    for instance in instances:
        for module_name, symbol in by_symbol[id(instance)]:
            family = homes[module_name]
            path = Path(inspect.getsourcefile(sys.modules[module_name]))
            facts = {
                "class": type(instance).__name__,
                "slug": instance.slug,
                "tag": tags.get(id(instance.tag)),
                "namespaces": list(instance.namespaces),
                "parents": [symbol_of[id(parent)] for parent in instance.parent_toggles],
                "relevantEnvironments": sorted(instance.relevant_environments)
                if instance.relevant_environments
                else None,
                "enabledForNewDomainsAfter": _date(instance.enabled_for_new_domains_after),
                "enabledForNewUsersAfter": _date(instance.enabled_for_new_users_after),
            }
            if facts["tag"] is None:
                raise SurfaceError(f"The toggle {symbol} has a tag no TAG_* constant of corehq.toggles names.")
            privilege = getattr(instance, "privilege_slug", None) or getattr(instance, "privilege", None)
            if privilege is not None:
                facts["privilege"] = slug_to_symbol.get(privilege, privilege)
            if hasattr(instance, "default_randomness"):
                facts["defaultRandomness"] = instance.default_randomness
            if family == "feature-preview":
                check = instance.can_self_enable_fn
                facts["selfEnableCheck"] = None if check is None else f"{check.__module__}.{check.__qualname__}"
            aliases = [name for _, name in by_symbol[id(instance)] if name != symbol]
            if aliases:
                facts["aliases"] = sorted(aliases)
            items.append(item(f"{family}:{symbol}", f"{sources.relative(path)}::{symbol}", **facts))
    return items


def _date(value):
    if value is None:
        return None
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    raise SurfaceError(
        f"A toggle's enable-after date is a {type(value).__name__}, which the toggle family does not read."
    )
