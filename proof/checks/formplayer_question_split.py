"""Align Formplayer's answered, submitted and rendered controls across a reviewed date/time split.

Formplayer indexes questions by their position. Inserting the time widget shifts every later
index, including repeat and group children. The raw records still hold each sent value, the
server's verdict, the final tree and HQ's received instance. Compare all of them. Only a
jointly witnessed pair is read as the split the worker chose; malformed or ambiguous records
remain unchanged for the ordinary comparison.
"""

import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, time
from functools import cache

from lxml import etree

from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml, qname
from proof.checks.differences import pointer_token
from proof.checks.native_question_split import joined_nodes, unique_node
from proof.formplayer.walk import load_answer_table, questions

IX = re.compile(r"(0|[1-9]\d*)((?:_\d+)?(?:,\d+(?:_\d+)?)*)")


@cache
def _first_values():
    table = load_answer_table()["dataTypes"]
    return table["date"][0], table["time"][0]


@dataclass(frozen=True)
class Values:
    day: str
    clock: str
    displayed: str


def answer_values(clock):
    if not isinstance(clock, str):
        return None
    day, sent = _first_values()
    day = day.replace("@clock:today", clock.split("T", 1)[0])
    # Web Apps resends the time as hours and minutes after the initial HH:MM:SS.
    try:
        parsed = time.fromisoformat(sent)
        date.fromisoformat(day)
    except ValueError:
        return None
    if parsed.second or parsed.microsecond or parsed.tzinfo:
        return None
    return Values(day, sent, parsed.isoformat(timespec="minutes"))


def _instance(step):
    xml = ((step.get("response") or {}).get("instanceXml") or {}).get("output")
    if isinstance(xml, str):
        try:
            root = parse_xml(xml)
        except XmlNotWellFormed:
            return None
        return qname(root.tag)[0]


def _index(ix, extra):
    if not isinstance(ix, str) or not (parts := IX.fullmatch(ix)):
        return ix
    first = int(parts[1])
    return f"{first - sum(first >= point for point in extra)}{parts[2]}"


def _move_tree(nodes, extra):
    for node in nodes:
        if "ix" in node:
            node["ix"] = _index(node["ix"], extra)
        _move_tree(node.get("children") or (), extra)


def _match_component(old, new, path, kind, answer, ix):
    expected = {
        **old,
        "ix": str(ix),
        "binding": path,
        "question_id": path.rsplit("/", 1)[1],
        "datatype": kind,
        "answer": answer,
    }
    # A copied plain label can also be supplied in the markdown slot. Only unformatted
    # words and spaces have exactly the same rendering in both forms.
    caption = old.get("caption")
    if (
        old.get("caption_markdown") is None
        and isinstance(caption, str)
        and all(word.isalnum() for word in caption.split(" "))
        and new.get("caption_markdown") == caption
    ):
        expected["caption_markdown"] = caption
    return expected == new


def _pair(tree, target, questions, values, *, filled):
    """Each placed source widget and both newly rendered controls, before or after answering."""
    held = []
    for place in questions:
        original = [v for v in tree if v.get("binding") == place.original and v.get("datatype") == "datetime"]
        offsets = [i for i, v in enumerate(target) if v.get("binding") == place.date]
        if len(original) != 1 or len(offsets) != 1:
            return None
        old, offset = original[0], offsets[0]
        if old.get("answer") is not None or offset + 1 >= len(target):
            return None
        day, clock = target[offset : offset + 2]
        first = day.get("ix")
        if not isinstance(first, str) or not first.isdigit() or clock.get("ix") != str(int(first) + 1):
            return None
        if not (
            _match_component(old, day, place.date, "date", values.day if filled else None, int(first))
            and _match_component(old, clock, place.time, "time", values.displayed if filled else None, int(first) + 1)
        ):
            return None
        held.append((int(first), offset, old, place))
    extra = [first + 1 for first, _, _, _ in held]
    if any(_index(str(first), extra) != old["ix"] for first, _, old, _ in held):
        return None
    # Collapse the checked pair to its original question and retain sibling ordering and properties.
    for first, offset, old, _ in sorted(held, key=lambda row: row[1], reverse=True):
        target[offset : offset + 2] = [{**old, "ix": str(first)}]
    _move_tree(target, extra)
    return held


