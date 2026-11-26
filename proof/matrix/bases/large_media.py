"""``hq-large-media``: an app made in HQ whose form shows a picture and a sound each larger than Nova lets a person
upload of its kind, which HQ stores whatever their size.

HQ's bulk upload reads each file of its ZIP whole and stores it with no size check
(``hqmedia/tasks.py::process_bulk_upload_zip``), and its template loader's calls store a file the same way
(``_pages.attach_file``), so an app made in HQ can hold files past Nova's per-kind upload caps
(``lib/domain/multimedia.ts::ASSET_SIZE_CAPS_BYTES``: a picture 5 MiB, a sound 10 MiB). Nova's reading streams each
such file into the receiving Project and judges it by range
(``lib/deployment/reading/projectData/mediaStore.ts``), so the app comes in whole.

1. A new app (``views/apps.py::default_new_app``), named "Site survey" on the app page (``edit_app_attr``), with Web
   Apps turned on, so it is read as running on both platforms.
2. A survey menu "Sites" (``views/modules.py::new_module``) whose one form's source is written by HQ's own form
   writer (``xform_builder.py::XFormBuilder``) with its labels' media forms in the shape HQ's form builder writes
   them, uploaded on the form page: a text question ``site_name`` whose label carries the picture, and a text
   question ``site_remark`` whose label carries the sound.
3. The two files attached with the calls HQ's template loader makes for a file: the picture
   (``media.py::oversize_png_of``) one byte past Nova's 5 MiB cap, at ``jr://file/large_site_photo.png``, a path of
   one segment HQ's bulk upload cannot address, so Nova's first publish sends it again at its own path through
   HQ's bulk upload (``media-files-renamed``); the sound (``media.py::oversize_mp3_of``) one byte past Nova's
   10 MiB cap, at the path HQ's pages give a label's sound, which the first publish keeps and settles by the
   file's digest, read by stream.

A video past its 50 MiB cap is not among them: the retained layout bounds a media file at 16 MiB
(``proof/matrix/retained-layout.json``).

Its configuration is the lane's floor with ``CLOUDCARE`` for Web Apps; media need no privilege
(``proof/checks/configurations.py::required_privileges``).
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.hq_media import _add_media
from proof.matrix.registry import Base

NAME = "Site survey"
MENU = "Sites"

# A path of one segment under jr://file/, which HQ's bulk upload cannot address.
LARGE_PICTURE = "jr://file/large_site_photo.png"
LARGE_SOUND = "jr://file/commcare/audio/data/site_remark.mp3"
# Nova's upload caps (``lib/domain/multimedia.ts::ASSET_SIZE_CAPS_BYTES``): a picture's, then a sound's.
PICTURE_CAP_BYTES = 5 * 1024 * 1024
SOUND_CAP_BYTES = 10 * 1024 * 1024


def sites_source(name):
    """The form: ``site_name``, whose label carries the large picture, and ``site_remark``, whose label carries the
    large sound."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("site_name", "Site name", "string")
    xform.new_question("site_remark", "Remark", "string")
    _add_media(
        xform,
        {
            "site_name-label": (("image", LARGE_PICTURE),),
            "site_remark-label": (("audio", LARGE_SOUND),),
        },
    )
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    from proof.matrix import media

    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.new_survey_module(authoring, app_id, name=MENU)
    ops.upload_form_source(authoring, app_id, 0, 0, sites_source, "sites-source")
    _pages.attach_file(authoring, app_id, LARGE_PICTURE, media.oversize_png_of(LARGE_PICTURE, PICTURE_CAP_BYTES + 1))
    _pages.attach_file(authoring, app_id, LARGE_SOUND, media.oversize_mp3_of(LARGE_SOUND, SOUND_CAP_BYTES + 1))
    return app_id


BASE = Base(
    id="hq-large-media",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE"})),
    exhibits=("expressions-and-data/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app",),
)
