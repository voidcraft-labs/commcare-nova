"""What CommCare Android made of a document's archives, judged: proofs 1, 3 and 4 over the Android stage's records.

The Android stage (``proof.android.stage``) has commcare-android's own code read every archive a device
installs of a document, and hands the answers here as one document record (``proof.android.stage
.document_record``)::

    {"local": {"app", "installs", "update"},
     "configurations": {<name>: {"A": {"app"}, "B": {"app"}, "B-edit": {"app"}, "installs", "update",
                                 "saves": {"B": [{"label", "editor", "over", "app", "update"}], "B-edit": [...]}}}}

each of ``app``, ``installs`` and ``update`` the reader's answer to that request (``proof/android/README.md``),
absent where the document has no such archive. Nothing here runs the reader: every function reads the record.

**Proof 3** (``behavior``): what a worker's device shows of Nova's local archive against HQ's build of A
(``android@local.ccz``), and of HQ's build of B against A's (``android@B``), per configuration: the install, the
profile as each of Android's readers gives it, the home screen, and every walk (``comparable_app``). And what
stands on its own of HQ's build of A (``android@A``): each search screen that sent, for an answer holding both
quote marks, the query HQ refuses (``/walks/*/steps/*/query/withAnswer/sent-unquotable-search``,
``refused_searches``).

**Proof 4** (``editability``): what a device shows of the app each editor save left against the state it was
saved over (``android@<editor>@<state>@<configuration>``), and, where the save's profile is not the one it was
saved over, what a device already on that state holds once it updates to the saved app: each of the worker's
own settings the update replaced (``/update/workerSettings/<setting>``).

**Proof 1** (``identity``): the two installs and the update of the local path against HQ's
(``android@local.ccz``: ``local.ccz`` then ``local-again.ccz`` against A then B), as ``identity_summary`` reads
them: each install's status and the apps the device then holds, whether the update was staged and installed,
and whether it is the same app at no lower a version; and, of each path alone (``android@local.ccz``,
``android@B``), each form a worker left incomplete before the update that the device no longer opens after it
(``/update/reopened/*``: before, how the device held the form; after, what it holds and shows), or whose
session, as Android itself stored it, home cannot read (``/update/reopened/*/session``).

One symptom is one difference. Two walks that opened another case at a list are compared as far as that list
(``/list/chose``), since every screen past it is of another case; a list that shows its cases in another
order is that (``/list/order``), and its rows are then compared case by case. A walk whose screens are not the
same screens in the same order is that difference, named by where the two part
(``/walks/*/screens/after-<the last screen both showed>:<the baseline's next>:<the other's next>``, each side's
whole walk its value), and its steps are not compared one against another; a form that takes another path of
screens is that (``/form/path``); a list whose rows are another kind of view is that (``/list/rowClass``); an
archive Android does not install is that (``/install``) and nothing of its app is compared. What a reader keys
by a name is compared by that name and never by position: a menu's items by their ids, a Sort choice's order by
the choice, a search's matches by its term, the cases a device holds by their ids (each case one value), the
home screen's hidden buttons by their names.

What is left out of a comparison, each because it names an install and not what a worker reads, or says again
what a reader beside it says: the app's id and version (proof 1's), the profile's stored values (each
reader's answer is compared, so a stored value no reader reads differently is no difference), the apps the
device holds, and the media check's flags beside its reader (``CommCareApp.areMMResourcesValidated``).
"""

from __future__ import annotations

import copy
import json

from proof.checks.compare.json_tree import compare_json
from proof.checks.differences import Difference, pointer_token

