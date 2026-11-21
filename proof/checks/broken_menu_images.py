"""A broken HQ menu picture removed by the first publish, at the choice that showed it.

Only the actual HQ read of the mapped image proves it unavailable. Core names the command in the root menu;
Formplayer gives its index and navigation state. Web Apps resolves the image through the same app's media map
and its menu/row.html and menu/grid_item.html choose their default icon from that navigation state.
"""

from __future__ import annotations

from urllib.parse import quote

from proof.checks.changes import command_place, unescaped

FORMPLAYER_IMAGE = "/runs/*/steps/*/response/commands/*/imageUri"
WEB_IMAGE = "/runs/*/screens/*/commands/*/image"
WEB_ICON = "/runs/*/screens/*/commands/*/icon"
SUFFIX = ":broken-picture"


def missing_images(source, reads):
    """Mapped HQ picture URIs whose own read returned 404 at the source's exact multimedia id."""
    mapping = source.get("multimedia_map") if isinstance(source, dict) else None
    if not isinstance(mapping, dict) or not isinstance(reads, list) or not all(isinstance(row, dict) for row in reads):
        return {}
    found = {}
    for path, item in mapping.items():
        if (
            not isinstance(path, str)
            or not path.startswith("jr://file/")
            or not isinstance(item, dict)
            or item.get("media_type") != "CommCareImage"
        ):
            continue
        image_id = item.get("multimedia_id")
        matching = [row for row in reads if row.get("path") == path]
        if (
            isinstance(image_id, str)
            and image_id
            and len(matching) == 1
            and matching[0].get("status") == 404
            and matching[0].get("mediaType") == "CommCareImage"
            and matching[0].get("multimediaId") == image_id
        ):
            found[path] = image_id
    return found


def candidate(d):
    if d.artifact in ("formplayer@B", "formplayer@local.ccz"):
        return d.path == FORMPLAYER_IMAGE and d.kind == "removed" and isinstance(d.before, str) and d.after is None
    return d.artifact == "webapps@B" and d.kind == "changed" and d.path in (WEB_IMAGE, WEB_ICON)


def _in(rows, index):
    if isinstance(rows, list) and 0 <= index < len(rows) and isinstance(rows[index], dict):
        return rows[index]
    return {}


def _root_response(step):
    response, request = step.get("response"), step.get("request")
    if (
        isinstance(response, dict)
        and isinstance(request, dict)
        and request.get("selections") == []
        and response.get("selections") == []
        and response.get("type") == "commands"
        and isinstance(response.get("commands"), list)
    ):
        return response["commands"]
    return []


def _root(core, formplayer):
    """The same, unambiguous root offer across Core and Formplayer. An unrecognized menu verifies nothing."""

    def unique(trace, steps_key):
        rows = None
        runs = trace.get("runs") if isinstance(trace, dict) else None
        if not isinstance(runs, list):
            return ()
        for run in runs:
            steps = run.get(steps_key) if isinstance(run, dict) else None
            if not isinstance(steps, list):
                return ()
            for step in steps:
                if not isinstance(step, dict):
                    return ()
                if steps_key == "trace":
                    if step.get("screen") != "menu" or step.get("root") != "root":
                        continue
                    offers = step.get("choices")
                    keys = ("command", "text", "image")
                else:
                    offers = _root_response(step)
                    if not offers:
                        continue
                    keys = ("index", "displayText", "imageUri", "navigationState")
                if not isinstance(offers, list) or not all(isinstance(c, dict) for c in offers):
                    return ()
                observed = tuple(tuple(c.get(k) for k in keys) for c in offers)
                if rows is not None and rows != observed:
                    return ()
                rows = observed
        return rows or ()

    choices, commands = unique(core, "trace"), unique(formplayer, "steps")
    if not all(
        isinstance(code, str) and isinstance(text, str) and (image is None or isinstance(image, str))
        for code, text, image in choices
    ):
        return ()
    if len({c[0] for c in choices}) != len(choices):
        return ()
    if [(i, *choice[1:]) for i, choice in enumerate(choices)] != [command[:3] for command in commands]:
        return ()
    return tuple((*choice, command[3]) for choice, command in zip(choices, commands))


def _source_slot(source, owner):
    if not isinstance(source, dict) or not owner or owner[0] not in ("form", "menu"):
        return {}
    module, _, form = owner[1].partition(".")
    node = _in(source.get("modules"), int(module))
    if owner[0] == "form":
        node = _in(node.get("forms"), int(form))
    slot = node.get("media_image")
    return slot if isinstance(slot, dict) and all(isinstance(value, str) for value in slot.values()) else {}


def locations(differences, source, missing, before, after, *, web=None):
    """Check both actual chooser rows, the raw stored slot, and the 404. No other visible change is covered."""
    old_core, old_fp = before
    new_core, new_fp = after
    old_root, new_root = _root(old_core, old_fp), _root(new_core, new_fp)
    if not old_root or [r[0] for r in old_root] != [r[0] for r in new_root]:
        return {}
    found = {}
    for d in differences:
        if not candidate(d):
            continue
        path = unescaped(d.at)
        browser = d.artifact == "webapps@B"
        last = 6 if browser else 7
        if len(path) != last + 1 or not all(path[n].isdigit() for n in (1, 3, last - 1)):
            continue
        if d.path != "/" + "/".join("*" if n in (1, 3, last - 1) else field for n, field in enumerate(path)):
            continue
        run, step, index = (int(path[n]) for n in (1, 3, last - 1))
        if index >= len(old_root):
            continue
        command, label, image, nav = old_root[index]
        owner = command_place(command)
        if (
            image not in missing
            or new_root[index] != (command, label, None, nav)
            or (owner[:1] == ("menu",) and command != "m" + owner[1])
            or {uri for uri in _source_slot(source, owner).values() if uri} != {image}
        ):
            continue
        if browser:
            if not isinstance(web, tuple) or len(web) != 2 or not all(isinstance(trace, dict) for trace in web):
                continue
            if not isinstance(nav, str) or not nav or sum(choice[1] == label for choice in old_root) != 1:
                continue
            screens = [_in(_in(trace.get("runs"), run).get("screens"), step) for trace in web]
            if any(not isinstance(s.get("route"), dict) or s["route"].get("selections") != [] for s in screens):
                continue
            rows = [s.get("commands") for s in screens]
            if any(not isinstance(side, list) or not all(isinstance(c, dict) for c in side) for side in rows):
                continue
            if any(
                [c.get("text") for c in side] != [c[1] for c in root] for side, root in zip(rows, (old_root, new_root))
            ):
                continue
            was, now = (side[index] for side in rows)
            url = f"/hq/multimedia/file/CommCareImage/{quote(missing[image], safe='')}/{quote(image.rsplit('/', 1)[-1], safe='')}"
            icon = "fa-pencil" if nav == "JUMP" else "fa-folder"
            if (
                was.get("image") != url
                or was.get("icon") is not None
                or now.get("image") is not None
                or now.get("icon") != icon
                or (d.before, d.after) != ((url, None) if d.path == WEB_IMAGE else (None, icon))
            ):
                continue
        else:
            rows = [_root_response(_in(_in(trace.get("runs"), run).get("steps"), step)) for trace in (old_fp, new_fp)]
            if (
                any(index >= len(side) for side in rows)
                or rows[0][index].get("imageUri") != d.before
                or d.before != image
            ):
                continue
        found[(d.artifact, d.at)] = (*owner, "media_image")
    return found
