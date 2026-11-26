"""Run the registered badge variant through native authoring independently."""

from proof.matrix import registry
from proof.matrix.author import authored
from proof.matrix.test_retained import _hold_variant


def test_hq_menu_overridden_generated_badge_has_its_exact_refusal(hq, core_runner, editor_driver, documents):
    base = next(base for base in registry.BASES if base.id == "hq-menus")
    variant = next(row for row in registry.load_variants() if row.id == "hq-menus/translation-overrides-a-menu-badge")
    made = authored(base, documents=documents, driver=editor_driver, core_runner=core_runner, variants=[variant])
    result, = made.variants
    assert _hold_variant(result) is None, _hold_variant(result)