LOCAL = "android@local.ccz"
REPUBLISH = "android@B"
INSTALLED = "Installed"
# The maps of an app answer whose keys are the app's own (a walk's path of commands, a search's terms).
DATA_MAPS = frozenset(
    {
        "/walks",
        "/walks/*/steps/*/menu/items",
        "/walks/*/steps/*/list/rows",
        "/walks/*/steps/*/list/sorted",
        "/walks/*/steps/*/list/searches/asInstalled",
        "/walks/*/steps/*/list/searches/fuzzyOn",
        "/walks/*/steps/*/list/searches/fuzzyOff",
        "/walks/*/steps/*/query/prompts",
        "/walks/*/steps/*/query/RemoteQuerySessionManager.getRawQueryParams",
        "/walks/*/steps/*/query/withAnswer/RemoteQuerySessionManager.getRawQueryParams",
        "/walks/*/steps/*/query/withAnswer/RemoteQuerySessionManager.getErrors",
        "/walks/*/steps/*/post/params",
        "/walks/*/steps/*/form/saved/cases",
    }
)
# What names an install, never what a worker reads of it.
APP_LEFT_OUT = ("uniqueId", "versionNumber", "installedApps", "resourcesValidated")


SEPARATOR = " | "


def _joined(values) -> str:
    return SEPARATOR.join("" if value is None else str(value) for value in values)


def _list(step: dict) -> None:
    """A case list as compared: the order it shows its cases in, its Sort menu and each search's matches one
    value each, each Sort choice's order by the choice."""
    held = step.get("list")
    if not isinstance(held, dict):
        return
    if isinstance(held.get("order"), list):
        held["order"] = _joined(held["order"])
    options = held.get("EntitySelectActivity.getSortOptionsList")
    if isinstance(options, list):
        held["EntitySelectActivity.getSortOptionsList"] = _joined(options)
    if isinstance(held.get("sorted"), list):
        held["sorted"] = {
            entry["option"]: _joined(entry.get("rows") or [entry.get("raised")]) for entry in held["sorted"]
        }
    searches = held.get("searches")
    if isinstance(searches, dict):
        # Whether fuzzy search is on is the profile reader's to say (``/profile/readers``); what it finds is here.
        searches.pop("MainConfigurablePreferences.isFuzzySearchEnabled", None)
        for name in ("asInstalled", "fuzzyOn", "fuzzyOff"):
            if isinstance(searches.get(name), dict):
                searches[name] = {term: _joined(found) for term, found in searches[name].items()}


def _menu(step: dict) -> None:
    """A menu as compared: its items by their ids, and the order it shows them in as one value."""
    held = step.get("menu")
    if not isinstance(held, dict) or not isinstance(held.get("items"), list):
        return
    held["order"] = _joined(entry["id"] for entry in held["items"])
    held["items"] = {
        entry["id"]: {name: value for name, value in entry.items() if name != "id"} for entry in held["items"]
    }


def _form(step: dict) -> None:
    """A form as compared: the cases the device holds after it by their ids, each case one value (a case a form
    left otherwise is one symptom, whichever of its type, name, properties and indices say so)."""
    saved = (step.get("form") or {}).get("saved") if isinstance(step.get("form"), dict) else None
    if isinstance(saved, dict) and isinstance(saved.get("cases"), list):
        saved["cases"] = {
            entry["id"]: json.dumps(
                {name: value for name, value in entry.items() if name != "id"}, sort_keys=True, ensure_ascii=False
            )
            for entry in saved["cases"]
        }


def comparable_app(answer: dict | None) -> dict | None:
    """An ``app`` answer as it is compared (the module's last paragraphs)."""
    if answer is None:
        return None
    if answer.get("install") != INSTALLED:
        return {"install": answer.get("install")}
    found = copy.deepcopy(answer)
    # What the install alone left of the media check is the profile reader's answer after it.
    found.pop("areMMResourcesValidatedAfterInstall", None)
    profile = found.get("profile") or {}
    profile.pop("stored", None)
    for name in APP_LEFT_OUT:
        (profile.get("app") or {}).pop(name, None)
    home = found.get("home")
    if isinstance(home, dict):
        hidden = home.get("StandardHomeActivityUIController.getHiddenButtons")
        if isinstance(hidden, list):
            home["StandardHomeActivityUIController.getHiddenButtons"] = {name: True for name in hidden}
    for walk in (found.get("walks") or {}).values():
        # What the app raised is its class and its message; the frames under it name the reader's own classes.
        if isinstance(walk.get("raised"), dict):
            walk["raised"] = {name: value for name, value in walk["raised"].items() if name != "stack"}
        for step in walk.get("steps") or []:
            _list(step)
            _menu(step)
            _form(step)
    return found


