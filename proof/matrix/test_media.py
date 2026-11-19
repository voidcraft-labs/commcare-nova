"""The lane's stand-in media files (``proof/matrix/media.py::stand_in``), held to HQ's own classification.

The contract: each stand-in is a valid file of the kind its path's extension
names, HQ classifies it so (``CommCareMultimedia.get_class_by_data``, through
the file's MIME type, ``hqmedia/models.py::get_base_mime_type``), and no two
paths share bytes, so ``get_by_data`` gives each path its own document. The
plausible failures: a stand-in HQ stores as another class (or as none, so
the template loader's call would skip it), and two paths sharing one file by
accident, which would join two of a template's paths into one asset no
template app holds. The first test needs HQ; the others run on the standard
library.

Nova's own judge of a file is held to the same stand-ins through a retained
pair: ``proof/matrix/stand-ins.json`` holds every stand-in the lane attaches
to a template app's path, one at a path of its own for each kind
``media.py`` makes, and one at a path of its own for each refused format it
makes (``refused_stand_in``), with the entry Nova's judge of it names
(``refusedUnder``), each with its bytes. A refused stand-in is held here to its
format's structure and, with HQ, to the class HQ stores it under, so a variant
that attaches one shows its format's entry and no other. ``test_the_stand_ins_vitest_reads_are_the_lanes_own``
holds the file to ``media.stand_in`` over HQ's template apps at the pin, and
``proof/matrix/__tests__/standIns.test.ts`` holds each of its files to
``lib/media/validate.ts``, the verdict a reading gives a file it fetched from
HQ. So a stand-in Nova's reading would refuse, or read as another kind, fails
by name before any base's reading meets it.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import zlib
from pathlib import Path

from proof.matrix import media

HQ_ROOT = Path(os.environ.get("PROOF_HQ", "/opt/hq"))
TEMPLATES = HQ_ROOT / "corehq/apps/app_manager/static/app_manager/template_apps"
MULTIMEDIA_PREFIX = "jr://file/"
STAND_INS = Path(__file__).resolve().parent / "stand-ins.json"
# Paths of the kinds the lane makes, written as HQ's template apps write theirs, for the tests that read no HQ.
PLANTED = (
    "commcare/image/module0_en.png",
    "commcare/image/module1_en.png",
    "commcare/audio/module0_form0_en.mp3",
    "commcare/audio/module0_form1_en.mp3",
)


def template_paths():
    """Every path HQ's template apps map, as ``load_app_from_slug`` maps each (``MULTIMEDIA_PREFIX + path``)."""
    paths = []
    for path in sorted(TEMPLATES.glob("*/multimedia.json")):
        paths.extend(MULTIMEDIA_PREFIX + item for item in json.loads(path.read_text(encoding="utf-8")))
    return paths


def test_hq_classifies_each_stand_in_as_its_kind(hq):
    from corehq.apps.hqmedia.models import CommCareMultimedia

    paths = template_paths()
    assert paths, f"HQ's template apps at {TEMPLATES} map no media, so nothing here holds a stand-in to HQ."
    wrong = {}
    for path in paths:
        made = media.stand_in_file(path)
        found = CommCareMultimedia.get_class_by_data(made.data)
        if found is None or found.__name__ != made.media_class:
            wrong[path] = (made.media_class, None if found is None else found.__name__)
    assert not wrong, f"HQ classifies these stand-ins as another class than their kind: {wrong}"
    assert len({media.stand_in(path) for path in paths}) == len(set(paths))


