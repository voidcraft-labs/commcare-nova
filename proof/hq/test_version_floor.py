"""The version floor: HQ gives a new app its own CommCare version, and builds the same app differently below 2.57.

Contract: Nova writes no ``build_spec`` and reads the target app's version
from HQ's source (``build_spec.version``), refusing to publish to an app
below 2.57 (``lib/commcare/versionFloor.ts::COMMCARE_VERSION_FLOOR``). HQ
gives an app it creates the project space's default build, whatever the body
names (``models/applications.py::_import_app`` deletes the body's
``build_spec``; ``builds/utils.py::get_default_build_spec``), and an update
keeps the app's own (``_merge_source_into_app``). HQ builds an app at the
version its ``build_spec`` holds, and the minimum-version gates of
``feature_support.py`` leave out what a lower version cannot read. The
plausible failures: a create that takes the version a body names (then Nova
could choose it, and reading it would say nothing), an update that changes
it, and a build that is the same on both sides of the floor (then the floor
guards nothing).

``prompt-widgets`` is created on a project space whose default build is
2.53.0 and on one whose default is 2.57.0. Each shell's source serves that
default, and an update whose body names another version leaves it. Each is
then filled and built: the 2.53 build's profile requires 2.53, its suite
holds no ``<select_text>`` on either case detail, and its app strings no
``m0_select_text``; the 2.57 build holds all three. The built files that
differ are pinned, so a pin move that changes what a version gates fails
here.
"""

from __future__ import annotations

import dataclasses
import json

from lxml import etree

from proof.hq import operations
from proof.hq.check import hq_check

DOCUMENT = "prompt-widgets"
BELOW, AT = "2.53.0", "2.57.0"
# The built files HQ writes differently for prompt-widgets at 2.53.0 and at 2.57.0.
DIFFERING_FILES = [
    "default/app_strings.txt",
    "en/app_strings.txt",
    "media_profile.ccpr",
    "media_profile.xml",
    "profile.ccpr",
    "profile.xml",
    "suite.xml",
]


def _with_body_version(upload, app_id, version):
    """The captured update with its app naming ``version`` as its ``build_spec``."""
    from proof.hq.operations import Upload

    upload = operations.with_app_id(upload, app_id)
    application = json.loads(operations.upload_field(upload, "app_file"))
    assert "build_spec" not in application, "Nova's update names a build_spec"
    application["build_spec"] = {"doc_type": "BuildSpec", "version": version, "build_number": None, "latest": True}
    boundary = "proof-version-boundary"
    body = b""
    for name in operations.upload_field_names(upload):
        content = json.dumps(application).encode() if name == "app_file" else operations.upload_field(upload, name)
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if name == "app_file":
            disposition += '; filename="app.json"\r\nContent-Type: application/json'
        body += f"--{boundary}\r\n{disposition}\r\n\r\n".encode() + content + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return Upload(body, f"multipart/form-data; boundary={boundary}")


def _profile_requirement(files):
    profile = etree.fromstring(files["profile.ccpr"])
    return profile.get("requiredMajor"), profile.get("requiredMinor")


def _select_texts(files):
    suite = etree.fromstring(files["suite.xml"])
    return sum(1 for _ in suite.iter("select_text"))


def _app_string_keys(files):
    text = files["en/app_strings.txt"]
    text = text.decode("utf-8") if isinstance(text, bytes) else text
    return {line.split("=", 1)[0] for line in text.splitlines() if "=" in line}


def test_hq_gives_a_new_app_its_default_version_and_builds_below_the_floor_without_what_2_57_reads(
    hq, core_runner, documents
):
    from proof.hq.seams import build_seams

    export = documents[DOCUMENT].exports["minimum"]
    assert export.two_imports
    shell = json.loads(operations.upload_field(export.create.upload(), "app_file"))
    assert "build_spec" not in shell
    built, versions = {}, {}
    for default in (BELOW, AT):
        configuration = dataclasses.replace(export.configuration.hq(), commcare_version=default)
        with hq_check(configuration) as (state, record):
            app_id, (created,) = operations.publish(state, [export.create.upload()])
            assert created.status == 201
            read = [operations.app_source(state, app_id)["build_spec"]["version"]]
            # The fill names another version; HQ keeps the app's own.
            filled = operations.apply_upload(state, _with_body_version(export.content.upload(), app_id, "2.99.0"))
            assert filled.status == 200, filled.response
            read.append(operations.app_source(state, app_id)["build_spec"]["version"])
            versions[default] = read
            with build_seams():
                outcome = operations.build(operations.held_app(state, app_id), record)
            assert outcome.errors == [], outcome.errors
            built[default] = outcome.files
    assert versions == {BELOW: [BELOW, BELOW], AT: [AT, AT]}, versions
    below, at = built[BELOW], built[AT]
    assert (_profile_requirement(below), _profile_requirement(at)) == (("2", "53"), ("2", "57"))
    assert _select_texts(below) == 0 and _select_texts(at) == 2
    assert "m0_select_text" not in _app_string_keys(below) and "m0_select_text" in _app_string_keys(at)
    differing = sorted(name for name in set(below) | set(at) if below.get(name) != at.get(name))
    assert differing == DIFFERING_FILES, " ".join(differing)
