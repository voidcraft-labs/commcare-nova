"""Compare a reviewed date-and-time split at the FormEntryActivity and TreeReferences the device observed."""

from datetime import date, datetime, time
from functools import lru_cache

from proof.checks import changes

PLACE_PATH = "/walks/*/steps/*/form/dateTimeSplit"


def _binding(reference):
    """The named nodes of a device's concrete TreeReference. Keep the occurrence in its comparison key."""
    if not isinstance(reference, str) or not reference.startswith("/data/"):
        return None
    nodes = []
    for step in reference[1:].split("/"):
        name, bracket, occurrence = step.partition("[")
        if not name or "]" in name:
            return None
        if bracket and not (
            occurrence.endswith("]")
            and occurrence[:-1].isascii()
            and occurrence[:-1].isdigit()
            and int(occurrence[:-1]) > 0
        ):
            return None
        nodes.append(name)
    return "/" + "/".join(nodes)


def _references(reference, split):
    if _binding(reference) != split.original:
        return None
    # Split controls are siblings of the original in the same repeat occurrence.
    parent, _, field = reference.rpartition("/")
    original_parent = split.original.rpartition("/")[0]
    if any(path.rpartition("/")[0] != original_parent for path in (split.date, split.time)):
        return None
    _, bracket, occurrence = field.partition("[")
    return tuple(f"{parent}/{path.rpartition('/')[2]}{bracket}{occurrence}" for path in (split.date, split.time))


@lru_cache(maxsize=1)
def _answers():
    """Forms.answer takes the first accepted value from the device's table. Only its first try is witnessed."""
    from proof.core.client import DEFAULT_CLOCK, load_answer_table

    kinds = load_answer_table()["dataTypes"]
    clock = {"@clock:today": DEFAULT_CLOCK[:10], "@clock:now": DEFAULT_CLOCK}
    # Forms.questions records getDisplayText(), the three Core data types' FORMAT_HUMAN_READABLE_SHORT.
    result = []
    for kind, read, fmt in (
        ("dateTime", datetime.fromisoformat, "%d/%m/%y %H:%M"),
        ("date", date.fromisoformat, "%d/%m/%y"),
        ("time", time.fromisoformat, "%H:%M"),
    ):
        given = clock.get(kinds[kind][0], kinds[kind][0])
        result.append((given, read(given.replace("Z", "+00:00")).strftime(fmt)))
    return result


def _screen(screen, reference, widget, answer):
    """An ordinary single-question screen. Every reported property is checked, including refusal and alert."""
    given, shown = answer
    prompts = screen.get("questions")
    if not isinstance(prompts, list) or len(prompts) != 1 or not isinstance(prompts[0], dict):
        return None
    text, required = prompts[0].get("text"), prompts[0].get("required")
    if not isinstance(text, str) or not isinstance(required, bool):
        return None
    prompt = {"reference": reference, "widget": widget, "required": required, "text": text}
    expected = {
        "event": "QUESTION",
        "index": reference,
        "alert": None,
        "questions": [{**prompt, "answer": None}],
        "answered": [{"reference": reference, "given": given}],
        "shown": [{**prompt, "answer": shown}],
    }
    if screen != expected or screen["shown"][0]["required"] is not required:
        return None
    return text, required


def _witness(original, targets, references):
    if len(targets) != 2:
        return False
    answers = _answers()
    old = _screen(original, original["index"], "DateTimeWidget", answers[0])
    return old is not None and all(
        _screen(screen, ref, widget, answer) == old
        for screen, ref, widget, answer in zip(
            targets, references, ("DateWidget", "TimeWidget"), answers[1:], strict=True
        )
    )


def _form_place(step):
    if step.get("screen") != "FormEntryActivity" or (step.get("form") or {}).get("loaded") is not True:
        return None
    command = (step.get("session") or {}).get("command")
    if isinstance(command, str):
        owner = changes.command_place(command)
        if owner[:1] == ("form",):
            return owner[1]
    return None


