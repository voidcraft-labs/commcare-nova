"""CommCare Core runs Nova's exports, and HQ's regeneration of them, as each proof class states.

Contract: each JUnit class in ``proof/native/core`` passes in Core's own test
build at the pin, over its family's exports or wire controls. Each class
states which paths it reads and its contract (form entry
and submission into Core's case storage, suite parsing, session and query
manager behavior, fixture installation, media resources) and keeps its own
negative controls (the retained pre-fix controls under ``core/resources``).
Gradle runs every class once per session, once per zone for a zoned class
(``NativeSession.core``), after every family's producer and HQ step; this test reports one class's JUnit
results, naming each method that failed and anything that failed before it
(its producer, its HQ step). The plausible failures: a proof class that no
longer compiles against Core at the pin, a method that fails, a class whose
tests silently stopped running (a class that reports no test, or skips one,
fails here), and a class Gradle runs that no test here reports.
"""

import pytest

from proof.native.families import CORE_CLASSES, ZONED_CLASSES, ZONES

FAMILIES = tuple(sorted(set(CORE_CLASSES.values())))


@pytest.mark.parametrize(
    ("junit_class", "zone"),
    [
        pytest.param(name, zone.label if zone else None, id=f"{name}[{zone.label}]" if zone else name)
        for name in sorted(CORE_CLASSES)
        for zone in ZONED_CLASSES.get(name, (None,))
    ],
)
def test_core_runs_the_proof_class(native, junit_class, zone):
    run = native.core()
    upstream = native.upstream_failures(CORE_CLASSES[junit_class])
    before = "\nBefore Core, the family failed:\n  " + "\n  ".join(upstream) if upstream else ""
    name = f"{junit_class}[{zone}]" if zone else junit_class
    result = run.zoned.get((junit_class, zone)) if zone else run.classes.get(junit_class)
    if result is None or not result.tests:
        pytest.fail(
            f"Core's Gradle build reported no tests for {name}, so nothing it states was checked. "
            f"Gradle's output is in {run.log}.{before}",
            pytrace=False,
        )
    problems = result.problems()
    if problems:
        pytest.fail(
            f"{name} ({len(problems)} of {len(result.tests)} tests) did not pass in Core:\n"
            + "\n".join(f"  {test.name} {test.outcome}: {test.message}\n{_indent(test.detail)}" for test in problems)
            + before,
            pytrace=False,
        )


def _indent(detail, limit=40):
    lines = detail.strip().splitlines()[:limit]
    return "\n".join(f"      {line}" for line in lines)


def test_gradle_runs_exactly_the_listed_classes(native):
    """Every listed class ran once, once per zone for a zoned class, and no other class or zone ran."""
    run = native.core()
    unzoned = set(CORE_CLASSES) - set(ZONED_CLASSES)
    expected_zoned = {(name, zone.label) for name, zones in ZONED_CLASSES.items() for zone in zones}
    unlisted = sorted(set(run.classes) - unzoned)
    missing = sorted(unzoned - set(run.classes))
    extra_zoned = sorted(set(run.zoned) - expected_zoned)
    missing_zoned = sorted(expected_zoned - set(run.zoned))
    unknown_zones = sorted(set(run.zone_directories) - {zone.label for zone in ZONES})
    unmapped = sorted(set(ZONED_CLASSES) - set(CORE_CLASSES))
    assert not (unlisted or missing or extra_zoned or missing_zoned or unknown_zones or unmapped), (
        "Core's Gradle build must run every CORE_CLASSES entry exactly in the JVMs ZONED_CLASSES names. "
        f"Unexpected suite classes (including any zoned class): {unlisted}; missing suite classes: {missing}; "
        f"unexpected (class, zone) results: {extra_zoned}; missing (class, zone) results: {missing_zoned}; "
        f"unknown zone directories: {unknown_zones}; zoned classes with no family: {unmapped}. "
        f"Gradle's output is in {run.log}."
    )
