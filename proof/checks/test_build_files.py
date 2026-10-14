"""Proof 2 compares everything HQ builds, and holds versions to content.

Contract (the plan's test row "Proof 2 compares everything HQ builds"): the
comparison enumerates every file ``create_all_files()`` and each build
profile's ``create_all_files(build_profile_id)`` write and fails on any file
it has no comparator for; each file it reads, a change to it is a difference
in that file, named as the artifact a rule or register entry names it by
(``form:<m>.<f>``, ``app_strings:<lang>``, the file name, each under
``<profile id>/`` for a profile's file). And the version clause: two builds
of one app may differ in a form's or a media resource's version only where
that form's or resource's content differs, as HQ's own
``set_form_versions`` and ``set_media_versions`` decide with the first build
as the previous one.

The plausible failures: a built file left out (a new file HQ starts writing,
or one the comparison silently skips), a build profile's file named so no
rule or entry can reach it, and a version clause that erases a version HQ
changed with nothing changed.

The app is HQ's own suite-test app with a build profile, published through
HQ's import as Nova publishes and built by HQ under the check's seams.
"""

from __future__ import annotations

import pytest
from lxml import etree

from proof.checks.compare.build_files import NoComparator, compare_parsed_builds, parse_build_files
from proof.checks.compare.versions import apply_version_clause
from proof.checks.proof2 import parsed_build
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.seams import build_seams
from proof.observe.build import build_state

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
PROFILE = "proofprofile"


def _with_profile(app):
    from corehq.apps.app_manager.models import BuildProfile

    app.build_profiles = {PROFILE: BuildProfile(name="Proof profile", langs=["en"])}
    return app


def _changed_label(app_json, held_form_ids, form_index=None):
    """The app as an update keeping HQ's form ids, with one form's first label changed (or none)."""
    forms = [form for module in app_json["modules"] for form in module["forms"]]
    for index, (form, held_id) in enumerate(zip(forms, held_form_ids, strict=True)):
        source = app_json["_attachments"].pop(f"{form['unique_id']}.xml")
        if index == form_index:
            tree = etree.fromstring(source.encode())
            text = next(el for el in tree.iter() if etree.QName(el).localname == "value" and el.text)
            text.text += " (changed)"
            source = etree.tostring(tree, encoding="unicode")
        form["unique_id"] = held_id
        app_json["_attachments"][f"{held_id}.xml"] = source
    return app_json


@pytest.fixture(scope="module")
def builds(hq, core_runner):
    """HQ's build of the app with a build profile (A), and of its update changing the second form's label (B)."""
    with hq_check(CONFIGURATION) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        app = _with_profile(operations.held_app(state, app_id))
        with build_seams(previous=None):
            a, hq_build = build_state(app, record, "A")
        saved_a = hq_build.saved_build()  # before the update replaces the forms' sources
        update = _changed_label(hq_test_app(), [form.unique_id for form in app.get_forms()], form_index=1)
        upload = operations.with_app_id(nova_shaped_upload(update, "Suite app", app_id="captured"), app_id)
        assert operations.apply_upload(state, upload).status == 200
        with build_seams(previous=saved_a):
            b, _ = build_state(_with_profile(operations.held_app(state, app_id)), record, "B")
    assert a.complete and b.complete, (a.raised, b.raised)
    return a, b


def _mutated(path, content):
    if path.endswith("app_strings.txt"):
        return content + b"\nproof.control=changed\n"
    root = etree.fromstring(content)
    root.set("proof-control", "changed")
    return etree.tostring(root, encoding="utf-8", xml_declaration=True)


def _with_file(outcome, path, content):
    """The build with one file (of the default build or of a profile's, by HQ's path) replaced."""
    if path in outcome.files:
        return type(outcome)(**{**outcome.__dict__, "files": {**outcome.files, path: content}})
    profiles = {
        profile_id: {**files, path: content} if path in files else files
        for profile_id, files in outcome.profile_files.items()
    }
    return type(outcome)(**{**outcome.__dict__, "profile_files": profiles})