def _screens(walk: dict) -> str:
    if "raised" in walk:
        return "raised"
    return _joined(step.get("screen") for step in walk.get("steps") or [])


def _parted(before: list, after: list) -> str:
    """Where two walks part, as a path names it: the last screen both showed, then what each showed next
    (``after-<screen>:<the baseline's next>:<the other's next>``, ``end`` where a walk ended there)."""
    shared = 0
    while shared < min(len(before), len(after)) and before[shared] == after[shared]:
        shared += 1
    last = before[shared - 1] if shared else "start"
    next_before = before[shared] if shared < len(before) else "end"
    next_after = after[shared] if shared < len(after) else "end"
    return f"after-{last}:{next_before}:{next_after}"


def _form_path(form) -> str | None:
    if not isinstance(form, dict) or not isinstance(form.get("screens"), list):
        return None
    return _joined(f"{screen.get('event')} {screen.get('index')}" for screen in form["screens"])


def _row_classes(held) -> str | None:
    if not isinstance(held, dict) or not isinstance(held.get("rows"), (list, dict)):
        return None
    rows = held["rows"].values() if isinstance(held["rows"], dict) else held["rows"]
    return _joined(sorted({str(row.get("class")) for row in rows}))


def _keyed_rows(held) -> dict | None:
    """A list's recorded rows by the case each is of (``order`` names every row's, the first of them recorded),
    where the list says which and no case is listed twice."""
    if not isinstance(held, dict) or not isinstance(held.get("rows"), list) or not isinstance(held.get("order"), str):
        return None
    cases = held["order"].split(SEPARATOR)[: len(held["rows"])]
    if len(cases) != len(held["rows"]) or len(set(cases)) != len(cases):
        return None
    return dict(zip(cases, held["rows"], strict=True))


def _rows_by_case(before: dict, after: dict) -> tuple[dict, dict]:
    """Two list steps whose lists show their cases in another order, each with its rows by their cases and only
    the rows both recorded: a row is compared with the row of the same case."""
    a, b = _keyed_rows(before.get("list")), _keyed_rows(after.get("list"))
    if a is None or b is None or before["list"]["order"] == after["list"]["order"]:
        return before, after
    both = set(a) & set(b)
    before = {**before, "list": {**before["list"], "rows": {case: row for case, row in a.items() if case in both}}}
    after = {**after, "list": {**after["list"], "rows": {case: row for case, row in b.items() if case in both}}}
    return before, after


def _chose(step: dict):
    return step["list"].get("chose") if isinstance(step.get("list"), dict) else None


def _to_first_other_choice(before: dict, after: dict) -> tuple[dict, dict]:
    """Two walks cut after the first list at which each opened another case: what each showed from there on
    (the case's detail, and every screen past the list) is of another case, and says nothing more of the two
    apps than the choice does (``/list/chose``)."""
    steps_a, steps_b = before.get("steps"), after.get("steps")
    if not isinstance(steps_a, list) or not isinstance(steps_b, list):
        return before, after
    for index, (a, b) in enumerate(zip(steps_a, steps_b, strict=False)):
        if a.get("screen") != b.get("screen"):
            break
        if _chose(a) != _chose(b):
            # The detail the list opened on the way is the chosen case's too.
            a = {**a, "list": {name: value for name, value in a["list"].items() if name != "detail"}}
            b = {**b, "list": {name: value for name, value in b["list"].items() if name != "detail"}}
            return {**before, "steps": [*steps_a[:index], a]}, {**after, "steps": [*steps_b[:index], b]}
    return before, after


