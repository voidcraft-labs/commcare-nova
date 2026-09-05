#!/usr/bin/env python3
"""Resolve the immutable manifest emitted by BuildKit's successful push."""
import argparse
import json
from pathlib import Path
import re


def write_image_environment(metadata: Path, repository: str, output: Path) -> str:
    if not re.fullmatch(r"[a-z0-9.-]+-docker\.pkg\.dev/[a-z0-9][a-z0-9/_-]+", repository):
        raise ValueError("Expected a canonical Artifact Registry repository")
    digest = json.loads(metadata.read_text())["containerimage.digest"]
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("BuildKit did not return an immutable pushed image digest")
    image = f"{repository}@{digest}"
    output.write_text(f"NOVA_IMMUTABLE_IMAGE='{image}'\nNOVA_IMAGE_DIGEST='{digest}'\n")
    return image


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print("NOVA_PUSHED_IMAGE=" + write_image_environment(args.metadata, args.repository, args.output))