def test_a_languages_app_strings_are_compared_as_core_reads_them():
    """Core reads a language's text from the default file's strings overlaid by the language's own
    (``Localizer.getLocaleData``), so a key a language's file leaves out where the default holds the same text is
    no difference, one it leaves out where the default holds another is that language's text changing, and a
    default that changes changes every language that reads it. The plausible failure: each file compared alone,
    so a language file dropping a key the default holds reads as the language losing its text."""
    key = "m0_no_items_text"
    before = {
        "default/app_strings.txt": f"{key}=List is empty.\n".encode(),
        "es/app_strings.txt": f"{key}=List is empty.\n".encode(),
        "fra/app_strings.txt": f"{key}=Liste vide\n".encode(),
    }
    dropped = {**before, "es/app_strings.txt": b"", "fra/app_strings.txt": b""}
    blank = {**dropped, "default/app_strings.txt": f"{key}=\n".encode()}

    def compared(after):
        return sorted(
            (d.artifact, d.path, d.kind, d.before, d.after)
            for d in compare_parsed_builds(
                parse_build_files(before, rules=()), parse_build_files(after, rules=()), check="proof2", document="d"
            )
        )

    path = "/m*_no_items_text"
    assert compared(dropped) == [("app_strings:fra", path, "changed", "Liste vide", "List is empty.")]
    assert compared(blank) == [
        ("app_strings:default", path, "changed", "List is empty.", ""),
        ("app_strings:es", path, "changed", "List is empty.", ""),
        ("app_strings:fra", path, "changed", "Liste vide", ""),
    ]


def test_a_change_a_profiles_file_shows_as_the_main_builds_does_is_reported_once():
    """A build profile's build is the main build kept to the profile's languages, so the same change in the same
    file of both, at the same place and between the same values, is one symptom, reported on the main build; a
    change a profile's file shows otherwise is its own. The plausible failure: every profile copying each of the
    main build's symptoms as one more difference (a register entry each), or a profile's own change dropped."""
    suite = b'<suite version="1"><menu id="m0"><text>Visits</text></menu></suite>'

    def build(main, profile):
        parsed = parse_build_files({"suite.xml": main}, rules=())
        parsed.update(parse_build_files({f"{PROFILE}/suite.xml": profile}, rules=(), profile_id=PROFILE))
        return parsed

    def compared(main, profile):
        return sorted(
            (d.artifact, d.path, d.kind)
            for d in compare_parsed_builds(build(suite, suite), build(main, profile), check="proof2", document="d")
        )

    renamed = suite.replace(b"Visits", b"Calls")
    assert compared(renamed, renamed) == [("suite.xml", "/suite/menu[@id=*]/text[*]/text()", "changed")]
    other = suite.replace(b"Visits", b"Rounds")
    assert compared(renamed, other) == [
        (f"{PROFILE}/suite.xml", "/suite/menu[@id=*]/text[*]/text()", "changed"),
        ("suite.xml", "/suite/menu[@id=*]/text[*]/text()", "changed"),
    ]


def test_every_file_hq_builds_is_read_and_compared(builds):
    a, _ = builds
    assert {"suite.xml", "media_suite.xml", "profile.ccpr", "media_profile.ccpr", "en/app_strings.txt"} <= set(a.files)
    profile_files = a.profile_files[PROFILE]
    assert profile_files and all(path.startswith(f"{PROFILE}/") for path in profile_files)
    before = parsed_build(a)
    assert set(before) == set(a.files) | set(profile_files)
    # A profile's files are named as the default build's are, under the profile.
    assert {
        f"{PROFILE}/form:0.0",
        f"{PROFILE}/form:0.1",
        f"{PROFILE}/app_strings:en",
        f"{PROFILE}/suite.xml",
    } <= {built.artifact for built in before.values()}
    assert {"form:0.0", "app_strings:en", "suite.xml"} <= {built.artifact for built in before.values()}
    for path in sorted(before):
        content = a.files[path] if path in a.files else profile_files[path]
        after = parsed_build(_with_file(a, path, _mutated(path, content)))
        found = compare_parsed_builds(before, after, check="proof2", document="suite-app")
        expected = [before[path].artifact]
        if path.endswith("default/app_strings.txt"):
            # A key the default file adds is read by every language whose own file leaves it out (as_read).
            head = path.removesuffix("default/app_strings.txt")
            expected += sorted(
                built.artifact
                for other, built in before.items()
                if other.startswith(head)
                and other.count("/") == path.count("/")
                and other.endswith("/app_strings.txt")
                and other != path
            )
        assert sorted(d.artifact for d in found) == sorted(expected), path


def test_a_file_no_comparator_reads_refuses_the_comparison(builds):
    a, _ = builds
    with pytest.raises(NoComparator) as refused:
        parse_build_files({**a.files, "commcare.jar": b"\x00\x01"}, rules=())
    assert "commcare.jar" in str(refused.value)
    in_profile = {PROFILE: {**a.profile_files[PROFILE], f"{PROFILE}/commcare.jar": b"\x00\x01"}}
    with pytest.raises(NoComparator, match="commcare.jar"):
        parsed_build(type(a)(**{**a.__dict__, "profile_files": in_profile}))


def _differences(a, b):
    before, after = apply_version_clause(
        parsed_build(a), parsed_build(b), app_version_before=a.app_version, app_version_after=b.app_version
    )
    return compare_parsed_builds(before, after, check="proof2", document="suite-app")


