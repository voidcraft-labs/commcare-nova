"""CSQL, lookup tables, media and project-space settings.

Contracts and the failures they catch:
- Every CSQL function, metadata property and distance unit HQ's compiler
  accepts is an item. The extractor reads HQ's loaded tables; the test reads
  the literal dicts, the ``_INDEXED_METADATA(key=...)`` calls and the unit list
  from the files' syntax trees, so a table the extractor drops or a
  comprehension it misreads fails.
- The project-space settings publish confirms carry the defaults a fresh HQ
  model instance has.
- The lookup workbook pass reads a planted column from a temporary copy,
  through a loop over literal owner types as well as a literal key.
"""

from __future__ import annotations

import ast
import dataclasses

from proof.surface.families.data import LOOKUP_CODE, WORKBOOK, _code_item, workbook_vocabulary


def _dict_keys(tree: ast.Module, name: str) -> set[str]:
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return {key.value for key in node.value.keys}
    raise AssertionError(f"no {name} literal")


def test_csql_tables_match_the_literal_tables(items, sources):
    functions = ast.parse(
        (sources.hq / "corehq/apps/case_search/xpath_functions/__init__.py").read_text(encoding="utf-8")
    )
    names = _dict_keys(functions, "XPATH_VALUE_FUNCTIONS") | _dict_keys(functions, "XPATH_QUERY_FUNCTIONS")
    # Nova's own fail-closed CSQL value is authored (proof/surface/families/authored.py), no function of HQ's.
    generated = {key for key, facts in items.items() if key.startswith("csql-fn:") and not facts.get("authored")}
    assert {key.split(":", 1)[1] for key in generated} == names
    const = ast.parse((sources.hq / "corehq/apps/case_search/const.py").read_text(encoding="utf-8"))
    metadata = {
        keyword.value.value
        for node in ast.walk(const)
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "_INDEXED_METADATA"
        for keyword in node.keywords
        if keyword.arg == "key"
    }
    assert {key.split(":", 1)[1] for key in items if key.startswith("csql-metadata:")} == metadata
    queries = ast.parse((sources.hq / "corehq/apps/es/queries.py").read_text(encoding="utf-8"))
    units = next(
        [element.value for element in node.value.elts]
        for node in queries.body
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "DISTANCE_UNITS" for t in node.targets)
    )
    assert {key.split(":", 1)[1] for key in items if key.startswith("csql-unit:")} == set(units)
    assert items["csql-metadata:last_modified"]["isDatetime"] is True


def test_project_settings_carry_the_model_defaults(items, hq):
    from corehq.apps.case_search.models import CaseSearchConfig
    from corehq.apps.locations.models import LocationFixtureConfiguration

    assert items["project-setting:LocationFixtureConfiguration.sync_flat_fixture"]["default"] is True
    assert LocationFixtureConfiguration().sync_flat_fixture is True
    for field in ("enabled", "sync_cases_on_form_entry"):
        assert items[f"project-setting:CaseSearchConfig.{field}"]["default"] is False
        assert getattr(CaseSearchConfig(), field) is False
    assert items["project-setting:Domain.commtrack_enabled"]["default"] is False


def test_the_workbook_pass_reads_a_planted_column(plant, sources):
    root = plant(
        sources.hq,
        [WORKBOOK],
        {
            WORKBOOK: (
                "            uid = di.get('UID')\n",
                "            uid = di.get('UID')\n            planted = di.get('planted_column')\n"
                "            for kind in ['planted_owner']:\n                planted = di[kind]\n",
            )
        },
    )
    planted = dataclasses.replace(sources, hq=root)
    words = {i.key.split(":", 1)[1] for i in workbook_vocabulary(planted, root / WORKBOOK)}
    assert {"planted_column", "planted_owner", "UID", "user"} <= words
    assert "planted_column" not in {i.key.split(":", 1)[1] for i in workbook_vocabulary(sources, sources.hq / WORKBOOK)}


def test_the_code_pass_reads_a_planted_call_and_string(plant, sources):
    relative, qualname = LOOKUP_CODE[0]
    root = plant(
        sources.hq,
        [relative],
        {
            relative: (
                "        for field in data_type.fields:\n",
                "        planted_call('planted-element')\n        for field in data_type.fields:\n",
            )
        },
    )
    planted = _code_item("lookup-code", dataclasses.replace(sources, hq=root), relative, qualname)
    assert "planted_call('planted-element')" in planted.facts["calls"]
    assert "planted-element" in planted.facts["strings"]
    unplanted = _code_item("lookup-code", sources, relative, qualname)
    assert "planted-element" not in unplanted.facts["strings"]