def _png_chunks(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    at, chunks = 8, []
    while at < len(data):
        (length,) = struct.unpack(">I", data[at : at + 4])
        kind, body = data[at + 4 : at + 8], data[at + 8 : at + 8 + length]
        (crc,) = struct.unpack(">I", data[at + 8 + length : at + 12 + length])
        assert crc == zlib.crc32(kind + body) & 0xFFFFFFFF, kind
        chunks.append((kind, body))
        at += 12 + length
    return chunks


def test_a_png_stand_in_is_one_pixel_of_its_paths_colour():
    import hashlib

    for path in PLANTED[:2]:
        chunks = _png_chunks(media.stand_in(path))
        assert [kind for kind, _ in chunks] == [b"IHDR", b"IDAT", b"IEND"]
        width, height, depth, colour_type = struct.unpack(">IIBB", chunks[0][1][:10])
        assert (width, height, depth, colour_type) == (1, 1, 8, 2)
        assert zlib.decompress(chunks[1][1]) == b"\x00" + hashlib.sha256(path.encode()).digest()[:3]


def test_an_mp3_stand_in_is_one_silent_frame_and_a_tag_holding_its_path():
    for path in PLANTED[2:]:
        data = media.stand_in(path)
        assert data[:4] == media.MPEG_HEADER
        frame = data[: media.MPEG_FRAME_LENGTH]
        assert frame[4:] == bytes(len(frame) - 4)
        tag = data[media.MPEG_FRAME_LENGTH :]
        assert tag[:3] == b"ID3" and tag[-10:-7] == b"3DI"
        assert path.encode() in tag


def test_no_two_paths_share_a_stand_in():
    assert len({media.stand_in(path) for path in PLANTED}) == len(PLANTED)


def refused_rows():
    """The rows of ``stand-ins.json`` for one path of its own a refused format ``media.py`` makes, by path."""
    rows = []
    for extension in sorted(media.REFUSED):
        path = f"{MULTIMEDIA_PREFIX}commcare/refused-stand-in.{extension}"
        data = media.refused_stand_in(path)
        _, kind, media_class, entry = media.REFUSED[extension]
        rows.append(
            {
                "path": path,
                "kind": kind,
                "mediaClass": media_class,
                "extension": extension,
                "refusedUnder": entry,
                "sha256": hashlib.sha256(data).hexdigest(),
                "base64": base64.b64encode(data).decode("ascii"),
            }
        )
    return rows


def held_rows():
    """The rows of ``stand-ins.json`` for one path of its own a held format ``media.py`` makes beyond png, mp3 and
    mp4 (``media.HELD``), by path, each with the entry that holds it."""
    rows = []
    for extension in sorted(media.HELD):
        path = f"{MULTIMEDIA_PREFIX}commcare/held-stand-in.{extension}"
        data = media.held_stand_in(path)
        _, kind, media_class, mime_type, entry = media.HELD[extension]
        rows.append(
            {
                "path": path,
                "kind": kind,
                "mediaClass": media_class,
                "mimeType": mime_type,
                "extension": extension,
                "heldUnder": entry,
                "sha256": hashlib.sha256(data).hexdigest(),
                "base64": base64.b64encode(data).decode("ascii"),
            }
        )
    return rows


def stand_in_rows(paths):
    """The rows of ``stand-ins.json`` for ``paths`` and for one path of its own a kind ``media.py`` makes, by path,
    then one a refused format it makes (``refused_rows``), then one a held format beyond those kinds
    (``held_rows``)."""
    own = {f"{MULTIMEDIA_PREFIX}commcare/stand-in.{extension}" for extension in media.MAKERS}
    rows = []
    for path in sorted(set(paths) | own):
        made = media.stand_in_file(path)
        rows.append(
            {
                "path": path,
                "kind": made.kind,
                "mediaClass": made.media_class,
                "mimeType": made.mime_type,
                "extension": made.extension,
                "sha256": hashlib.sha256(made.data).hexdigest(),
                "base64": base64.b64encode(made.data).decode("ascii"),
            }
        )
    return rows + refused_rows() + held_rows()


def test_the_stand_ins_vitest_reads_are_the_lanes_own():
    paths = template_paths()
    assert paths, f"HQ's template apps at {TEMPLATES} map no media, so no stand-in of theirs can be held to Nova."
    rows = stand_in_rows(paths)
    if json.loads(STAND_INS.read_text(encoding="utf-8")) == rows:
        return
    written = Path(os.environ.get("PROOF_OUT", ".proof/out")) / "stand-ins.json"
    written.parent.mkdir(parents=True, exist_ok=True)
    written.write_text(json.dumps(rows, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
    raise AssertionError(
        f"proof/matrix/stand-ins.json is not the stand-ins the lane attaches at HQ's pin: the files"
        f" proof/matrix/media.py makes for HQ's template apps' paths, and one a kind it makes, are under {written}."
        " Copy that file over proof/matrix/stand-ins.json, so proof/matrix/__tests__/standIns.test.ts holds Nova's"
        " judge of a file to the files the lane attaches."
    )


def test_the_stand_in_rows_are_each_paths_own_file():
    rows = [row for row in stand_in_rows(PLANTED) if "refusedUnder" not in row and "heldUnder" not in row]
    assert [row["path"] for row in rows] == sorted(
        set(PLANTED) | {f"{MULTIMEDIA_PREFIX}commcare/stand-in.{extension}" for extension in media.MAKERS}
    )
    for row in rows:
        data = base64.b64decode(row["base64"])
        assert data == media.stand_in(row["path"])
        assert row["sha256"] == hashlib.sha256(data).hexdigest()
        assert (row["kind"], row["mediaClass"], row["mimeType"]) == media.KINDS[row["extension"]]


def test_a_path_of_another_kind_is_refused_by_name():
    try:
        media.stand_in("commcare/video/intro.webm")
    except ValueError as refusal:
        assert ".webm" in str(refusal)
    else:
        raise AssertionError("stand_in made a file for a kind it does not know")


def test_hq_stores_each_refused_stand_in_under_its_class(hq):
    from corehq.apps.hqmedia.models import CommCareMultimedia

    wrong = {}
    for row in refused_rows():
        found = CommCareMultimedia.get_class_by_data(base64.b64decode(row["base64"]))
        if found is None or found.__name__ != row["mediaClass"]:
            wrong[row["path"]] = (row["mediaClass"], None if found is None else found.__name__)
    assert not wrong, f"HQ classifies these refused stand-ins as another class than their format's: {wrong}"


def _riff_chunks(data, form):
    assert data[:4] == b"RIFF" and data[8:12] == form
    (size,) = struct.unpack("<I", data[4:8])
    assert size == len(data) - 8
    at, chunks = 12, {}
    while at < len(data):
        kind, (length,) = data[at : at + 4], struct.unpack("<I", data[at + 4 : at + 8])
        chunks[kind] = data[at + 8 : at + 8 + length]
        at += 8 + length + length % 2
    assert at == len(data)
    return chunks


def test_each_refused_stand_in_is_its_format_holding_its_path():
    import xml.etree.ElementTree as ElementTree

    path = "jr://file/commcare/refused/one"
    svg = ElementTree.fromstring(media.svg_of(path + ".svg"))
    assert svg.tag == "{http://www.w3.org/2000/svg}svg"
    assert svg.find("{http://www.w3.org/2000/svg}desc").text == path + ".svg"

    tif = media.tif_of(path + ".tif")
    assert tif[:4] == b"II*\x00"
    (ifd_at,) = struct.unpack("<I", tif[4:8])
    (count,) = struct.unpack("<H", tif[ifd_at : ifd_at + 2])
    fields = {}
    for at in range(ifd_at + 2, ifd_at + 2 + count * 12, 12):
        tag, kind, number, value = struct.unpack("<HHII", tif[at : at + 12])
        fields[tag] = (kind, number, value & 0xFFFF if kind == 3 and number == 1 else value)
    assert sorted(fields) == [256, 257, 258, 259, 262, 270, 273, 277, 278, 279]
    assert (fields[256][2], fields[257][2], fields[259][2], fields[262][2], fields[277][2]) == (1, 1, 1, 2, 3)
    description = fields[270]
    assert tif[description[2] : description[2] + description[1]] == (path + ".tif").encode() + b"\x00"
    pixel = fields[273][2]
    assert tif[pixel : pixel + 3] == hashlib.sha256((path + ".tif").encode()).digest()[:3]

    wav = _riff_chunks(media.wav_of(path + ".wav"), b"WAVE")
    audio_format, channels, rate, _, block, bits = struct.unpack("<HHIIHH", wav[b"fmt "])
    assert (audio_format, channels, rate, block, bits) == (1, 1, 8000, 3, 24)
    assert wav[b"data"] == bytes(24)
    assert (path + ".wav").encode() in wav[b"LIST"]

    avi = _riff_chunks(media.avi_of(path + ".avi"), b"AVI ")
    assert list(avi) == [b"LIST"] and (path + ".avi").encode() in avi[b"LIST"]

    assert len({media.refused_stand_in(path + "." + extension) for extension in media.REFUSED}) == len(media.REFUSED)


def test_an_oversize_png_is_one_pixel_of_its_paths_colour_at_the_size_asked():
    path = "jr://file/commcare/image/large.png"
    data = media.oversize_png_of(path, 5 * 1024 * 1024 + 1)
    assert len(data) == 5 * 1024 * 1024 + 1
    chunks = _png_chunks(data)
    assert [kind for kind, _ in chunks] == [b"IHDR", b"IDAT", b"npAd", b"IEND"]
    assert chunks[:2] == _png_chunks(media.png_of(path))[:2]


def test_hq_stores_each_held_stand_in_under_its_class(hq):
    """Contract: HQ's own classification (``CommCareMultimedia.get_class_by_data``, libmagic's MIME type) files each
    held-format stand-in under its kind's class, so the variant that attaches one is stored as HQ stores such a file.
    The plausible failure: a file libmagic names another type, stored under another class or refused."""
    from corehq.apps.hqmedia.models import CommCareMultimedia

    wrong = {}
    for row in held_rows():
        found = CommCareMultimedia.get_class_by_data(base64.b64decode(row["base64"]))
        if found is None or found.__name__ != row["mediaClass"]:
            wrong[row["path"]] = found and found.__name__
    assert not wrong, f"HQ classifies these held stand-ins as another class than their format's: {wrong}"


def test_each_held_stand_in_is_its_format_holding_its_path():
    """Contract: each held-format stand-in is a whole file of its format whose bytes name its path, so two paths
    get two files: a BMP's 24-bit pixel of the path's colour under a 40-byte header, an icon directory of one PNG,
    Ogg pages each carrying its CRC with Opus's head, an AMR narrowband frame pair and a Matroska file of one VP8
    track. The plausible failure: a maker that writes a header its readers refuse (a wrong page CRC, a size that
    does not match), read as no file of the format."""
    path = "jr://file/commcare/held"
    bmp = media.held_stand_in(path + ".bmp")
    assert bmp[:2] == b"BM" and struct.unpack("<I", bmp[2:6])[0] == len(bmp)
    assert struct.unpack("<IiiHHI", bmp[14:34]) == (40, 1, 1, 1, 24, 0)
    assert bmp[54:57] == hashlib.sha256((path + ".bmp").encode()).digest()[:3][::-1]
    ico = media.held_stand_in(path + ".ico")
    assert struct.unpack("<HHH", ico[:6]) == (0, 1, 1)
    assert ico[22:] == media.png_of(path + ".ico") and struct.unpack("<II", ico[14:22]) == (len(ico) - 22, 22)
    ogg = media.held_stand_in(path + ".ogg")
    pages, at = [], 0
    while at < len(ogg):
        assert ogg[at : at + 4] == b"OggS"
        lacing = ogg[at + 27 : at + 27 + ogg[at + 26]]
        end = at + 27 + len(lacing) + sum(lacing)
        page = ogg[at:end]
        assert struct.unpack("<I", page[22:26])[0] == media._ogg_crc(page[:22] + bytes(4) + page[26:])
        pages.append(page)
        at = end
    assert [page[5] for page in pages] == [0x02, 0x00, 0x04]
    assert pages[0][28:36] == b"OpusHead" and (path + ".ogg").encode() in pages[1]
    amr = media.held_stand_in(path + ".amr")
    assert amr[:6] == b"#!AMR\n" and len(amr) == 6 + 2 * 32 and amr[6] == amr[38] == 0x3C
    mkv = media.held_stand_in(path + ".mkv")
    assert mkv[:4] == bytes.fromhex("1a45dfa3") and b"matroska" in mkv[:128]
    assert b"V_VP8" in mkv and (path + ".mkv").encode() in mkv
    made = [media.held_stand_in(f"{path}-{n}.{extension}") for extension in media.HELD for n in (1, 2)]
    assert len(set(made)) == len(made)
