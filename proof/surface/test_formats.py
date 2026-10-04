"""Case list column formats and field types.

Contracts and the failures they catch:
- Every format HQ's build registers is an item, with the class HQ builds it
  with. The extractor reads the registry after the boot; the test reads the
  ``@register_format_type(...)`` and ``@register_type_processor(...)``
  decorators in ``detail_screen.py``'s syntax tree, so a registration the
  extractor misses, or one it invents, fails.
- A slug HQ registers no class for is built all the same, with the class
  ``get_class_for_format`` falls back to: ``format:<unregistered>`` records
  it, and HQ's own function gives that class for a slug no table holds.
- The editor's offer is read with its guards: a planted format behind a
  planted toggle in a temporary copy of ``details/utils.js`` is read as
  offered under that toggle, and a planted removal in a copy of ``column.js``
  is read as a removal under its conditions.
- ``filterFormats``' treatment of a format is what its list call does:
  ``graph`` is added (``concat``) only when it is the column's current format,
  ``picture`` is removed (``splice``) for a calculated column unless it is the
  current format, and ``translatable-enum`` is removed by a substring match.
  Turning the ``concat`` into a removal, or dropping the ``unless current``
  test, in a temporary copy changes the recorded facts.
"""

from __future__ import annotations

import ast

from proof.surface import pyast
from proof.surface.families.formats import COLUMNS, UTILS, editor_formats


def _registered(sources, decorator: str) -> dict[str, str]:
    """Each slug a class decorator registers: a literal, or a `const.NAME` of the module the file imports as `const`."""
    tree = ast.parse((sources.hq / "corehq/apps/app_manager/detail_screen.py").read_text(encoding="utf-8"))
    imported = next(
        f"{statement.module}.{alias.name}"
        for statement in tree.body
        if isinstance(statement, ast.ImportFrom)
        for alias in statement.names
        if (alias.asname or alias.name) == "const"
    )
    const = pyast.module_constants(pyast.parse(sources.hq / (imported.replace(".", "/") + ".py")))
    found = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for applied in node.decorator_list:
                if (
                    isinstance(applied, ast.Call)
                    and isinstance(applied.func, ast.Name)
                    and applied.func.id == decorator
                ):
                    argument = applied.args[0]
                    if isinstance(argument, ast.Constant):
                        found[argument.value] = node.name
                    elif pyast.dotted(argument) and pyast.dotted(argument).startswith("const."):
                        found[const[argument.attr]] = node.name
    return found


def test_registered_formats_and_field_types_match_the_decorators(items, sources):
    formats = {
        key.split(":", 1)[1]: facts["buildClass"]
        for key, facts in items.items()
        if key.startswith("format:") and key != "format:<unregistered>"
    }
    registered = _registered(sources, "register_format_type")
    assert {slug: cls for slug, cls in formats.items() if cls is not None} == registered
    types = {
        key.split(":", 1)[1]: facts["buildClass"]
        for key, facts in items.items()
        if key.startswith("detail-field-type:")
    }
    assert types == _registered(sources, "register_type_processor")


def test_the_editor_offer_carries_each_guard(items):
    assert items["format:plain"]["offered"] is True and items["format:plain"]["guards"] == []
    assert items["format:address-popup"]["guards"] == [{"branch": "then", "toggle": "CASE_LIST_MAP"}]
    assert items["format:enum-image"]["guards"] == [{"addOn": "enum_image", "branch": "then"}]
    assert items["format:graph"]["offered"] is False
    assert items["format:geo-points"]["dependencies"] == {"dependencies": ["address"], "display": "short"}


KEEPS_CURRENT = (
    "filteredOptions[j].value !== self.original.format\n"
    "                        && filteredOptions[j].value === menuOptionsToRemove[i]"
)


