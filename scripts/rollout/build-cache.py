#!/usr/bin/env python3
"""Private immutable BuildKit caches; GCS stores only completion manifests.

Compiler state travels directly between Artifact Registry and BuildKit. There
is no host extraction, gzip archive, or compiler cache in an application layer.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess

CACHE_FORMAT = "v2"
PLATFORM = "linux/amd64"
BUILD_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def cache_key(root: Path, profile: str = "production") -> str:
    digest = hashlib.sha256(f"{CACHE_FORMAT}\n{PLATFORM}\n{profile}\n".encode())
    for name in (".nvmrc", ".npmrc", "package-lock.json", "Dockerfile", "next.config.ts", "tsconfig.production.json", "scripts/build-app.mjs"):
        digest.update(name.encode() + b"\0" + (root / name).read_bytes() + b"\0")
    return f"{CACHE_FORMAT}-{digest.hexdigest()[:24]}"


def gcloud(*args: str) -> str:
    result = subprocess.run(["gcloud", *args, "--verbosity=error"], check=True,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    return result.stdout.strip()


def next_repository(args: argparse.Namespace) -> str:
    return args.repository.rsplit("/", 1)[0] + "/next"


def restore(args: argparse.Namespace) -> None:
    args.directory.mkdir(parents=True, exist_ok=True)
    seed = args.directory / "input"
    if seed.exists():
        shutil.rmtree(seed)
    seed.mkdir()
    for name in ("seed-context", "next-image.json", "app-image.json", "migration-image.json"):
        (args.directory / name).unlink(missing_ok=True)
    key = cache_key(args.root, args.profile)
    docker_prefix = f"{args.repository}:{key}-"
    environment = {
        "NOVA_BUILD_CACHE_DIRECTORY": str(args.directory.resolve()),
        "NOVA_DOCKER_CACHE_TO": f"{docker_prefix}{args.build_id}",
        "NOVA_NEXT_CACHE_TO": f"{next_repository(args)}:{key}-{args.build_id}",
    }
    try:
        if args.cold:
            raise ValueError("Cold build requested")
        manifests = sorted(gcloud("storage", "ls", f"gs://{args.bucket}/{key}/snapshots/*.json").splitlines())
        if not manifests:
            raise ValueError("No snapshot")
        manifest = json.loads(gcloud("storage", "cat", manifests[-1]))
        snapshot_id = manifest["buildId"]
        if not BUILD_ID_RE.fullmatch(snapshot_id) or manifest["key"] != key or not DIGEST_RE.fullmatch(manifest["nextDigest"]):
            raise ValueError("Invalid snapshot identity")
        environment["NOVA_DOCKER_CACHE_FROM"] = f"{docker_prefix}{snapshot_id}"
        environment["NOVA_NEXT_CACHE_FROM"] = f"{next_repository(args)}@{manifest['nextDigest']}"
        print(f"Selected immutable build cache {snapshot_id}; compiler bytes stay in BuildKit.")
    except (subprocess.SubprocessError, ValueError, KeyError, TypeError, OSError):
        print("No usable build cache; building cold.")
    args.environment.write_text("".join(f"export {key}={shlex.quote(value)}\n"
                                        for key, value in environment.items()))


def publish(args: argparse.Namespace) -> None:
    key = cache_key(args.root, args.profile)
    try:
        metadata = json.loads((args.directory / "next-image.json").read_text())
        digest = metadata["containerimage.digest"]
        if not DIGEST_RE.fullmatch(digest):
            raise ValueError("Invalid exported compiler cache digest")
        manifest = {"buildId": args.build_id, "key": key, "nextDigest": digest}
        manifest_path = args.directory / "manifest.json"
        manifest_path.write_text(json.dumps(manifest) + "\n")
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        gcloud("storage", "cp", "--if-generation-match=0", str(manifest_path),
               f"gs://{args.bucket}/{key}/snapshots/{timestamp}-{args.build_id}.json")
        print(f"Published {manifest_path.stat().st_size}-byte completion manifest for {args.build_id}.")
    except (subprocess.SubprocessError, ValueError, KeyError, TypeError, OSError) as error:
        print(f"Cache publication skipped ({type(error).__name__}); the build remains valid.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("restore", "publish"))
    parser.add_argument("--build-id", required=True)
    parser.add_argument("--cold", action="store_true", help="do not restore prior build caches")
    parser.add_argument("--profile", choices=("production", "benchmark"), default="production")
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
