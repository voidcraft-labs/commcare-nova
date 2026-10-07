"""``python3 proof/android/toolchain.py``: what the reader's runtime is built with, read for a shell and a workflow.

    python3 proof/android/toolchain.py sdk <ANDROID_HOME>     refuses an SDK that is not the toolchain's
    python3 proof/android/toolchain.py packages               the SDK packages, one a line, as sdkmanager names them
    python3 proof/android/toolchain.py key                    what a built runtime is a function of, as one digest
    python3 proof/android/toolchain.py get <name> <field>     one value (jdk version, gradle sha256, ...)

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


def sdk_problems(sdk: Path) -> list[str]:
    """Why the SDK at ``sdk`` is not the one the toolchain names: a package missing, or at another revision."""
    problems = []
    for package in toolchain()["androidSdk"]:
        properties = Path(sdk) / package["directory"] / "source.properties"
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
    return problems


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
                + ". Install each named package at its revision (sdkmanager), or move the toolchain's pin with"
                " the SDK.",
                file=sys.stderr,
            )
            return 1
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
