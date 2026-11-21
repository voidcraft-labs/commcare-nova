"""Locate HQ's blank sort header in the retained app and in both installed short details."""

from functools import cache

from proof.checks import android, changes
from proof.checks.compare.xml_tree import XmlNotWellFormed, compare_xml_trees, parse_xml

NBSP = "\u00a0"


def _one(items):
    return items[0] if len(items) == 1 else None


def _detail(files, menu):
    """The case selection detail the commands in this installed menu actually use."""
    if not files or not files.get("suite.xml"):
        return None
    try:
        suite = parse_xml(files["suite.xml"])
    except XmlNotWellFormed:
        return None
    command = "m" + menu
    offered = _one([node for node in suite.findall("menu") if node.get("id") == command])
    if offered is None:
        return None
    commands = {item.get("id") for item in offered.findall("command")}
    details = {
        datum.get("detail-select")
        for entry in suite.findall("entry")
        if any(node.get("id") in commands for node in entry.findall("command"))
        for datum in entry.findall("session/datum[@id='case_id']")
    }
    if details != {f"{command}_case_short"}:
        return None
    return _one([detail for detail in suite.findall("detail") if detail.get("id") in details])


def _blank_resource(files, key, differing):
    """HQ writes an explicitly blank default as NBSP. Accept only that exact locale line or its fallback."""
    if "default/app_strings.txt" not in files:
        return False
    for path, content in files.items():
        if not path.endswith("/app_strings.txt"):
            continue
        if path in differing:
            return False
        text = content.decode("utf-8") if isinstance(content, bytes) else content
        values = [line.partition("=")[2] for line in text.splitlines() if line.partition("=")[0] == key]
        if (values or path == "default/app_strings.txt") and values != [NBSP]:
            return False
    return True


def _blank_option(app, menu, before_files, after_files, differing):
    """The single active source sort and its Android label, where both installed suites prove the change."""
    modules = app.get("modules") or []
    if int(menu) >= len(modules) or "suite.xml" in differing:
        return None
    short = (modules[int(menu)].get("case_details") or {}).get("short") or {}
    columns = short.get("columns") or []
    sort = _one(short.get("sort_elements") or [])
    if not sort or not isinstance(key := sort.get("field"), str):
        return None
    # Two columns for this property would leave its joined sort ambiguous.
    index = _one([i for i, column in enumerate(columns) if column.get("field") == key])
    if index is None:
        return None
    column = columns[index]
    if column.get("model") != "case" or column.get("format") != "invisible" or column.get("useXpathExpression"):
        return None
    headers = column.get("header")
    if (
        not isinstance(headers, dict)
        or not headers
        or any(not isinstance(v, str) or v.strip() for v in headers.values())
    ):
        return None
    display = sort.get("display")
    if (
        sort.get("sort_calculation")
        or not isinstance(display, dict)
        or not any(isinstance(v, str) and v.strip() for v in display.values())
    ):
        return None

    old, new = (_detail(files, menu) for files in (before_files, after_files))
    if old is None or new is None:
        return None
    fields, later = old.findall("field"), new.findall("field")
    if (
        index >= len(fields)
        or len(fields) != len(later)
        or any(len(detail.findall("field/sort[@order]")) != 1 for detail in (old, new))
    ):
        return None
    a, b = fields[index], later[index]
    head = a.find("header")
    label = a.find("header/text/locale")
    template, order = a.find("template"), a.find("sort")
    if (
        head is None
        or head.attrib != {"width": "0"}
        or label is None
        or template is None
        or template.get("width") != "0"
        or order is None
        or order.get("order") != "1"
        or order.get("direction") != sort.get("direction")
        or order.get("type") != sort.get("type")
        or order.get("blanks", "last") != sort.get("blanks", "last")
        or any(
            node is None or node.attrib != {"function": key}
            for node in (template.find("text/xpath"), order.find("text/xpath"))
        )
    ):
        return None
    locale_key = f"m{menu}.case_short.case_{key}_{index + 1}.header"
    if label.attrib != {"id": locale_key} or not _blank_resource(before_files, locale_key, differing):
        return None
    # Everything else in the field, including the order expression and blank placement, must be unchanged.
    # Work on the freshly parsed suite; no shared or retained artifact is modified.
    label.getparent().remove(label)
    new_text = b.find("header/text")
    if (
        new_text is None
        or len(new_text)
        or new_text.text
        or compare_xml_trees(a, b, check="proof3", document="", artifact="suite.xml")
    ):
        return None
    prefix = {"ascending": "(^) ", "descending": "(v) "}.get(sort.get("direction"))
    if prefix:
        return ("menu", menu, "case_details", "short", "sort_elements", "0", "display"), prefix + NBSP
    return None


