"""What CommCare HQ's bulk media upload, the one Nova's publish sends, takes of one file, at the bounds Nova holds.

Contract: Nova reads a file brought in from CommCare HQ up to ``lib/commcare/hq/media.ts::HQ_MEDIA_STREAM_MAX_BYTES``
(1 GiB), a picture up to ``mediaStore.ts::WHOLE_PICTURE_MAX_BYTES`` (64 MiB), and refuses for every app a picture of
more than ``lib/domain/multimedia.ts::HQ_PICTURE_MAX_PIXELS`` pixels (``picture-too-many-pixels``). HQ's bulk upload
(``app_import_api.py::_handle_upload_multimedia`` -> ``hqmedia/tasks.py::process_bulk_upload_zip``) reads each ZIP
member whole and checks no size, and stores a picture through Pillow (``CommCareImage.attach_data`` ->
``Image.open``), whose decompression-bomb check raises past twice ``PIL.Image.MAX_IMAGE_PIXELS``; the task turns
that into one error that stops the whole upload before the app is saved.

The plausible failures this tells apart: a size bound somewhere on HQ's path (a request, cache or blob limit) that
would refuse a file Nova holds and publishes, so Nova would hold a file it cannot send; a pixel bound other than
the one Nova refuses at, so Nova would refuse a picture HQ stores or take one HQ cannot; and a refused picture that
leaves the files beside it mapped, which would make the publish's per-file account wrong.

Production's own front servers (outside HQ's source) may bound a request's body; no checkout the lane holds names
one, so this holds HQ's application alone.
"""

from __future__ import annotations

import hashlib
import io
import struct
import warnings
import zipfile
import zlib

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload, timed

