"""Toggles, feature previews, privileges and plan allocations.

Contracts and the failures they catch:
- Every toggle HQ declares is an item with its class, whatever the class. The
  extractor reads toggles as HQ holds them after the boot; the test reads the
  registry file's syntax tree independently (each module-level assignment of
  a toggle class's constructor). HQ's own ``all_toggles()`` leaves out the
  ``FrozenPrivilegeToggle`` instances, so an extractor enumerating through it,
  or one dropping any class, disagrees with the source.
- A toggle's namespaces are the runtime values the flag probe compares
  (``SESSION_ENDPOINTS`` passes its namespace positionally, which a
  keyword-only reading misses).
- Privileges and plan allocations are read statically; the test imports
  both modules and compares, so a missed constant or a mis-evaluated
  ``+`` join of plan lists fails. A planted constant and plan list in a
  temporary copy prove the static pass reads what the files hold.
"""

from __future__ import annotations

import ast
import collections

from proof.surface.families.flags import plan_allocations, privilege_constants

TOGGLE_CLASSES = (
    "StaticToggle",
    "FrozenPrivilegeToggle",
    "PredictablyRandomToggle",
    "DynamicallyPredictablyRandomToggle",
    "FeatureRelease",
)


def test_every_declared_toggle_is_an_item_with_its_class(items, sources):
    tree = ast.parse((sources.hq / "corehq/toggles/__init__.py").read_text(encoding="utf-8"))
    declared = {}
    for statement in tree.body:
        if (
            isinstance(statement, ast.Assign)
            and isinstance(statement.value, ast.Call)
            and isinstance(statement.value.func, ast.Name)
            and statement.value.func.id in TOGGLE_CLASSES
        ):
            for target in statement.targets:
                declared[target.id] = statement.value.func.id
    extracted = {key.split(":", 1)[1]: facts["class"] for key, facts in items.items() if key.startswith("toggle:")}
    assert extracted == declared
    # The classes all_toggles() leaves out are among them.
    by_class = collections.Counter(extracted.values())
    assert by_class["FrozenPrivilegeToggle"] > 0 and by_class["FeatureRelease"] > 0


def test_toggle_facts_are_the_runtime_values(items, hq):
    import corehq.toggles as toggles

    endpoints = items["toggle:SESSION_ENDPOINTS"]
    assert endpoints["namespaces"] == ["domain"] == list(toggles.SESSION_ENDPOINTS.namespaces)
    assert endpoints["slug"] == toggles.SESSION_ENDPOINTS.slug
    assert endpoints["tag"] == "TAG_FROZEN" and toggles.SESSION_ENDPOINTS.tag is toggles.TAG_FROZEN
    advanced = items["toggle:CASE_SEARCH_ADVANCED"]
    assert advanced["parents"] == ["SYNC_SEARCH_CASE_CLAIM"]
    frozen = items["toggle:VELLUM_SAVE_TO_CASE"]
    assert frozen["class"] == "FrozenPrivilegeToggle" and frozen["privilege"] == "VELLUM_SAVE_TO_CASE"
    # A toggle declared without namespaces is read as HQ reads it: the user namespace, held as None.
    unnamespaced = [key for key, facts in items.items() if key.startswith("toggle:") and facts["namespaces"] == [None]]
    assert "toggle:IS_CONTRACTOR" in unnamespaced


def test_privileges_and_plans_match_the_imported_modules(items, hq):
    import corehq.privileges as privileges
    from corehq.apps.accounting.bootstrap import features

    constants = {name: value for name, value in vars(privileges).items() if name.isupper() and isinstance(value, str)}
    extracted = {key.split(":", 1)[1]: facts["slug"] for key, facts in items.items() if key.startswith("privilege:")}
    assert extracted == constants
    slug_to_symbol = {value: name for name, value in constants.items()}
    plans = {
        name: sorted({slug_to_symbol[slug] for slug in value})
        for name, value in vars(features).items()
        if isinstance(value, list) and not name.startswith("_")
    }
    extracted_plans = {
        key.split(":", 1)[1]: facts["privileges"] for key, facts in items.items() if key.startswith("plan:")
    }
    assert extracted_plans == plans
    assert "advanced_v0" in items["privilege:VELLUM_SAVE_TO_CASE"]["plans"]


def test_the_static_pass_reads_a_planted_privilege_and_plan(plant, sources):
    root = plant(
        sources.hq,
        ["corehq/privileges.py", "corehq/apps/accounting/bootstrap/features.py"],
        {
            "corehq/privileges.py": ("\nDATA_CLEANUP = ", "\nPLANTED_PRIVILEGE = 'planted_privilege'\nDATA_CLEANUP = "),
            "corehq/apps/accounting/bootstrap/features.py": (
                "\nenterprise_v0 = ",
                "\nplanted_v0 = standard_v2 + [\n    privileges.PLANTED_PRIVILEGE,\n]\nenterprise_v0 = ",
            ),
        },
    )
    constants = privilege_constants(root / "corehq/privileges.py")
    plans = plan_allocations(root / "corehq/apps/accounting/bootstrap/features.py")
    assert constants["PLANTED_PRIVILEGE"] == "planted_privilege"
    assert "PLANTED_PRIVILEGE" in plans["planted_v0"] and set(plans["standard_v2"]) < set(plans["planted_v0"])
    # The copy without the plant reads as the pinned files do.
    assert "PLANTED_PRIVILEGE" not in privilege_constants(sources.hq / "corehq/privileges.py")
