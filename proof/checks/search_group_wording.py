"""Match the native footprint of one source-owned Search heading key move."""

from __future__ import annotations

import re
from dataclasses import dataclass

from proof.checks import changes


@dataclass(frozen=True)
class Move:
    menu: str
    row: str
    old: str
    new: str

    def locale(self, key):
        return f"search_property.m{self.menu}.{key}"


def _moves(places):
    locales = set()
    groups = set()
    for place in places:
        steps = changes.unescaped(place)
        if len(steps) == 4 and steps[:2] == ["app", "translations"]:
            key = re.fullmatch(r"search_property\.m([0-9]+)\.([A-Za-z][A-Za-z0-9_-]*)", steps[-1])
            if key:
                locales.add((steps[2], *key.groups()))
        elif (len(steps) == 6 and steps[0] == "menu" and steps[2:4] == ["search_config", "properties"]
              and steps[4].isdigit() and steps[-1] == "group_key"):
            groups.add((steps[1], steps[4]))
    for menu, row in groups:
        new = f"group_header_{row}"
        old_keys = {
            key for language, position, key in locales
            if position == menu and not changes.POSITIONAL_SEARCH_GROUP_KEY.fullmatch(key)
            and (language, menu, new) in locales
        }
        for old in old_keys:
            yield Move(menu, row, old, new)


def _changed(row, before, after):
    return row.kind == "changed" and row.before == before and row.after == after


def _same_text(rows, old, new, *, empty=False):
    removed = [r.before for r in rows if r.at == old and r.kind == "removed" and r.after is None]
    added = [r.after for r in rows if r.at == new and r.kind == "added" and r.before is None]
    return (
        bool(removed) and len(removed) == len(added)
        and all(isinstance(value, str) and ((value == "") if empty else bool(value.strip()))
                for value in removed + added)
        and sorted(removed) == sorted(added)
    )


def _query_sites(rows, artifact, sites, move):
    """Find actual suite queries that both renamed a header and kept its locale reference and member."""
    keys, locales, prompts = set(), set(), set()
    for row in rows:
        if row.artifact != artifact:
            continue
        steps = changes._xml_steps(row.at)
        if len(steps) < 6 or steps[0] != "suite" or not steps[1].startswith("remote-request["):
            continue
        if sites.builds.get((artifact, steps[1])) != ("menu", move.menu):
            continue
        query, group = tuple(steps[1:4]), tuple(steps[1:5])
        if len(steps) == 6 and steps[4].startswith("group[") and steps[-1] == "@key":
            if _changed(row, move.old, move.new):
                keys.add(group)
        elif (steps[4].startswith("group[")
              and tuple(map(changes._without_position, steps[5:])) == ("display", "text", "locale", "@id")):
            if _changed(row, move.locale(move.old), move.locale(move.new)):
                locales.add(group)
        elif len(steps) == 6 and steps[4].startswith("prompt[") and steps[-1] == "@group_key":
            source = sites.builds.get((artifact, *steps[1:5]))
            if (source and source[:4] == ("menu", move.menu, "search_config", "properties")
                    and source[4].isdigit() and int(source[4]) > int(move.row)
                    and _changed(row, move.old, move.new)):
                prompts.add(query)
    return {group for group in keys & locales if group[:3] in prompts}


def _build(difference, rows, sites, move):
    profile, slash, artifact = difference.artifact.rpartition("/")
    suite = f"{profile}/suite.xml" if slash else "suite.xml"
    queries = _query_sites(rows, suite, sites, move)
    if not queries:
        return False
    if artifact == "suite.xml":
        steps = changes._xml_steps(difference.at)
        if len(steps) < 6:
            return False
        group = tuple(steps[1:5])
        if group in queries:
            return (
                (steps[5:] == ["@key"] and _changed(difference, move.old, move.new))
                or (tuple(map(changes._without_position, steps[5:])) == ("display", "text", "locale", "@id")
                    and _changed(difference, move.locale(move.old), move.locale(move.new)))
            )
        if not any(query[:3] == group[:3] for query in queries):
            return False
        prompt = sites.builds.get((suite, *group))
        return (
            steps[4].startswith("prompt[") and steps[5:] == ["@group_key"]
            and prompt is not None and prompt[:4] == ("menu", move.menu, "search_config", "properties")
            and prompt[4].isdigit() and int(prompt[4]) > int(move.row)
            and _changed(difference, move.old, move.new)
        )
    if not artifact.startswith("app_strings:"):
        return False
    locale_rows = [row for row in rows if row.artifact == difference.artifact]
    old, new = f"/{move.locale(move.old)}", f"/{move.locale(move.new)}"
    if not _same_text(locale_rows, old, new):
        return False
    if difference.at in (old, new):
        return difference.kind == ("removed" if difference.at == old else "added")
    old, new = f"{old}.hint", f"{new}.hint"
    return (
        difference.at in (old, new)
        and difference.kind == ("removed" if difference.at == old else "added")
        and _same_text(locale_rows, old, new, empty=True)
    )


def formplayer_body(path):
    """The query payload and exact data-map/rendered-prompt member observed at this step."""
    if path[:1] != ["response"]:
        return None
    cut = 2 if path[1:2] == ["queryResponse"] else 1
    tail = path[cut:]
    if (len(tail) == 2 and tail[0] == "groupHeaders") or (
        len(tail) == 3 and tail[0] == "displays" and tail[1].isdigit() and tail[2] == "groupKey"
    ):
        return cut, tail
    return None


def formplayer_site(response, path):
    matched = formplayer_body(path)
    if not matched:
        return None
    payload = response.get("queryResponse") if matched[0] == 2 else response
    if not isinstance(payload, dict) or payload.get("type") != "query":
        return None
    key = payload.get("queryKey")
    if not isinstance(key, str):
        return None
    command, separator, datum = key.partition("_")
    # HQ's search command is itself spelled search_command.m<menu>.
    if command == "search" and datum.startswith("command.m"):
        suffix, separator, datum = datum.partition("_")
        command = f"search_{suffix}"
    owner = changes.command_place(command)
    if not owner or not separator or not datum:
        return None
    return ("menu", owner[1].split(".")[0], "search_config", "request", key)


def _formplayer(difference, rows, sites, move):
    path = changes.unescaped(difference.at)
    place = sites.served.get((difference.artifact, difference.at))
    matched = formplayer_body(path[4:])
    if not matched or not place or place[:4] != ("menu", move.menu, "search_config", "request"):
        return False
    pointer = difference.at.split("/")
    prefix = "/".join(pointer[:5 + matched[0]])
    siblings = [
        row for row in rows if row.artifact == difference.artifact and row.at.startswith(prefix + "/")
        and sites.served.get((row.artifact, row.at)) == place
    ]
    old, new = (f"{prefix}/groupHeaders/{key}" for key in (move.old, move.new))
    if not _same_text(siblings, old, new):
        return False
    members = [
        row for row in siblings if row.at.startswith(prefix + "/displays/")
        and row.at.endswith("/groupKey") and _changed(row, move.old, move.new)
    ]
    return bool(members) and (
        difference in members or difference.at == old and difference.kind == "removed"
        or difference.at == new and difference.kind == "added"
    )


def holds(difference, places, siblings, sites):
    rows = [row for row in siblings if row.check == difference.check and row.document == difference.document]
    if difference.check == "proof2":
        return any(_build(difference, rows, sites, move) for move in _moves(places))
    if difference.artifact in ("formplayer@B", "formplayer@local.ccz"):
        return any(_formplayer(difference, rows, sites, move) for move in _moves(places))
    return False
