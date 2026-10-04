"""The spelling rules a comparison is given, applied to one parsed artifact.

A comparator reads the rules its caller hands it and never the registry:
the judges hand it the registered set (``proof.rules.RULES``), and the
observation, which decides from raw builds whether B's sessions run
(``proof.observe.builds``), hands it none. So what the observation records
does not depend on which rules are registered, and registering a rule
changes judgments only.

A rule is anything with ``applies_to(artifact)`` and ``normalize(parsed)``
(``proof.rules.SpellingRule``), applied in the order given.
"""

from __future__ import annotations

import copy


def normalizers(artifact: str, rules):
    """The normalizers of the rules that apply to ``artifact``, in the order given."""
    return tuple(rule.normalize for rule in rules if rule.applies_to(artifact))


def normalized(artifact: str, parsed, rules):
    """A copy of one parsed artifact with each given rule for it applied, in the order given."""
    value = copy.deepcopy(parsed)
    for normalize in normalizers(artifact, rules):
        value = normalize(value)
    return value