def _one_step(before: dict, after: dict) -> tuple[dict, dict]:
    """Two steps of one screen with what would report one symptom many times reduced to that symptom: a form
    that takes another path of screens is that path (``/form/path``), a list whose rows are another kind of
    view (a tile, a plain row) is that (``/list/rowClass``), and of two lists that show their cases in another
    order (``/list/order``) each row is compared with the other list's row of the same case."""
    a, b = _form_path(before.get("form")), _form_path(after.get("form"))
    if a is not None and b is not None and a != b:
        before = {**before, "form": {**{k: v for k, v in before["form"].items() if k != "screens"}, "path": a}}
        after = {**after, "form": {**{k: v for k, v in after["form"].items() if k != "screens"}, "path": b}}
    before, after = _rows_by_case(before, after)
    a, b = _row_classes(before.get("list")), _row_classes(after.get("list"))
    if a is not None and b is not None and a != b:
        kept = ("rows", "header")
        before = {**before, "list": {**{k: v for k, v in before["list"].items() if k not in kept}, "rowClass": a}}
        after = {**after, "list": {**{k: v for k, v in after["list"].items() if k not in kept}, "rowClass": b}}
    return before, after


def one_symptom(before: dict, after: dict) -> tuple[dict, dict]:
    """The two comparable answers with each walk whose screens differ reduced to its screens, as one value,
    and each step of the others reduced as ``_one_step`` reduces it."""
    if not isinstance(before.get("walks"), dict) or not isinstance(after.get("walks"), dict):
        return before, after
    before, after = dict(before), dict(after)
    before["walks"], after["walks"] = dict(before["walks"]), dict(after["walks"])
    for name in set(before["walks"]) & set(after["walks"]):
        walk_a, walk_b = _to_first_other_choice(before["walks"][name], after["walks"][name])
        before["walks"][name], after["walks"][name] = walk_a, walk_b
        a, b = _screens(walk_a), _screens(walk_b)
        if a != b:
            parted = _parted(a.split(SEPARATOR), b.split(SEPARATOR))
            before["walks"][name], after["walks"][name] = {"screens": {parted: a}}, {"screens": {parted: b}}
        elif "steps" in walk_a and "steps" in walk_b:
            steps = [_one_step(x, y) for x, y in zip(walk_a["steps"], walk_b["steps"], strict=True)]
            before["walks"][name] = {**walk_a, "steps": [x for x, _ in steps]}
            after["walks"][name] = {**walk_b, "steps": [y for _, y in steps]}
    return before, after


def app_differences(before, after, *, check, document, artifact) -> list:
    """Every difference between what a device shows of two archives: ``before`` the baseline's ``app`` answer,
    ``after`` the other's."""
    a, b = comparable_app(before), comparable_app(after)
    if a is None or b is None:
        return []
    if a.get("install") != INSTALLED or b.get("install") != INSTALLED:
        a, b = {"install": a.get("install")}, {"install": b.get("install")}
    else:
        a, b = one_symptom(a, b)
    return compare_json(a, b, check=check, document=document, artifact=artifact, data_maps=DATA_MAPS)


# Proof 3 ------------------------------------------------------------------------------------------------------


# What Nova's suite sends in place of a search value that holds both quote marks, which no XPath string can
# hold: a function HQ's query compiler knows none of, so HQ refuses the search (finding 48).
UNQUOTABLE = "search-value-mixes-quote-marks()"
A = "android@A"


