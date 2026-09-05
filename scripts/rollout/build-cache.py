#!/usr/bin/env python3
"""Best-effort compiler caches. No deployable output or credentials in GCS.

Each successful build publishes an immutable manifest last. Readers select the
newest complete snapshot in their compatibility namespace; concurrent writers
never overwrite each other's cache. Only main's build identity can write here.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import tarfile

CACHE_FORMAT = "v1"
PLATFORM = "linux/amd64"
MAX_CACHE_BYTES = 2 * 1024**3
BUILD_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def cache_key(root: Path) -> str:
    digest = hashlib.sha256(f"{CACHE_FORMAT}\n{PLATFORM}\n".encode())
    for name in (".nvmrc", ".npmrc", "package-lock.json", "Dockerfile", "next.config.ts"):
        digest.update(name.encode() + b"\0" + (root / name).read_bytes() + b"\0")
    return f"{CACHE_FORMAT}-{digest.hexdigest()[:24]}"


def gcloud(*args: str) -> str:
    result = subprocess.run(["gcloud", *args, "--verbosity=error"], check=True,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    return result.stdout.strip()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_cache(archive: Path, destination: Path) -> None:
    # Validate the whole archive before writing, including links and total size.
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        total = 0
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError("Cache archive contains an unsafe entry")
            total += member.size
            if total > MAX_CACHE_BYTES:
                raise ValueError("Cache archive exceeds 2 GiB")
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                stream = source.extractfile(member)
                if stream is None:
                    raise ValueError("Missing cache file contents")
                with stream, target.open("wb") as out:
                    shutil.copyfileobj(stream, out)
                target.chmod(0o600)


def restore(args: argparse.Namespace) -> None:
    args.directory.mkdir(parents=True, exist_ok=True)
    seed = args.directory / "input"
    # This directory belongs solely to this invocation; never trust a partial
    # extraction from an earlier failed attempt.
    if seed.exists():
        shutil.rmtree(seed)
    seed.mkdir()
    key = cache_key(args.root)
    prefix = f"gs://{args.bucket}/{key}"
    docker_prefix = f"{args.repository}:{key}-"
    environment = {
        "NOVA_BUILD_CACHE_DIRECTORY": str(args.directory.resolve()),
        "NOVA_DOCKER_CACHE_TO": f"{docker_prefix}{args.build_id}",
        "NOVA_EXPORT_NEXT_CACHE": "true",
    }
    try:
        if getattr(args, "cold", False):
            raise ValueError("Cold benchmark requested")
        manifests = sorted(gcloud("storage", "ls", f"{prefix}/snapshots/*.json").splitlines())
        if not manifests:
            raise ValueError("No snapshot")
        manifest = json.loads(gcloud("storage", "cat", manifests[-1]))
        snapshot_id = manifest["buildId"]
        if not BUILD_ID_RE.fullmatch(snapshot_id) or manifest["key"] != key:
            raise ValueError("Invalid snapshot identity")
        archive_uri = f"{prefix}/archives/{snapshot_id}.tgz"
        archive = args.directory / "restored.tgz"
        gcloud("storage", "cp", archive_uri, str(archive))
        if file_sha256(archive) != manifest["sha256"]:
            raise ValueError("Cache checksum mismatch")
        extract_cache(archive, seed)
        environment["NOVA_DOCKER_CACHE_FROM"] = f"{docker_prefix}{snapshot_id}"
        print(f"Restored Next.js and Docker cache snapshot {snapshot_id}")
    except (subprocess.SubprocessError, ValueError, KeyError, OSError, tarfile.TarError):
        shutil.rmtree(seed)
        seed.mkdir()
        print("No usable build cache; building cold.")
    args.environment.write_text("".join(f"export {key}={shlex.quote(value)}\n"
                                        for key, value in environment.items()))


def publish(args: argparse.Namespace) -> None:
    output = args.directory / "output"
    if not output.is_dir():
        print("No compiler cache exported; skipping cache publication.")
        return
    key = cache_key(args.root)
    prefix = f"gs://{args.bucket}/{key}"
    try:
        files = list(output.rglob("*"))
        if any(path.is_symlink() for path in files):
            raise ValueError("Cache contains a link")
        if sum(path.stat().st_size for path in files if path.is_file()) > MAX_CACHE_BYTES:
            raise ValueError("Cache exceeds 2 GiB")
        archive = args.directory / "published.tgz"
        with tarfile.open(archive, "w:gz", compresslevel=1) as dest:
            dest.add(output, arcname=".")
        manifest = {
            "buildId": args.build_id,
            "key": key,
            "sha256": file_sha256(archive),
        }
        manifest_path = args.directory / "manifest.json"
        manifest_path.write_text(json.dumps(manifest) + "\n")
        # Creating a new object is atomic. The manifest is the completion marker.
        gcloud("storage", "cp", "--if-generation-match=0", str(archive),
               f"{prefix}/archives/{args.build_id}.tgz")
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        gcloud("storage", "cp", "--if-generation-match=0", str(manifest_path),
               f"{prefix}/snapshots/{timestamp}-{args.build_id}.json")
        print(f"Published compiler cache snapshot {args.build_id}")
    except (subprocess.SubprocessError, ValueError, OSError, tarfile.TarError) as error:
        print(f"Cache publication skipped ({type(error).__name__}); the build remains valid.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("restore", "publish"))
    parser.add_argument("--build-id", required=True)
    parser.add_argument("--cold", action="store_true", help="benchmark without restoring previous caches")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--bucket", default="commcare-nova-build-cache")
    parser.add_argument("--repository", default="us-central1-docker.pkg.dev/commcare-nova/nova-build-cache/compiler")
    parser.add_argument("--directory", type=Path, default=Path("/workspace/.nova-build-cache"))
    parser.add_argument("--environment", type=Path, default=Path("/workspace/cache.env"))
    args = parser.parse_args()
    if not BUILD_ID_RE.fullmatch(args.build_id):
        parser.error("--build-id must be a Cloud Build UUID")
    (restore if args.mode == "restore" else publish)(args)


if __name__ == "__main__":
    main()
