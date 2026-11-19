"""``hq-media``: an app whose media sit in every place and every shape the first publish reads, made in HQ's own pages.

A new app (``views/apps.py::default_new_app``) named "Picture book", with two
survey menus (``views/modules.py::new_module`` with ``module_type``
``survey``, each holding one form), each form's source written by HQ's own
form writer (``xform_builder.py::XFormBuilder``) with its labels' media forms
added in the shape HQ's form builder writes them (``<value form="image">``,
``audio`` and ``video`` under the text's ``<value>``), uploaded on the form
page and then saved in the form builder (``vellum``). Each menu's and form's
icon and audio label are chosen on its settings page
(``views/modules.py::edit_module_attr``, ``views/forms.py::edit_form_attr``,
through ``views/media_utils.py::handle_media_edits``), and each file is the
lane's stand-in (``proof/matrix/media.py``) attached with the calls HQ's
template loader makes for a file (``_pages.attach_media``). It holds:

- image, audio and video on a question's label, an image, an audio and a
  video on three choices, an icon and an audio label on a menu and on a
  form, each at the kind of path HQ's own pages give it;
- one file at two paths, the menu's icon and the form's (``media-paths-joined``);
- three paths a file cannot keep (``media-files-renamed``): two labels'
  pictures whose paths differ only by letter case, each a file of its own;
  a label's picture at ``jr://file/loose_picture.png``, a path of one
  segment HQ's bulk upload cannot address; and a label's picture at a path
  in Nova's derived shape (``commcare/<sha256>.png``) that names other bytes;
- a ``multimedia_map`` entry nothing references (``unused-media-entries-removed``);
- an icon chosen on the second menu's page whose file was never uploaded,
  so the map holds no entry for it, on a menu with no audio label, which no
  runtime draws without its file (``media-references-with-no-file-removed``).

Web Apps stays off, as ``Application.cloudcare_enabled`` defaults, so the
reading's preselected declaration is Android only, the platform its content
runs on; its configuration is the lane's floor, since media need no
privilege (``proof/checks/configurations.py::required_privileges``).
"""

from __future__ import annotations

import hashlib

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Picture book"

LABEL_IMAGE = "jr://file/commcare/image/data/animal_name.png"
LABEL_AUDIO = "jr://file/commcare/audio/data/animal_name.mp3"
LABEL_VIDEO = "jr://file/commcare/video/data/animal_name.mp4"
CHOICE_IMAGE = "jr://file/commcare/image/data/animal-goat.png"
CHOICE_AUDIO = "jr://file/commcare/audio/data/animal-cow.mp3"
CHOICE_VIDEO = "jr://file/commcare/video/data/animal-hen.mp4"
MENU_IMAGE = "jr://file/commcare/image/module0_en.png"
MENU_AUDIO = "jr://file/commcare/audio/module0_en.mp3"
FORM_IMAGE = "jr://file/commcare/image/module0_form0_en.png"
FORM_AUDIO = "jr://file/commcare/audio/module0_form0_en.mp3"
# Two files whose paths differ only by letter case.
UPPER_CASE_IMAGE = "jr://file/commcare/image/data/Place.png"
LOWER_CASE_IMAGE = "jr://file/commcare/image/data/place.png"
# A path of one segment under jr://file/, which HQ's bulk upload cannot address.
LOOSE_IMAGE = "jr://file/loose_picture.png"
# A path in Nova's derived shape whose digest is another file's.
DERIVED_SHAPE_IMAGE = "jr://file/commcare/" + hashlib.sha256(b"hq-media: another picture").hexdigest() + ".png"
UNUSED_IMAGE = "jr://file/commcare/image/data/unused_picture.png"
# The second menu's icon, whose file is never uploaded.
MISSING_MENU_IMAGE = "jr://file/commcare/image/module1_en.png"


def _add_media(xform, media):
    """Each ``(form, path)`` of ``media[<text id>]`` added under that text of the form's one translation as a
    ``<value form="<form>">`` after its text, as HQ's form builder writes a label's media."""
    from lxml import etree

    namespaces = xform.ns
    translation = xform._etree.xpath("./h:head/x:model/x:itext/x:translation", namespaces=namespaces)[0]
    # XFormBuilder makes each text with lxml's ``E``, which names no namespace while the form is in memory; the
    # form's default namespace is theirs once the source is written out.
    for text in translation.findall("text"):
        for form, path in media.get(text.get("id"), ()):
            value = etree.SubElement(text, f"{{{namespaces['x']}}}value", form=form)
            value.text = path


