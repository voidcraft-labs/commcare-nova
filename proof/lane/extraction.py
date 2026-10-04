"""The surface extraction and its key: the image and the extractor code that made it.

    python -m proof.lane.extraction --out DIR

extracts the surface once (``proof.surface``'s command line) into
``DIR/surface.json``, with how long each family took in ``DIR/timings.json``,
and writes the extraction's key beside them, ``DIR/extraction.json``::

    {"image": <the image's id>, "extractor": <digest of the extractor's code>}

The image is ``PROOF_IMAGE_ID``, the content-addressed id of the harness
image, which ``proof/run.mjs`` passes into every container it starts. The
extractor's code is every file under ``proof/surface`` but its tests and
conftest, and the Python of ``proof/hq``, whose HQ boot the extractor runs
(``proof/surface/hqboot.py``); ``extractor_digest`` is the sha256 over each
file's path and bytes. The key is read before the extraction runs, so a file
edited while it runs makes a key no later run matches.

An extraction stands in for a run's own (``PROOF_SURFACE_EXTRACTION``,
``proof/surface/conftest.py``) only when its key is that run's
(``key_problem``): an extraction another image or other extractor code made
could match the committed surface while this run's code would not, and the
surface block's verdict would then hold nothing.

Standard library only, apart from the extraction itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

PROOF_DIR = Path(__file__).resolve().parents[1]
IMAGE_ENVIRONMENT = "PROOF_IMAGE_ID"
KEY = "extraction.json"
SURFACE = "surface.json"
TIMINGS = "timings.json"


def extractor_files(proof_dir: Path = PROOF_DIR) -> list[Path]:
    """The extractor's code, in path order: what a change to would change the extraction."""

    def code(path: Path) -> bool:
        return (
            path.is_file()
            and "__pycache__" not in path.parts
            and path.name != "conftest.py"
            and not path.name.startswith("test_")
        )

    files = [path for path in (proof_dir / "surface").rglob("*") if code(path)]
    files += [path for path in (proof_dir / "hq").rglob("*.py") if code(path)]
    return sorted(files, key=lambda path: path.relative_to(proof_dir).as_posix())


def extractor_digest(proof_dir: Path = PROOF_DIR) -> str:
    digest = hashlib.sha256()
    for path in extractor_files(proof_dir):
        digest.update(path.relative_to(proof_dir).as_posix().encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).hexdigest().encode("ascii") + b"\n")
    return digest.hexdigest()


def key(proof_dir: Path = PROOF_DIR) -> dict:
    """This run's key: its image (None when ``PROOF_IMAGE_ID`` is unset) and its extractor code."""
    return {"image": os.environ.get(IMAGE_ENVIRONMENT) or None, "extractor": extractor_digest(proof_dir)}


def write_key(directory: Path, value: dict) -> None:
    Path(directory, KEY).write_text(json.dumps(value, indent="\t", sort_keys=True) + "\n", encoding="utf-8")


def _described(value: dict) -> str:
    return f"image {value.get('image')} with extractor code {value.get('extractor')}"


def key_problem(directory: Path, expected: dict) -> str | None:
    """Why the extraction in ``directory`` cannot stand in for one this run (``expected``) makes, or None."""
    directory = Path(directory)
    again = (
        "Extract it again with `npm run surface` (which leaves it in .proof/surface), or unset"
        " PROOF_SURFACE_EXTRACTION to extract in this run."
    )
    if expected.get("image") is None:
        return (
            f"PROOF_SURFACE_EXTRACTION names {directory}, and this run does not know its image ({IMAGE_ENVIRONMENT}"
            " is unset; proof/run.mjs sets it), so nothing shows the extraction was made by this run's image. " + again
        )
    try:
        recorded = json.loads((directory / KEY).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return (
            f"PROOF_SURFACE_EXTRACTION names {directory}, which holds no readable {KEY} saying which image and"
            f" extractor code made it ({error}). " + again
        )
    if not isinstance(recorded, dict) or recorded != expected:
        shown = _described(recorded) if isinstance(recorded, dict) else repr(recorded)
        return (
            f"PROOF_SURFACE_EXTRACTION names {directory}, an extraction made by {shown}, and this run is"
            f" {_described(expected)}, so it cannot stand in for this run's extraction. " + again
        )
    return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m proof.lane.extraction", description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help=f"the directory to write {SURFACE}, {TIMINGS}, {KEY}")
    arguments = parser.parse_args(argv)
    value = key()
    if value["image"] is None:
        print(
            f"{IMAGE_ENVIRONMENT} is unset, so the extraction would carry no image in its key and no run could reuse"
            " it; run it through `npm run surface` (proof/run.mjs), which sets it.",
            file=sys.stderr,
        )
        return 2
    from proof.surface.__main__ import main as extract

    out = arguments.out
    code = extract(["--out", str(out / SURFACE), "--timings", str(out / TIMINGS)])
    if code == 0:
        write_key(out, value)
    return code


if __name__ == "__main__":
    sys.exit(main())
