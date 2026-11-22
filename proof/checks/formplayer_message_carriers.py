"""Locate Formplayer's changed trigger index after a reviewed, permanently irrelevant message carrier.

PromptToJson writes the binding and FormIndex separately. Web Apps submits each label as "OK" at its
FormIndex. Keep the original rows and their concrete pointers, classifying only the complete three-row
move proved by both installed bodies, the question trees and the two submissions.
"""

from collections import Counter, defaultdict
from dataclasses import replace
from functools import cache

from proof.checks import changes, served
from proof.checks.manifest_value_classes import XFORMS, XHTML

TREE = "/runs/*/steps/*/tree/*/ix"
ANSWERS = "/runs/*/steps/*/submitted/answers/"
SUFFIX = ":reviewed-message-index"


def _body(form):
    body = form.root.find(f"{{{XHTML}}}body")
    if body is None:
        return []
    return [(child.tag, child.get("ref")) for child in body if isinstance(child.tag, str)]


def _shift(old, new, helper):
    """The top-level trigger indices when this carrier alone was inserted into the control order."""
    before, after = _body(old), _body(new)
    carrier = (f"{{{XFORMS}}}input", "/data/" + helper)
    if after.count(carrier) != 1:
        return {}
    i = after.index(carrier)
    if before != after[:i] + after[i + 1 :] or any(not ref for _, ref in before):
        return {}
    counts = Counter(ref for _, ref in before)
    return {
        ref: (str(index), str(index + 1))
        for index, (tag, ref) in enumerate(before)
        if index >= i and tag == f"{{{XFORMS}}}trigger" and counts[ref] == 1
    }


def _labels(old, new, shifts):
    """Both successful requests used the same binding and OK for the same trigger at the same visible position."""
    if not shifts or any(
        (step.get("submit") or {}).get("status") != "success"
        or (step.get("submitted") or {}).get("prevalidated") is not True
        for step in (old, new)
    ):
        return
    left, right = (served._form_step(step).get("tree") or [] for step in (old, new))
    bindings = [n.get("binding") for n in left]
    if len(set(bindings)) != len(bindings) or bindings != [n.get("binding") for n in right]:
        return
    if any(len({n.get("ix") for n in nodes}) != len(nodes) for nodes in (left, right)):
        return
    given_a, given_b = (step["submitted"].get("answers") or {} for step in (old, new))
    for i, (a, b) in enumerate(zip(left, right, strict=True)):
        old_ix, new_ix = a.get("ix"), b.get("ix")
        if (
            shifts.get(a.get("binding")) == (old_ix, new_ix)
            and (a.get("type"), a.get("control"), a.get("datatype")) == ("question", 9, "info")
            and b == {**a, "ix": new_ix}
            and given_a.get(old_ix) == given_b.get(new_ix) == "OK"
            and old_ix not in given_b
            and new_ix not in given_a
        ):
            yield i, old_ix, new_ix


def shifted_triggers(rows, sites, old_forms, new_forms, before_trace, after_trace):
    openings = defaultdict(list)
    for row in rows:
        if row.path.endswith(":reviewed-message"):
            at = changes.unescaped(row.at)
            openings[row.artifact, int(at[1]), int(at[3])].append(sites[row.artifact, row.at])
    if not openings:
        return sites, rows

    layout = cache(lambda pos, name: _shift(old_forms[pos], new_forms[pos], name))
    by_at = {(row.artifact, row.at): row for row in rows}
    classes = {}
    for (artifact, run, opening), owners in openings.items():
        if len(owners) != 1:
            continue
        owner = owners[0]
        old, new = (t["runs"][run]["steps"] for t in (before_trace, after_trace))
        fill = opening + 1
        if fill >= min(len(old), len(new)):
            continue
        for i, old_ix, new_ix in _labels(old[fill], new[fill], layout(owner[1], owner[-1])):
            prefix = f"/runs/{run}/steps/{fill}"
            expected = [
                (f"/tree/{i}/ix", TREE, "changed", old_ix, new_ix),
                (
                    "/submitted/answers/" + old_ix,
                    ANSWERS + old_ix,
                    "removed",
                    "OK",
                    None,
                ),
                ("/submitted/answers/" + new_ix, ANSWERS + new_ix, "added", None, "OK"),
            ]
            moves = {}
            for at, path, kind, a, b in expected:
                key = (artifact, prefix + at)
                found = by_at.get(key)
                if found and (found.path, found.kind, found.before, found.after) == (
                    path,
                    kind,
                    a,
                    b,
                ):
                    moves[key] = (TREE if path == TREE else ANSWERS + "*") + SUFFIX
            if len(moves) == len(expected):
                sites.update(dict.fromkeys(moves, owner))
                classes.update(moves)
    return sites, [
        replace(row, path=classes[row.artifact, row.at]) if (row.artifact, row.at) in classes else row for row in rows
    ]