def test_the_filter_records_what_it_does_with_each_format(items):
    for flavour in ("bootstrap3", "bootstrap5"):
        assert items["format:graph"]["filters"][flavour] == [
            {
                "conditions": [{"branch": "then", "test": 'currentFormatValue === "graph"'}],
                "match": None,
                "method": "concat",
                "operation": "add",
            }
        ]
        for removed in ("picture", "audio"):
            assert items[f"format:{removed}"]["filters"][flavour] == [
                {
                    "conditions": [
                        {"branch": "then", "test": "self.useXpathExpression"},
                        {"branch": "then", "test": KEEPS_CURRENT},
                    ],
                    "match": "filteredOptions[j].value === menuOptionsToRemove[i]",
                    "method": "splice",
                    "operation": "remove",
                }
            ]
        assert items["format:translatable-enum"]["filters"][flavour] == [
            {
                "conditions": [
                    {"branch": "else", "test": "self.useXpathExpression"},
                    {"branch": "then", "test": "index !== -1"},
                ],
                "match": "f.value.includes('translatable-enum')",
                "method": "splice",
                "operation": "remove",
            }
        ]


def test_a_changed_filter_changes_its_facts(plant, sources, hq):
    column = COLUMNS[1]
    root = plant(
        sources.hq,
        [UTILS, column],
        {
            column: (
                "            filteredOptions = filteredOptions.concat([{\n",
                "            filteredOptions = filteredOptions.filter([{\n",
            ),
        },
    )
    text = (root / column).read_text(encoding="utf-8")
    (root / column).write_text(text.replace(KEEPS_CURRENT, "filteredOptions[j].value === menuOptionsToRemove[i]"))
    read = editor_formats(sources, root / UTILS, [root / column])
    assert read["graph"]["filters"]["bootstrap5"][0]["operation"] == "remove"
    assert read["picture"]["filters"]["bootstrap5"][0]["conditions"] == [
        {"branch": "then", "test": "self.useXpathExpression"},
        {"branch": "then", "test": "filteredOptions[j].value === menuOptionsToRemove[i]"},
    ]


def test_the_editor_pass_reads_a_planted_format_and_filter(plant, sources, hq):
    root = plant(
        sources.hq,
        [UTILS, *COLUMNS],
        {
            UTILS: (
                '    var addOns = initialPageData.get("add_ons");',
                "    if (toggles.toggleEnabled('PLANTED_TOGGLE')) {\n"
                "        formats.push({value: \"plain-planted\", label: gettext('Planted')});\n"
                "    }\n"
                '    var addOns = initialPageData.get("add_ons");',
            ),
            COLUMNS[0]: (
                "            const menuOptionsToRemove = ['picture', 'audio'];",
                "            const menuOptionsToRemove = ['picture', 'audio', 'plain-planted'];",
            ),
        },
    )
    read = editor_formats(sources, root / UTILS, [root / column for column in COLUMNS])
    assert read["plain-planted"]["guards"] == [{"branch": "then", "toggle": "PLANTED_TOGGLE"}]
    assert read["plain-planted"]["filters"] == {
        "bootstrap3": [
            {
                "conditions": [
                    {"branch": "then", "test": "self.useXpathExpression"},
                    {"branch": "then", "test": KEEPS_CURRENT},
                ],
                "match": "filteredOptions[j].value === menuOptionsToRemove[i]",
                "method": "splice",
                "operation": "remove",
            }
        ]
    }
    assert "plain-planted" not in editor_formats(sources, sources.hq / UTILS, [sources.hq / c for c in COLUMNS])


def test_an_unregistered_format_is_built_with_the_fallback_class(items, hq):
    from corehq.apps.app_manager import detail_screen

    slug = "nova-proof-unregistered"
    assert slug not in detail_screen.get_class_for_format._format_map
    assert items["format:<unregistered>"]["buildClass"] == detail_screen.get_class_for_format(slug).__name__
    assert "format:<unregistered>" not in {f"format:{slug}" for slug in detail_screen.get_class_for_format._format_map}
