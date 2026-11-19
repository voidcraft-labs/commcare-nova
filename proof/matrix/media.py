"""The lane's own media files, which stand in for the files an app made in HQ maps.

HQ's template apps name their media in ``multimedia.json``, a map of path to
an address ``views/apps.py::load_app_from_slug`` fetches, skipping a file
whose fetch fails ("It's not a big deal if a template app is missing a
file."). The lane reaches no such address, and those files are not Nova's to
commit, so for each path the lane makes a file of the kind the path's
extension names and attaches it with the calls that loader makes
(``proof/hq/operations.py::save_authored_app``, and a base's builder).

``stand_in(path)`` is a distinct, valid file of its kind for each path:

- ``.png``: a PNG of one pixel whose colour is the first three bytes of
  ``sha256(path)``;
- ``.mp3``: one silent MPEG-1 Layer III frame followed by an ID3v2.4 tag
  appended with its footer, whose one comment frame holds the path;
- ``.mp4``: an ISO base media file of brand ``isom`` holding one H.264 Main
  video track of 16 by 16 pixels with no sample, then a ``free`` box holding
  the path.

So ``CommCareMultimedia.get_class_by_data`` classifies each by its kind and
``get_by_data`` gives two paths two documents. What a picture shows is no
claim the lane makes; where it sits, what kind it is and that Nova keeps it
there are.

``refused_stand_in(path)`` is a file of a format Nova refuses, for the
variants that show each refused format's entry, by the path's extension:

- ``.svg``: an SVG document of one pixel whose ``desc`` holds the path;
- ``.tif``: a little-endian TIFF of one uncompressed RGB pixel of the path's
  colour, whose ``ImageDescription`` holds the path;
- ``.wav``: a WAVE file of 24-bit PCM, mono at 8 kHz, eight samples of
  silence, whose ``LIST``/``INFO`` comment holds the path;
- ``.avi``: a RIFF ``AVI `` file holding only a ``LIST``/``INFO`` comment that
  holds the path.

``held_stand_in(path)`` is a file of a format Nova holds beyond the three
above, for the variants that hold each such format's entry, by the path's
extension:

- ``.bmp``: a BMP of one 24-bit pixel of the path's colour under a 40-byte
  ``BITMAPINFOHEADER``, the path after its pixel array;
- ``.ico``: an icon directory of one 1 by 1 image, ``png_of(path)``;
- ``.ogg``: an Ogg stream of Opus audio, mono at 48 kHz: its ``OpusHead``
  page, its ``OpusTags`` page, whose one comment holds the path, and one page
  of one silent 20 ms packet;
- ``.amr``: an AMR narrowband file of two 12.2 kbit/s frames, the second's
  bits the first bytes of ``sha256(path)``;
- ``.mkv``: a Matroska file holding one VP8 video track of 16 by 16 pixels
  and no frame, its writing application the path.

``oversize_png_of(path, size)`` is a PNG of one pixel, as ``png_of`` makes,
grown to ``size`` bytes by a private ancillary chunk after its image data,
which no reader of the picture reads.

Standard library only.
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from dataclasses import dataclass

# A file's kind, HQ's class of it, its MIME type and its extension, by the extension a path names.
KINDS = {
    "png": ("image", "CommCareImage", "image/png"),
    "mp3": ("audio", "CommCareAudio", "audio/mpeg"),
    "mp4": ("video", "CommCareVideo", "video/mp4"),
}


@dataclass(frozen=True)
class StandIn:
    """One stand-in file: the row ``media.json`` records of it beside its bytes."""

    path: str
    kind: str
    media_class: str
    mime_type: str
    extension: str
    data: bytes


def extension_of(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    if "." not in name:
        raise ValueError(f"The media path {path} names no extension, so the lane cannot tell what kind of file it is.")
    return name.rsplit(".", 1)[1].lower()


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png_of(path: str) -> bytes:
    """A PNG of one pixel, truecolour at eight bits a sample, whose colour is the first three bytes of
    ``sha256(path)``."""
    colour = hashlib.sha256(path.encode("utf-8")).digest()[:3]
    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    # One scanline: filter type 0, then the pixel.
    pixels = zlib.compress(b"\x00" + colour, 9)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", pixels) + _chunk(b"IEND", b"")


# MPEG-1 Layer III, no CRC; 128 kbit/s at 44.1 kHz, no padding; mono. A frame of it is 144 * 128000 / 44100
# bytes, rounded down; its side information and main data all zero is one frame of silence.
MPEG_HEADER = bytes((0xFF, 0xFB, 0x90, 0xC0))
MPEG_FRAME_LENGTH = 144 * 128000 // 44100


def _syncsafe(size: int) -> bytes:
    if size >= 1 << 28:
        raise ValueError(f"An ID3v2 size is 28 bits; {size} does not fit.")
    return bytes(((size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F))


def mp3_of(path: str) -> bytes:
    """One silent MPEG frame, then an ID3v2.4 tag appended after it with its footer (an appended tag must carry
    one), whose one ``COMM`` frame holds ``path`` in UTF-8."""
    frame = MPEG_HEADER + bytes(MPEG_FRAME_LENGTH - len(MPEG_HEADER))
    # Text encoding 3 (UTF-8), language, an empty short description, then the text.
    comment = b"\x03" + b"eng" + b"\x00" + path.encode("utf-8")
    frames = b"COMM" + _syncsafe(len(comment)) + b"\x00\x00" + comment
    # Version 2.4.0, flags: footer present.
    tag_header = b"ID3" + b"\x04\x00" + b"\x10" + _syncsafe(len(frames))
    footer = b"3DI" + b"\x04\x00" + b"\x10" + _syncsafe(len(frames))
    return frame + tag_header + frames + footer


def _box(kind: bytes, payload: bytes) -> bytes:
    """An ISO base media box (ISO/IEC 14496-12): its size, its type and its payload."""
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def _full_box(kind: bytes, version: int, flags: int, payload: bytes) -> bytes:
    """A full box: a box whose payload opens with its version and three bytes of flags."""
    return _box(kind, bytes((version,)) + flags.to_bytes(3, "big") + payload)


# The identity transform every header of a track and a movie carries.
_MATRIX = struct.pack(">9I", 0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)
# The movie's and the track's time scale (units a second) and duration (forty milliseconds).
_TIMESCALE = 1000
_DURATION = 40
_SIDE = 16
# H.264 Main profile (profile_idc 77) at level 3.0, with one sequence and one picture parameter set.
_PROFILE_MAIN = 77
_LEVEL_3 = 30
_SPS = bytes((0x67, _PROFILE_MAIN, 0x40, _LEVEL_3, 0xE8, 0x80, 0x80, 0x80, 0x80))
_PPS = bytes((0x68, 0xEE, 0x3C, 0x80))


def mp4_of(path: str) -> bytes:
    """An ISO base media file of brand ``isom``: one video track whose one sample entry is H.264 Main
    (``avc1`` with its ``avcC``), 16 by 16 pixels, holding no sample, then a ``free`` box holding ``path`` in
    UTF-8."""
    ftyp = _box(b"ftyp", b"isom" + struct.pack(">I", 0x200) + b"isom" + b"iso2" + b"avc1" + b"mp41")
    mvhd = _full_box(
        b"mvhd",
        0,
        0,
        struct.pack(">IIII", 0, 0, _TIMESCALE, _DURATION)
        + struct.pack(">IH", 0x00010000, 0x0100)
        + bytes(10)
        + _MATRIX
        + bytes(24)
        + struct.pack(">I", 2),
    )
    tkhd = _full_box(
        b"tkhd",
        0,
        3,
        struct.pack(">IIIII", 0, 0, 1, 0, _DURATION)
        + bytes(8)
        + struct.pack(">hhhH", 0, 0, 0, 0)
        + _MATRIX
        + struct.pack(">II", _SIDE << 16, _SIDE << 16),
    )
    # The language `und`, packed as three five-bit letters less 0x60.
    mdhd = _full_box(b"mdhd", 0, 0, struct.pack(">IIIIHH", 0, 0, _TIMESCALE, _DURATION, 0x55C4, 0))
    hdlr = _full_box(b"hdlr", 0, 0, struct.pack(">I", 0) + b"vide" + bytes(12) + b"VideoHandler\x00")
    vmhd = _full_box(b"vmhd", 0, 1, bytes(8))
    dinf = _box(b"dinf", _full_box(b"dref", 0, 0, struct.pack(">I", 1) + _full_box(b"url ", 0, 1, b"")))
    avcc = _box(
        b"avcC",
        bytes((1, _PROFILE_MAIN, 0x40, _LEVEL_3, 0xFF, 0xE1))
        + struct.pack(">H", len(_SPS))
        + _SPS
        + bytes((1,))
        + struct.pack(">H", len(_PPS))
        + _PPS,
    )
    avc1 = _box(
        b"avc1",
        bytes(6)
        + struct.pack(">H", 1)
        + bytes(16)
        + struct.pack(">HHIII", _SIDE, _SIDE, 0x00480000, 0x00480000, 0)
        + struct.pack(">H", 1)
        + bytes(32)
        + struct.pack(">Hh", 0x0018, -1)
        + avcc,
    )
    stbl = _box(
        b"stbl",
        _full_box(b"stsd", 0, 0, struct.pack(">I", 1) + avc1)
        + _full_box(b"stts", 0, 0, struct.pack(">I", 0))
        + _full_box(b"stsc", 0, 0, struct.pack(">I", 0))
        + _full_box(b"stsz", 0, 0, struct.pack(">II", 0, 0))
        + _full_box(b"stco", 0, 0, struct.pack(">I", 0)),
    )
    minf = _box(b"minf", vmhd + dinf + stbl)
    trak = _box(b"trak", tkhd + _box(b"mdia", mdhd + hdlr + minf))
    moov = _box(b"moov", mvhd + trak)
    return ftyp + moov + _box(b"free", path.encode("utf-8"))


MAKERS = {"png": png_of, "mp3": mp3_of, "mp4": mp4_of}


def _colour(path: str) -> bytes:
    return hashlib.sha256(path.encode("utf-8")).digest()[:3]


def svg_of(path: str) -> bytes:
    """An SVG document of one pixel whose ``desc`` holds ``path``."""
    from xml.sax.saxutils import escape

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">'
        f"<desc>{escape(path)}</desc></svg>\n"
    ).encode("utf-8")


# TIFF field types: SHORT, ASCII and LONG.
_TIFF_SHORT, _TIFF_ASCII, _TIFF_LONG = 3, 2, 4


def tif_of(path: str) -> bytes:
    """A little-endian baseline TIFF of one uncompressed RGB pixel of ``path``'s colour, in one strip, whose
    ``ImageDescription`` holds ``path`` in ASCII with its closing NUL."""
    description = path.encode("ascii") + b"\x00"
    entries = 10
    ifd_at = 8
    after_ifd = ifd_at + 2 + entries * 12 + 4
    bits_at = after_ifd
    description_at = bits_at + 6
    pixel_at = description_at + len(description) + (len(description) % 2)

    def short(tag, value):
        return struct.pack("<HHIHH", tag, _TIFF_SHORT, 1, value, 0)

    def long(tag, value):
        return struct.pack("<HHII", tag, _TIFF_LONG, 1, value)

    ifd = (
        struct.pack("<H", entries)
        + short(256, 1)
        + short(257, 1)
        + struct.pack("<HHII", 258, _TIFF_SHORT, 3, bits_at)
        + short(259, 1)
        + short(262, 2)
        + struct.pack("<HHII", 270, _TIFF_ASCII, len(description), description_at)
        + long(273, pixel_at)
        + short(277, 3)
        + short(278, 1)
        + long(279, 3)
        + struct.pack("<I", 0)
    )
    body = (
        struct.pack("<HHH", 8, 8, 8) + description + bytes(pixel_at - description_at - len(description)) + _colour(path)
    )
    return b"II*\x00" + struct.pack("<I", ifd_at) + ifd + body


def _riff_info_comment(path: str) -> bytes:
    """A RIFF ``LIST`` chunk of type ``INFO`` whose one ``ICMT`` holds ``path`` in UTF-8 with its closing NUL."""
    text = path.encode("utf-8") + b"\x00"
    comment = b"ICMT" + struct.pack("<I", len(text)) + text + bytes(len(text) % 2)
    return b"LIST" + struct.pack("<I", 4 + len(comment)) + b"INFO" + comment


def _riff(form: bytes, chunks: bytes) -> bytes:
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + form + chunks


# 24-bit PCM, mono, at 8 kHz: a frame of it is three bytes.
_WAV_RATE, _WAV_BITS, _WAV_SAMPLES = 8000, 24, 8


def wav_of(path: str) -> bytes:
    """A WAVE file of 24-bit PCM (format tag 1), mono at 8 kHz, holding eight samples of silence, then a
    ``LIST``/``INFO`` comment holding ``path``."""
    block = _WAV_BITS // 8
    fmt = struct.pack("<HHIIHH", 1, 1, _WAV_RATE, _WAV_RATE * block, block, _WAV_BITS)
    data = bytes(block * _WAV_SAMPLES)
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data
    return _riff(b"WAVE", chunks + _riff_info_comment(path))


def avi_of(path: str) -> bytes:
    """A RIFF file of form ``AVI `` holding only a ``LIST``/``INFO`` comment that holds ``path``."""
    return _riff(b"AVI ", _riff_info_comment(path))


# A refused format's file, its kind, HQ's class of it and the manifest entry Nova's judge of its bytes names, by the
# extension a path names.
REFUSED = {
    "svg": (svg_of, "image", "CommCareImage", "expressions-and-data/image-svg"),
    "tif": (tif_of, "image", "CommCareImage", "expressions-and-data/image-tiff-heif"),
    "wav": (wav_of, "audio", "CommCareAudio", "expressions-and-data/audio-wav-that-is-not-8-or-16-bit-pcm"),
    "avi": (avi_of, "video", "CommCareVideo", "expressions-and-data/video-av1-mov-avi-ogg-theora-h-263-3gp"),
}


def refused_stand_in(path: str) -> bytes:
    """The lane's file of a format Nova refuses for ``path``, by its extension (the module's docstring)."""
    extension = extension_of(path)
    if extension not in REFUSED:
        raise ValueError(
            f"The lane makes files of the refused formats {sorted(REFUSED)}, and the path {path} names a .{extension}"
            " file. Make one for that format in proof/matrix/media.py."
        )
    return REFUSED[extension][0](path)


def bmp_of(path: str) -> bytes:
    """A BMP of one pixel of ``path``'s colour: the 14-byte file header, a 40-byte ``BITMAPINFOHEADER`` at 24 bits
    a pixel with no compression, the one row padded to four bytes, then ``path`` in UTF-8, which no reader of the
    picture reads."""
    blue_green_red = _colour(path)[::-1]
    row = blue_green_red + b"\x00"
    pixels_at = 14 + 40
    trailer = path.encode("utf-8")
    info = struct.pack("<IiiHHIIiiII", 40, 1, 1, 1, 24, 0, len(row), 2835, 2835, 0, 0)
    size = pixels_at + len(row) + len(trailer)
    return b"BM" + struct.pack("<IHHI", size, 0, 0, pixels_at) + info + row + trailer


def ico_of(path: str) -> bytes:
    """An icon directory (type 1) of one 1 by 1 image at 32 bits, the image ``png_of(path)``."""
    image = png_of(path)
    directory = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 1, 1, 0, 0, 1, 32, len(image), 6 + 16)
    return directory + entry + image


def _ogg_crc(data: bytes) -> int:
    """The CRC an Ogg page carries (RFC 3533): polynomial 0x04C11DB7, no reflection, initial and final value 0."""
    crc = 0
    for byte in data:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) if crc & 0x80000000 else crc << 1
            crc &= 0xFFFFFFFF
    return crc


_OGG_SERIAL = 0x4E4F5641


def _ogg_page(packet: bytes, sequence: int, granule: int, flags: int) -> bytes:
    """One Ogg page holding the one ``packet`` whole (under 255 * 255 bytes)."""
    lacing = bytes([255] * (len(packet) // 255) + [len(packet) % 255])
    header = b"OggS" + struct.pack("<BBqIII", 0, flags, granule, _OGG_SERIAL, sequence, 0) + bytes([len(lacing)])
    page = header + lacing + packet
    return page[:22] + struct.pack("<I", _ogg_crc(page)) + page[26:]


# Opus's pre-skip, the 48 kHz samples a decoder drops at the start (RFC 7845, its 80 ms default of 3840 / 12.5).
_OPUS_PRE_SKIP = 312
# One silent 20 ms Opus frame: the TOC byte of configuration 31 (CELT, fullband, 20 ms), mono, one frame, and
# a byte of no energy.
_OPUS_SILENCE = bytes((0xF8, 0xFF, 0xFE))


def ogg_of(path: str) -> bytes:
    """An Ogg Opus stream (RFC 7845), mono at 48 kHz: the ``OpusHead`` page, the ``OpusTags`` page whose one
    comment, ``COMMENT``, holds ``path``, and the last page, one silent 20 ms packet."""
    head = b"OpusHead" + struct.pack("<BBHIhB", 1, 1, _OPUS_PRE_SKIP, 48000, 0, 0)
    vendor = b"nova-proof"
    comment = b"COMMENT=" + path.encode("utf-8")
    tags = b"OpusTags" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<II", 1, len(comment)) + comment
    return (
        _ogg_page(head, 0, 0, 0x02)
        + _ogg_page(tags, 1, 0, 0x00)
        + _ogg_page(_OPUS_SILENCE, 2, _OPUS_PRE_SKIP + 960, 0x04)
    )


# An AMR narrowband frame of mode 7 (12.2 kbit/s, quality bit set): its header byte, then 31 bytes of bits.
_AMR_HEADER = 0x3C
_AMR_FRAME_BITS = 31


def amr_of(path: str) -> bytes:
    """An AMR narrowband file (RFC 4867, section 5): its magic, a frame of no bits, and a frame whose bits are the
    first 31 bytes of ``sha256(path)`` twice over."""
    bits = (hashlib.sha256(path.encode("utf-8")).digest() * 2)[:_AMR_FRAME_BITS]
    return b"#!AMR\n" + bytes((_AMR_HEADER,)) + bytes(_AMR_FRAME_BITS) + bytes((_AMR_HEADER,)) + bits


def _ebml_size(size: int) -> bytes:
    """An EBML element's size as a variable-length integer of the fewest bytes that hold it (a value of all ones
    stands for an unknown size, so it takes one byte more), as a Matroska muxer writes it. libmagic, which HQ classifies
    an upload by (``CommCareMultimedia.get_class_by_data``), reads the DocType's text one byte past its ID
    (``Magdir/matroska``: ``>>&1 string matroska``), so a file whose DocType size is longer is no Matroska to HQ."""
    length = next(length for length in range(1, 9) if size < (1 << (7 * length)) - 1)
    return ((1 << (7 * length)) | size).to_bytes(length, "big")


def _ebml(element_id: int, payload: bytes) -> bytes:
    """One EBML element: its ID's own bytes, its size and its payload."""
    return element_id.to_bytes((element_id.bit_length() + 7) // 8, "big") + _ebml_size(len(payload)) + payload


def _ebml_uint(element_id: int, value: int) -> bytes:
    return _ebml(element_id, value.to_bytes(max(1, (value.bit_length() + 7) // 8), "big"))


def mkv_of(path: str) -> bytes:
    """A Matroska file (``DocType`` ``matroska``): its EBML header, then a segment whose ``Info`` names ``path`` as
    its writing application and whose one track is VP8 video of 16 by 16 pixels, holding no frame."""
    header = _ebml(
        0x1A45DFA3,
        _ebml_uint(0x4286, 1)
        + _ebml_uint(0x42F7, 1)
        + _ebml_uint(0x42F2, 4)
        + _ebml_uint(0x42F3, 8)
        + _ebml(0x4282, b"matroska")
        + _ebml_uint(0x4287, 4)
        + _ebml_uint(0x4285, 2),
    )
    info = _ebml(
        0x1549A966,
        _ebml_uint(0x2AD7B1, 1000000) + _ebml(0x4D80, b"nova-proof") + _ebml(0x5741, path.encode("utf-8")),
    )
    video = _ebml(0xE0, _ebml_uint(0xB0, _SIDE) + _ebml_uint(0xBA, _SIDE))
    track = _ebml(
        0xAE,
        _ebml_uint(0xD7, 1) + _ebml_uint(0x73C5, 1) + _ebml_uint(0x83, 1) + _ebml(0x86, b"V_VP8") + video,
    )
    return header + _ebml(0x18538067, info + _ebml(0x1654AE6B, track))


# A held format's file, its kind, HQ's class of it, its MIME type as Nova's judge names it and the manifest entry
# that holds it, by the extension a path names.
HELD = {
    "bmp": (bmp_of, "image", "CommCareImage", "image/bmp", "expressions-and-data/image-bmp"),
    "ico": (ico_of, "image", "CommCareImage", "image/vnd.microsoft.icon", "expressions-and-data/image-ico-avif"),
    "ogg": (ogg_of, "audio", "CommCareAudio", "audio/ogg", "expressions-and-data/audio-ogg-vorbis-or-opus"),
    "amr": (amr_of, "audio", "CommCareAudio", "audio/amr", "expressions-and-data/audio-raw-aac-adts-aac-amr-midi"),
    "mkv": (
        mkv_of,
        "video",
        "CommCareVideo",
        "video/x-matroska",
        "expressions-and-data/video-hevc-mp4-mpeg-4-part-2-mp4-and-mkv-holding-a-codec-android",
    ),
}


def held_stand_in(path: str) -> bytes:
    """The lane's file of a held format beyond png, mp3 and mp4 for ``path``, by its extension (the module's
    docstring)."""
    extension = extension_of(path)
    if extension not in HELD:
        raise ValueError(
            f"The lane makes files of the held formats {sorted(HELD)}, and the path {path} names a .{extension}"
            " file. Make one for that format in proof/matrix/media.py."
        )
    return HELD[extension][0](path)


def oversize_png_of(path: str, size: int) -> bytes:
    """``png_of(path)`` grown to ``size`` bytes by a private ancillary chunk (``npAd``) between its image data and
    its end, which no reader of the picture needs."""
    small = png_of(path)
    end = _chunk(b"IEND", b"")
    padding = size - len(small) - 12
    if padding < 0:
        raise ValueError(f"A PNG for {path} is {len(small)} bytes at the least; {size} is smaller.")
    return small[: -len(end)] + _chunk(b"npAd", bytes(padding)) + end


def stand_in(path: str) -> bytes:
    """The lane's file for ``path``, of the kind its extension names (the module's docstring)."""
    extension = extension_of(path)
    maker = MAKERS.get(extension)
    if maker is None:
        raise ValueError(
            f"The lane makes stand-in files of {sorted(MAKERS)}, and the path {path} names a .{extension} file. Make"
            " one for that kind in proof/matrix/media.py, as valid a file of it as HQ's own classification reads."
        )
    return maker(path)


def stand_in_file(path: str) -> StandIn:
    """``stand_in(path)`` with the row ``media.json`` records of it."""
    extension = extension_of(path)
    if extension not in KINDS:
        stand_in(path)
    kind, media_class, mime_type = KINDS[extension]
    return StandIn(path, kind, media_class, mime_type, extension, stand_in(path))
