"""The HQ self-check apps that are files in the upstream checkouts.

- HQ's test app JSONs: every Application document in
  ``corehq/apps/app_manager/tests/data`` and its ``suite`` folder. One holds
  its forms in the blob store (``external_blobs``) rather than inline, so
  HQ's import cannot receive it from the file alone, and it is left out
  with that reason.
- HQ's template apps (``corehq/apps/app_manager/static/app_manager/template_apps/<slug>/app.json``),
  which HQ's ``views/apps.py::load_app_from_slug`` imports with
  ``import_app_from_doc`` as they are.
- The HQ-built ``.ccz`` apps in Core's and Android's test resources: each
  archive's profile names an HQ server's download URL.

Each is written byte for byte; ``expected`` records what the research found
when it built each test JSON at CommCare 2.54.0 (17 build clean).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

HQ_ROOT = Path(os.environ.get("PROOF_HQ", "/opt/hq"))
CORE_ROOT = Path(os.environ.get("PROOF_CORE", "/opt/core"))
ANDROID_ROOT = Path(os.environ.get("PROOF_ANDROID", "/opt/android"))

APP_MANAGER = Path("corehq/apps/app_manager")
TEST_DATA = APP_MANAGER / "tests" / "data"
TEMPLATE_APPS = APP_MANAGER / "static" / "app_manager" / "template_apps"
CORE_CCZ_ROOT = Path("src/test/resources")
ANDROID_CCZ_ROOT = Path("app/instrumentation-tests/resources")

# The test JSONs whose validate_app() the research found empty when it built
# them at CommCare 2.54.0, with create_all_files() producing every file and
# Core admitting every form.
BUILDS_CLEAN = frozenset(
    {
        "yesno",
        "days_ago_migration",
        "suite/app",
        "suite/app_case_sharing",
        "suite/app_case_tiles",
        "suite/app_fixture_graphing",
        "suite/app_no_case_sharing",
        "suite/call-center",
        "suite/multi-sort",
        "suite/owner-name",
        "suite/shadow_module",
        "suite/shadow_module_cases",
        "suite/shadow_module_forms_only",
        "suite/sort-only-value",
        "suite/suite-advanced",
        "suite/tiered-select-3",
        "suite/tiered-select",
    }
)


@dataclass(frozen=True)
class FileApp:
    """One self-check app copied from a checkout."""

    id: str
    path: Path
    file: str  # "app.json" or "app.ccz"
    source: dict


@dataclass(frozen=True)
class LeftOut:
    path: Path
    reason: str


def _stem(path: Path, root: Path) -> str:
    return path.relative_to(root).with_suffix("").as_posix()


def _identifier(text: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in text)


def hq_test_apps() -> tuple[list[FileApp], list[LeftOut]]:
    """HQ's test app JSONs, with the one HQ's import cannot receive from its file left out."""
    root = HQ_ROOT / TEST_DATA
    apps, left_out = [], []
    for path in sorted([*root.glob("*.json"), *(root / "suite").glob("*.json")]):
        doc = json.loads(path.read_text())
        if not isinstance(doc, dict) or doc.get("doc_type") != "Application":
            continue
        stem = _stem(path, root)
        if doc.get("external_blobs"):
            left_out.append(
                LeftOut(
                    path,
                    "its forms are in HQ's blob store (external_blobs), not in the file, "
                    "so HQ's import cannot receive the app from it",
                )
            )
            continue
        apps.append(
            FileApp(
                id=_identifier(f"test-{stem.replace('/', '-')}"),
                path=path,
                file="app.json",
                source={
                    "kind": "test-json",
                    "path": (TEST_DATA / path.relative_to(root)).as_posix(),
                    "expected": "clean" if stem in BUILDS_CLEAN else "errors",
                },
            )
        )
    return apps, left_out


def template_apps() -> list[FileApp]:
    """HQ's template apps, as ``load_app_from_slug`` imports them."""
    root = HQ_ROOT / TEMPLATE_APPS
    return [
        FileApp(
            id=_identifier(f"template-{directory.name}"),
            path=directory / "app.json",
            file="app.json",
            source={
                "kind": "template",
                "slug": directory.name,
                "path": (TEMPLATE_APPS / directory.name / "app.json").as_posix(),
            },
        )
        for directory in sorted(root.iterdir())
        if (directory / "app.json").is_file()
    ]


def _hq_built(path: Path) -> bool:
    """Whether the archive's profile names an HQ download URL (``/apps/download/``) as its update source."""
    import zipfile

    from lxml import etree

    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if name == "profile.ccpr" or name.endswith("/profile.ccpr")]
        if not names:
            return False
        profile = etree.fromstring(archive.read(names[0]))
    return "/apps/download/" in (profile.get("update") or "")


def ccz_apps() -> tuple[list[FileApp], list[LeftOut]]:
    """The HQ-built archives in Core's and Android's test resources."""
    apps, left_out = [], []
    for repository, root, resources in (
        ("commcare-core", CORE_ROOT, CORE_CCZ_ROOT),
        ("commcare-android", ANDROID_ROOT, ANDROID_CCZ_ROOT),
    ):
        for path in sorted((root / resources).rglob("*.ccz")):
            relative = path.relative_to(root / resources).with_suffix("").as_posix()
            if not _hq_built(path):
                left_out.append(LeftOut(path, "its profile names no HQ download URL, so HQ did not build it"))
                continue
            apps.append(
                FileApp(
                    id=_identifier(f"ccz-{repository.removeprefix('commcare-')}-{relative.replace('/', '-')}"),
                    path=path,
                    file="app.ccz",
                    source={
                        "kind": "ccz",
                        "repository": repository,
                        "path": (resources / path.relative_to(root / resources)).as_posix(),
                    },
                )
            )
    return apps, left_out
