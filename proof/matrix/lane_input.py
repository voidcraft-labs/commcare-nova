"""A base's retained answers as the reader bundle's first-read input (``proof/reader/laneReading.ts::LaneReadInput``).

The reader bundle (``native/reader/reader.mjs``) reads one requests file:
``{"requests": [{"id", "mode", "input", ...}]}``. ``input_of`` builds the
``input`` of a base's first reading from the members of a
``proof/hq-apps/<base>/`` directory as the retained layout read them
(``proof.matrix.layout``): ``identity: "mint"``, ``appId`` the base's id,
the base's own declaration where ``base.json`` states one, HQ's source,
application and version answers, the two project space lists where the
directory holds them, and the project data answers with each mapped file's
read and bytes. A media row's file is looked up among the members the layout
read, never joined to a directory, so a row can name only one of the base's
own media files. ``first_read_input`` reads a directory through the layout
first.

Standard library only: ``python3 -m proof.matrix.adopt`` reads it with no
image.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Mapping
from pathlib import Path

from proof.matrix import layout


def fixture_rows_stem(tag: str) -> str:
    if re.fullmatch(r"[a-z_][a-z0-9_.-]*", tag):
        return f"fixture-rows-{tag}"
    return "fixture-rows~" + "-".join(format(ord(unit), "x") for unit in tag)


def fixture_rows_tag(name: str) -> str | None:
    plain = re.fullmatch(r"fixture-rows-([A-Za-z_][A-Za-z0-9_.-]*)\.json", name)
    if plain is not None:
        return plain.group(1)
    encoded = re.fullmatch(
        r"fixture-rows~([0-9a-f]{1,6}(?:-[0-9a-f]{1,6}){0,31})\.json", name
    )
    if encoded is None:
        return None
    units = [int(token, 16) for token in encoded.group(1).split("-")]
    if any(n > 0x10FFFF or 0xD800 <= n <= 0xDFFF for n in units):
        raise layout.LayoutRefused(
            [f"Invalid Unicode scalar in retained fixture rows filename {name}"]
        )
    tag = "".join(chr(n) for n in units)
    if fixture_rows_stem(tag) + ".json" != name:
        raise layout.LayoutRefused(
            [f"Noncanonical retained fixture rows filename {name}"]
        )
    return tag


def _json(members: Mapping[str, bytes], name: str):
    if name not in members:
        raise layout.LayoutRefused(
            [f"The base holds no {name}, which its first reading reads."]
        )
    return json.loads(members[name].decode("utf-8"))


def _optional(members: Mapping[str, bytes], name: str):
    return json.loads(members[name].decode("utf-8")) if name in members else None


def project_data(members: Mapping[str, bytes]) -> dict:
    """The ``projectData`` of a base's first reading: HQ's lookup table, row, level and place answers the base
    holds, and each mapped file's read (``media-reads.json``) with its bytes (``media.json``'s file for its path,
    looked up among the base's members) where HQ answered 200."""
    files = {
        row["path"]: row["file"] for row in (_optional(members, "media.json") or [])
    }
    media = []
    for read in _optional(members, "media-reads.json") or []:
        entry = {
            "path": read["path"],
            "mediaType": read["mediaType"],
            "multimediaId": read["multimediaId"],
            "status": read["status"],
        }
        if read["status"] == 200 and read["path"] in files:
            named = files[read["path"]]
            if named not in members:
                raise layout.LayoutRefused(
                    [
                        f"media.json names {json.dumps(named)} for {read['path']}, which is not one of the base's files."
                    ]
                )
            entry["base64"] = base64.b64encode(members[named]).decode("ascii")
        media.append(entry)
    fixtures = {}
    for name in sorted(members):
        tag = fixture_rows_tag(name)
        if tag is not None:
            if tag in fixtures:
                raise layout.LayoutRefused(
                    [f"The base holds two fixture row answers for {tag}"]
                )
            fixtures[tag] = _json(members, name)
    found = {"fixtureRows": fixtures, "media": media}
    # A base keeps the answers its reading asked for and no other (retain.py), so an answer it does not hold is
    # one the reading never asks for.
    for key, name in (
        ("lookupTables", "lookup-tables.json"),
        ("locationTypes", "location-types.json"),
        ("locations", "locations.json"),
    ):
        answer = _optional(members, name)
        if answer is not None:
            found[key] = answer
    return found


def input_of(members: Mapping[str, bytes], *, claims: str = "full") -> dict:
    """The ``LaneReadInput`` of a base's first reading, from its members as the retained layout read them."""
    base = _json(members, "base.json")
    found = {
        "appId": base["id"],
        "source": _json(members, "app-source.json"),
        "application": _json(members, "application.json"),
        "currentVersion": _json(members, "current-version.json"),
        "projectData": project_data(members),
        "identity": "mint",
        "claims": claims,
    }
    factories = _optional(members, "source-factories.json")
    if factories:
        found["sourceFactoryReads"] = factories
    spaces = _optional(members, "project-spaces.json")
    flagged = _optional(members, "project-spaces-flag.json")
    if spaces is not None and flagged is not None:
        found["projectSpaces"] = {"all": spaces, "flagged": flagged}
    if base["declaration"] != "preselected":
        found["declaration"] = base["declaration"]
    return found


def first_read_input(directory: Path, *, claims: str = "full") -> dict:
    """The ``LaneReadInput`` of the base at ``directory``'s first reading, its members read through the layout."""
    return input_of(layout.read_base(Path(directory)), claims=claims)