def _bound(tree, ix):
    matches = [node for node in questions(tree) if node.get("ix") == ix]
    return matches[0] if len(matches) == 1 else None


def _gestures(opening, fill):
    """Each request's actual control immediately before send and when the server returned its tree."""
    tree = opening.get("tree")
    answers, resends = fill.get("answers") or [], fill.get("resent") or []
    triggers = [row.get("after") for row in resends]
    if not isinstance(tree, list) or any(type(i) is not int or not 0 <= i < len(answers) for i in triggers):
        return None
    if triggers != sorted(triggers):
        return None
    sequence = []
    for index, primary in enumerate(answers):
        requests = [("primary", primary), *(("resend", r) for r in resends if r["after"] == index)]
        for kind, sent in requests:
            ix = sent.get("ix")
            before = _bound(tree, ix)
            if before is None:
                return None
            returned = (sent.get("response") or {}).get("tree")
            after = None
            if isinstance(returned, list):
                tree = returned
                after = _bound(tree, ix)
            sequence.append((kind, ix, before, after))
    return sequence


def _identity(node):
    return (node.get("type"), node.get("binding"), node.get("datatype"), node.get("question_id")) if node else None


def _same_gestures(open_a, fill_a, open_b, fill_b, held, values):
    target = {
        ix: pair
        for first, _, _, split in held
        for ix, pair in ((str(first), (split.date, "date")), (str(first + 1), (split.time, "time")))
    }
    extra = [first + 1 for first, _, _, _ in held]
    original, published = _gestures(open_a, fill_a), _gestures(open_b, fill_b)
    if original is None or published is None:
        return False
    # Different primary gestures trigger the same previous widget's reconciliation at the insertion.
    # Preserve order within both kinds; _answers compares each resend's precise trigger independently.
    for kind in ("primary", "resend"):
        old = [(ix, _identity(node), _identity(echo)) for action, ix, node, echo in original if action == kind]
        new = []
        for action, ix, node, echo in published:
            if action != kind:
                continue
            if ix not in target:
                new.append((_index(ix, extra), _identity(node), _identity(echo)))
                continue
            path, datatype = target[ix]
            expected = ("question", path, datatype, path.rsplit("/", 1)[1])
            if (
                _identity(node) != expected
                or _identity(echo) != expected
                or echo.get("answer") != (values.day if datatype == "date" else values.displayed)
            ):
                return False
        if old != new:
            return False
    return True


def gestures_agree(open_a, fill_a, open_b, fill_b, splits, values):
    """The full actual Formplayer input stream still addressed the same questions in the same order."""
    from proof.checks.served import _form_step

    held = _pair(open_a["tree"], deepcopy(open_b["tree"]), splits, values, filled=False)
    if not held or not _same_gestures(open_a, fill_a, open_b, fill_b, held, values):
        return False
    old, new = _form_step(fill_a), deepcopy(_form_step(fill_b))
    return _answers(old, new, held, values) and all(
        old.get(k) == new.get(k) for k in ("answers", "resent", "submitted")
    )


