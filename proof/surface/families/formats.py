"""Case list and case detail column formats, and the field types a column reads.

Keys:

- ``format:<slug>``: each format HQ's build registers
  (``detail_screen.py::register_format_type``, read as
  ``get_class_for_format._format_map`` after the boot) or the case list editor
  offers (``details/utils.js::getFieldFormats``), with the class HQ builds it
  with (``null`` where HQ builds it as a plain column), whether and under
  which toggle or add-on the editor offers it, the dependencies and screen
  ``dynamicFormats.COLUMN_FORMAT_DEPENDENCIES`` declares for it, and what
  ``details/bootstrap{3,5}/column.js::filterFormats`` does with it: whether it
  adds the format to the menu or removes it (``operation``, from the list
  method that consumes the format, ``method``), the comparison that matches an
  option against it (``match``: ``f.value.includes('translatable-enum')`` is a
  substring match), and every test around that list call (``conditions``,
  including the loop-body test that keeps a column's current format).
- ``format:<unregistered>``: any slug ``get_class_for_format._format_map``
  does not register, which HQ's build still builds, with the class
  ``get_class_for_format`` falls back to (read from its syntax tree:
  ``_format_map.get(slug, <class>)``).
- ``detail-field-type:<type>``: each field type HQ's build registers
  (``register_type_processor``, ``get_class_for_type._type_map``), with its class.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

from proof.surface import pyast
from proof.surface.model import Item, Sources, SurfaceError, item
from proof.surface.node import run_node

DETAILS = "corehq/apps/app_manager/static/app_manager/js/details"
UTILS = f"{DETAILS}/utils.js"
COLUMNS = (f"{DETAILS}/bootstrap3/column.js", f"{DETAILS}/bootstrap5/column.js")


def extract(sources: Sources) -> list[Item]:
    from corehq.apps.app_manager import detail_screen

    registered = {slug: cls.__name__ for slug, cls in detail_screen.get_class_for_format._format_map.items()}
    editor = editor_formats(sources, sources.hq / UTILS, [sources.hq / column for column in COLUMNS])
    screen = f"{sources.relative(inspect.getsourcefile(detail_screen))}::get_class_for_format._format_map"
    items = []
    for slug in sorted(set(registered) | set(editor)):
        offered = editor.get(slug, {})
        where = [screen] if slug in registered else []
        if offered:
            where.append(f"{sources.relative(sources.hq / UTILS)}::getFieldFormats")
        items.append(
            item(
                f"format:{slug}",
                where,
                buildClass=registered.get(slug),
                offered=offered.get("offered", False),
                guards=offered.get("guards", []),
                dependencies=offered.get("dependencies"),
                filters=offered.get("filters", {}),
            )
        )
    items.append(unregistered_format(sources, Path(inspect.getsourcefile(detail_screen))))
    type_source = f"{sources.relative(inspect.getsourcefile(detail_screen))}::get_class_for_type._type_map"
    for slug, cls in sorted(detail_screen.get_class_for_type._type_map.items()):
        items.append(item(f"detail-field-type:{slug}", type_source, buildClass=cls.__name__))
    return items


def unregistered_format(sources: Sources, path: Path) -> Item:
    """``format:<unregistered>``: the class ``get_class_for_format`` builds a slug its table does not hold with,
    the default of its ``_format_map.get(slug, <class>)``."""
    function = pyast.find_in(pyast.in_checkout(sources.hq, path), "get_class_for_format")
    fallbacks = [
        node.args[1]
        for node in ast.walk(function)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "get"
        and isinstance(node.func.value, ast.Attribute)
        and node.func.value.attr == "_format_map"
        and len(node.args) == 2
        and isinstance(node.args[1], ast.Name)
    ]
    if len(fallbacks) != 1:
        raise SurfaceError(
            f"The surface extractor found {len(fallbacks)} fallbacks in {path}::get_class_for_format, which it reads"
            " as one `_format_map.get(slug, <class>)`."
        )
    return item(
        "format:<unregistered>",
        f"{sources.relative(path)}::get_class_for_format",
        buildClass=fallbacks[0].id,
        offered=False,
    )


def editor_formats(sources: Sources, utils, columns) -> dict[str, dict]:
    """What the case list editor offers of each format, read by the JavaScript helper."""
    read = run_node("detail-formats", [str(utils), *(str(column) for column in columns)])
    formats: dict[str, dict] = {}
    for entry in read["offered"]:
        formats.setdefault(entry["value"], {"offered": True, "guards": entry["guards"]})
    for slug, dependency in read["dependencies"].items():
        formats.setdefault(slug, {"offered": False})["dependencies"] = dependency
    known = set(formats)
    for column, found in read["filters"].items():
        flavour = Path(column).parent.name
        for slug, occurrences in found.items():
            if slug not in known and not _registered(slug):
                # Screen names and labels in the filter are not formats.
                continue
            formats.setdefault(slug, {"offered": False}).setdefault("filters", {})[flavour] = occurrences
    return formats


def _registered(slug: str) -> bool:
    from corehq.apps.app_manager import detail_screen

    return slug in detail_screen.get_class_for_format._format_map
