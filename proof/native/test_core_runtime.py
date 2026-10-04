"""CommCare Core runs Nova's exports, and HQ's regeneration of them, as each proof class states.

Contract: each JUnit class in ``proof/native/core`` passes in Core's own test
build at the pin, over its family's artifacts from both export paths (the
CCZ and HQ's regeneration). Each class states its own contract (form entry
and submission into Core's case storage, suite parsing, session and query
manager behavior, fixture installation, media resources) and keeps its own
negative controls (the retained pre-fix controls under ``core/resources``).
Gradle runs every class once per session (``NativeSession.core``), after
every family's producer and HQ step; this test reports one class's JUnit
results, naming each method that failed and anything that failed before it
(its producer, its HQ step). The plausible failures: a proof class that no
longer compiles against Core at the pin, a method that fails, a class whose
tests silently stopped running (a class that reports no test, or skips one,
fails here), and a class Gradle runs that no test here reports.
"""

import pytest

from proof.native.families import CORE_CLASSES

FAMILIES = tuple(sorted(set(CORE_CLASSES.values())))


@pytest.mark.parametrize("junit_class", sorted(CORE_CLASSES))
def test_core_runs_the_proof_class(native, junit_class):
    run = native.core()
    upstream = native.upstream_failures(CORE_CLASSES[junit_class])
    before = "\nBefore Core, the family failed:\n  " + "\n  ".join(upstream) if upstream else ""
    result = run.classes.get(junit_class)
    if result is None or not result.tests:
        pytest.fail(
            f"Core's Gradle build reported no tests for {junit_class}, so nothing it states was checked. "
            f"Gradle's output is in {run.log}.{before}",
            pytrace=False,
        )
    problems = result.problems()
    if problems:
        pytest.fail(
            f"{junit_class} ({len(problems)} of {len(result.tests)} tests) did not pass in Core:\n"
            + "\n".join(f"  {test.name} {test.outcome}: {test.message}\n{_indent(test.detail)}" for test in problems)
            + before,
            pytrace=False,
        )


def _indent(detail, limit=40):
    lines = detail.strip().splitlines()[:limit]
    return "\n".join(f"      {line}" for line in lines)


def test_gradle_runs_exactly_the_listed_classes(native):
    """Every proof class Gradle runs is one this module reports, and each listed class ran."""
    run = native.core()
    unlisted = sorted(set(run.classes) - set(CORE_CLASSES))
    missing = sorted(set(CORE_CLASSES) - set(run.classes))
    assert not unlisted and not missing, (
        f"Core's Gradle build ran {unlisted or 'no'} proof classes that proof/native/families.py::CORE_CLASSES does "
        f"not list, and reported nothing for {missing or 'none'} of those it lists. List each class of "
        "proof/native/core with the family it reads, so a failure there names it."
    )