def animals_source(name):
    """The first menu's form: a text question whose label carries a picture, a sound and a video; a single
    select whose three choices carry a picture, a sound and a video; two text questions whose labels' pictures
    differ only by letter case; and one whose label's picture is at a path of one segment."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("animal_name", "Animal name", "string")
    xform.new_question("animal", "Animal", "select1", choices={"goat": "Goat", "cow": "Cow", "hen": "Hen"})
    xform.new_question("place_name", "Place", "string")
    xform.new_question("place_note", "Place note", "string")
    xform.new_question("loose_note", "Loose note", "string")
    _add_media(
        xform,
        {
            "animal_name-label": (("image", LABEL_IMAGE), ("audio", LABEL_AUDIO), ("video", LABEL_VIDEO)),
            "animal-goat-label": (("image", CHOICE_IMAGE),),
            "animal-cow-label": (("audio", CHOICE_AUDIO),),
            "animal-hen-label": (("video", CHOICE_VIDEO),),
            "place_name-label": (("image", UPPER_CASE_IMAGE),),
            "place_note-label": (("image", LOWER_CASE_IMAGE),),
            "loose_note-label": (("image", LOOSE_IMAGE),),
        },
    )
    return xform.tostring(xml_declaration=True).decode("utf-8")


def notes_source(name):
    """The second menu's form: a text question whose label's picture is at a path in Nova's derived shape that
    names other bytes, a whole number, and a hidden value doubling it."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("note_text", "Note", "string")
    xform.new_question("note_count", "How many", "int")
    xform.new_question("note_count_doubled", None, None, calculate="/data/note_count * 2")
    _add_media(xform, {"note_text-label": (("image", DERIVED_SHAPE_IMAGE),)})
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.new_survey_module(authoring, app_id, name="Animals")
    ops.upload_form_source(authoring, app_id, 0, 0, animals_source, "animals-source")
    _pages.new_survey_module(authoring, app_id, name="Notes")
    ops.upload_form_source(authoring, app_id, 1, 0, notes_source, "notes-source")
    _pages.save_menu_media(authoring, app_id, 0, image=MENU_IMAGE, audio=MENU_AUDIO)
    _pages.save_form_media(authoring, app_id, 0, 0, image=FORM_IMAGE, audio=FORM_AUDIO)
    _pages.save_menu_media(authoring, app_id, 1, image=MISSING_MENU_IMAGE)
    for path in (
        LABEL_IMAGE,
        LABEL_AUDIO,
        LABEL_VIDEO,
        CHOICE_IMAGE,
        CHOICE_AUDIO,
        CHOICE_VIDEO,
        MENU_IMAGE,
        MENU_AUDIO,
        FORM_AUDIO,
        UPPER_CASE_IMAGE,
        LOWER_CASE_IMAGE,
        LOOSE_IMAGE,
        DERIVED_SHAPE_IMAGE,
        UNUSED_IMAGE,
    ):
        _pages.attach_media(authoring, app_id, path)
    # The form's icon is the menu's own file: get_by_data finds the document the menu's attach made.
    _pages.attach_media(authoring, app_id, FORM_IMAGE, like=MENU_IMAGE)
    return app_id


BASE = Base(
    id="hq-media",
    build=build,
    configuration=Configuration(),
    exhibits=(
        "application-and-settings/multimedia-map",
        "questions/label-image-audio-video-same-asset-every-language",
        "questions/choice-image",
        "questions/choice-audio-video",
        "menus-and-case-lists/media-image-media-audio-same-asset-in-every-language",
        "forms-and-case-writes/media-image-media-audio-same-asset-every-language",
        "expressions-and-data/media-path-jr-file",
        "expressions-and-data/image-png-jpeg-gif-webp",
        "expressions-and-data/audio-mp3-aac-in-m4a-brand-m4a-m4b-flac-pcm-wav-8-or-16-bit",
        "expressions-and-data/video-mp4-h-264-baseline-or-main-with-aac-lc-or-no-audio-webm",
        "expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map",
    ),
    vellum=((0, 0), (1, 0)),
)
