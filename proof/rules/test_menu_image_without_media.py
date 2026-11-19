"""The rule ``menu-image-without-media`` is sound: no reader draws a menu icon whose path no media resource installs
apart from a menu that names none.

Contract: given a trace beside the media its build installs, the rule writes
null for the image of each menu choice whose path none of them installs, and
leaves an image a media resource installs, every step that is no menu, and a
trace given no media table. The comparison never reports the media table
itself. Its readers are HQ's build, which writes the reference and no media
resource, Core, Formplayer, which hands the path on, the Web Apps client,
which looks it up in the app's media map, and CommCare Android
(``proof/android/predicates.py::test_a_menu_icon_no_media_resource_installs_draws_as_none``).
The plausible failures: a reader that draws a path with no file as something
other than no image (a broken picture, an install refused); the rule erasing
a picture a media resource names with no file (``broken-pictures-removed``);
and the media table compared as part of the trace.

``case-list-local``'s first menu is published as Nova writes it, with no
icon, and with an icon at a path the media map does not hold, as CommCare
HQ's settings page stores one whose file was never uploaded. HQ builds both
whole, the two builds differ only where the menu names its icon (its app
string and its ``<display>``), Core's sessions, which list that menu at the
root and go on to the list's search with no form to open, differ only at the
menu item's image, which the rule erases given each build's admission,
and leaves where the other build's media table installs the path. Formplayer
hands the path on, and the Web Apps client's screens of the two releases
compare equal.
"""

from __future__ import annotations

import copy
import fnmatch
import json
from dataclasses import replace

import pytest

from proof.checks import proof3
from proof.checks.compare.trace import INSTALLED_MEDIA, compare_traces
from proof.rules.conftest import (
    build_differences,
    client_differences,
    edited,
    formplayer_differences,
    published,
    runs_alike,
    served_readings,
    shown,
    trace_differences,
)
from proof.rules.menu_image_without_media import RULE, normalize

DOCUMENT = "case-list-local"
# A menu icon at a path the media map does not hold, as HQ's settings page stores one whose file was never uploaded.
ICON = "jr://file/commcare/image/module0_en.png"
# Where HQ's build writes a menu's icon, as artifact globs and structural paths: its app string in every language,
# and the ``<display>`` that names it in place of the menu's own ``<text>``.
ICON_PLACES = (
    ("app_strings:*", "/modules.m*.icon"),
    ("suite.xml", "/suite/menu[@id=*]/display[*]"),
    ("suite.xml", "/suite/menu[@id=*]/text[*]"),
)
IMAGE = ("trace", "/runs/*/trace/*/choices/*/image", "changed")


def _menu(image, installed=None):
    """A trace of one run whose first step is a menu listing one item with ``image``, and whose second is a form whose
    one choice names ``ICON``."""
    trace = {
        "runs": [
            {
                "trace": [
                    {"screen": "menu", "choices": [{"command": "m0", "text": "Visits", "image": image, "audio": None}]},
                    {"screen": "form", "choices": [{"text": "Red", "image": ICON}]},
                ]
            }
        ]
    }
    if installed is not None:
        trace[INSTALLED_MEDIA] = list(installed)
    return trace


# The rule over traces alone ------------------------------------------------------------------------------------


def test_a_menu_image_no_media_resource_installs_reads_as_none_and_nothing_else_is_changed():
    found = normalize(_menu(ICON, installed=["jr://file/commcare/image/other.png"]))
    menu, form = found["runs"][0]["trace"]
    assert menu["choices"][0]["image"] is None
    # A step that is no menu is left, and so is a trace given no media table.
    assert form["choices"][0]["image"] == ICON
    assert normalize(_menu(ICON)) == _menu(ICON)
    # An image a media resource installs is left, though the build may hold no file for it.
    assert normalize(_menu(ICON, installed=[ICON])) == _menu(ICON, installed=[ICON])