CONFIGURATION = Configuration()
MiB = 1024 * 1024
# ``lib/commcare/hq/media.ts::HQ_MEDIA_STREAM_MAX_BYTES``: the most of one file Nova reads from HQ.
STREAM_MAX_BYTES = 1024 * MiB
# ``lib/deployment/reading/projectData/mediaStore.ts::WHOLE_PICTURE_MAX_BYTES``: the most of one picture Nova reads.
WHOLE_PICTURE_MAX_BYTES = 64 * MiB
# ``lib/domain/multimedia.ts::HQ_PICTURE_MAX_PIXELS``.
PICTURE_MAX_PIXELS = 2 * (1024 * 1024 * 1024 // 4 // 3)
# Two pictures at either side of the bound, each side under libvips' own bound on a side.
WITHIN = (13_377, 13_377)
PAST = (13_378, 13_377)


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def _gray_png(width: int, height: int) -> bytes:
    """A one-bit grayscale PNG of ``width`` x ``height`` pixels, every one black: a few kilobytes at any size."""
    row = b"\x00" * (1 + (width + 7) // 8)
    compressor = zlib.compressobj(9)
    data = b"".join(compressor.compress(row) for _ in range(height)) + compressor.flush()
    header = struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", data) + _chunk(b"IEND", b"")


def _upload(members):
    """A multipart body shaped as Nova's ``uploadAppMediaBundle`` sends it (``waf_padding``, then the ZIP as
    ``bulk_upload_file`` named ``multimedia.zip``), the ZIP holding ``members``: ``(path, chunks)`` pairs, each
    member written chunk by chunk and deflated, so a gigabyte of repeated frames travels in about a megabyte.
    Returns the upload and each member's SHA-256."""
    archive = io.BytesIO()
    digests = {}
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as zipped:
        for path, chunks in members:
            digest = hashlib.sha256()
            with zipped.open(path, "w", force_zip64=True) as member:
                for chunk in chunks:
                    digest.update(chunk)
                    member.write(chunk)
            digests[path] = digest.hexdigest()
    boundary = "----formdata-undici-0123456789"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="waf_padding"\r\n\r\n'.encode()
        + b"x" * 16384
        + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="bulk_upload_file";'
        f' filename="multimedia.zip"\r\nContent-Type: application/zip\r\n\r\n'.encode()
        + archive.getvalue()
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return operations.Upload(body, f"multipart/form-data; boundary={boundary}"), digests


def _mp3_chunks(size):
    """An MP3 of ``size`` bytes (``proof/matrix/media.py::oversize_mp3_of``), in pieces of at most 64 MiB."""
    from proof.matrix import media

    path = "jr://file/commcare/audio/large.mp3"
    small = media.mp3_of(path)
    frame = small[: media.MPEG_FRAME_LENGTH]
    extra = size - len(small)
    frames = 1 + extra // media.MPEG_FRAME_LENGTH
    # The appended tag, its comment padded as ``oversize_mp3_of`` pads it.
    tag = media.mp3_of(path, comment_padding=extra % media.MPEG_FRAME_LENGTH)[media.MPEG_FRAME_LENGTH :]
    per_chunk = (64 * MiB) // media.MPEG_FRAME_LENGTH
    block = frame * per_chunk
    left = frames
    while left:
        take = min(left, per_chunk)
        yield block if take == per_chunk else frame * take
        left -= take
    yield tag


def _stored_digest(media_class, multimedia_id):
    """The SHA-256 of the bytes HQ stored for ``multimedia_id``, read from its blob a piece at a time."""
    from corehq.apps.hqmedia.models import CommCareMultimedia

    media = CommCareMultimedia.get_doc_class(media_class).get(multimedia_id)
    digest = hashlib.sha256()
    with media.fetch_attachment(media.attachment_id, stream=True) as stream:
        for chunk in iter(lambda: stream.read(8 * MiB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _app(state, name, *, images=(), audio=None):
    """An app of HQ's suite-test shape whose one menu shows the first of ``images`` and the sound ``audio``, and
    whose first form shows the second of ``images``, published as Nova's import publishes; its id."""
    source = hq_test_app()
    module = source["modules"][0]
    holders = (module, module["forms"][0])
    assert len(images) <= len(holders), "The suite-test app's menu and form show two pictures at the most."
    for holder, path in zip(holders, images, strict=False):
        holder["media_image"] = {"en": path}
    if audio is not None:
        module["media_audio"] = {"en": audio}
    app_id, _ = operations.publish(state, [nova_shaped_upload(source, name)])
    assert dict(operations.held_app(state, app_id).multimedia_map) == {}
    return app_id


def test_hq_stores_a_file_as_large_as_nova_reads_through_its_bulk_upload(hq):
    """A sound of 1 GiB and a picture of 64 MiB, the most of each Nova reads from CommCare HQ and so may publish
    again, are each stored byte for byte and mapped: HQ's bulk upload bounds no file's size."""
    from proof.matrix import media

    sound = "jr://file/commcare/audio/large.mp3"
    picture = "jr://file/commcare/image/large.png"
    png = media.oversize_png_of(picture, WHOLE_PICTURE_MAX_BYTES)
    upload, digests = _upload(
        [
            ("commcare/audio/large.mp3", _mp3_chunks(STREAM_MAX_BYTES)),
            ("commcare/image/large.png", [png]),
        ]
    )
    del png
    with hq_check(CONFIGURATION) as (state, _):
        app_id = _app(state, "Large media app", images=(picture,), audio=sound)
        with timed("media_upload_large"):
            result = operations.apply_media_upload(state, app_id, upload)
        assert result.status == 200 and result.response["success"] is True
        processing = result.processing
        assert processing["complete"] is True and processing["errors"] == []
        assert processing["unmatched_files"] == [] and processing["skipped_files"] == []
        assert [info["path"] for info in processing["matched_files"]["CommCareAudio"]] == [sound]
        assert [info["path"] for info in processing["matched_files"]["CommCareImage"]] == [picture]
        mapped = operations.held_app(state, app_id).multimedia_map
        assert _stored_digest("CommCareAudio", mapped[sound].multimedia_id) == digests["commcare/audio/large.mp3"]
        assert _stored_digest("CommCareImage", mapped[picture].multimedia_id) == digests["commcare/image/large.png"]


def test_hq_stores_a_picture_at_its_pixel_bound_and_refuses_the_whole_upload_past_it(hq):
    """A picture of 178,944,129 pixels is stored (Pillow only warns past 89,478,485); one of 178,957,506 stops the
    whole upload with Pillow's decompression-bomb error, and the ordinary picture before it in the same ZIP is left
    unmapped, since the app is saved only after the last file."""
    from proof.matrix import media

    media_png = media.png_of("jr://file/commcare/image/ordinary.png")
    ordinary = "jr://file/commcare/image/ordinary.png"
    wide = "jr://file/commcare/image/wide.png"
    assert WITHIN[0] * WITHIN[1] <= PICTURE_MAX_PIXELS < PAST[0] * PAST[1]
    within, _ = _upload([("commcare/image/ordinary.png", [media_png]), ("commcare/image/wide.png", [_gray_png(*WITHIN)])])
    past, _ = _upload([("commcare/image/ordinary.png", [media_png]), ("commcare/image/wide.png", [_gray_png(*PAST)])])
    with hq_check(CONFIGURATION) as (state, _):
        from PIL import Image

        assert 2 * Image.MAX_IMAGE_PIXELS == PICTURE_MAX_PIXELS

        taken_id = _app(state, "Wide picture app", images=(ordinary, wide))
        with warnings.catch_warnings(record=True) as warned:
            warnings.simplefilter("always")
            taken = operations.apply_media_upload(state, taken_id, within)
        assert taken.processing["complete"] is True and taken.processing["errors"] == []
        assert [info["path"] for info in taken.processing["matched_files"]["CommCareImage"]] == [ordinary, wide]
        assert sorted(operations.held_app(state, taken_id).multimedia_map) == sorted([ordinary, wide])
        assert any(issubclass(one.category, Image.DecompressionBombWarning) for one in warned)

        refused_id = _app(state, "Wider picture app", images=(ordinary, wide))
        refused = operations.apply_media_upload(state, refused_id, past)
        assert refused.status == 200 and refused.response["success"] is True
        assert refused.processing["complete"] is True
        # The task reported the ordinary picture matched before the wide one stopped it, and never saved the app.
        assert [info["path"] for info in refused.processing["matched_files"]["CommCareImage"]] == [ordinary]
        pixels = PAST[0] * PAST[1]
        message = (
            f"Error while processing zip: Image size ({pixels} pixels) exceeds limit of {PICTURE_MAX_PIXELS}"
            " pixels, could be decompression bomb DOS attack."
        )
        assert refused.processing["errors"] == [message]
        assert dict(operations.held_app(state, refused_id).multimedia_map) == {}
