"""``proof.matrix.lane_input``: a base's first-read input from the members the retained layout read.

The contract: a media row's file is looked up among the base's members,
never joined to a directory, so a row naming anything else is refused and
no byte outside the base is read; a row naming one of the base's own media
files carries its bytes. Standard library only.
"""

from __future__ import annotations

import base64
import json

import pytest

from proof.matrix import lane_input, layout

BASE = {
    "base.json": json.dumps({"id": "hq-media", "declaration": "preselected"}).encode(),
    "app-source.json": b"{}",
    "application.json": b"{}",
    "current-version.json": b"{}",
}


def _members(named: str) -> dict[str, bytes]:
    rows = [{"path": "jr://file/a.png", "file": named}]
    reads = [{"path": "jr://file/a.png", "mediaType": "CommCareImage", "multimediaId": "m", "status": 200}]
    return {
        **BASE,
        "media.json": json.dumps(rows).encode(),
        "media-reads.json": json.dumps(reads).encode(),
        "media/0.png": b"\x89PNG",
    }


def test_a_media_row_carries_its_own_file_bytes():
    found = lane_input.input_of(_members("media/0.png"))
    assert found["projectData"]["media"][0]["base64"] == base64.b64encode(b"\x89PNG").decode()


@pytest.mark.parametrize("named", ["../../../etc/hosts", "/etc/hosts", "media/1.png"])
def test_a_media_row_naming_no_member_is_refused(named):
    with pytest.raises(layout.LayoutRefused) as refused:
        lane_input.input_of(_members(named))
    assert "which is not one of the base's files" in str(refused.value)
