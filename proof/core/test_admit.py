"""Admission is Core's archive installer, and every refusal names what Core refused.

The contract: an archive the way HQ builds one installs through
CommCareConfigEngine (profile, suites, forms, locale files, media), its app
strings are read, and the report says what Core holds; an archive Core cannot
install is refused, with each resource Core refused named, not only the first.

Expected values come from the archive itself, read here with lxml: the suite's
xform and locale resources, the profile's attributes and properties.
"""

from __future__ import annotations

import json
import shutil

import pytest
from lxml import etree

from proof.core.artifacts import (
    BASIC_APP,
    BASIC_RESTORE,
    CORE_TEST_RESOURCES,
    archive_variant,
    read_archive_entry,
    self_check_archives,
    suite_resource_ids,
)
from proof.core.client import CoreRunnerError


def refused_resources(report: dict) -> set[str]:
    return {problem["resource"] for problem in report["problems"]}


def test_an_hq_built_archive_is_admitted_with_what_core_holds(core_runner):
    report = core_runner.admit(BASIC_APP)
    try:
        assert report["admitted"] is True
        assert report["problems"] == []
        forms = suite_resource_ids(BASIC_APP, "xform")
        assert len(report["forms"]) == len(forms)
        suite = etree.fromstring(read_archive_entry(BASIC_APP, "suite.xml"))
        languages = {locale.get("language") for locale in suite.findall("locale")}
        assert set(report["locales"]) == languages | {"default"}

        profile = etree.fromstring(read_archive_entry(BASIC_APP, "profile.ccpr"))
        for attribute in ("requiredMajor", "requiredMinor", "requiredMinimal", "uniqueid", "version"):
            assert report["profile"][attribute] == profile.get(attribute)
        assert report["profile"]["uniqueIdGenerated"] is False
        declared = {prop.get("key"): prop.get("value") for prop in profile.iter("property")}
        installed = {prop["key"]: prop["value"] for prop in report["profile"]["properties"]}
        assert installed == declared

        media_suite = etree.fromstring(read_archive_entry(BASIC_APP, "media_suite.xml"))
        assert len(report["media"]) == len(list(media_suite.iter("resource")))
        assert {resource["status"] for resource in report["resources"]} == {"Installed"}
    finally:
        if report.get("app"):
            core_runner.release(report["app"])


@pytest.mark.parametrize("archive", self_check_archives(), ids=lambda archive: archive.name)
def test_the_archives_hq_built_for_core_and_android_tests_are_admitted(core_runner, archive):
    """The self-check: every HQ-built archive Core's and Android's own tests install, Core's installer admits."""
    report = core_runner.admit(archive)
    if report["app"]:
        core_runner.release(report["app"])
    assert report["problems"] == []
    assert report["admitted"] is True
    assert len(report["forms"]) == len(suite_resource_ids(archive, "xform"))


def test_every_refused_form_is_named(core_runner, tmp_path):
    """Core's installer stops at its first refusal; the report goes on and names each one."""
    forms = suite_resource_ids(BASIC_APP, "xform")
    broken = ("modules-1/forms-0.xml", "modules-2/forms-1.xml")
    variant = archive_variant(BASIC_APP, tmp_path / "two-broken-forms.ccz", {name: b"<h:html" for name in broken})
    report = core_runner.admit(variant)
    assert report["admitted"] is False
    assert report["appHandle"] is None
    assert refused_resources(report) == {forms[name] for name in broken}
    assert {problem["stage"] for problem in report["problems"]} == {"install"}


def test_an_admission_names_the_root_it_read_the_archive_under_whether_core_admitted_it_or_not(core_runner, tmp_path):
    """The runner reads each archive under a root of its own, numbered by every admission it made before, admitted
    or refused (``Apps.nextHandle``), and names it (``archiveRoot``), so a reader can hold a report free of it: the
    report's resource locations are read under that root."""
    refusing = archive_variant(BASIC_APP, tmp_path / "broken-form.ccz", {"modules-1/forms-0.xml": b"<h:html"})
    reports = [core_runner.admit(refusing), core_runner.admit(BASIC_APP)]
    try:
        assert [report["admitted"] for report in reports] == [False, True]
        roots = [report["archiveRoot"] for report in reports]
        assert all(roots) and roots[0] != roots[1]
        for report, root in zip(reports, roots, strict=True):
            read = {key: value for key, value in report.items() if key != "app"}
            assert f"jr://archive/{root}/profile.ccpr" in json.dumps(read)
    finally:
        for report in reports:
            if report.get("app") and core_runner.holds(report["app"]):
                core_runner.release(report["app"])


