"""A base's retained answers as the reader bundle's first-read input (``proof/reader/laneReading.ts::LaneReadInput``).

The reader bundle (``native/reader/reader.mjs``) reads one requests file:
``{"requests": [{"id", "mode", "input", ...}]}``. ``first_read_input``
builds the ``input`` of a base's first reading from the files of a
``proof/hq-apps/<base>/`` directory, committed or as a run wrote it:
``identity: "mint"``, ``appId`` the base's id, the base's own declaration
where ``base.json`` states one, HQ's source, application and version
answers, the two project space lists where the directory holds them, and the
project data answers with each mapped file's read and bytes.

Standard library only: ``python3 -m proof.matrix.adopt`` reads it with no
image.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path


def _json(directory: Path, name: str):
    return json.loads((directory / name).read_text(encoding="utf-8"))


def _optional(directory: Path, name: str):
    path = directory / name
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def project_data(directory: Path) -> dict:
    """The ``projectData`` of a base's first reading: HQ's lookup table, row, level and place answers the directory
    holds, and each mapped file's read (``media-reads.json``) with its bytes (``media.json``'s file for its path)
    where HQ answered 200."""
    files = {row["path"]: row["file"] for row in (_optional(directory, "media.json") or [])}
    media = []
    for read in _optional(directory, "media-reads.json") or []:
        entry = {
            "path": read["path"],
            "mediaType": read["mediaType"],
            "multimediaId": read["multimediaId"],
            "status": read["status"],
        }
        if read["status"] == 200 and read["path"] in files:
            entry["base64"] = base64.b64encode((directory / files[read["path"]]).read_bytes()).decode("ascii")
        media.append(entry)
    found = {
        "fixtureRows": {
            path.stem[len("fixture-rows-") :]: json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(directory.glob("fixture-rows-*.json"))
        },
        "media": media,
    }
    # A base keeps the answers its reading asked for and no other (retain.py), so an answer it does not hold is
    # one the reading never asks for.
    for key, name in (
        ("lookupTables", "lookup-tables.json"),
        ("locationTypes", "location-types.json"),
        ("locations", "locations.json"),
    ):
        answer = _optional(directory, name)
        if answer is not None:
            found[key] = answer
    return found


def first_read_input(directory: Path, *, claims: str = "full") -> dict:
    """The ``LaneReadInput`` of the base at ``directory``'s first reading."""
    directory = Path(directory)
    base = _json(directory, "base.json")
    found = {
        "appId": base["id"],
        "source": _json(directory, "app-source.json"),
        "application": _json(directory, "application.json"),
        "currentVersion": _json(directory, "current-version.json"),
        "projectData": project_data(directory),
        "identity": "mint",
        "claims": claims,
    }
    spaces = _optional(directory, "project-spaces.json")
    flagged = _optional(directory, "project-spaces-flag.json")
    if spaces is not None and flagged is not None:
        found["projectSpaces"] = {"all": spaces, "flagged": flagged}
    if base["declaration"] != "preselected":
        found["declaration"] = base["declaration"]
    return found
