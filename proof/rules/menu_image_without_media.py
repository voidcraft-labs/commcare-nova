"""A menu item's image whose path no media resource of the build installs, where the other build names no image.

An app made in CommCare HQ can name a menu's or a form's icon whose file was
never uploaded: HQ's settings page stores the path, the media map holds no
entry for it, and HQ's build writes the reference (``modules.m<i>.icon``,
the menu's ``<display>``) and no media resource (``hq-media``'s second menu).
Nova's reader leaves such a reference out, and the first publish writes none
(``media-references-with-no-file-removed``, which touches no worker). Core's
runner records the reference a menu item names whether or not any resource
installs a file for it (``SessionOp.java``, ``MenuDisplayable.getImageURI``),
so proof 3's trace shows the path on one side and none on the other.

No reader of the app shows the two apart:

- CommCare Android draws a menu item's icon with
  ``MediaUtil.inflateDisplayImage``, which answers null for no reference and
  for a reference whose binary does not exist alike, and ``MenuAdapter.
  setupImageView`` then draws the default icon (``setupDefaultIcon``) in both
  cases; an install checks only the media resources the suite names, and
  this path has none;
- Formplayer hands the path on as it stands (``beans/menus/Command.java``,
  ``imageUri``), and the Web Apps client looks it up in the app's media map
  (``cloudcare/js/formplayer/app.js``, ``resourceMap``), which answers nothing
  for a path the map does not hold, so the client draws what it draws for a
  menu that names no image.

The rule reads a trace beside the media its build installs, which proof 3
lays there from Core's admission of the build
(``proof.checks.proof3.comparable_trace``,
``compare.trace.INSTALLED_MEDIA``), and writes null for the image of each
menu choice whose path is none of them. It holds only under that condition:
an image whose path a media resource installs is left, so a picture the media
map names with no file HQ serves (``broken-pictures-removed``, which Web Apps
shows as a broken picture) stays a difference, and a trace given no media
table is left as it is. The same rule reads a native menu image URI with its own archive's evidence;
the Android comparison also retains a file the device itself says it holds.
"""

from __future__ import annotations

from proof.checks.compare.trace import INSTALLED_MEDIA
from proof.rules import SpellingRule

# The screen a menu's step records, with the items it lists as ``choices`` (``SessionOp.java``).
MENU_SCREEN = "menu"


def normalize(trace):
    if not isinstance(trace, dict) or not isinstance(trace.get(INSTALLED_MEDIA), list):
        return trace
    installed = frozenset(trace[INSTALLED_MEDIA])
    image = trace.get("menuImage")
    if isinstance(image, str) and image.startswith("jr://file/") and image not in installed:
        trace["menuImage"] = None
    for run in trace.get("runs") or ():
        for step in (run.get("trace") or ()) if isinstance(run, dict) else ():
            if not isinstance(step, dict) or step.get("screen") != MENU_SCREEN:
                continue
            for choice in step.get("choices") or ():
                image = choice.get("image") if isinstance(choice, dict) else None
                if isinstance(image, str) and image not in installed:
                    choice["image"] = None
    return trace


RULE = SpellingRule(
    "menu-image-without-media",
    ("trace", "menu-image"),
    "A menu item's image whose path no media resource of the build installs, which Android draws as its default"
    " icon and the Web Apps client as no image (MediaUtil.inflateDisplayImage, app.js resourceMap).",
    normalize,
    readers=(
        ("formplayer", "test_web_apps_shows_a_menu_icon_with_no_media_as_none"),
        ("webapps", "test_web_apps_shows_a_menu_icon_with_no_media_as_none"),
        ("android", "test_a_menu_icon_no_media_resource_installs_draws_as_none"),
    ),
)
