"""Relate a reviewed question's native Web Apps widgets to Formplayer's actual question bindings."""

from datetime import date

from lxml import etree

from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml
from proof.checks.differences import pointer_token
from proof.checks.formplayer_question_split import answer_values, gestures_agree
from proof.formplayer.walk import UNSUPPORTED


def _only(items):
    return items[0] if len(items) == 1 else None


def opened_form(trace, browser):
    """The Formplayer form and final answers for the same completed browser script."""
    run = _only([run for run in trace.get("runs") or [] if run.get("script") == browser.get("script")])
    if not run or run.get("end") != "submitted" or browser.get("submit") != "submitted" or "stopped" in browser:
        return None
    steps = run.get("steps") or []
    opened = _only([s["response"] for s in steps if isinstance((s.get("response") or {}).get("tree"), list)])
    filled = _only([s for s in steps if isinstance(s.get("answers"), list)])
    if not opened or not filled:
        return None
    try:
        root = parse_xml((opened.get("instanceXml") or {}).get("output") or "")
    except XmlNotWellFormed:
        return None
    return etree.QName(root).namespace, opened, filled


def _questions(tree):
    for n in tree:
        if n.get("type") == "question":
            yield n
        yield from _questions(n.get("children") or [])


def question_states(opened, filled):
    """The native opening tree and the tree after the final gesture or reconciliation."""
    from proof.checks.served import _form_step

    opened_tree = opened["tree"]
    last_tree = _form_step(filled).get("tree", opened_tree)
    return list(_questions(opened_tree)), list(_questions(last_tree))


def _pair(nodes, names, kinds):
    indices = []
    for path, kind in zip(names, kinds, strict=True):
        index = _only([i for i, q in enumerate(nodes) if q.get("binding") == path and q.get("datatype") == kind])
        if index is None:
            return None
        indices.append(index)
    return indices[0] if indices == list(range(indices[0], indices[0] + len(indices))) else None


def _rendered_date(value):
    try:
        parsed = date.fromisoformat(value)
    except (ValueError, TypeError):
        return None
    return f"{parsed.month}/{parsed.day}/{parsed.year}"


def _native_values(question, state_a, state_b, filled_a, filled_b, expected):
    old = _pair(state_a, [question.original], ["datetime"])
    new = _pair(state_b, [question.date, question.time], ["date", "time"])
    if old is None or new is None:
        return None
    original, day, clock = state_a[old], state_b[new], state_b[new + 1]
    if original.get("answer") is not None:
        return None
    # The client submits the date/time values Formplayer echoed at the exact native indices.
    sent_a = (filled_a.get("submitted") or {}).get("answers") or {}
    sent_b = (filled_b.get("submitted") or {}).get("answers") or {}
    if original["ix"] not in sent_a or sent_a[original["ix"]] is not None:
        return None
    if any(not n.get("answer") or n["answer"] != sent_b.get(n["ix"]) for n in (day, clock)):
        return None
    date_text = _rendered_date(day["answer"])
    if day["answer"] != expected.day or clock["answer"] != expected.displayed or not date_text:
        return None
    return date_text, clock["answer"]


def _screen_pair(question, native_a, native_b, web_a, web_b, *, initial, values):
    ia = _pair(native_a, [question.original], ["datetime"])
    ib = _pair(native_b, [question.date, question.time], ["date", "time"])
    if ia is None or ib is None or len(native_a) != len(web_a) or len(native_b) != len(web_b):
        return None
    old, day, clock = web_a[ia], web_b[ib], web_b[ib + 1]
    for rendered, native in (
        (old, native_a[ia]),
        (day, native_b[ib]),
        (clock, native_b[ib + 1]),
    ):
        if rendered.get("label") != native.get("caption") or rendered.get("required") != bool(native.get("required")):
            return None
    common = {k: v for k, v in old.items() if k != "answer"}
    if common.get("errors") != [] or common.get("media") != [] or not common.get("label"):
        return None
    if any({k: v for k, v in n.items() if k != "answer"} != common for n in (day, clock)):
        return None
    expected = (UNSUPPORTED, "", "") if initial else ("", *values)
    if tuple(n.get("answer") for n in (old, day, clock)) != expected:
        return None
    return ia, ib