def refused_searches(answer: dict | None) -> list[tuple[str, str, dict]]:
    """Each search screen of an ``app`` answer that sent, for an answer holding both quote marks, the query HQ
    refuses, with no error of its own: ``(structural path, concrete path, what it sent and then showed)``. It
    stands on its own of one archive: Formplayer stops the same search at the screen, and a device sends it."""
    found = []
    for name, walk in sorted(((answer or {}).get("walks") or {}).items()):
        for index, step in enumerate(walk.get("steps") or []):
            probe = (step.get("query") or {}).get("withAnswer") if isinstance(step.get("query"), dict) else None
            if not probe or probe.get("RemoteQuerySessionManager.getErrors"):
                continue
            sent = (probe.get("RemoteQuerySessionManager.getRawQueryParams") or {}).get("_xpath_query") or []
            if UNQUOTABLE in sent:
                shown = (probe.get("afterServerAnswers400") or {}).get("errorText")
                at = f"/walks/{pointer_token(name)}/steps/{index}/query/withAnswer/sent-unquotable-search"
                found.append(
                    ("/walks/*/steps/*/query/withAnswer/sent-unquotable-search", at, {"sent": sent, "shown": shown})
                )
    return found


def behavior(document: str, record: dict) -> list:
    found = []
    local = (record.get("local") or {}).get("app")
    for name in sorted(record.get("configurations") or {}):
        held = record["configurations"][name]
        a = (held.get("A") or {}).get("app")
        if a is None:
            continue
        found += [
            Difference("proof3", document, A, path, at, "error", None, value) for path, at, value in refused_searches(a)
        ]
        if local is not None:
            found += app_differences(a, local, check="proof3", document=document, artifact=LOCAL)
        b = (held.get("B") or {}).get("app")
        if b is not None:
            found += app_differences(a, b, check="proof3", document=document, artifact=REPUBLISH)
    return found


# Proof 4 ------------------------------------------------------------------------------------------------------


def settings_replaced(update: dict | None) -> list[tuple[str, object, object]]:
    """Each of the worker's own settings an update replaced: ``(setting, the worker's value, the value after)``."""
    if not update or update.get("updated") != INSTALLED:
        return []
    before = ((update.get("before") or {}).get("stored")) or {}
    after = ((update.get("after") or {}).get("stored")) or {}
    return [
        (name, before.get(name), after.get(name))
        for name in update.get("workerSettings") or []
        if before.get(name) != after.get(name)
    ]


def editability(document: str, record: dict) -> list:
    found = []
    for name in sorted(record.get("configurations") or {}):
        held = record["configurations"][name]
        for state in ("B", "B-edit"):
            base = (held.get(state) or {}).get("app")
            if base is None:
                continue
            left = {None: base}
            for save in (held.get("saves") or {}).get(state) or []:
                if save.get("app") is None:
                    continue
                artifact = f"android@{save['editor']}@{state}@{name}"
                over = left.get(save.get("over"), base)
                found += app_differences(over, save["app"], check="proof4", document=document, artifact=artifact)
                left[save["label"]] = save["app"]
                update = save.get("update")
                if update is not None and update.get("install") == INSTALLED:
                    for status in ("staged", "updated"):
                        if update.get(status) not in ("UpdateStaged", INSTALLED):
                            path = f"/update/{status}"
                            found.append(
                                Difference("proof4", document, artifact, path, path, "error", None, update.get(status))
                            )
                    for setting, own, after in settings_replaced(update):
                        path = f"/update/workerSettings/{pointer_token(setting)}"
                        found.append(Difference("proof4", document, artifact, path, path, "changed", own, after))
    return found


# Proof 1 ------------------------------------------------------------------------------------------------------