def _answers(old, new, held, values):
    if not all(isinstance((s.get("submitted") or {}).get("answers"), dict) for s in (old, new)):
        return False
    extra = [first + 1 for first, _, _, _ in held]
    added = {}
    for first, _, node, _ in held:
        a_ix, d_ix, t_ix = node["ix"], str(first), str(first + 1)
        old_sent, sent = old["submitted"]["answers"], new["submitted"]["answers"]
        if (
            a_ix not in old_sent
            or old_sent[a_ix] is not None
            or sent.get(d_ix) != values.day
            or sent.get(t_ix) != values.displayed
        ):
            return False
        if any(row.get("ix") == a_ix for row in old.get("answers", ())):
            return False
        added[d_ix], added[t_ix] = (values.day, False), (values.clock, True)
    # The fixed walker answers in native tree order. A refusal, duplicate or missing answer is evidence.
    # Each actual answer, resend and submit reads session_details once. Only the final submit
    # posts to HQ's receiver. Extra reads, changed views/status or a different order must remain red.
    for step in (old, new):
        requests = 1 + len(step.get("answers") or ()) + len(step.get("resent") or ())
        if step.get("asked") != [["session_details", "200"]] * requests + [["receiver_post_with_app_id", "201"]]:
            return False
    removed, seen, last = {}, [], -1
    kept = []
    for i, row in enumerate(new.get("answers") or ()):
        ix = row["ix"]
        if ix in added:
            value, is_time = added[ix]
            if row != {"ix": ix, "value": value, "status": "accepted", "reason": None, "type": None}:
                return False
            if is_time and (not seen or seen[-1] != str(int(ix) - 1) or i != last + 1):
                return False
            removed[ix], last = i, i
            seen.append(ix)
        else:
            kept.append({**row, "ix": _index(ix, extra)})
    # Adjacent reviewed splits have the same number of ordinary gestures before them. Their
    # complete ordered pairs must still follow the source question order rendered by Formplayer.
    expected_order = [str(ix) for first, _, _, _ in sorted(held, key=lambda row: row[0]) for ix in (first, first + 1)]
    if seen != expected_order:
        return False
    for first, _, original, _ in held:
        # The two gestures must occur where the unanswered original stood. Preserve a second
        # attempt after a later question (conditional forms) as an observable change.
        orig = int(original["ix"])
        order = [IX.fullmatch(row["ix"]) for row in old["answers"]]
        if not all(order):
            return False
        earlier = [int(match[1]) < orig for match in order]
        insertion = removed[str(first)]
        if earlier != sorted(earlier, reverse=True) or insertion - sum(i < insertion for i in removed.values()) != sum(
            earlier
        ):
            return False
    new["answers"] = kept
    # For each unchanged resend, preserve its exact triggering native gesture. When it reconciled
    # the immediately preceding answer, the first inserted gesture following that answer must trigger it.
    primary = [i for i in range(len(kept) + len(removed)) if i not in removed.values()]
    expected = iter(old.get("resent") or [])
    resends = []
    special_triggers = {removed[ix] + 1 for ix, (_, is_time) in added.items() if is_time}
    expected_resends = {ix for ix, (_, is_time) in added.items() if is_time}
    for row in new.get("resent") or ():
        ix, after = row["ix"], row["after"]
        if ix in added:
            if ix not in expected_resends or row != {
                "ix": ix,
                "value": values.displayed,
                "status": "accepted",
                "reason": None,
                "type": None,
                "after": removed[ix] + 1,
            }:
                return False
            expected_resends.remove(ix)
        else:
            original = next(expected, None)
            if original is None or not 0 <= original["after"] < len(primary):
                return False
            trigger = original["after"]
            prior = trigger - 1
            expected_after = (
                primary[prior] + 1 if prior >= 0 and old["answers"][prior]["ix"] == original["ix"] else primary[trigger]
            )
            if after in special_triggers or after != expected_after:
                return False
            resends.append({**row, "ix": _index(ix, extra), "after": trigger})
    if expected_resends or next(expected, None) is not None:
        return False
    new["resent"] = resends
    new["asked"] = old["asked"]
    second = {str(first + 1) for first, _, _, _ in held}
    new["submitted"]["answers"] = {
        _index(ix, extra): (None if ix in added else value)
        for ix, value in new["submitted"]["answers"].items()
        if ix not in second
    }
    return True


