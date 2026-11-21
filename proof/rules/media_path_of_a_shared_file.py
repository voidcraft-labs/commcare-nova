"""A media reference to a file its build installs under several paths, read as the first of those paths.

An app made in CommCare HQ can hold one file under two paths: its media map
names the same ``CommCareMultimedia`` at each (``hq-media``'s menu icon and
form icon, the one picture uploaded once and named twice). Nova keeps one path
for each file, the first in code-unit order of the paths it can hold
(``lib/deployment/reading/adoption.ts::assignMediaPaths``), so its first
publish points the second reference at the first path
(``media-paths-joined``, which touches no worker). Core's runner records the
path a menu item, a question or a choice names (``SessionOp.java``,
``MenuDisplayable.getImageURI``; ``FormRun.java``'s events), so proof 3's
trace shows the second path on one side and the first on the other.

No reader of the app shows the two apart:

- HQ's build installs a media resource at each path the map names, each
  fetched from HQ's media file view for the one multimedia document
  (``suite_xml/generator.py::SuiteGenerator.media_resources``,
  ``hqmedia_download``), so a device holds the same bytes at both and CommCare
  Android draws the file at the path it is given
  (``MediaUtil.inflateDisplayImage``, ``MenuAdapter.setupImageView``);
- Formplayer hands the path on as it stands (``beans/menus/Command.java``,
  ``imageUri``), and the Web Apps client asks HQ for
  ``/hq/multimedia/file/<type>/<multimedia id>/<name>`` (``formplayer/app.js``,
  ``resourceMap``), which HQ's ``ViewMultimediaFile`` answers with the
  document's file whatever the name.

The rule reads a trace beside the file each media resource of its build
installs, which proof 3 lays there from the build's own media suite
(``proof.checks.proof3.media_files``, ``compare.trace.MEDIA_FILES``: the
bytes where the build carries them, else the address HQ serves the file
from, less the file's name), and writes each image, sound and video a step
names as the first path, in code-unit order, of the paths its build installs
the same file at. It holds only under that condition: a path no other path
of its build shares a file with is left, so a file Nova renamed
(``media-files-renamed``) or a picture with no file
(``broken-pictures-removed``) stays a difference, and a trace given no media
files is left as it is. The native readers apply the same rule to a command or menu item's image URI
alongside that archive's own files.
"""

from __future__ import annotations

from proof.checks.compare.trace import MEDIA_FILES
from proof.rules import SpellingRule

# The keys under which a step of Core's trace names a media reference: a menu choice's, a question's and a
# question's choice's (``SessionOp.java``, ``FormRun.java``).
MEDIA_KEYS = frozenset({"image", "audio", "video"})


def first_paths(files) -> dict:
    """Each path of a build's media that shares its file with another path, to the first of those paths in
    code-unit order."""
    by_file = {}
    for path, identity in files.items():
        if isinstance(path, str) and isinstance(identity, str):
            by_file.setdefault(identity, []).append(path)
    first = {}
    for paths in by_file.values():
        if len(paths) > 1:
            chosen = min(paths)
            first.update({path: chosen for path in paths})
    return first


def _read(value, first):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in MEDIA_KEYS and isinstance(item, str) and item in first:
                value[key] = first[item]
            else:
                _read(item, first)
    elif isinstance(value, list):
        for item in value:
            _read(item, first)


def normalize(trace):
    if not isinstance(trace, dict) or not isinstance(trace.get(MEDIA_FILES), dict):
        return trace
    first = first_paths(trace[MEDIA_FILES])
    if first and isinstance(trace.get("menuImage"), str):
        trace["menuImage"] = first.get(trace["menuImage"], trace["menuImage"])
    if first:
        _read(trace.get("runs"), first)
    return trace


RULE = SpellingRule(
    "media-path-of-a-shared-file",
    ("trace", "menu-image"),
    "A media reference to a file its build installs under several paths, read as the first of those paths: a"
    " device holds the same bytes at each and the Web Apps client fetches the one multimedia document"
    " (SuiteGenerator.media_resources, app.js resourceMap, ViewMultimediaFile).",
    normalize,
    readers=(
        ("formplayer", "test_web_apps_shows_a_picture_two_paths_name_alike"),
        ("webapps", "test_web_apps_shows_a_picture_two_paths_name_alike"),
        ("android", "test_a_picture_two_paths_name_draws_alike"),
    ),
)