def test_versions_differ_only_where_content_differs(builds):
    a, b = builds
    assert b.app_version > a.app_version
    raw = compare_parsed_builds(parsed_build(a), parsed_build(b), check="proof2", document="x")
    assert {d.path for d in raw if d.path.endswith("/@version")}, "the two builds differ in versions"
    found = _differences(a, b)
    # The one label the update changed, in its form, and nothing else: the profile's form changed alike, which is
    # that one symptom again (once_per_symptom).
    assert found and {d.artifact for d in found} == {"form:0.1"}, [d.describe() for d in found]
    assert not [d for d in found if d.path.endswith("/@version")]


def test_a_version_changed_with_no_content_change_is_a_difference(builds):
    a, b = builds
    root = etree.fromstring(b.files["modules-0/forms-0.xml"])
    data = next(el for el in root.iter() if etree.QName(el).localname == "instance")[0]
    assert data.get("version") == str(a.app_version)  # HQ kept the unchanged form's version
    data.set("version", str(b.app_version))
    tampered = _with_file(b, "modules-0/forms-0.xml", etree.tostring(root, encoding="utf-8"))
    found = _differences(a, tampered)
    assert [(d.artifact, d.path) for d in found if d.artifact == "form:0.0"] == [
        ("form:0.0", "/html/head[*]/model[*]/instance[*]/data[*]/@version")
    ]


# Media: a module icon kept from A to B, and a form icon whose file B replaces.
KEPT = "jr://file/commcare/image/module0.png"
REPLACED = "jr://file/commcare/image/form0.png"


def _with_media(app, replaced_id):
    from corehq.apps.hqmedia.models import HQMediaMapItem

    module = app.get_module(0)
    module.media_image = {"en": KEPT}
    module.get_form(0).media_image = {"en": REPLACED}
    app.multimedia_map = {
        KEPT: HQMediaMapItem(multimedia_id="a" * 32, media_type="CommCareImage"),
        REPLACED: HQMediaMapItem(multimedia_id=replaced_id, media_type="CommCareImage"),
    }
    return app


def _media_versions(outcome):
    root = etree.fromstring(outcome.files["media_suite.xml"])
    return {
        location.text.strip(): resource.get("version")
        for resource in root.iter("resource")
        for location in resource.iter("location")
        if location.get("authority") == "local"
    }


@pytest.fixture(scope="module")
def media_builds(hq, core_runner):
    """HQ's build of the app with two media (A), and after its republish, with one media file replaced (B)."""
    with hq_check(CONFIGURATION) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        with build_seams(previous=None):
            a, hq_build = build_state(_with_media(operations.held_app(state, app_id), "b" * 32), record, "A")
        saved_a = hq_build.saved_build()
        held = [form.unique_id for form in operations.held_app(state, app_id).get_forms()]
        republish = nova_shaped_upload(_changed_label(hq_test_app(), held), "Suite app", app_id="captured")
        assert operations.apply_upload(state, operations.with_app_id(republish, app_id)).status == 200
        with build_seams(previous=saved_a):
            b, _ = build_state(_with_media(operations.held_app(state, app_id), "c" * 32), record, "B")
    assert a.complete and b.complete, (a.raised, b.raised)
    return a, b


def test_a_media_version_differs_only_where_its_file_does(media_builds):
    a, b = media_builds
    assert b.app_version > a.app_version
    versions_a, versions_b = _media_versions(a), _media_versions(b)
    # HQ kept the unchanged file's version and gave the replaced one B's.
    kept, replaced = "./commcare/image/module0.png", "./commcare/image/form0.png"
    assert versions_a == {kept: str(a.app_version), replaced: str(a.app_version)}
    assert versions_b == {kept: str(a.app_version), replaced: str(b.app_version)}
    media = [d for d in _differences(a, b) if d.artifact == "media_suite.xml"]
    # The replaced file's download location differs; no version does.
    assert media and not [d for d in media if d.path.endswith("/@version")], [d.describe() for d in media]
    assert {d.path for d in media} == {"/suite/media[*]/resource[@id=*]/location[*]/text()"}


def test_a_media_version_changed_with_its_file_unchanged_is_a_difference(media_builds):
    a, b = media_builds
    root = etree.fromstring(b.files["media_suite.xml"])
    kept = next(
        resource
        for resource in root.iter("resource")
        if any(location.text.strip() == "./commcare/image/module0.png" for location in resource.iter("location"))
    )
    kept.set("version", str(b.app_version))
    found = _differences(a, _with_file(b, "media_suite.xml", etree.tostring(root, encoding="utf-8")))
    assert [(d.artifact, d.path) for d in found if d.path.endswith("/@version")] == [
        ("media_suite.xml", "/suite/media[*]/resource[@id=*]/@version")
    ]