def test_the_comparison_erases_only_an_image_no_resource_installs_and_never_reports_the_media_table():
    def compared(before, after, rules):
        return shown(compare_traces(before, after, check="proof3", document="d", rules=rules))

    named = _menu(ICON, installed=[])
    none = _menu(None, installed=[])
    assert compared(named, none, ()) == [IMAGE]
    assert compared(named, none, (RULE,)) == []
    installed = _menu(ICON, installed=[ICON])
    assert compared(installed, none, (RULE,)) == [IMAGE]
    # Two media tables apart are no difference of the trace: proof 2 compares the media suites.
    assert compared(_menu(None, installed=[ICON]), none, ()) == []


def test_proof_3_lays_the_media_a_build_installs_beside_its_trace():
    admission = {
        "media": [
            {"id": "a", "location": "./commcare/image/module0_en.png", "bytesInArchive": False},
            {"id": "b", "location": "./commcare/audio/module0_en.mp3", "bytesInArchive": True},
        ]
    }
    shown_trace = proof3.comparable_trace({"runs": []}, proof3.RUNTIMES["B"], admission)
    assert shown_trace[INSTALLED_MEDIA] == ["jr://file/commcare/audio/module0_en.mp3", ICON]
    assert INSTALLED_MEDIA not in proof3.comparable_trace({"runs": []}, proof3.RUNTIMES["B"])
    assert RULE.applies_to("trace") and not RULE.applies_to("suite.xml")


# The readers, run ---------------------------------------------------------------------------------------------


def _iconed(doc):
    """The first menu's icon at ``ICON`` in every language, which the media map does not hold."""
    module = doc["modules"][0]
    module["media_image"] = {language: ICON for language in doc["langs"]}
    assert ICON not in (doc.get("multimedia_map") or {}), "the document's media map holds the icon's path"


def _installing(ran, path):
    """``ran`` as if its build installed a media resource at ``path``: the rule's condition made false."""
    admission = copy.deepcopy(ran.admission)
    admission.setdefault("media", []).append({"id": "planted", "location": "./" + path[len("jr://file/") :]})
    return replace(ran, admission=admission)


def test_hq_builds_a_menu_icon_with_no_media_and_core_runs_it_as_none(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(doc=edited(lambda doc: None))
        iconed = app.spell(doc=edited(_iconed))
        first, second, alike = runs_alike(app, core_runner, nova.build, iconed.build, reads="menu")

    for spelled in (nova, iconed):
        assert spelled.build.files is not None and not spelled.build.raised, spelled.build.raised
    built = shown(build_differences(nova.build, iconed.build))
    assert built, "the two spellings built the same app, so the test shows nothing"
    stray = [
        (artifact, path, kind)
        for artifact, path, kind in built
        if not any(fnmatch.fnmatchcase(artifact, glob) and path == place for glob, place in ICON_PLACES)
    ]
    assert stray == [], f"HQ's build of the icon wrote more than its reference: {stray}"
    assert ICON in json.dumps(second.trace), "Core's run of the icon's build names no icon"
    assert shown(alike) == [IMAGE], shown(alike)
    assert trace_differences(first, second, rules=(RULE,)) == []
    planted = trace_differences(first, _installing(second, ICON), rules=(RULE,))
    assert shown(planted) == [IMAGE], "the rule erased an icon a media resource installs"


@pytest.mark.reader("webapps")  # beside Formplayer, which its fixture starts: it reads the client's screens too
def test_web_apps_shows_a_menu_icon_with_no_media_as_none(rule_documents, hq, core_runner, formplayer_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        readings = served_readings(app, formplayer_runner, {"nova": None, "iconed": _iconed})

    nova, iconed = readings["nova"], readings["iconed"]
    # Formplayer hands the path on as it stands, and the client looks it up in a media map that does not hold it.
    assert ICON in json.dumps(iconed["formplayer"]), "Formplayer's walk named no icon"
    assert ICON not in (iconed["doc"].get("multimedia_map") or {})
    handed = shown(formplayer_differences(nova, iconed))
    assert all(path.endswith("/imageUri") for _, path, _ in handed), handed
    assert client_differences(nova, iconed) == []