def _align_run(a, b, native_a, native_b, spec, expected):
    _, opened_a, filled_a = native_a
    _, opened_b, filled_b = native_b
    if not gestures_agree(opened_a, filled_a, opened_b, filled_b, spec.questions, expected):
        return {}
    before, after = question_states(opened_a, filled_a), question_states(opened_b, filled_b)
    # Native indices are positional. The only permitted insertion in either snapshot is each
    # reviewed time immediately after its date at the original bound question's place. This
    # also distinguishes identical captions across different source questions.
    expansion = {q.original: (q.date, q.time) for q in spec.questions}
    if len({p for q in spec.questions for p in (q.original, q.date, q.time)}) != 3 * len(spec.questions):
        return {}
    for snapshot_a, snapshot_b in zip(before, after, strict=True):
        expected_bindings = [path for n in snapshot_a for path in expansion.get(n.get("binding"), (n.get("binding"),))]
        if expected_bindings != [n.get("binding") for n in snapshot_b]:
            return {}
    left = [s["form"] for s in a.get("screens") or [] if isinstance(s.get("form"), dict)]
    right = [s["form"] for s in b.get("screens") or [] if isinstance(s.get("form"), dict)]
    if len(left) != 2 or len(right) != 2 or a.get("viewport") != b.get("viewport"):
        return {}
    if any(
        s.get("title") != opened.get("title") for side, opened in ((left, opened_a), (right, opened_b)) for s in side
    ):
        return {}
    events = [a.get("answers") or [], b.get("answers") or []]
    if any(len(answered) != len(step["answers"]) for answered, step in zip(events, (filled_a, filled_b), strict=True)):
        return {}
    # One-question App Preview records just the first and final question on screen; its intervening
    # worker gestures are nevertheless recorded one-for-one with these Formplayer attempts.
    individual = a.get("viewport") == "preview" and all(len(s.get("questions") or []) == 1 for s in left + right)
    widgets, attempts, found = [[], []], [], {}
    for q in spec.questions:
        values = _native_values(q, before[1], after[1], filled_a, filled_b, expected)
        if not values:
            continue
        # The shared gesture check proved both indices at the real send and echo, including
        # which unchanged gesture triggered any reconciliation. Verify the browser acted on both.
        new = _pair(after[0], [q.date, q.time], ["date", "time"])
        if new is None:
            continue
        indices = {n["ix"] for n in after[0][new : new + 2]}
        hits = [i for i, gesture in enumerate(filled_b["answers"]) if gesture["ix"] in indices]
        if len(hits) != 2 or any(events[1][i] != "answered" for i in hits):
            continue
        # Only pair complete worker screens; one-page Preview has no full question array to align.
        plan = []
        if not individual:
            for phase in range(2):
                indices = _screen_pair(
                    q,
                    before[phase],
                    after[phase],
                    left[phase].get("questions") or [],
                    right[phase].get("questions") or [],
                    initial=phase == 0,
                    values=values,
                )
                if indices is None:
                    break
                plan.append(indices)
            if len(plan) != 2:
                continue
        for phase, pair in enumerate(plan):
            widgets[phase].append(pair)
        attempts.extend(hits)
        found[q.original] = "gestures" if individual else "widgets"
    for phase, pairs in enumerate(widgets):
        for ia, ib in sorted(pairs, reverse=True):
            # Both sides keep the original position and every untouched neighbor. The extra time
            # widget was checked above, including its visible label, metadata, answer and errors.
            del right[phase]["questions"][ib + 1]
            right[phase]["questions"][ib]["answer"] = left[phase]["questions"][ia]["answer"]
    for i in sorted(attempts, reverse=True):
        del events[1][i]
    return found


def align_screens(before, after, *, traces, splits):
    """Replace only independently witnessed transformations with a placed, reviewable native difference."""
    locations = {}
    if not splits or not isinstance(traces[0].get("clock"), str) or traces[0]["clock"] != traces[1].get("clock"):
        return locations
    expected = answer_values(traces[0]["clock"])
    if expected is None:
        return locations
    for i, (a, b) in enumerate(zip(before.get("runs") or [], after.get("runs") or [], strict=False)):
        if a.get("script") != b.get("script"):
            continue
        forms = [opened_form(trace, run) for trace, run in zip(traces, (a, b), strict=True)]
        if None in forms:
            continue
        source, target = forms
        candidates = [
            (pos, f) for pos, f in splits.items() if (f.before_namespace, f.after_namespace) == (source[0], target[0])
        ]
        if len(candidates) != 1:
            continue
        [(pos, spec)] = candidates
        for path, observation in _align_run(a, b, source, target, spec, expected).items():
            a.setdefault("reviewedDateTime", {})[path] = (
                "unsupported datetime" if observation == "widgets" else "no date or time gesture"
            )
            b.setdefault("reviewedDateTime", {})[path] = (
                "date and time" if observation == "widgets" else "accepted date and time gestures"
            )
            locations[f"/runs/{i}/reviewedDateTime/{pointer_token(path)}"] = (
                "form",
                pos,
                "xform",
                *path[1:].split("/"),
            )
    return locations
