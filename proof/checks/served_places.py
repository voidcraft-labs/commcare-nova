"""Attribute one configuration's native readings to the app slots that produced them.

A difference is judged beside the two actual reader answers that produced it. A changed slot needs agreement
between both sides; an added slot is located by the new side and a removed slot by the old. The document-wide
first-publish judge merges concrete places across configurations after each has judged its own readings.
"""

from __future__ import annotations

import json
from dataclasses import replace
from functools import cache

from proof.checks import (
    android_places,
    changes,
    formplayer_menus,
    formplayer_places,
    xform_parts,
)
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.differences import ANDROID, ANDROID_TABLET, FORMPLAYER, pointer_token

# The release answer, and the local delivered-archive answer, that each reader actually compared.
READERS = (
    (FORMPLAYER, "formplayer", "formplayer", "trace"),
    (ANDROID, "android", "androidDelivered", "answer"),
    (ANDROID_TABLET, "androidTablet", "androidDeliveredTablet", "answer"),
)
CAPTIONS = frozenset(
    {
        "/walks/*/steps/*/form/screens/*/questions/*/text",
        "/walks/*/steps/*/form/screens/*/shown/*/text",
        "/runs/*/steps/*/response/tree/*/caption",
        "/runs/*/steps/*/tree/*/caption",
    }
)


def form_namespaces(files):
    """The installed suite names the form a command opens by namespace. Conflicting entries prove no position."""
    if not files.get("suite.xml"):
        return {}
    try:
        suite = parse_xml(files["suite.xml"])
    except XmlNotWellFormed:
        return {}
    found = {}
    for entry in suite.findall("entry"):
        namespace = entry.findtext("form")
        command = entry.find("command")
        place = changes.command_place(command.get("id") if command is not None else None)
        if namespace:
            position = place[1] if place[:1] == ("form",) else None
            found[namespace] = position if found.get(namespace, position) == position else None
    return found


def sites(records, name, differences, observed, local_files):
    """Read each side's witness from this configuration. An absent contributor cannot borrow its peer's site."""
    parts = records.configurations[name]
    baseline = (((parts.a or {}).get("hooks") or {}).get("served") or {}).get("A") or {}
    others = (parts.b_aligned or {}).get("served") or {}
    sessions = (parts.b_aligned or {}).get("sessions") or {}
    by_side = {
        "A": (baseline, observed.a.build.files if observed.a else {}, "baseline"),
        "B": (others.get("B") or {}, observed.b_aligned.files if observed.b_aligned else {}, "b"),
        "local.ccz": (others.get("local") or {}, local_files, "local"),
    }

    @cache
    def namespaces(side):
        state, files, _ = by_side[side]
        if "suite.xml" in ((state.get("releaseDiffers") or {}).get("differing") or ()):
            return {}
        return form_namespaces(files or {})

    get_json = cache(records.blobs.get_json)
    results = []
    for reader, release_key, local_key, payload in READERS:
        for side in ("local.ccz", "B"):
            selected = [d for d in differences if d.artifact == f"{reader}@{side}"]
            for old, which in ((True, "A"), (False, side)):
                contributed = [d for d in selected if d.kind != ("added" if old else "removed")]
                if not contributed:
                    continue
                state, files, session = by_side[which]
                key = local_key if which == "local.ccz" else release_key
                blob = (state.get(key) or {}).get(payload)
                locations = {}
                if blob and reader == FORMPLAYER:
                    trace = get_json(blob)
                    locations = formplayer_places.locations(contributed, trace, namespaces(which))
                    menus = [d for d in contributed if formplayer_menus.trimmed(d)]
                    if menus:
                        core = (sessions.get(session) or {}).get("trace")
                        menu_sites = formplayer_menus.locations(
                            menus,
                            trace,
                            get_json(core) if core else {},
                            files or {},
                            (state.get("releaseDiffers") or {}).get("differing") or (),
                            before=old,
                        )
                        locations.update({(d.artifact, d.at): menu_sites.get((d.artifact, d.at)) for d in menus})
                elif blob:
                    locations = android_places.locations(contributed, get_json(blob), {})
                results.append(
                    changes.Sites(served={(d.artifact, d.at): locations.get((d.artifact, d.at)) for d in contributed})
                )
    return changes.merged_sites(*results)


