"""Prepare the pinned Linux JDK once; every consumer verifies the cached archive.

The runtime builder alone may download it. Three bounded attempts recover
transient transport failures; checksum or layout failures never become a cache
entry. Consumers never fall back to a version lookup or an unpinned runner JDK.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tarfile
import tempfile
import time
from pathlib import Path

from proof import processes
from proof.android.toolchain import toolchain

DOWNLOAD_SECONDS = 180
TRANSIENT_CURL = {5, 6, 7, 18, 28, 35, 52, 55, 56}


class JdkUnavailable(RuntimeError):
    pass


def verify(archive, pin):
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != pin["sha256"]:
        raise JdkUnavailable(f"Pinned Android JDK archive failed SHA-256 verification: {actual}.")


def transfer(url, partial):
    """One curl, killed and joined even if it exceeds its own total transfer deadline.

    Exit 18 distinguishes a truncated response from a complete archive with
    incorrect bytes. Curl's max-time covers headers and a continuously slow
    body, unlike a socket's inactivity timeout.
    """
    status, errors = partial.with_suffix(".status"), partial.with_suffix(".errors")
    with status.open("w") as output, errors.open("w") as stderr:
        try:
            code = processes.run(
                [
                    "curl",
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--connect-timeout",
                    "30",
                    "--max-time",
                    str(DOWNLOAD_SECONDS),
                    "--output",
                    str(partial),
                    "--write-out",
                    "%{http_code}",
                    url,
                ],
                timeout=DOWNLOAD_SECONDS + 5,
                stdout=output,
                stderr=stderr,
            )
        except processes.TimedOut:
            return True, "JDK transfer exceeded its process deadline"
    if code == 0:
        return False, None
    http_status = status.read_text().strip()
    transient = code in TRANSIENT_CURL or (
        code == 22 and (http_status in {"408", "429"} or http_status.startswith("5"))
    )
    return transient, f"curl exit {code}, HTTP {http_status}: {errors.read_text().strip()}"


def download(archive, pin):
    archive.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        with tempfile.TemporaryDirectory(dir=archive.parent) as scratch:
            partial = Path(scratch) / "jdk.tar.gz"
            transient, error = transfer(pin["url"], partial)
            if error is None:
                verify(partial, pin)
                partial.replace(archive)
                return
        if not transient or attempt == 2:
            raise JdkUnavailable(f"Pinned Android JDK download failed after {attempt + 1} attempt(s): {error}")
        delay = (5, 15)[attempt]
        print(f"Pinned Android JDK download failed ({error}); retrying in {delay}s.", file=sys.stderr)
        time.sleep(delay)


def prepare(archive, target, *, allow_download=False, pin=None):
    pin = toolchain()["jdk"]["linuxX64"] if pin is None else pin
    archive, target = Path(archive), Path(target)
    if not archive.is_file():
        if not allow_download:
            raise JdkUnavailable(
                "Pinned Android JDK archive is missing from the runtime cache; the runtime builder must prepare it."
            )
        download(archive, pin)
    verify(archive, pin)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as scratch:
        with tarfile.open(archive) as packed:
            packed.extractall(scratch, filter="data")
        roots = list(Path(scratch).iterdir())
        if len(roots) != 1 or not (roots[0] / "bin/java").is_file() or not (roots[0] / "release").is_file():
            raise JdkUnavailable("Pinned Android JDK archive does not contain one JDK with bin/java and release.")
        if target.exists():
            shutil.rmtree(target)
        roots[0].replace(target)
    return target.resolve()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--download", action="store_true")
    arguments = parser.parse_args()
    try:
        home = prepare(arguments.archive, arguments.target, allow_download=arguments.download)
    except (JdkUnavailable, OSError, tarfile.TarError) as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as env:
        env.write(f"JAVA_HOME={home}\n")
    with open(os.environ["GITHUB_PATH"], "a", encoding="utf-8") as path:
        path.write(f"{home / 'bin'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
