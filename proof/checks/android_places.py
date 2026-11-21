"""Where a witnessed Android question, location prompt or saved fix stands in a form Nova read.

The form belongs to the session command at this exact FormEntryActivity step (Screens.session).
Each question widget reports its prompt's own TreeReference on both the first and the answered screen
(Forms.questions); the form supplies its actual language, including on a walk in the default language.
"""

from proof.checks import changes, xform_parts


def _at(values, index):
    return values[int(index)] if isinstance(values, list) and index.isdigit() and int(index) < len(values) else None


def _question_node(reference):
    """A concrete TreeReference has only child steps and their numeric positions. Keep their names in order."""
    if not isinstance(reference, str) or not reference.startswith("/"):
        return None
    steps = []
    for step in reference[1:].split("/"):
        name, bracket, position = step.partition("[")
        if bracket and not (position.endswith("]") and position[:-1].isdigit()):
            return None
        steps.append(name)
    return xform_parts.node_steps("/" + "/".join(steps))


def locations(differences, trace, form_namespaces=None):
    """Map the concrete differences whose observed form and owner the device identifies. An unplaced screen
    or ambiguous path provides no owning slot; a caller merging sides keeps any conflict as unknown."""
    found = {}
    for difference in differences:
        if not difference.artifact.startswith(("android@", "android-tablet@")):
            continue
        path = changes.unescaped(difference.at)
        if len(path) < 6 or path[0] != "walks" or path[2] != "steps" or path[4] != "form":
            continue
        rest = path[5:]
        question = len(rest) == 5 and rest[0] == "screens" and rest[2] in ("questions", "shown") and rest[4] == "text"
        gps = difference.path in (
            "/walks/*/steps/*/form/deviceAsked:location",
            "/walks/*/steps/*/form/deviceGave:location",
        ) or (len(rest) == 4 and rest[:2] == ["saved", "records"] and rest[2].isdigit() and rest[3] == "metaLocation")
        if not (question or gps):
            continue
        key = (difference.artifact, difference.at)
        found[key] = None
        walk = ((trace or {}).get("walks") or {}).get(path[1]) or {}
        step = _at(walk.get("steps"), path[3])
        if not isinstance(step, dict) or step.get("screen") != "FormEntryActivity":
            continue
        owner = changes.command_place((step.get("session") or {}).get("command"))
        form = step.get("form")
        if owner[:1] != ("form",) or not isinstance(form, dict):
            continue
        if gps:
            found[key] = (*owner, "xform", "data", "meta", "location")
            continue
        screen = _at(form.get("screens"), rest[1])
        widget = _at(screen.get(rest[2]), rest[3]) if isinstance(screen, dict) else None
        node = _question_node(widget.get("reference")) if isinstance(widget, dict) else None
        language = form.get("language")
        if node and isinstance(language, str) and language:
            found[key] = (*owner, "xform", *node, ":itext", "label", language, "default")
    return found
