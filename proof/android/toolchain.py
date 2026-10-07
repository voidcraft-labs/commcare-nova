"""``python3 proof/android/toolchain.py``: what the reader's runtime is built with, read for a shell and a workflow.

    python3 proof/android/toolchain.py prepare-sdk <dir>      an SDK directory the build may install into
    python3 proof/android/toolchain.py sdk <ANDROID_HOME>     refuses an SDK that is not the toolchain's
    python3 proof/android/toolchain.py contents <directory>   the digest of an installed package's files
    python3 proof/android/toolchain.py packages               the SDK packages, one a line, as sdkmanager names them
    python3 proof/android/toolchain.py key                    what a built runtime is a function of, as one digest
    python3 proof/android/toolchain.py get <name> <field>     one value (jdk version, gradle sha256, ...)

The Android Gradle plugin installs the SDK packages a build needs into ``ANDROID_HOME`` itself, where the
SDK's license was accepted there. ``prepare-sdk`` makes a directory for it that holds nothing but the license
acceptances of the SDK ``ANDROID_HOME`` already names (a person's, or a runner image's; this accepts none), so
the build installs every package afresh; ``sdk`` then holds what it installed to the toolchain: each package
at the named revision, its files the named bytes (``contents``, the digest of every file the package's archive
unpacks to). A package the SDK's repository has since revised fails there, and the pin moves with a person's
review.

``proof/android/toolchain.json`` names each tool exactly; ``build-runtime.sh`` builds from it, and the Android
stage's workflow installs the JDK and the SDK packages it names. ``key`` is the digest of everything a build of
the runtime reads: the two pins, the toolchain, the script that builds it, its init script, the fetch script
and the dependencies' checksums. A runtime kept under that key is the runtime a build would make, so the stage
keeps one a key (``.github/workflows/proof-android.yml``).

Standard library only, and run as a file: it is read before any package of the proof is importable.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOLCHAIN = HERE / "toolchain.json"
PINS = HERE.parent / "pins.json"
PINNED = ("commcare-android", "commcare-core")
# The files a build of the runtime reads beside the pins (one absent is named as absent).
BUILD_FILES = (
    HERE / "toolchain.json",
    HERE / "build-runtime.sh",
    HERE / "reader.init.gradle",
    HERE / "verification-metadata.xml",
    HERE.parent / "image" / "fetch-commit.sh",
)


def toolchain() -> dict:
    return json.loads(TOOLCHAIN.read_text(encoding="utf-8"))


def contents_digest(directory: Path) -> str:
    """The sha256 of ``<relative path>\\0<sha256 of its bytes>\\n`` for every file of an installed package, by
    path: a symbolic link by its target, and without ``package.xml``, which the installer writes beside what it
    unpacked."""
    entries = []
    for path in sorted(Path(directory).rglob("*")):
        relative = path.relative_to(directory).as_posix()
        if relative == "package.xml" or relative.startswith("."):
            continue
        if path.is_symlink():
            entries.append((relative, hashlib.sha256(os.readlink(path).encode()).hexdigest()))
        elif path.is_file():
            entries.append((relative, hashlib.sha256(path.read_bytes()).hexdigest()))
    digest = hashlib.sha256()
    for relative, content in entries:
        digest.update(f"{relative}\0{content}\n".encode())
    return digest.hexdigest()


def host() -> str:
    return {"Linux": "linux", "Darwin": "darwin"}.get(platform.system(), platform.system().lower())


def sdk_problems(sdk: Path) -> list[str]:
    """Why the SDK at ``sdk`` is not the one the toolchain names: a package missing, at another revision, or
    holding other bytes."""
    problems = []
    for package in toolchain()["androidSdk"]:
        directory = Path(sdk) / package["directory"]
        properties = directory / "source.properties"
        if not properties.is_file():
            problems.append(f"{package['package']} is not installed ({properties} is missing)")
            continue
        held = dict(
            line.split("=", 1)
            for line in properties.read_text(encoding="utf-8").splitlines()
            if "=" in line and not line.startswith("#")
        )
        if held.get("Pkg.Revision") != package["revision"]:
            problems.append(
                f"{package['package']} is at revision {held.get('Pkg.Revision')}, and the toolchain names"
                f" {package['revision']}"
            )
            continue
        expected = package["contents"].get("any") or package["contents"].get(host())
        actual = contents_digest(directory)
        if expected is None:
            problems.append(f"the toolchain names no contents of {package['package']} for {platform.system()}")
        elif actual != expected:
            problems.append(
                f"{package['package']} at revision {package['revision']} holds the contents {actual}, and the"
                f" toolchain names {expected}"
            )
    return problems


def prepare_sdk(target: Path) -> list[str]:
    """Make ``target`` an Android SDK directory the build may install into: empty but for the license
    acceptances of the SDK ``ANDROID_HOME`` names. This accepts nothing: where no person or runner image
    accepted the SDK's license there, it is a problem."""
    import shutil

    accepted = Path(os.environ.get("ANDROID_HOME") or "") / "licenses"
    if not (accepted / "android-sdk-license").is_file():
        return [
            "ANDROID_HOME names no Android SDK whose license was accepted (licenses/android-sdk-license); the"
            " build installs the SDK's packages only where a person or a runner image accepted its license"
        ]
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    if not (target / "licenses").is_dir():
        shutil.copytree(accepted, target / "licenses")
    return []


def key() -> str:
    pinned = json.loads(PINS.read_text(encoding="utf-8"))
    digest = hashlib.sha256()
    for name in PINNED:
        digest.update(f"{name}\0{pinned[name]['commit']}\n".encode())
    for path in BUILD_FILES:
        content = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "absent"
        digest.update(f"{path.name}\0{content}\n".encode())
    return digest.hexdigest()


def main(argv) -> int:
    if argv[:1] == ["sdk"] and len(argv) == 2:
        problems = sdk_problems(Path(argv[1]))
        if problems:
            print(
                f"The Android SDK at {argv[1]} is not the one proof/android/toolchain.json names: "
                + "; ".join(problems)
                + ". The build installs what it needs into an SDK directory that holds only accepted licenses"
                " (prepare-sdk); where the SDK's repository now gives another revision, move the toolchain's"
                " pin with it.",
                file=sys.stderr,
            )
            return 1
        return 0
    if argv[:1] == ["prepare-sdk"] and len(argv) == 2:
        problems = prepare_sdk(Path(argv[1]))
        if problems:
            print("The Android SDK directory could not be prepared: " + "; ".join(problems) + ".", file=sys.stderr)
            return 1
        return 0
    if argv[:1] == ["contents"] and len(argv) == 2:
        print(contents_digest(Path(argv[1])))
        return 0
    if argv == ["packages"]:
        print("\n".join(package["package"] for package in toolchain()["androidSdk"]))
        return 0
    if argv == ["key"]:
        print(key())
        return 0
    if argv[:1] == ["get"] and len(argv) == 3:
        print(toolchain()[argv[1]][argv[2]])
        return 0
    print(__doc__.split("\n\n")[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
