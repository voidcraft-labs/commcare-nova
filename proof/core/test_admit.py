"""Admission is Core's archive installer, and every refusal names what Core refused.

The contract: an archive the way HQ builds one installs through
CommCareConfigEngine (profile, suites, forms, locale files, media), its app
strings are read, and the report says what Core holds; an archive Core cannot
install is refused, with each resource Core refused named, not only the first.

Expected values come from the archive itself, read here with lxml: the suite's
xform and locale resources, the profile's attributes and properties.

An archive only CommCare Android reads is admitted over Android's own strings
(``runtime_defaults``), which Android registers as the default locale's first
source before the app's files (``CommCareApplication.initializeDefaultLocalizerData``):
a key one language holds and the app's default file lacks is admitted where
Android's strings name it, as on a device, and refused where they do not, as
Core's strict localizer refuses it with none; and the app keeps them when
another archive's admission took Core's localizer in between.
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
from proof.core.client import ANDROID_DEFAULT_STRINGS, CoreRunnerError


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


def _with_a_language_key(tmp_path, name, key, text):
    """BASIC_APP with ``key`` added to its ``hin`` strings alone, which its default file lacks."""
    held = read_archive_entry(BASIC_APP, "hin/app_strings.txt").decode("utf-8")
    assert key not in read_archive_entry(BASIC_APP, "default/app_strings.txt").decode("utf-8")
    edited = held + ("" if held.endswith("\n") else "\n") + f"{key}={text}\n"
    return archive_variant(BASIC_APP, tmp_path / name, {"hin/app_strings.txt": edited.encode("utf-8")})


def _android_keys():
    lines = ANDROID_DEFAULT_STRINGS.read_text(encoding="utf-8").splitlines()
    return {line.split("=", 1)[0].strip() for line in lines if "=" in line and not line.lstrip().startswith("#")}


def test_a_key_one_language_holds_is_admitted_where_androids_own_strings_name_it(core_runner, tmp_path):
    """``home.sync`` in ``hin`` alone: Core's own engine refuses the language (its localizer is strict), and an
    admission over Android's own strings admits it, as a device installs it."""
    assert "home.sync" in _android_keys()
    variant = _with_a_language_key(tmp_path, "hin-sync.ccz", "home.sync", "Sync karo")
    refused = core_runner.admit(variant)
    assert refused["admitted"] is False
    assert [(problem["stage"], problem.get("locale")) for problem in refused["problems"]] == [("locale", "hin")]
    assert "home.sync" in refused["problems"][0]["message"]
    assert "runtimeDefaults" not in refused

    report = core_runner.admit(variant, runtime_defaults=ANDROID_DEFAULT_STRINGS)
    other = None
    try:
        assert report["problems"] == []
        assert report["admitted"] is True
        assert report["runtimeDefaults"] > 0
        # Another archive's admission takes Core's localizer; a session on the first in hin activates it again
        # over Android's strings, or setting hin would raise as the admission without them did.
        other = core_runner.admit(BASIC_APP)
        assert other["admitted"] is True
        run = core_runner.session(report["app"], restore=BASIC_RESTORE.read_bytes(), locale="hin")
        assert run["locale"] == "hin"
    finally:
        for admitted in (report, other):
            if admitted and admitted.get("app") and core_runner.holds(admitted["app"]):
                core_runner.release(admitted["app"])


def test_a_key_one_language_holds_and_androids_own_strings_lack_is_refused_over_them(core_runner, tmp_path):
    """The other side: Android's strings admit only the keys they name, so a key neither they nor the app's default
    file hold is refused at its language, naming the key, as a device refuses it."""
    key = "proof.key.no.runtime.names"
    assert key not in _android_keys()
    variant = _with_a_language_key(tmp_path, "hin-unnamed.ccz", key, "Koi nahin")
    report = core_runner.admit(variant, runtime_defaults=ANDROID_DEFAULT_STRINGS)
    if report.get("app"):
        core_runner.release(report["app"])
    assert report["admitted"] is False
    assert [(problem["stage"], problem.get("locale")) for problem in report["problems"]] == [("locale", "hin")]
    assert key in report["problems"][0]["message"]


def test_a_runtime_strings_file_the_runner_cannot_read_is_refused_by_name(core_runner, tmp_path):
    with pytest.raises(CoreRunnerError, match="runtimeDefaults"):
        core_runner.admit(BASIC_APP, runtime_defaults=tmp_path / "no-such-strings.txt")


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
