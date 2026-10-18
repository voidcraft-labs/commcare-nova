"""The Gradle boundary preserves every requested context and every report it writes.

Contract: one build requests the suite and each zone's own classes, while
the media certificate requests no zone. JUnit reports of the same class in
different JVMs remain distinct, and an unexpected or duplicate report stays
visible. The plausible failures are a lost provider field in the command,
the default suite running in place of a zone, and a later passing XML
silently replacing another JVM's failure before pytest can report it.
The resource directory must never contain a report output: Gradle correctly
refuses that implicit dependency between otherwise independent test JVMs.

These checks need no Gradle or HQ: command arguments and JUnit XML are the
two external formats the adapter writes and reads. The actual zone and
provider are asserted by each zoned class in Core's own test JVM.
"""

from pathlib import Path

import pytest

from proof.native import core_suite
from proof.native.families import MEDIA_CERTIFICATE, ZONES
from proof.native.session import NativeSession


def test_the_build_requests_each_contexts_own_classes_and_keeps_the_certificate_unzoned(tmp_path, monkeypatch):
    monkeypatch.setattr(
        core_suite,
        "ZONED_CLASSES",
        {"InstantOrderingRuntimeTest": ZONES, "OnlyUtcRuntimeTest": (ZONES[0],)},
    )
    native = tmp_path / "native"
    reports = tmp_path / "native-core" / "suite" / "junit"
    command = core_suite.core_tests_command("*", native_dir=native, reports=reports, zones=ZONES)
    assert command.count("test") == 1 and command.count("novaZones") == 1
    assert command[command.index("--tests") + 1] == "nova.compatibility.*"
    rows = next(arg.removeprefix("-PnovaProofZones=") for arg in command if arg.startswith("-PnovaProofZones="))
    assert rows.split(";") == [
        "utc|UTC||false|InstantOrderingRuntimeTest+OnlyUtcRuntimeTest",
        "new-york|America/New_York||false|InstantOrderingRuntimeTest",
        "kolkata|Asia/Kolkata||false|InstantOrderingRuntimeTest",
        "kiritimati|Pacific/Kiritimati||false|InstantOrderingRuntimeTest",
        "formplayer-new-york|UTC|America/New_York|false|InstantOrderingRuntimeTest",
        "formplayer-kolkata|UTC|Asia/Kolkata|false|InstantOrderingRuntimeTest",
        "formplayer-new-york-offset|UTC|America/New_York|true|InstantOrderingRuntimeTest",
    ]
    certificate = core_suite.core_tests_command(MEDIA_CERTIFICATE, native_dir=native, reports=reports)
    assert "novaZones" not in certificate
    assert not any(arg.startswith("-PnovaProofZones=") for arg in certificate)
    assert certificate[certificate.index("--tests") + 1] == f"nova.compatibility.{MEDIA_CERTIFICATE}"


def _report(directory, filename, outcome=""):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / filename).write_text(
        '<testsuite name="nova.compatibility.InstantOrderingRuntimeTest" time="1.25">'
        '<testcase name="ordersInstants" time="1.25">'
        f"{outcome}</testcase></testsuite>"
    )


def test_reports_keep_each_jvm_and_unknown_empty_zone_visible(tmp_path):
    _report(tmp_path / "suite", "TEST-suite.xml")
    _report(tmp_path / "zones" / "utc", "TEST-utc.xml")
    _report(
        tmp_path / "zones" / "new-york",
        "TEST-new-york.xml",
        '<failure message="An earlier instant sorted last">the failing assertion</failure>',
    )
    (tmp_path / "zones" / "unexpected-empty-zone").mkdir()

    classes, zoned, directories = core_suite._read_reports(tmp_path)

    assert set(classes) == {"InstantOrderingRuntimeTest"}
    assert set(zoned) == {("InstantOrderingRuntimeTest", "utc"), ("InstantOrderingRuntimeTest", "new-york")}
    assert directories == ("new-york", "unexpected-empty-zone", "utc")
    assert not classes["InstantOrderingRuntimeTest"].problems()
    assert not zoned["InstantOrderingRuntimeTest", "utc"].problems()
    failed = zoned["InstantOrderingRuntimeTest", "new-york"].problems()
    assert [(test.name, test.outcome, test.message, test.detail) for test in failed] == [
        ("ordersInstants", "failed", "An earlier instant sorted last", "the failing assertion")
    ]


@pytest.mark.parametrize("directory", ("suite", "zones/utc"))
def test_a_second_report_cannot_replace_the_first_result(tmp_path, directory):
    reports = tmp_path / directory
    _report(reports, "TEST-first.xml", '<error message="The class did not start"/>')
    _report(reports, "TEST-second.xml")
    with pytest.raises(core_suite.CoreBuildFailed, match="InstantOrderingRuntimeTest more than once"):
        core_suite._read_reports(tmp_path)


@pytest.mark.parametrize("relative", (".", "core/suite/junit"))
def test_reports_cannot_be_inside_the_classpath_input(tmp_path, relative):
    with pytest.raises(ValueError, match="outside the native resource directory"):
        core_suite.core_tests_command("*", native_dir=tmp_path, reports=tmp_path / relative, zones=ZONES)


def test_the_session_separates_resources_from_reports_and_clears_both_before_a_run(tmp_path, monkeypatch):
    native = tmp_path / "native"
    stale = native / "expression" / "stale.json"
    stale.parent.mkdir(parents=True)
    stale.write_text("old resource")
    report_root = tmp_path / "native-core" / "suite" / "junit"
    _report(report_root / "suite", "TEST-stale.xml", '<failure message="Old run"/>')
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        resources = Path(
            next(arg.removeprefix("-PnovaProofNative=") for arg in command if arg.startswith("-PnovaProofNative="))
        )
        reports = Path(
            next(arg.removeprefix("-PnovaProofReports=") for arg in command if arg.startswith("-PnovaProofReports="))
        )
        assert not reports.resolve().is_relative_to(resources.resolve())
        assert not list(reports.rglob("TEST-*.xml"))
        _report(reports / "suite", "TEST-suite.xml")
        _report(reports / "zones" / "utc", "TEST-utc.xml")
        return 0

    monkeypatch.setattr(core_suite.processes, "run", run)
    session = NativeSession(native, core_runner=None)
    try:
        assert not stale.exists() and not report_root.exists()
        result = session.core_run("suite", "*", zones=ZONES)
        assert set(result.classes) == {"InstantOrderingRuntimeTest"}
        assert set(result.zoned) == {("InstantOrderingRuntimeTest", "utc")}
        assert result.log == tmp_path / "native-core" / "suite" / "gradle.log"
        assert session.core_run("suite", "*", zones=ZONES) is result
        assert len(commands) == 1
    finally:
        session.close()