def align(before, after, splits, paths):
    """Keep the raw joined and paired screens as one change and compare every other screen at its original
    reference. An additional path change still reports the full original paths. The shared screens remain
    comparable in that case too, including screens reached after a moved sibling."""
    position = _form_place(before)
    form_split = splits.get(position)
    if not form_split or _form_place(after) != position:
        return None
    forms = (before["form"], after["form"])
    a, b = (form.get("screens") for form in forms)
    if not all(
        isinstance(screens, list) and all(isinstance(s, dict) and isinstance(s.get("index"), str) for s in screens)
        for screens in (a, b)
    ):
        return None
    if any(len({s["index"] for s in screens}) != len(screens) for screens in (a, b)):
        return None
    by_binding = {q.original: q for q in form_split.questions}
    positions = {screen["index"]: index for index, screen in enumerate(b)}
    joined, paired, renamed, times = {}, {}, {}, set()
    for screen in a:
        ref = screen["index"]
        split = by_binding.get(_binding(ref))
        if not split or ref in positions:
            continue
        references = _references(ref, split)
        if not references or references[0] not in positions:
            return None
        index = positions[references[0]]
        targets = b[index : index + 2]
        if references[0] in renamed or references[1] in times or not _witness(screen, targets, references):
            return None
        joined[ref], paired[ref] = screen, targets
        renamed[references[0]] = ref
        times.add(references[1])
    if not joined:
        return None
    order_a = [(s.get("event"), s["index"]) for s in a]
    order_b = [(s.get("event"), renamed.get(s["index"], s["index"])) for s in b if s["index"] not in times]
    common = set(order_a) & set(order_b)

    def project(step, screens, changes_by_reference, excluded, path):
        siblings = {
            s["index"]: s for s in screens if s["index"] not in excluded and (s.get("event"), s["index"]) in common
        }
        form = {**step["form"], "screens": siblings, "dateTimeSplit": changes_by_reference}
        if order_a != order_b:
            form["path"] = path
        return {**step, "form": form}

    return (project(before, a, joined, joined, paths[0]), project(after, b, paired, renamed.keys() | times, paths[1]))


def screen_at(screens, key):
    """The unmodified record keeps a list. Aligned comparisons address siblings by concrete TreeReference."""
    if not isinstance(screens, list):
        return None
    if key.isdigit() and int(key) < len(screens):
        return screens[int(key)]
    matched = [s for s in screens if isinstance(s, dict) and s.get("index") == key]
    return matched[0] if len(matched) == 1 else None


def location(difference, trace, *, before):
    """Rejoin both receipts to the raw, ordered screens of the form actually opened by this command."""
    path = changes.unescaped(difference.at)
    if (
        difference.path != PLACE_PATH
        or difference.kind != "changed"
        or len(path) != 7
        or path[0] != "walks"
        or path[2] != "steps"
        or path[4:6] != ["form", "dateTimeSplit"]
        or not path[3].isdigit()
    ):
        return None
    walk = ((trace or {}).get("walks") or {}).get(path[1]) or {}
    steps = walk.get("steps") or []
    step = steps[int(path[3])] if int(path[3]) < len(steps) else {}
    position = _form_place(step)
    original, pair = difference.before, difference.after
    binding = _binding(path[6])
    if (
        position is None
        or not binding
        or not isinstance(original, dict)
        or original.get("index") != path[6]
        or not isinstance(pair, list)
        or len(pair) != 2
        or any(not isinstance(s, dict) for s in pair)
    ):
        return None
    # The judge made this row only with the per-build declared split. A receipt from another
    # configuration, even with the same command and path, must match this device's screen values here.
    screens = step["form"].get("screens") or []
    expected = [original] if before else pair
    matches = [i for i, s in enumerate(screens) if s.get("index") == expected[0].get("index")]
    if len(matches) == 1 and screens[matches[0] : matches[0] + len(expected)] == expected:
        return ("form", position, "xform", *binding[1:].split("/"))
    return None