OPTIONS = "/walks/*/steps/*/list/EntitySelectActivity.getSortOptionsList"
SORTED = "/walks/*/steps/*/list/sorted/*"


def candidate(difference):
    return difference.artifact.startswith(("android@", "android-tablet@")) and (
        (difference.path == OPTIONS and difference.kind == "changed")
        or (difference.path == SORTED and difference.kind == "removed")
    )


def _list(device, walk, index):
    steps = ((device.get("walks") or {}).get(walk) or {}).get("steps") or []
    if not index.isdecimal() or int(index) >= len(steps):
        return None, None
    step = steps[int(index)]
    session = step.get("session") or {}
    place = changes.command_place(session.get("command"))
    if (
        step.get("screen") != "EntitySelectActivity"
        or session.get("datum") != "case_id"
        or place[:1] != ("menu",)
        or session.get("command") != f"m{place[1]}"
    ):
        return None, None
    return place[1], step.get("list")


def _first_text(view):
    # Lists.firstCells reads the first TextView of each actual row, in child order (Lists.firstText).
    if "text" in view:
        return view["text"]
    for child in view.get("children") or []:
        text = _first_text(child)
        if text is not None:
            return text
    return None


def _removed_order(before, after, blank):
    options = "EntitySelectActivity.getSortOptionsList"
    old, new = before.get(options), after.get(options)
    if (
        not isinstance(old, list)
        or len(set(old)) != len(old)
        or blank not in old
        or [name for name in old if name != blank] != new
    ):
        return None
    sorted_before, sorted_after = before.get("sorted"), after.get("sorted")
    if (
        not isinstance(sorted_before, list)
        or not isinstance(sorted_after, list)
        or [s.get("option") for s in sorted_before] != old
        or [s.get("option") for s in sorted_after] != new
        or [s for s in sorted_before if s["option"] != blank] != sorted_after
    ):
        return None
    removed = sorted_before[old.index(blank)]
    # On this walk the removed choice produced the default order, which both builds still show. Compare all
    # first cells to both native lists and retain the case IDs in that order, including ties in the displayed text.
    rows = removed.get("rows")
    ids = before.get("order")
    if (
        not isinstance(rows, list)
        or removed != {"option": blank, "rows": rows}
        or not isinstance(ids, list)
        or any(not isinstance(case, str) for case in ids)
        or len(set(ids)) != len(ids)
        or len(rows) != len(ids)
        or ids != after.get("order")
        or any(
            not isinstance(held.get("rows"), list) or rows != [_first_text(row) for row in held["rows"]]
            for held in (before, after)
        )
    ):
        return None
    return rows


def locations(differences, app, before, after, before_files, after_files, *, differing=()):
    """Only the disappearance of the one annotated active sort and of its native tap result, on the same menu."""

    @cache
    def blank_option(menu):
        return _blank_option(app, menu, before_files, after_files, differing)

    found = {}
    for d in differences:
        path = changes.unescaped(d.at)
        if not candidate(d) or len(path) < 6 or path[0] != "walks" or path[2] != "steps":
            continue
        menu, a = _list(before, path[1], path[3])
        other, b = _list(after, path[1], path[3])
        if menu is None or menu != other or not isinstance(a, dict) or not isinstance(b, dict):
            continue
        option = blank_option(menu)
        if option is None:
            continue
        owner, blank = option
        rows = _removed_order(a, b, blank)
        if rows is None:
            continue
        key = "EntitySelectActivity.getSortOptionsList"
        if (
            d.path == OPTIONS
            and path[4:] == ["list", key]
            and d.before == android._joined(a[key])
            and d.after == android._joined(b[key])
        ) or (
            d.path == SORTED
            and path[4:] == ["list", "sorted", blank]
            and d.before == android._joined(rows)
            and d.after is None
        ):
            found[d.artifact, d.at] = owner
    return found
