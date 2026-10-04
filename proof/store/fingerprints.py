"""What names the code, image and platform an evidence-store entry was made under.

    python3 -m proof.store.fingerprints [--arch arm64|amd64] [--image IMAGE] [--root DIR]

prints the fingerprints as one line of canonical JSON: the value the lane's
containers read as ``PROOF_FINGERPRINTS`` (``current``), and what the queue
builder writes into a queue's ``fingerprints``.

Each partition's fingerprint is the sha256 of the lines ``<path>\\0<git blob
hash>\\n`` of its files, sorted by path. The files are the checkout's: every
file git tracks and every untracked file it does not ignore, each hashed as
git hashes a blob from the bytes in the working tree, so a clean checkout
gives exactly ``git ls-files -s`` and an edited one names its edits. A file a
sparse checkout leaves out of the working tree keeps the hash git's index
holds for it. A copy of a checkout without git is read by walking the
directories the partitions cover (``walked_files``).

- ``observation``: every file ``proof.observe.partition.observes`` holds, and
  the lane's container configuration (``LANE_FILES``: the compose file that
  sets the harness's environment and the script that starts it), which
  decides what the observation's code runs under.
- ``browser``: the editor driver's code, ``proof/editors/driver/**``, which
  node runs and the observation partition leaves out.
- ``judge``: every file under ``proof/checks/`` the observation does not
  hold, ``proof/rules/**``, both registers (``proof/identity-moves.json``,
  and ``proof/known-defects.json``, which the sensitivity judge reads before
  it writes its evidence: ``proof/checks/sensitivity.py::hold_flips``), and
  ``lib/commcare/surface/**``.
- ``harness``: every file under ``proof/`` and ``lib/commcare/surface/``, and
  Nova's package manifest, lock and Node version (``HARNESS_FILES``): what a
  package group's tests can read of the checkout.

Beside them: ``image``, the digest ``proof/image.lock`` pins (or one named
with ``--image``); ``postgres``, the digest of the Postgres image
``proof/compose.yaml`` pins; ``arch``, the architecture the lane runs on.

Standard library and git only, so it runs on the runner's own Python.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

from proof.observe.partition import observes

WORKTREE = Path(__file__).resolve().parents[2]
ENVIRONMENT = "PROOF_FINGERPRINTS"
# What a queue's and the lane's fingerprints hold, each a string.
NAMES = ("observation", "browser", "judge", "harness", "image", "postgres", "arch")
ARCHES = ("arm64", "amd64")

# The lane's container configuration: what its environment, mounts and Postgres are.
LANE_FILES = frozenset({"proof/compose.yaml", "proof/run.mjs"})
BROWSER_DIRECTORY = "proof/editors/driver/"
JUDGE_DIRECTORIES = ("proof/checks/", "proof/rules/", "lib/commcare/surface/")
JUDGE_FILES = frozenset({"proof/identity-moves.json", "proof/known-defects.json"})
HARNESS_DIRECTORIES = ("proof/", "lib/commcare/surface/")
HARNESS_FILES = frozenset({"package.json", "package-lock.json", ".nvmrc"})
# The paths a walk of a copy without git reads: the partitions' directories and files.
WALKED = ("proof", "lib/commcare/surface", *sorted(HARNESS_FILES))
# What a walk leaves out, as git's ignore rules would: bytecode, installed packages, the lane's output.
WALK_SKIPPED = frozenset({"__pycache__", "node_modules", ".proof", ".DS_Store", ".git", ".ruff_cache", ".pytest_cache"})

LOCK = "proof/image.lock"
COMPOSE = "proof/compose.yaml"
DIGEST = re.compile(r"@(sha256:[0-9a-f]{64})\s*$")


class FingerprintError(ValueError):
    """The checkout cannot be fingerprinted: its lock, compose file or git could not be read."""


def blob_hash(content: bytes) -> str:
    """The hash git gives a blob of ``content`` (``git hash-object``)."""
    return hashlib.sha1(b"blob %d\0" % len(content) + content).hexdigest()


def _file_hash(path: Path) -> str:
    if path.is_symlink():
        # git stores a symbolic link as a blob of its target.
        return blob_hash(os.readlink(path).encode())
    return blob_hash(path.read_bytes())


def _git(root: Path, *arguments: str) -> list[str]:
    try:
        result = subprocess.run(["git", "-C", str(root), *arguments], capture_output=True, check=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as error:
        detail = getattr(error, "stderr", b"") or b""
        raise FingerprintError(
            f"git could not list the checkout at {root} ({' '.join(arguments[:2])}: "
            f"{detail.decode(errors='replace').strip() or error}). The fingerprints name every file git tracks, so"
            " run this in a git checkout, or in a copy without .git, which is walked instead."
        ) from error
    return [entry for entry in result.stdout.decode("utf-8", "surrogateescape").split("\0") if entry]


def git_files(root: Path) -> dict[str, str]:
    """Every file of the checkout the fingerprints cover, by path, with its git blob hash."""
    scope = ["--", *WALKED]
    found = {}
    skipped = set()
    for entry in _git(root, "ls-files", "-z", "-s", "-t", *scope):
        tag, rest = entry.split(" ", 1)
        meta, path = rest.split("\t", 1)
        _, object_hash, stage = meta.split(" ")
        if stage != "0":
            continue
        found[path] = object_hash
        if tag == "S":
            skipped.add(path)
    for path in _git(root, "diff-files", "-z", "--name-only", *scope):
        if path in skipped:
            continue
        file = root / path
        if file.is_file() or file.is_symlink():
            found[path] = _file_hash(file)
        else:
            found.pop(path, None)
    for path in _git(root, "ls-files", "-z", "--others", "--exclude-standard", *scope):
        file = root / path
        if file.is_file() or file.is_symlink():
            found[path] = _file_hash(file)
    return found


def walked_files(root: Path) -> dict[str, str]:
    """The files the fingerprints cover in a copy of a checkout without git, read from its directories."""
    found = {}
    for name in WALKED:
        start = root / name
        if start.is_file():
            found[name] = _file_hash(start)
            continue
        for directory, subdirectories, files in os.walk(start):
            subdirectories[:] = sorted(d for d in subdirectories if d not in WALK_SKIPPED)
            for file in files:
                if file in WALK_SKIPPED or file.endswith(".pyc"):
                    continue
                path = Path(directory, file)
                found[path.relative_to(root).as_posix()] = _file_hash(path)
    return found


def checkout_files(root: Path = WORKTREE) -> dict[str, str]:
    root = Path(root)
    return git_files(root) if (root / ".git").exists() else walked_files(root)


def in_observation(path: str) -> bool:
    return observes(path) or path in LANE_FILES


def in_browser(path: str) -> bool:
    return path.startswith(BROWSER_DIRECTORY)


def in_judge(path: str) -> bool:
    if path in JUDGE_FILES:
        return True
    return any(path.startswith(directory) for directory in JUDGE_DIRECTORIES) and not observes(path)


def in_harness(path: str) -> bool:
    return path in HARNESS_FILES or any(path.startswith(directory) for directory in HARNESS_DIRECTORIES)


PARTITIONS = {"observation": in_observation, "browser": in_browser, "judge": in_judge, "harness": in_harness}


def partition_digest(files: dict[str, str]) -> str:
    """The sha256 of ``<path>\\0<blob hash>\\n`` for each file, by path."""
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(f"{PurePosixPath(path).as_posix()}\0{files[path]}\n".encode())
    return digest.hexdigest()


def locked_image(root: Path = WORKTREE) -> str:
    """The digest of the image ``proof/image.lock`` pins (``sha256:<hex>``)."""
    path = Path(root) / LOCK
    try:
        image = json.loads(path.read_text(encoding="utf-8"))["image"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise FingerprintError(f"{path} could not be read as the image lock ({error}).") from error
    found = DIGEST.search(image or "")
    if found is None:
        raise FingerprintError(
            f"{path} records the image {image!r}, which no sha256 digest pins; the store's keys name that digest."
        )
    return found.group(1)


def compose_postgres(root: Path = WORKTREE) -> str:
    """The digest of the Postgres image ``proof/compose.yaml``'s ``postgres`` service pins."""
    path = Path(root) / COMPOSE
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise FingerprintError(f"{path} could not be read ({error}).") from error
    service_indent = None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if stripped == "postgres:":
            service_indent = indent
            continue
        if service_indent is not None:
            if indent <= service_indent:
                break
            if stripped.startswith("image:"):
                found = DIGEST.search(stripped)
                if found is None:
                    break
                return found.group(1)
    raise FingerprintError(
        f"{path} holds no postgres service whose image is pinned by a sha256 digest; the store's keys name it."
    )


