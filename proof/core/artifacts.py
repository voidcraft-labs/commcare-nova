"""Core and HQ artifacts the Core runner's tests run on, and variants built from them.

The inputs are real: Core's own test resources in the image
(/opt/core/src/test/resources), among them an app HQ built
(basic_app/basic.ccz) with the restore Core's CLI tests run it against. A
variant changes single archive entries of such an app.
"""

from __future__ import annotations

import os
import zipfile
from collections.abc import Mapping
from pathlib import Path

from lxml import etree

from proof.core.client import CORE_DIR

CORE_TEST_RESOURCES = CORE_DIR / "src" / "test" / "resources"
ANDROID_DIR = Path(os.environ.get("PROOF_ANDROID", "/opt/android"))
# Where the archives HQ built that Android's instrumentation tests install are.
ANDROID_TEST_RESOURCES = ANDROID_DIR / "app" / "instrumentation-tests" / "resources"
# An app HQ built, and the restore Core's CLI tests run it against
# (org.cli.CliTests::testCaseSelection).
BASIC_APP = CORE_TEST_RESOURCES / "basic_app" / "basic.ccz"
BASIC_RESTORE = CORE_TEST_RESOURCES / "basic_app" / "restore.xml"
# Core's template restore: one user and one case (src/test/resources/template).
TEMPLATE_RESTORE = CORE_TEST_RESOURCES / "template" / "user_restore.xml"
# Core's session test app: case lists, a case search and case claims
# (org.cli.CliTests::testEntryWithPost_*).
SESSION_APP = CORE_TEST_RESOURCES / "session-tests-template"
SESSION_RESTORE = SESSION_APP / "user_restore.xml"

XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"


def self_check_archives() -> list[Path]:
    """basic.ccz and every archive Android's instrumentation tests install: the HQ-built apps Core must run.

    Found by listing the image's Android checkout, so an image that stops carrying
    them fails collection here rather than silently shrinking the check to basic.ccz.
    """
    android = sorted(ANDROID_TEST_RESOURCES.glob("*.ccz"))
    if not android:
        raise RuntimeError(
            f"The Core runner's self-check found no .ccz archives in {ANDROID_TEST_RESOURCES}. The proof image"
            " carries commcare-android's instrumentation-test resources there; check that it still does."
        )
    return [BASIC_APP, *android]


def read_archive_entry(archive: Path, name: str) -> bytes:
    with zipfile.ZipFile(archive) as zipped:
        return zipped.read(name)


def archive_variant(source: Path, target: Path, edits: Mapping[str, bytes | None]) -> Path:
    """A copy of the archive with the named entries replaced (bytes) or removed (None)."""
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as copy:
        names = {info.filename for info in original.infolist()}
        for name in edits:
            assert name in names, f"{source} has no entry {name}"
        for info in original.infolist():
            if info.filename in edits:
                if edits[info.filename] is not None:
                    copy.writestr(info.filename, edits[info.filename])
            else:
                copy.writestr(info, original.read(info.filename))
    return target


def suite_resource_ids(archive: Path, kind: str) -> dict[str, str]:
    """The suite's resources of one kind ("xform", "locale"), keyed by their local location without "./"."""
    suite = etree.fromstring(read_archive_entry(archive, "suite.xml"))
    ids: dict[str, str] = {}
    for holder in suite.findall(kind):
        resource = holder.find("resource")
        for location in resource.iter("location"):
            if location.get("authority") == "local":
                ids[location.text.strip().removeprefix("./")] = resource.get("id")
    return ids


def form_xmlns(form: bytes) -> str:
    root = etree.fromstring(form)
    instance = root.find(f"{{{XHTML}}}head/{{{XFORMS}}}model/{{{XFORMS}}}instance")
    return etree.QName(instance[0]).namespace


def core_site(source: str, method: str, marker: str) -> str:
    """Where the runner records that Core constructed an exception (``FormRun.java::site``), for the one line of
    Core's ``source`` (a path under its src/main/java) that holds ``marker``, in ``method``:
    ``<class>.<method>(<file>:<line>)``.

    Read from Core's own source, so a test names the line by what it holds rather than by its number at a pin.
    """
    path = CORE_DIR / "src" / "main" / "java" / source
    lines = [number for number, line in enumerate(path.read_text().splitlines(), start=1) if marker in line]
    if len(lines) != 1:
        raise AssertionError(
            f"A site is named by the one line of Core's {source} that holds {marker!r}, and that text is on lines"
            f" {lines}. Check that the marker still names the line that constructs the exception at Core's pin."
        )
    return f"{source.removesuffix('.java').replace('/', '.')}.{method}({path.name}:{lines[0]})"