def _xml(old_xml, new_xml, namespaces, questions, values, *, filled):
    try:
        old, new = parse_xml(old_xml), parse_xml(new_xml)
    except (XmlNotWellFormed, TypeError):
        return None
    if (qname(old.tag)[0], qname(new.tag)[0]) != namespaces:
        return None

    for split in questions:
        original = unique_node(old, split.original)
        inserted = joined_nodes(new, split.original, split.date, split.time)
        if original is None or inserted is None:
            return None
        day, clock, joined = inserted
        if any(len(node) or node.attrib for node in (*inserted, original)) or original.text:
            return None
        if any((node.tail or "").strip(" \t\r\n") for node in (day, clock)):
            return None
        old_neighbors = [qname(node.tag)[1] for node in original.getparent() if isinstance(node.tag, str)]
        new_neighbors = [qname(node.tag)[1] for node in joined.getparent() if isinstance(node.tag, str)]
        shared = set(old_neighbors) & set(new_neighbors)
        if [k for k in old_neighbors if k in shared] != [k for k in new_neighbors if k in shared]:
            return None
        answer = values.day + "T" + values.clock + ".000Z" if filled else None
        if (joined.text, day.text, clock.text) != (
            answer,
            values.day if filled else None,
            values.clock + ".000" if filled else None,
        ):
            return None
        day.getparent().remove(day)
        clock.getparent().remove(clock)
        joined.text = original.text
    return etree.tostring(new, encoding="unicode")


def align(before, after, *, splits, raw):
    """Align only a paired run whose generated controls, actual input and final received instance all agree."""
    sites = {}
    values = answer_values(before.get("clock")) if splits and before.get("clock") == after.get("clock") else None
    if values is None:
        return sites
    for ri, (old_run, new_run) in enumerate(zip(before.get("runs", ()), after.get("runs", ()))):
        if old_run.get("script") != new_run.get("script"):
            continue
        old_steps, new_steps = old_run.get("steps", ()), new_run.get("steps", ())
        for i in range(min(len(old_steps), len(new_steps)) - 1):
            a, b = old_steps[i : i + 2]
            c, d = deepcopy(new_steps[i : i + 2])
            ns = (_instance(a), _instance(c))
            matches = [
                (pos, form) for pos, form in splits.items() if ns == (form.before_namespace, form.after_namespace)
            ]
            if len(matches) != 1 or "tree" not in b or "tree" not in d:
                continue
            pos, form = matches[0]
            old_open, new_open = a["response"], c["response"]
            start = _pair(old_open["tree"], new_open["tree"], form.questions, values, filled=False)
            end = _pair(b["tree"], d["tree"], form.questions, values, filled=True)
            if not start or not end or [(v[0], v[3]) for v in start] != [(v[0], v[3]) for v in end]:
                continue
            raw_a, raw_b = (side["runs"][ri]["steps"] for side in raw)
            if not _same_gestures(raw_a[i]["response"], raw_a[i + 1], raw_b[i]["response"], raw_b[i + 1], end, values):
                continue
            if not _answers(b, d, end, values):
                continue
            # These structures use positional pointers. Keep the original pointers whenever another
            # widget or gesture differs, so its independently determined site still reads the right raw row.
            if old_open["tree"] != new_open["tree"] or any(
                b.get(key) != d.get(key) for key in ("tree", "answers", "resent", "submitted")
            ):
                continue
            opening = _xml(
                old_open["instanceXml"]["output"],
                new_open["instanceXml"]["output"],
                ns,
                form.questions,
                values,
                filled=False,
            )
            originals, submissions = b.get("submissions") or [], d.get("submissions") or []
            if not opening or len(originals) != 1 or len(submissions) != 1:
                continue
            submission = _xml(
                originals[0]["instance"], submissions[0]["instance"], ns, form.questions, values, filled=True
            )
            if submission is None:
                continue
            new_open["instanceXml"]["output"] = opening
            submissions[0]["instance"] = submission
            new_steps[i : i + 2] = c, d
            for item in form.questions:
                # Keep the reviewed worker-visible difference in the register while ordinary comparison
                # checks everything else in the two complete native records.
                old_run.setdefault("reviewedDateTime", {})[item.original] = "unanswered datetime"
                new_run.setdefault("reviewedDateTime", {})[item.original] = f"{values.day} {values.displayed}"
                sites[f"/runs/{ri}/reviewedDateTime/{pointer_token(item.original)}"] = (
                    "form",
                    pos,
                    "xform",
                    *item.original.split("/")[1:],
                )
    return sites
