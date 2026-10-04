"""The spelling rules are a closed set: every rule is registered, and every registered rule is proven.

Contract (plan work item 11, "Spelling rules"): the comparators apply only
the rules ``proof/rules/__init__.py::RULES`` lists, each rule is a module of
its own here with its own proof test (a module whose name starts with ``_``
is a helper the rule modules share, and no rule), and nothing else erases a
difference.
The plausible failures: a rule module nobody registered (so the comparators
never apply what it claims), a registered normalizer living outside a rule
module, and a rule without the test that shows HQ's build or Core's run
does not depend on what it erases.

The rules directory itself is checked, and the checker is shown to refuse
each of those on a directory built for the purpose, beside one it accepts,
and a rule's globs to name exactly the artifacts they match.
"""

from __future__ import annotations

import importlib.util
import sys

from proof.rules import RULES, SpellingRule, rules_for, unregistered_rules


def test_the_rule_set_is_closed():
    assert unregistered_rules() == []
    assert all(rule.id for rule in RULES)


def _load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[path.stem] = module
    try:
        spec.loader.exec_module(module)
    finally:
        del sys.modules[path.stem]
    return module


def test_the_checker_refuses_an_unregistered_or_unproven_rule(tmp_path):
    rule_file = tmp_path / "attribute_case.py"
    rule_file.write_text(
        "def normalize(root):\n    return root\n",
        encoding="utf-8",
    )
    rule = SpellingRule("attribute-case", "suite.xml", "A rule built for this test.", _load(rule_file).normalize)

    assert any("does not list" in p for p in unregistered_rules(tmp_path, rules=()))
    assert any("has no proof test" in p for p in unregistered_rules(tmp_path, rules=(rule,)))

    (tmp_path / "test_attribute_case.py").write_text("def test_placeholder():\n    pass\n", encoding="utf-8")
    assert unregistered_rules(tmp_path, rules=(rule,)) == []

    # A private helper the rule modules share is no rule.
    (tmp_path / "_helpers.py").write_text("ROOT = 'h:html'\n", encoding="utf-8")
    assert unregistered_rules(tmp_path, rules=(rule,)) == []

    outside = SpellingRule("outside", "suite.xml", "A normalizer outside the rules directory.", lambda root: root)
    assert any("not in a rule module" in p for p in unregistered_rules(tmp_path, rules=(rule, outside)))
    assert any("share the id" in p for p in unregistered_rules(tmp_path, rules=(rule, rule)))


def test_a_rule_applies_to_the_artifacts_its_glob_names():
    rule = SpellingRule("forms-only", "form:*", "A rule built for this test.", lambda root: root)
    assert rules_for("form:0.1", rules=(rule,)) == (rule.normalize,)
    assert rules_for("p1/form:0.1", rules=(rule,)) == ()
    assert rules_for("suite.xml", rules=(rule,)) == ()
    # A tuple of globs names every artifact any of them names.
    both = SpellingRule("forms", ("form:*", "*/form:*"), "A rule built for this test.", lambda root: root)
    assert rules_for("p1/form:0.1", rules=(both,)) == (both.normalize,)
    assert rules_for("local:form:0.1", rules=(both,)) == ()
