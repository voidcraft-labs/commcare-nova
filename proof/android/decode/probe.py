"""What CommCare Android's platform decoders make of every media format Nova accepts, on three emulator images.

    PROOF_ANDROID_DECODE_AVDS="23=<avd>,29=<avd>,35=<avd>" python3 -m unittest proof.android.decode.probe -v

Each image is booted by ``run.sh``, which runs ``DecodeProbe.java`` with ``app_process`` over
``lib/media/__tests__/fixtures/`` and the files ``lib/media/__tests__/bmpFixtures.ts`` and ``builtFixtures.ts``
build: each audio and video file decoded to the end of its stream by the platform's own ``MediaCodec`` decoder, each
image by ``BitmapFactory`` (CommCare Android plays an app's media with the platform's own MediaPlayer, VideoView and
image views). Contract: every file of a variant whose Android reading is ``runs`` decodes fully on Android 6.0 (API
23, CommCare's minimum), 10 (API 29) and 15 (API 35), and each VP9 profile Nova refuses is refused by Android 6.0's
decoder, the reason Nova holds VP9 to profile 0. Failure it catches: a format or a variant Nova accepts that a
supported device cannot play, and a near miss Nova refuses for no reason a device shows.

It needs an Apple-silicon Mac with the Android SDK's emulator and the arm64 system images of API 23, 29 and 35;
no proof machine and no CI runner boots them, so the lane never collects this (it is no ``test_*.py``). Each run
prints the image's ``ro.build.fingerprint``, which ``lib/commcare/surface/media-formats.json``'s
``android-decode`` record holds.
"""

from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]

# Every file of a variant whose Android reading is runs (the validator's own fixtures and the files the builders
# make). A file of a variant whose reading is still the documentation's gains its run's ``executed`` mark when it
# decodes on all three images.
ACCEPTED = (
    "tone.m4a",
    "tone-m4b.m4a",
    "tone.flac",
    "tone-vorbis.ogg",
    "tone-opus.ogg",
    "pattern-vp8.webm",
    "pattern-vp8-vorbis.webm",
    "pattern-vp9.webm",
    "pattern-vp9-opus.webm",
    "pattern-8.bmp",
    "pattern-16.bmp",
    "pattern-24.bmp",
    "pattern-32.bmp",
    "pattern-1.bmp",
    "pattern-4.bmp",
    "pattern-v5-srgb-32.bmp",
    "tiny-video.mp4",
    "pattern-h264-baseline.mp4",
    "pattern-h264-main-aac.mp4",
    "pattern-hevc.mp4",
    "pattern-mpeg4.mp4",
    "pattern-vp8.mkv",
    "tone.wav",
    "tone-8.wav",
    "tone.mp3",
    "tone.aac",
    "amr-nb.amr",
    "amr-wb.amr",
    "midi.mid",
    "pattern.png",
    "pattern.jpg",
    "pattern.gif",
    "pattern.webp",
)
# The image files, which BitmapFactory decodes whole and which carry no frame count.
IMAGES = (".bmp", ".png", ".jpg", ".gif", ".webp")
# The VP9 profiles Nova refuses, each refused by Android 6.0's decoder.
REFUSED_ON_API_23 = ("pattern-vp9-profile1.webm", "pattern-vp9-profile2.webm")


def images() -> dict[int, str]:
    """The AVD of each API level the run names (``PROOF_ANDROID_DECODE_AVDS``)."""
    named = os.environ.get("PROOF_ANDROID_DECODE_AVDS", "")
    avds = {}
    for pair in filter(None, (part.strip() for part in named.split(","))):
        api, _, avd = pair.partition("=")
        avds[int(api)] = avd
    return avds


def decoded(avd: str) -> tuple[str, dict[str, dict]]:
    """The image's fingerprint and what its decoders made of each file, by file name."""
    run = subprocess.run(
        [str(HERE / "run.sh"), avd], cwd=ROOT, capture_output=True, text=True, check=True, timeout=1_800
    )
    fingerprint, results = "", {}
    for line in run.stdout.splitlines():
        if line.startswith("FINGERPRINT "):
            fingerprint = line.removeprefix("FINGERPRINT ")
        elif line.startswith("{"):
            result = json.loads(line)
            results[result["file"]] = result
    return fingerprint, results


class Decode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        avds = images()
        missing = sorted({23, 29, 35} - set(avds))
        if missing:
            raise unittest.SkipTest(
                f"Name an AVD for API levels {missing} in PROOF_ANDROID_DECODE_AVDS (23=<avd>,29=<avd>,35=<avd>)."
            )
        cls.runs = {api: decoded(avd) for api, avd in sorted(avds.items())}
        for api, (fingerprint, _) in cls.runs.items():
            print(f"API {api}: {fingerprint}")

    def test_every_accepted_file_decodes_fully_on_each_image(self):
        for api, (fingerprint, results) in self.runs.items():
            self.assertTrue(fingerprint, f"API {api} printed no build fingerprint")
            for name in ACCEPTED:
                with self.subTest(api=api, file=name):
                    result = results.get(name)
                    self.assertIsNotNone(result, f"API {api} read no {name}")
                    self.assertEqual(result["outcome"], "decoded", result)
                    if not name.endswith(IMAGES):
                        self.assertGreater(result["frames"], 0, result)

    def test_android_6_refuses_the_vp9_profiles_nova_refuses(self):
        _, results = self.runs[23]
        for name in REFUSED_ON_API_23:
            with self.subTest(file=name):
                self.assertIn(results[name]["outcome"], {"refused", "no-decoder"}, results[name])


if __name__ == "__main__":
    unittest.main()