def host_arch() -> str:
    machine = platform.machine().lower()
    return {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(machine, machine)


def compute(root: Path = WORKTREE, *, arch: str | None = None, image: str | None = None, files=None) -> dict:
    """Every fingerprint of the checkout at ``root``, on ``arch`` (the host's), of ``image`` (the lock's)."""
    root = Path(root)
    files = checkout_files(root) if files is None else files
    found = {
        name: partition_digest({path: blob for path, blob in files.items() if belongs(path)})
        for name, belongs in PARTITIONS.items()
    }
    arch = arch or host_arch()
    if arch not in ARCHES:
        raise FingerprintError(f"The architecture is {arch!r}; the lane runs on {' or '.join(ARCHES)}.")
    found["image"] = image or locked_image(root)
    found["postgres"] = compose_postgres(root)
    found["arch"] = arch
    return found


def problem(value) -> str | None:
    """Why ``value`` is not a set of fingerprints (``NAMES``, each a non-empty string), or None."""
    if not isinstance(value, dict):
        return f"it is {type(value).__name__}, not an object"
    missing = [name for name in NAMES if not isinstance(value.get(name), str) or not value.get(name)]
    if missing:
        return f"it lacks {', '.join(missing)}"
    return None


def current(environ=None) -> dict | None:
    """The fingerprints the lane was started with (``PROOF_FINGERPRINTS``), or None when it names none."""
    environ = os.environ if environ is None else environ
    raw = environ.get(ENVIRONMENT)
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return None if problem(value) else {name: value[name] for name in NAMES}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m proof.store.fingerprints", description=__doc__.splitlines()[0])
    parser.add_argument("--arch", choices=ARCHES, help="the architecture the lane runs on (the host's by default)")
    parser.add_argument("--image", help="the image's digest or id (the digest proof/image.lock pins by default)")
    parser.add_argument("--root", type=Path, default=WORKTREE, help="the checkout (this one by default)")
    arguments = parser.parse_args(argv)
    try:
        found = compute(arguments.root, arch=arguments.arch, image=arguments.image)
    except FingerprintError as error:
        print(error, file=sys.stderr)
        return 2
    print(json.dumps(found, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