def first_language_fill(difference, location, app, form_parts):
    """The native caption changed from empty to the source's exact first-language label for that question."""
    if (
        difference.kind != "changed"
        or difference.path not in CAPTIONS
        or difference.before != ""
        or not isinstance(difference.after, str)
        or not difference.after
        or len(location) < 9
        or location[0] != "form"
        or location[2:4] != ("xform", "data")
        or location[-4:-2] != (":itext", "label")
        or location[-1] != "default"
    ):
        return False
    languages = app.get("langs") or []
    if not isinstance(languages, list) or not languages or location[-2] not in languages[1:]:
        return False
    parts = form_parts(location[1])
    slot = "/" + "/".join(pointer_token(token) for token in location[3:-2])
    target = f"{slot}/{pointer_token(location[-2])}/default"
    first = f"{slot}/{pointer_token(languages[0])}/default"
    return parts.get(target, (None, None))[1] == "" and parts.get(first, (None, None))[1] == difference.after


def review_read(document):
    """The app Nova actually read for a first publish, or after the person's HQ saves for a next publish."""
    if document.kind != "corpus":
        return None
    saves = document.hq_side
    if saves is not None:
        return "saved" if saves.get("republish") == "brings-in" else None
    if document.hq_authored:
        return "authored"
    return None


def _source(records, name, label):
    reads = (records.configurations[name].a or {}).get("apiReads") or {}
    answer = (reads.get(label) or {}).get("source")
    if isinstance(answer, str):
        answer = records.blobs.get_json(answer)
    if not isinstance(answer, dict) or answer.get("status") != 200:
        return {}
    try:
        source = json.loads(answer.get("body") or "")
    except (TypeError, ValueError):
        return {}
    return source if isinstance(source, dict) else {}


def text_candidate(difference):
    return formplayer_menus.trimmed(difference) or (
        difference.path in CAPTIONS
        and difference.kind == "changed"
        and difference.before == ""
        and isinstance(difference.after, str)
        and bool(difference.after)
    )


def _source_menu_name(app, position, text):
    """Attribute a trim to the stored menu name only. An override of the generated key has a different owner."""
    if not position.isdigit():
        return False
    module = int(position)
    modules = app.get("modules")
    if not isinstance(modules, list) or module >= len(modules) or not isinstance(modules[module], dict):
        return False
    names = modules[module].get("name") or {}
    key = f"modules.m{position}"
    overrides = app.get("translations") or {}
    return (
        isinstance(names, dict)
        and text in names.values()
        and isinstance(overrides, dict)
        and all(isinstance(table, dict) and key not in table for table in overrides.values())
    )


def classify(document, records, name, differences, places):
    """Classify only this configuration's own native differences. A source-less caption stays a difference."""
    read = review_read(document)
    if not read:
        return differences

    @cache
    def source():
        return _source(records, name, read)

    @cache
    def form_parts(position):
        app = source()
        module, form = map(int, position.split("."))
        modules = app.get("modules") or []
        if module >= len(modules) or not isinstance(modules[module], dict):
            return {}
        forms = modules[module].get("forms") or []
        if form >= len(forms) or not isinstance(forms[form], dict):
            return {}
        file = (app.get("_attachments") or {}).get(f"{forms[form].get('unique_id')}.xml")
        return (xform_parts.parts(file) or {}) if isinstance(file, str) else {}

    found = []
    for difference in differences:
        owner = places.served.get((difference.artifact, difference.at)) or ()
        if formplayer_menus.is_trimmed_menu(difference, owner) and _source_menu_name(
            source(), owner[1], difference.before
        ):
            difference = replace(difference, path=formplayer_menus.TRIMMED)
        elif owner and difference.path in CAPTIONS and first_language_fill(difference, owner, source(), form_parts):
            difference = replace(difference, path=f"{difference.path}:filled")
        found.append(difference)
    return found
