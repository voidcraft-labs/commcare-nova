"""Two of HQ's builds compared, the second built from an app aligned to the first's: proof 2's comparison.

``build_differences`` compares both ``validate_app()`` results and what each
build step raised (as JSON), then every file both builds wrote, default and
build profiles, each parsed by its comparator
(``proof.checks.compare.build_files``), with the version clause
(``proof.checks.compare.versions``) deciding which version numbers may
differ. Every comparison reads each artifact after the spelling rules it is
given (``rules``, ``proof.checks.compare.spelling``).

The observation compares the raw builds (``rules=()``) to decide whether
B's sessions run (``proof.observe.unit``: they run wherever the raw builds
differ), so that decision reads no registered rule and registering one
changes no record. The judge (``proof.checks.proof2``) compares the same
builds after the registered rules, which only narrow what differs.

The alignment must leave none of B's identities in what HQ built from the
aligned copy, or proof 2 would judge identity again (``AlignmentIncomplete``).
"""

from __future__ import annotations

from proof.checks.compare.build_files import compare_parsed_builds, parse_build_files
from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.spelling import normalized
from proof.checks.compare.versions import apply_version_clause
from proof.observe.alignment import AlignmentIncomplete, leftover_identities


def parsed_build(outcome, *, rules):
    """Every file of one build, default and build profiles, parsed after ``rules``; keyed by the path HQ gave it.

    A build profile's paths are already under ``<profile id>/``
    (``Application.create_all_files``), so they sit beside the default
    build's.
    """
    parsed = parse_build_files(outcome.files or {}, rules=rules)
    for profile_id, files in sorted(outcome.profile_files.items()):
        for path, built in parse_build_files(files, profile_id=profile_id, rules=rules).items():
            if path in parsed:
                raise ValueError(f"HQ's build of the profile {profile_id} and another build both wrote {path}.")
            parsed[path] = built
    return parsed


def build_differences(document, before, after, alignment, *, rules):
    """Every difference between two builds, the second built from an app aligned to the first's by ``alignment``."""
    found = []
    for artifact, value_a, value_b in (
        ("validate_app", before.errors, after.errors),
        ("build", before.raised, after.raised),
    ):
        found += compare_json(
            normalized(artifact, value_a, rules),
            normalized(artifact, value_b, rules),
            check="proof2",
            document=document,
            artifact=artifact,
        )
    parsed_a, parsed_b = parsed_build(before, rules=rules), parsed_build(after, rules=rules)
    leftovers = leftover_identities(parsed_b, alignment)
    if leftovers:
        raise AlignmentIncomplete(
            f"B's identities remain in what HQ built from B aligned to A, so proof 2 would judge identity"
            f" again: {leftovers[:10]}. proof/observe/alignment.py maps only values equal to an identity; look"
            " for a reference it did not reach."
        )
    parsed_a, parsed_b = apply_version_clause(
        parsed_a,
        parsed_b,
        app_version_before=before.app_version,
        app_version_after=after.app_version,
    )
    found += compare_parsed_builds(parsed_a, parsed_b, check="proof2", document=document)
    return found


def raw_builds_differ(document, before, after, alignment):
    """Whether the raw builds differ (``build_differences`` with no spelling rule), a refusal aside."""
    return any(
        difference.kind != "refused" for difference in build_differences(document, before, after, alignment, rules=())
    )
