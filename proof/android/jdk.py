"""Prepare the pinned Linux JDK once; every consumer verifies the cached archive.

The runtime builder alone may download it. Three bounded attempts recover
transient transport failures; checksum or layout failures never become a cache
entry. Consumers never fall back to a version lookup or an unpinned runner JDK.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import os
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from proof.android.toolchain import toolchain


class JdkUnavailable(RuntimeError):
    pass


def verify(archive, pin):
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != pin["sha256"]:
        raise JdkUnavailable(f"Pinned Android JDK archive failed SHA-256 verification: {actual}.")


def download(archive, pin):
    archive.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            with tempfile.TemporaryDirectory(dir=archive.parent) as scratch:
                partial = Path(scratch) / "jdk.tar.gz"
                started = time.monotonic()
                with urllib.request.urlopen(pin["url"], timeout=60) as response, partial.open("wb") as target:
                    while chunk := response.read(1024 * 1024):
                        target.write(chunk)
                        if time.monotonic() - started > 180:
                            raise TimeoutError("JDK download exceeded 180 seconds")
                verify(partial, pin)
                partial.replace(archive)
            return
        except (OSError, http.client.HTTPException) as error:
            transient = not isinstance(error, urllib.error.HTTPError) or error.code in (408, 429) or error.code >= 500
            if not transient or attempt == 2:
                raise JdkUnavailable(
                    f"Pinned Android JDK download failed after {attempt + 1} attempt(s): {error}"
                ) from error
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
