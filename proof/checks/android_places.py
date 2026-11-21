"""Where a witnessed Android question, location prompt or saved fix stands in a form Nova read.

The form belongs to the session command at this exact FormEntryActivity step (Screens.session).
Each question widget reports its prompt's own TreeReference on both the first and the answered screen
(Forms.questions); the form supplies its actual language, including on a walk in the default language.
"""

from proof.checks import changes, served_datetimes, xform_parts


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


def locations(differences, trace, form_namespaces=None, *, writes_at=None):
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
            "/walks/*/steps/*/form/saved/records/*/metaLocation:location",
        )
        saved_time = writes_at is not None and difference.path == served_datetimes.CASES and served_datetimes.candidate(difference)
        if not (question or gps or saved_time):
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
        if saved_time:
            prop = served_datetimes.saved_property(difference)
            cases = (form.get("saved") or {}).get("cases") or []
            matching = [c for c in cases if isinstance(c, dict) and c.get("id") == rest[-1]]
            # Android records the entire installed case store after a save. Only the case that
            # EntitySelectActivity actually handed this form can witness its direct update.
            index = int(path[3])
            prior = walk["steps"][index - 1] if index else {}
            selected = prior.get("session") or {}
            if (prop and len(matching) == 1 and matching[0].get("type") == prop[0]
                    and selected.get("command") == step["session"].get("command")
                    and selected.get("datum") == "case_id" and (prior.get("list") or {}).get("chose") == rest[-1]
                    and prop in writes_at(owner[1])):
                # Keep the writer in the witness until both sides and all configurations have agreed.
                found[key] = (*owner, "case", *prop)
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