def test_a_form_with_an_invalid_expression_is_refused_by_name(core_runner, tmp_path):
    name = "modules-1/forms-0.xml"
    form = etree.fromstring(read_archive_entry(BASIC_APP, name))
    bind = next(b for b in form.iter("{http://www.w3.org/2002/xforms}bind") if b.get("constraint"))
    bind.set("constraint", ". +")
    variant = archive_variant(BASIC_APP, tmp_path / "invalid-expression.ccz", {name: etree.tostring(form)})
    report = core_runner.admit(variant)
    assert report["admitted"] is False
    assert refused_resources(report) == {suite_resource_ids(BASIC_APP, "xform")[name]}


def test_a_missing_archive_entry_is_named(core_runner, tmp_path):
    """Core's archive reference says every entry exists, so a missing form fails as it is read, unnamed by Core."""
    name = "modules-2/forms-0.xml"
    variant = archive_variant(BASIC_APP, tmp_path / "missing-form.ccz", {name: None})
    report = core_runner.admit(variant)
    assert report["admitted"] is False
    assert refused_resources(report) == {suite_resource_ids(BASIC_APP, "xform")[name]}


def test_app_strings_are_read_at_admission(core_runner, tmp_path):
    """Core's installer only records where a locale file lives; the runner sets each locale, which reads it."""
    variant = archive_variant(BASIC_APP, tmp_path / "missing-strings.ccz", {"hin/app_strings.txt": None})
    report = core_runner.admit(variant)
    assert report["admitted"] is False
    assert [(problem["stage"], problem.get("locale")) for problem in report["problems"]] == [("locale", "hin")]


def test_a_malformed_suite_is_refused_by_name(core_runner, tmp_path):
    variant = archive_variant(BASIC_APP, tmp_path / "malformed-suite.ccz", {"suite.xml": b"<suite><menu"})
    report = core_runner.admit(variant)
    assert report["admitted"] is False
    assert "suite" in refused_resources(report)


def test_an_archive_without_a_profile_is_refused(core_runner, tmp_path):
    variant = archive_variant(BASIC_APP, tmp_path / "no-profile.ccz", {"profile.ccpr": None})
    report = core_runner.admit(variant)
    assert report["admitted"] is False
    assert {problem["stage"] for problem in report["problems"]} >= {"archive"}


def test_the_required_version_is_reported_not_enforced(core_runner, tmp_path):
    """Core's archive installer forces past the profile's required version; Core's own check is reported beside it."""
    profile = etree.fromstring(read_archive_entry(BASIC_APP, "profile.ccpr"))
    profile.set("requiredMinor", "99")
    variant = archive_variant(BASIC_APP, tmp_path / "requires-2.99.ccz", {"profile.ccpr": etree.tostring(profile)})
    report = core_runner.admit(variant, platform_version="2.64.0")
    try:
        assert report["admitted"] is True
        assert report["profile"]["requiredMinor"] == "99"
        assert report["versionCheck"]["accepted"] is False
        assert "Minor Version Mismatch" in report["versionCheck"]["message"]
    finally:
        core_runner.release(report["app"])
    original = core_runner.admit(BASIC_APP, platform_version="2.64.0")
    core_runner.release(original["app"])
    assert original["versionCheck"]["accepted"] is True


def test_a_directory_of_built_files_is_admitted_as_its_archive(core_runner, tmp_path):
    source = CORE_TEST_RESOURCES / "app_for_text_tests"
    report = core_runner.admit(source)
    core_runner.release(report["app"])
    assert report["admitted"] is True
    assert set(report["locales"]) == {"default", "en", "hin"}

    incomplete = tmp_path / "app_for_text_tests"
    shutil.copytree(source, incomplete)
    (incomplete / "modules-1" / "forms-0.xml").unlink()
    refused = core_runner.admit(incomplete)
    assert refused["admitted"] is False
    assert refused_resources(refused) == {"ee2be993c2f7bd0b99ecc101f0d4b85087e080ad"}


def test_a_released_app_cannot_run_a_session(core_runner):
    report = core_runner.admit(BASIC_APP)
    core_runner.release(report["app"])
    with pytest.raises(CoreRunnerError) as refused:
        core_runner.session(report["app"], restore=BASIC_RESTORE.read_bytes())
    assert refused.value.kind == "request"
    assert report["app"].handle in str(refused.value)


def test_a_malformed_platform_version_is_refused_and_leaves_nothing_open(core_runner):
    """A directory is admitted through a temporary archive; a refused request must not leave one behind."""
    source = CORE_TEST_RESOURCES / "app_for_text_tests"
    temporary = core_runner.temporary
    before = set(temporary.glob("proof-core-*.ccz"))
    with pytest.raises(CoreRunnerError) as refused:
        core_runner.admit(source, platform_version="2.x.0")
    assert refused.value.kind == "request"
    assert "platformVersion" in str(refused.value)
    assert set(temporary.glob("proof-core-*.ccz")) == before

    report = core_runner.admit(source, platform_version="2.64.0")
    assert report["admitted"] is True
    assert len(set(temporary.glob("proof-core-*.ccz")) - before) == 1
    core_runner.release(report["app"])
    assert set(temporary.glob("proof-core-*.ccz")) == before
