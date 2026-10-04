"""Settings, add-ons and suite instance schemes.

Contracts and the failures they catch:
- Every setting HQ's loader returns is an item keyed ``<type>.<id>`` with the
  attributes that gate it. The test reads the two YAML files independently
  (with the loader's own defaults: profile settings are ``properties``, app
  settings ``hq``) and compares keys and every ``since``, ``toggle``,
  ``toggles``, ``privilege`` and ``disabled``, so a dropped file, a wrong type
  default or a dropped attribute fails.
- Every add-on in HQ's loaded registry is an item; the test reads the
  ``_ADD_ONS`` literal's keys from the syntax tree. A planted add-on in a
  temporary copy is read by the syntax-tree pass that supplies the
  ``used_in_*`` tests.
- Every scheme HQ registers an instance factory for is an item; the test reads
  the ``@register_factory(...)`` arguments from the syntax tree (the preset
  schemes come from ``INSTANCE_KWARGS_BY_ID``'s keys).
"""

from __future__ import annotations

import ast

import yaml

from proof.surface import pyast
from proof.surface.families.registries import ADD_ONS, INSTANCES, SETTINGS_DIR, _add_on_calls

GATES = ("since", "toggle", "toggles", "privilege", "disabled")


def test_settings_match_the_yaml(items, sources):
    expected = {}
    for name, default_type in (("commcare-profile-settings.yml", "properties"), ("commcare-app-settings.yml", "hq")):
        for setting in yaml.safe_load((sources.hq / SETTINGS_DIR / name).read_text(encoding="utf-8")):
            expected[f"setting:{setting.get('type') or default_type}.{setting['id']}"] = {
                gate: setting[gate] for gate in GATES if gate in setting
            }
    extracted = {
        key: {gate: facts[gate] for gate in GATES if gate in facts}
        for key, facts in items.items()
        if key.startswith("setting:")
    }
    assert extracted == expected
    assert items["setting:hq.target_commcare_flavor"]["toggles"] == "TARGET_COMMCARE_FLAVOR"


def test_add_ons_match_the_registry_literal(items, sources):
    literal = _add_on_calls(pyast.parse(sources.hq / ADD_ONS))
    assert {key.split(":", 1)[1] for key in items if key.startswith("add-on:")} == set(literal)
    assert items["add-on:subcases"]["privilege"] == "child_cases" and items["add-on:subcases"]["upgradeText"] is True


def test_the_add_on_pass_reads_a_planted_add_on(plant, sources):
    root = plant(
        sources.hq,
        [ADD_ONS],
        {
            ADD_ONS: (
                "_ADD_ONS = {\n",
                "_ADD_ONS = {\n    \"planted\": AddOn(name='P', description='P', used_in_form=lambda f: f.planted),\n",
            )
        },
    )
    literal = _add_on_calls(ast.parse((root / ADD_ONS).read_text(encoding="utf-8")))
    assert literal["planted"]["used_in_form"] == "lambda f: f.planted"
    assert "planted" not in _add_on_calls(pyast.parse(sources.hq / ADD_ONS))


def test_instance_schemes_match_the_registrations(items, sources):
    tree = pyast.parse(sources.hq / INSTANCES)
    presets = []
    registered = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            getattr(t, "id", None) == "INSTANCE_KWARGS_BY_ID" for t in node.targets
        ):
            presets = [key.value for key in node.value.keys]
        if isinstance(node, ast.FunctionDef):
            for applied in node.decorator_list:
                if isinstance(applied, ast.Call) and getattr(applied.func, "id", None) == "register_factory":
                    for argument in applied.args:
                        if isinstance(argument, ast.Constant):
                            registered.add(argument.value)
                        elif isinstance(argument, ast.Starred):
                            registered.update(presets)
    assert {key.split(":", 1)[1] for key in items if key.startswith("instance-scheme:")} == registered
    assert items["instance-scheme:commcare"]["toggles"] == ["MOBILE_UCR"]
