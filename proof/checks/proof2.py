"""Proof 2, build equivalence: ``build(A)`` against ``build(B)`` for a publish with no edit.

B is aligned to A first (``proof.observe.alignment``), so identity is judged
once, by proof 1. Then everything HQ's build returns is compared:

- both ``validate_app()`` results (``validate_app``, as JSON) and what each
  build step raised (``build``, as JSON), each after the spelling rules
  registered for its artifact;
- every file ``create_all_files()`` and each build profile's
  ``create_all_files(build_profile_id)`` wrote, each parsed by its comparator
  (``proof.checks.compare.build_files``, which refuses a file it has no
  comparator for), after the registered spelling rules, with the version
  clause (``proof.checks.compare.versions``) deciding which version numbers
  may differ: HQ's own ``set_form_versions`` set each form's, with
  ``build(A)`` as the previous build.

The alignment must leave none of B's identities in what HQ built from the
aligned copy, or proof 2 would judge identity again (``AlignmentIncomplete``).

Where there is no B to compare because HQ refused a publish, the bar reports
the refusal (``import@<state>``) and proof 2 reports nothing more (decision
12: one class per symptom); a state missing for any other reason is a
refusal naming it (``build`` ``/no-<state>``).

The comparison itself is the observation's (``proof.observe.builds``), which
makes it with no rule to decide whether B's sessions run; this module makes
it after the registered rules and judges the records.
"""

from __future__ import annotations

from proof.checks.differences import Difference
from proof.observe import builds
from proof.rules import RULES


def parsed_build(outcome, rules=None):
    """Every file of one build, default and build profiles, parsed; keyed by the path HQ gave it.

    ``rules`` are the spelling rules applied (the registered set when None,
    ``()`` for the raw files; ``proof.observe.builds.parsed_build``).
    """
    return builds.parsed_build(outcome, rules=RULES if rules is None else rules)


def build_equivalence(document, observed, rules=None):
    """Every difference between ``build(A)`` and the build of B aligned to A.

    ``rules`` are the spelling rules applied (the registered set when None);
    the observation compares the raw builds (``()``) to decide whether B's
    sessions run, and the judge compares after the registered rules.
    """
    if observed.a is None or observed.b is None or observed.b_aligned is None:
        refused = {refusal.state for refusal in observed.refusals}
        missing = [name for name, held in (("A", observed.a), ("B", observed.b)) if held is None] or ["B-aligned"]
        if any(name in refused for name in missing):
            return []
        cause = f"/no-{missing[0]}"
        return [Difference("proof2", document, "build", cause, cause, "refused", None, f"No {missing[0]} to compare.")]
    return build_differences(document, observed.a.build, observed.b_aligned, observed.alignment, rules=rules)


def build_differences(document, before, after, alignment, *, rules=None):
    """Every difference between two builds, the second built from an app aligned to the first's by ``alignment``
    (``proof.observe.builds.build_differences``; ``rules`` the registered set when None)."""
    return builds.build_differences(document, before, after, alignment, rules=RULES if rules is None else rules)


def document_build_equivalence(document, records):
    """Proof 2's differences on one document: each configuration it is exported under, judged from its records."""
    from proof.checks import observations

    found = []
    for name in sorted(document.exports):
        found += build_equivalence(document.id, observations.republish_view(records, name))
    return found + observations.soft_assertion_differences(records, "proof2")
