"""What the checks' own tests share."""

from __future__ import annotations

import pytest


@pytest.fixture
def without_spelling_rules(monkeypatch):
    """No spelling rule registered, for a test of a judge's own mechanics.

    Each registered rule's own test proves what it erases (``proof/rules``);
    a test that holds what a judge reports of a difference a rule may read
    as a spelling (``requiredMinimal`` ``"0"`` against none, a ``vellum:``
    attribute, an operator null against ``=``) judges with none: the
    registry, and the names the judges import it under.
    """
    from proof import rules
    from proof.checks import proof2, proof3

    for module in (rules, proof2, proof3):
        monkeypatch.setattr(module, "RULES", ())
