"""The closed set of spelling rules the comparators apply (proof/README.md).

A spelling rule erases exactly one difference in how an artifact is spelled
that no reader of it depends on. Each rule is a module here,
``proof/rules/<rule>.py``, exporting
``RULE = SpellingRule(id, artifact_glob, description, normalize, readers)``,
where ``normalize(parsed_artifact) -> parsed_artifact`` takes the artifact
as the comparators parse it (an lxml root for XML, a dict for app strings, a
JSON value otherwise) and returns it with that one spelling made canonical;
a rule that holds only under a condition states it and leaves the artifact
as it is elsewhere.

Each rule is proven by tests that run every reader of its spelling on both
spellings. Its own test, ``proof/rules/test_<rule>.py``, builds (HQ) or
runs (Core) both spellings of a corpus document and asserts identical
output or traces, and, for a conditional rule, that the two differ where
the condition does not hold. Where the spelling has readers beyond HQ's
build and Core's run, the rule names each in ``readers`` with the test that
runs it on both spellings (``READERS``):

- ``formplayer``, ``webapps`` and ``connect`` are run inside the image, so
  the test is a function of the rule's own test module (Formplayer's walk
  of both spellings served by HQ's own views, the Web Apps client's screens
  on them, HQ's Connect repeater and Connect's receiver);
- ``android`` is CommCare Android's own code, which runs only where its
  reader's runtime does (``proof/android``, the job that builds or restores
  that runtime, on every run): the test is a method of
  ``proof/android/predicates.py``, which installs both spellings on a
  device.

A module whose name starts with ``_`` is a helper the rule modules share
(``_xforms``, ``_app``, and ``_xpath``, through which a rule reads an XPath
expression's shape as Core's lexer does), not a rule.

``RULES`` lists every registered rule, in the order the comparators apply
them, and the comparators apply those and no others: a rule module that is
not listed, a listed rule without its own test, or a rule naming a reader
whose test does not exist fails ``unregistered_rules``.
"""

from __future__ import annotations

import ast
import copy
import fnmatch
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

RULES_DIR = Path(__file__).resolve().parent
# Where CommCare Android's own code is held on both spellings of a rule (``READERS``).
ANDROID_PREDICATES = RULES_DIR.parent / "android" / "predicates.py"
# The readers a rule may name beyond HQ's build and Core's run, which every rule's own test runs: the three the
# image runs, each proven by a test of the rule's own test module, and Android, proven by a method of
# ``ANDROID_PREDICATES``.
IMAGE_READERS = ("formplayer", "webapps", "connect")
ANDROID = "android"
READERS = (*IMAGE_READERS, ANDROID)
# The artifacts only one reader gives, so a rule that reads one names that reader, and the reader that reads
# what it hands on: Formplayer's answers are the Web Apps client's input.
ARTIFACT_READERS = {"formplayer": ("formplayer", "webapps"), "instance": ("formplayer",)}


@dataclass(frozen=True)
class SpellingRule:
    id: str
    # The artifacts the rule applies to, as a glob over artifact names
    # (``form:*``, ``suite.xml``, ``app_strings:*``), or a tuple of globs, any of which names one.
    artifact_glob: str | tuple[str, ...]
    description: str
    normalize: Callable[[object], object]
    # Each reader of the spelling beyond HQ's build and Core's run (one of ``READERS``), with the name of the
    # test that runs it on both spellings.
    readers: tuple[tuple[str, str], ...] = ()

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
    search_description_empty,
    search_title_empty,
    select_string_type,
    setvalue_order,
    sort_blanks_default,
    sort_calculation_pair,
    sort_display_empty,
    sort_type_plain,
    subcase_empty_strings,
    tile_cell_fields,
    tile_vertical_align_start,
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
    # After tile_cell_fields: what is left of a cell is a custom tile's, whose start every runtime reads as none.
    tile_vertical_align_start.RULE,
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
    # Read by Formplayer, the Web Apps client and Android beside HQ's build and Core.
    search_description_empty.RULE,
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


def _test_names(path: Path) -> set[str]:
    """Every test function a Python file defines, at its top level or as a method of a class (read with ``ast``,
    never imported: Android's predicates import nothing the image holds a runtime for)."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return set()
    return {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")
    }


def _reader_problems(rule, module, rules_dir, android_predicates):
    """Why a rule's ``readers`` do not each name a test that exists, and a reader its artifacts need."""
    problems = []
    named = dict(rule.readers)
    if len(named) != len(rule.readers):
        problems.append(f"The rule {rule.id} names one reader twice in its readers.")
    own = _test_names(rules_dir / f"test_{module}.py")
    for reader, test in rule.readers:
        if reader not in READERS:
            problems.append(f"The rule {rule.id} names the reader {reader!r}, which is not one of {list(READERS)}.")
        elif reader == ANDROID and test not in _test_names(android_predicates):
            problems.append(
                f"The rule {rule.id} names {test} as the test that runs CommCare Android on both spellings, and"
                f" {android_predicates.name} holds no such test."
            )
        elif reader != ANDROID and test not in own:
            problems.append(
                f"The rule {rule.id} names {test} as the test that runs {reader} on both spellings, and"
                f" proof/rules/test_{module}.py holds no such test."
            )
    for artifact, needed in ARTIFACT_READERS.items():
        if rule.applies_to(artifact):
            for reader in needed:
                if reader not in named:
                    problems.append(
                        f"The rule {rule.id} reads the artifact {artifact!r}, which {reader} reads, and names no"
                        f" test that runs {reader} on both spellings."
                    )
    return problems


def unregistered_rules(rules_dir: Path = RULES_DIR, rules=None, android_predicates: Path = ANDROID_PREDICATES):
    """Why the rule set is not closed, as person-readable problems; empty when it is.

    Every module in the rules directory other than its tests, its conftest
    and its private helpers (a name starting with ``_``) is a rule that must
    be registered, every registered rule must be one of those modules,
    every rule module must have its own proof test beside it, and every
    reader a rule names beyond HQ's build and Core's run must name a test
    that exists (``_reader_problems``).
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
        problems += _reader_problems(rule, module, rules_dir, android_predicates)
    for module in sorted(modules):
        if module not in registered.values():
            problems.append(
                f"proof/rules/{module}.py is a rule module that RULES does not list, so no comparator applies it."
                " List its RULE in proof/rules/__init__.py or remove the module."
            )
        if not (rules_dir / f"test_{module}.py").exists():
            problems.append(
                f"proof/rules/{module}.py has no proof test (proof/rules/test_{module}.py) showing no reader of"
                " the spelling it erases depends on it."
            )
    ids = [rule.id for rule in rules]
    for rule_id in sorted({i for i in ids if ids.count(i) > 1}):
        problems.append(f"Two registered rules share the id {rule_id}.")
    return problems
