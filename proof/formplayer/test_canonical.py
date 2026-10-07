"""Marking what Formplayer generated: only ids no input holds, the same token wherever one id occurs.

Contract (``proof.formplayer.canonical``): an id is marked when it is shaped
as a generated UUID, is a whole value (a JSON string, or a text or attribute
of an XML document a string holds), and is in no input; every occurrence of
it then holds one token, numbered by first appearance. Plausible failures: an
id an app or a restore authors marked (two documents' cases would read
alike), a generated id left in longer text (two runs would differ), or two
different ids given one token (a difference would vanish).
"""

from __future__ import annotations

import io
import zipfile

from proof.formplayer import canonical

GENERATED = "816c51dd-c6ff-4858-841b-c240493a3a3f"
OTHER = "f9bd2c66-5e58-4325-8cd5-983ac99b864d"
AUTHORED = "0b32ad70-b6dd-4c1a-9c1a-2d4bd0f3499d"


def test_a_generated_id_is_marked_everywhere_and_an_id_an_input_holds_is_kept():
    value = {
        "session_id": GENERATED,
        "selections": ["0", AUTHORED],
        "title": f"Session {GENERATED}",
        "instanceXml": {"output": f'<data id="{OTHER}"><case>{AUTHORED}</case><instanceID>{GENERATED}</instanceID></data>'},
        "other": OTHER,
    }
    marked, count = canonical.mark(value, canonical.given_ids([f"<restore><case_id>{AUTHORED}</case_id></restore>"]))
    assert count == 2
    # Tokens number the ids in the order the value's keys, sorted, first hold them: instanceXml before session_id.
    assert marked["instanceXml"]["output"] == (
        f'<data id="@generated:uuid:1"><case>{AUTHORED}</case><instanceID>@generated:uuid:2</instanceID></data>'
    )
    assert marked["other"] == "@generated:uuid:1"
    assert marked["session_id"] == "@generated:uuid:2"
    assert marked["title"] == "Session @generated:uuid:2"
    assert marked["selections"] == ["0", AUTHORED]


def test_an_id_only_inside_longer_text_is_not_taken_for_generated():
    value = {"caption": f"See {GENERATED} for details", "not-an-id": "816c51dd-c6ff-1858-841b-c240493a3a3f"}
    marked, count = canonical.mark(value, set())
    assert (marked, count) == (value, 0)


def test_the_ids_an_archive_holds_are_its_text_entries_and_media_is_passed_over():
    held = io.BytesIO()
    with zipfile.ZipFile(held, "w") as archive:
        archive.writestr("suite.xml", f'<suite><detail id="{AUTHORED}"/></suite>')
        archive.writestr("logo.png", b"\x89PNG\xff\xfe" + GENERATED.encode())
    assert canonical.given_ids(archives=[held.getvalue()]) == {AUTHORED}


def test_canonical_bytes_do_not_depend_on_key_order_and_keep_text_as_it_is():
    assert canonical.encode({"b": " ", "a": [1, None]}) == canonical.encode({"a": [1, None], "b": " "})
    assert canonical.encode({"b": " ", "a": [1, None]}) == '{"a":[1,null],"b":" "}'.encode()