def identity_summary(installs: dict | None, update: dict | None) -> dict:
    """Two exports of one app as a device meets them: installed in turn (each install's status), and one
    updated to the other (``update``: where the update stopped, else ``Installed``; ``updated``, where it was
    installed, whether it is the same app and whether its version went down)."""
    found = {}
    if installs is not None:
        found["installs"] = [step.get("install") for step in installs.get("installs") or []]
    if update is not None and update.get("install") == INSTALLED:
        staged, updated = update.get("staged"), update.get("updated")
        found["update"] = staged if staged != "UpdateStaged" else updated
        if updated == INSTALLED:
            before = ((update.get("before") or {}).get("app")) or {}
            after = ((update.get("after") or {}).get("app")) or {}
            found["updated"] = {"sameApp": before.get("uniqueId") == after.get("uniqueId")}
            try:
                lower = int(after.get("versionNumber")) < int(before.get("versionNumber"))
            except (TypeError, ValueError):
                lower = None
            found["updated"]["versionLower"] = lower
    elif update is not None:
        found["update"] = f"not installed: {update.get('install')}"
    return found


def _identity_differences(document: str, hq: dict, local: dict) -> list:
    """The local path's summary against HQ's; what an installed update is, only where both installed one (an
    update that did not install is that difference, and says nothing more of the app it would have been)."""
    if "updated" not in hq or "updated" not in local:
        hq = {name: value for name, value in hq.items() if name != "updated"}
        local = {name: value for name, value in local.items() if name != "updated"}
    return compare_json(hq, local, check="proof1", document=document, artifact=LOCAL)


def _held(records) -> list:
    return sorted(
        [entry.get("status"), entry.get("AndroidCommCarePlatform.getFormDefId")]
        for entry in records or []
        if entry.get("status") == "incomplete"
    )


def not_reopened(update: dict | None) -> list[tuple[str, str, object, object]]:
    """Each form a worker left incomplete before an update that the device does not open after it:
    ``(structural path, concrete path, before, after)``. Where home could not read the session Android itself
    kept for the form, that is the symptom (``/update/reopened/*/session``: before, the session as Android
    stored it; after, what home raised reading it), and it is the form's own, whatever the update was. Else
    (``/update/reopened/*``) before is how the device held and opened the form, after what it holds and shows."""
    if not update or update.get("install") != INSTALLED:
        return []
    found = []
    saved = update.get("incompleteForms") or {}
    for command, after in sorted((update.get("reopened") or {}).items()):
        before = saved.get(command) or {}
        opened = next(
            (step.get("loaded") for step in (before.get("walk") or {}).get("steps") or [] if "loaded" in step), None
        )
        form = after.get("form") or {}
        if not opened or form.get("loaded"):
            continue
        at = f"/update/reopened/{pointer_token(command)}"
        raised = after.get("homeRaised")
        if isinstance(raised, dict):
            kept = after.get("SessionStateDescriptor.getSessionDescriptor")
            unread = {"raised": raised.get("class"), "message": raised.get("message")}
            found.append(("/update/reopened/*/session", f"{at}/session", {"kept": kept}, unread))
            continue
        alert = form.get("alert") or after.get("alert")
        found.append(
            (
                "/update/reopened/*",
                at,
                {"opened": True, "held": _held(before.get("records"))},
                {
                    "opened": False,
                    "held": _held(after.get("records")),
                    "screen": after.get("screen"),
                    "alert": alert.get("title") if isinstance(alert, dict) else None,
                },
            )
        )
    return found


def identity(document: str, record: dict) -> list:
    found = []
    local = record.get("local") or {}

    def reopened(update, artifact):
        for path, at, before, after in not_reopened(update):
            found.append(Difference("proof1", document, artifact, path, at, "changed", before, after))

    reopened(local.get("update"), LOCAL)
    for name in sorted(record.get("configurations") or {}):
        held = record["configurations"][name]
        if held.get("installs") is None and held.get("update") is None:
            continue
        reopened(held.get("update"), REPUBLISH)
        if local.get("installs") is None and local.get("update") is None:
            continue
        found += _identity_differences(
            document,
            identity_summary(held.get("installs"), held.get("update")),
            identity_summary(local.get("installs"), local.get("update")),
        )
    return found


JUDGES = {"proof1": identity, "proof3": behavior, "proof4": editability}
