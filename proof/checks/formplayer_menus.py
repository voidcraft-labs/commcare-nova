"""Locate a Formplayer root choice in the same build's named menu.

Formplayer's CommandListResponseBean and the Core runner's SessionOp both enumerate MenuScreen.getMenuDisplayables().
Formplayer reports the index and displayed text. Core also records the command id. A different language may change
the text, so compare the entire root chooser against the suite's actual menu-name resources in the requested locale.
"""

import zipfile

from proof.checks.changes import command_place, unescaped
from proof.checks.compare.app_strings import parse_app_strings
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml

DISPLAY = "/runs/*/steps/*/response/commands/*/displayText"
TRIMMED = DISPLAY + ":trimmed"
# heldText.ts::javaTrim drops just the characters Java's String.trim() drops.
JAVA_TRIM = "".join(chr(code) for code in range(0x21))


def trimmed(difference):
    return (
        difference.artifact in ("formplayer@B", "formplayer@local.ccz")
        and difference.path in (DISPLAY, TRIMMED)
        and difference.kind == "changed"
        and isinstance(difference.before, str)
        and difference.before != difference.after
        and difference.before.strip(JAVA_TRIM) == difference.after
    )


def is_trimmed_menu(difference, location):
    return (
        trimmed(difference)
        and difference.path == DISPLAY
        and len(location or ()) == 3
        and location[0] == "menu"
        and location[2] == "name"
    )


def archive_files(path):
    with zipfile.ZipFile(path) as archive:
        return {
            entry: archive.read(entry)
            for entry in archive.namelist()
            if entry == "suite.xml" or entry.endswith("/app_strings.txt")
        }


def _root_commands(core, files):
    """One consistent set of root offers, all plain menus displaying their own name's locale key."""
    offers = {
        tuple(item.get("command") for item in step.get("choices") or ())
        for run in core.get("runs") or ()
        for step in run.get("trace") or ()
        if step.get("screen") == "menu" and step.get("root") == "root"
    }
    if len(offers) != 1 or "suite.xml" not in files:
        return ()
    (commands,) = offers
    try:
        suite = parse_xml(files["suite.xml"])
    except XmlNotWellFormed:
        return ()
    names = []
    for menu in suite.findall("menu"):
        command = menu.get("id", "")
        if menu.get("root", "root") != "root":
            continue
        place = command_place(command)
        text = menu.find("text")
        if (
            place[:1] != ("menu",)
            or command != "m" + place[1]
            or text is None
            or text.attrib
            or len(text) != 1
            or text[0].tag != "locale"
            or text[0].attrib != {"id": "modules." + command}
            or len(text[0])
        ):
            return ()
        names.append(command)
    return commands if len(set(names)) == len(names) == len(commands) and set(names) == set(commands) else ()


def locations(differences, trace, core, files, release_differs, *, before):
    """Concrete places for the observed side. A missing, ambiguous or mismatching record gives no place."""
    commands = _root_commands(core, files)
    if not commands or "suite.xml" in release_differs:
        return {}
    strings = {}
    found = {}
    runs = trace.get("runs") or ()
    for d in differences:
        path = unescaped(d.at)
        if not trimmed(d) or len(path) != 8 or not all(path[n].isdigit() for n in (1, 3, 6)):
            continue
        run, number, index = (int(path[n]) for n in (1, 3, 6))
        if run >= len(runs) or number >= len(runs[run]["steps"]) or index >= len(commands):
            continue
        step = runs[run]["steps"][number]
        request, response = step.get("request") or {}, step.get("response") or {}
        if (
            request.get("selections") != []
            or response.get("selections") != []
            or response.get("type") != "commands"
            or response.get("menuTitle") is not None
            or len(response.get("breadcrumbs") or ()) != 1
        ):
            continue
        locale = request.get("locale") or trace.get("locale")
        resource = f"{locale}/app_strings.txt"
        if resource not in files or resource in release_differs:
            continue
        if locale not in strings:
            strings[locale] = parse_app_strings(files[resource])
        names = [strings[locale].get("modules." + command) for command in commands]
        offered = response.get("commands") or ()
        texts = [choice.get("displayText") for choice in offered]
        if (
            texts != names
            or any(not text for text in texts)
            or len(set(texts)) != len(texts)
            or [choice.get("index") for choice in offered] != list(range(len(commands)))
            or texts[index] != (d.before if before else d.after)
        ):
            continue
        found[(d.artifact, d.at)] = (*command_place(commands[index]), "name")
    return found
