"""The closed set of spelling rules the comparators apply (proof/README.md).

A spelling rule erases exactly one difference in how an artifact is spelled
that no reader of it depends on: HQ's build output and Core's run, and,
where a spelling's readers are others the lane runs (Formplayer, HQ's
Connect repeater and Connect's receiver), those. Each rule is a
module here, ``proof/rules/<rule>.py``, exporting
``RULE = SpellingRule(id, artifact_glob, description, normalize)``, where
``normalize(parsed_artifact) -> parsed_artifact`` takes the artifact as the
comparators parse it (an lxml root for XML, a dict for app strings, a JSON
value otherwise) and returns it with that one spelling made canonical; a rule
that holds only under a condition states it and leaves the artifact as it is
elsewhere. Each has its own proof test, ``proof/rules/test_<rule>.py``, that
builds (HQ) or runs (Core) both spellings of a corpus document and asserts
identical output or traces, and, for a conditional rule, that the two differ
where the condition does not hold. A module whose name starts with ``_`` is a
helper the rule modules share (``_xforms``, ``_app``, and ``_xpath``, through
which a rule reads an XPath expression's shape as Core's lexer does), not a
rule.

``RULES`` lists every registered rule, in the order the comparators apply
them, and the comparators apply those and no others: a rule module that is
not listed, or a listed rule without its own test, fails
``unregistered_rules``.
"""

from __future__ import annotations

import copy
import fnmatch
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

RULES_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class SpellingRule:
    id: str
    # The artifacts the rule applies to, as a glob over artifact names
    # (``form:*``, ``suite.xml``, ``app_strings:*``), or a tuple of globs, any of which names one.
    artifact_glob: str | tuple[str, ...]
    description: str
    normalize: Callable[[object], object]

    def applies_to(self, artifact: str) -> bool:
        globs = (self.artifact_glob,) if isinstance(self.artifact_glob, str) else self.artifact_glob
        return any(fnmatch.fnmatchcase(artifact, glob) for glob in globs)


# The registered rules, in the order they apply: every rule module imports ``SpellingRule`` from here, so the
# modules are imported after it is defined.
from proof.rules import (  # noqa: E402
    add_ons,
    case_block_position,
    case_list_form_unset,
    case_references_load,
    column_tab_keys,
    condition_operator_default,
    connect_work_area_empty,
    detail_null_booleans,
    empty_binds,
    empty_media_maps,
    form_link_fallback,
    inactive_parent_select,
    itext_value_order,
    lookup_fields_unshown,
    model_order,
    preload_condition,
    profile_custom_properties,
    profile_features_users,
    profile_required_minimal,
    profile_unread_properties,
    required_condition,
    search_title_empty,
    select_string_type,
    setvalue_order,
    sort_blanks_default,
    sort_calculation_pair,
    sort_display_empty,
    sort_type_plain,
    subcase_empty_strings,
    tile_cell_fields,
    update_never_beside_actions,
    vellum_alert,
    vellum_attributes,
    vellum_hashtags,
)

RULES: tuple[SpellingRule, ...] = (
    # A form, stored or built: Vellum's own markup first, then what Core reads alike in either spelling.
    vellum_attributes.RULE,
    vellum_hashtags.RULE,
    required_condition.RULE,
    vellum_alert.RULE,
    # Before empty_binds: a select's bind left with its node set alone is then an empty bind.
    select_string_type.RULE,
    empty_binds.RULE,
    itext_value_order.RULE,
    model_order.RULE,
    setvalue_order.RULE,
    # A form's data as Connect reads it: the one rule whose readers are HQ's repeater and Connect's receiver.
    connect_work_area_empty.RULE,
    # HQ's app document, and the suite where it builds the same reading.
    case_references_load.RULE,
    add_ons.RULE,
    profile_features_users.RULE,
    profile_custom_properties.RULE,
    empty_media_maps.RULE,
    case_list_form_unset.RULE,
    detail_null_booleans.RULE,
    column_tab_keys.RULE,
    tile_cell_fields.RULE,
    lookup_fields_unshown.RULE,
    inactive_parent_select.RULE,
    preload_condition.RULE,
    condition_operator_default.RULE,
    form_link_fallback.RULE,
    update_never_beside_actions.RULE,
    subcase_empty_strings.RULE,
    sort_display_empty.RULE,
    sort_type_plain.RULE,
    search_title_empty.RULE,
    sort_blanks_default.RULE,
    sort_calculation_pair.RULE,
    # A built profile.
    profile_unread_properties.RULE,
    # A session trace.
    profile_required_minimal.RULE,
    case_block_position.RULE,
)


def rules_for(artifact: str, rules=None):
    """The registered rules' normalizers for one artifact, in registration order."""
    return tuple(rule.normalize for rule in (RULES if rules is None else rules) if rule.applies_to(artifact))


def normalized(artifact: str, parsed, rules=None):
    """A copy of one parsed artifact with every registered rule for it applied, in registration order."""
    value = copy.deepcopy(parsed)
    for normalize in rules_for(artifact, rules):
        value = normalize(value)
    return value


def unregistered_rules(rules_dir: Path = RULES_DIR, rules=None):
    """Why the rule set is not closed, as person-readable problems; empty when it is.

    Every module in the rules directory other than its tests, its conftest
    and its private helpers (a name starting with ``_``) is a rule that must
    be registered, every registered rule must be one of those modules, and
    every rule module must have its own proof test beside it.
    """
    rules = RULES if rules is None else rules
    modules = {
        path.stem
        for path in rules_dir.glob("*.py")
        if not path.stem.startswith(("_", "test_")) and path.stem != "conftest"
    }
    registered = {}
    problems = []
    for rule in rules:
        module = getattr(rule.normalize, "__module__", "").rpartition(".")[2]
        registered[rule.id] = module
        if module not in modules:
            problems.append(
                f"The rule {rule.id} is registered, and its normalizer lives in {rule.normalize.__module__},"
                f" not in a rule module in {rules_dir}. Move it into proof/rules/<rule>.py."
            )
    for module in sorted(modules):
        if module not in registered.values():
            problems.append(
                f"proof/rules/{module}.py is a rule module that RULES does not list, so no comparator applies it."
                " List its RULE in proof/rules/__init__.py or remove the module."
            )
        if not (rules_dir / f"test_{module}.py").exists():
            problems.append(
                f"proof/rules/{module}.py has no proof test (proof/rules/test_{module}.py) showing HQ's build"
                " or Core's run does not depend on the spelling it erases."
            )
    ids = [rule.id for rule in rules]
    for rule_id in sorted({i for i in ids if ids.count(i) > 1}):
        problems.append(f"Two registered rules share the id {rule_id}.")
    return problems
