"""The reader's screens end with the walk that opened them.

Contract (``src/nova/proof/android/Opened.java``): every screen the reader builds is built through ``Opened``,
which keeps its controller and ends it when its walk ends, as Android ends a screen the worker has left.
Robolectric holds an activity it built, its window and every theme its views were made with until its controller
is closed, so a screen built anywhere else is never ended: a device that walks every path, case and language of
an app then holds hundreds of screens, its heap fills, and the request spends its time collecting (the 106 walks
of ``selfcheck.py``'s two-case request took 263 s that way, 175 of them collecting, and 96 s with their screens
ended). Plausible
failure: a new part of the reader builds a screen with Robolectric's own builder. The JVM is not here to ask
(the reader's runtime is outside the image the lane's tests run in), so the observation is the sources': the
one call of Robolectric's builder is ``Opened``'s.
"""

from __future__ import annotations

from proof.android.client import SOURCE_DIR

BUILDER = "Robolectric.buildActivity("


def test_every_screen_the_reader_builds_is_built_where_its_end_is_kept():
    builds = {
        path.name: path.read_text(encoding="utf-8").count(BUILDER)
        for path in SOURCE_DIR.rglob("*.java")
        if BUILDER in path.read_text(encoding="utf-8")
    }
    assert builds == {"Opened.java": 1}
