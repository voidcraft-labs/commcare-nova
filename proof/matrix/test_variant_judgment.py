"""How ``proof/matrix/test_retained.py`` judges a variant's reading against its row, with no HQ.

The contract: a holding row's fragment speaks of an entity the reading holds,
so a fragment whose key names no menu, form or field of the reading fails
whatever its value, and a null value holds only where the entity the key names
holds nothing at the pointer (``proof/reader/cli.ts::heldOf`` answers ``named``
beside ``found``); and the rows the lane's manifest check decides of a base are
held both ways to ``proof/matrix/parity-decided.json``. The plausible
failures: a null fragment passing because the bundle answers ``found: null``
for a key it does not resolve exactly as for an absent value, so a mistyped
key, or a reader that drops the entity, holds; and a change to
``parity.added_uses`` or ``row_uses`` that makes every row's judged uses empty,
which leaves the join no use to judge and passes every base.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from proof.matrix import registry
from proof.matrix.retain import VariantOutcome
from proof.matrix.test_retained import (
    PARITY_DECIDED,
    _hold_variant,
    decided_rows_message,
    parity_decided,
)

KEY = json.dumps(["form", "http://openrosa.org/formdesigner/planted"])
ENTRY = "forms-and-case-writes/comment"


def _outcome(held, holds):
    variant = SimpleNamespace(id="hq-plain/planted", entry=ENTRY, hq_never_serves=None, refusing=False)
    claims = json.dumps({ENTRY: 1})
    return VariantOutcome(variant, answer={"kind": "read", "claims": claims, "held": held}, holds=holds)


def test_a_null_fragment_of_a_key_the_reading_holds_nothing_under_fails():
    hold = {"key": KEY, "pointer": "/default_value", "value": None}
    unnamed = _outcome([{"key": KEY, "pointer": "/default_value", "named": False, "found": None}], [hold])
    message = _hold_variant(unnamed)
    assert message is not None and KEY in message and "names no menu, form or field" in message
    # An answer from before the bundle said whether it named the key is no evidence either.
    assert _hold_variant(_outcome([{"key": KEY, "pointer": "/default_value", "found": None}], [hold])) is not None


def test_a_null_fragment_of_an_entity_that_holds_nothing_there_holds():
    hold = {"key": KEY, "pointer": "/default_value", "value": None}
    named = _outcome([{"key": KEY, "pointer": "/default_value", "named": True, "found": None}], [hold])
    assert _hold_variant(named) is None
    # The same entity holding a value there does not hold a null fragment.
    holding = _outcome([{"key": KEY, "pointer": "/default_value", "named": True, "found": "x"}], [hold])
    assert "does not hold what its row says" in _hold_variant(holding)


def test_the_rows_the_manifest_check_decides_are_held_both_ways():
    committed = {"hq-plain": ["hq-plain/a", "hq-plain/b"]}
    assert decided_rows_message("hq-plain", ["hq-plain/a", "hq-plain/b"], committed) is None
    # Every row's judged uses empty: each row it decided is named as decided by nothing.
    lost = decided_rows_message("hq-plain", [], committed)
    assert "no longer decides hq-plain/a and hq-plain/b" in lost
    gained = decided_rows_message("hq-plain", ["hq-plain/a", "hq-plain/b", "hq-plain/c"], committed)
    assert "now decides hq-plain/c" in gained and "no longer" not in gained
    assert "names no rows of the base hq-other" in decided_rows_message("hq-other", [], committed)


def test_the_committed_rows_name_every_base_and_only_rows_of_it():
    decided = parity_decided()
    assert sorted(decided) == sorted(base.id for base in registry.BASES), PARITY_DECIDED
    rows = {variant.id: variant.base for variant in registry.load_variants()}
    wrong = sorted(row for base, names in decided.items() for row in names if rows.get(row) != base)
    assert not wrong, f"{PARITY_DECIDED} names rows that are no row of the base it lists them under: {wrong}"
    assert all(names == sorted(set(names)) for names in decided.values())
