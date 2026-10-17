"""What CommCare Android made of a document's states, judged: proofs 1, 3 and 4 over the devices the unit read.

Wherever the unit serves a state to Formplayer and the Web Apps client, it hands it to a worker's device too
(``proof.android.observe``): commcare-android's own code installs the state's archive, the worker HQ made signs
in on it, and every walk down the app's menus runs, its network answered by HQ's own views over the state. The
part records keep each answer as a blob, and ``document_record`` gathers one document's::

    {"configurations": {<name>: {"A": {"app"}, "B": {"app"}, "installs", "update",
                                 "local": {"app", "asIs", "installs", "update"},
                                 "proof4": {"B": {"app"}, "B-edit": {"app"}},
                                 "saves": {"B": [{"label", "editor", "over", "app", "update"}], "B-edit": [...]}}}}

each of ``app``, ``installs`` and ``update`` the reader's answer to that request (``proof/android/README.md``),
absent where the document has no such state. ``B`` is B aligned to A, served where its raw build differs from
A's (proof 3's B); proof 4's states are B and B-edit as the unit served them. ``local`` is Nova's local archive
on a device each configuration's unit served: one archive, but its device's network is that configuration's
HQ (its searches compiled by that HQ under that configuration's flags, its restore that state's), so it is
compared with the same configuration's A. Nothing here runs the reader: every function reads the records.

A walk is named by what it chose (``proof/android/README.md``): its menus' commands, a list's action
(``@action:<n>``), the case it opened at its first list (``@case:<id>``), and, for a walk in a language other than
the one the app starts in, that language first (``@language:<code>``), so two devices' walks pair by name, case by
case and language by language.

**Proof 3** (``behavior``): what a worker's device shows of Nova's local archive against HQ's release of A
(``android@local.ccz``), and of HQ's release of B against A's (``android@B``), per configuration: the install,
the sign-in, the profile as each of Android's readers gives it, the home screen, and every walk
(``comparable_app``). And what stands on its own of HQ's release of A (``android@A``): each search screen that
sent, for an answer holding both quote marks, the query HQ refuses, with HQ's answer to it (``/walks/*/steps/*
/query/withAnswer/sent-unquotable-search``, ``refused_searches``), and each other request of A's device HQ's
views refused that they did not refuse Formplayer's walk with (``/hq/<view>/<status>/<what HQ said>``). And
of every state of proofs 3 and 4 on its own: each form the device did not save and yet left a mark of
(``/walks/*/steps/*/form/saved/applied-though-refused``, ``applied_though_refused``), which Android's one
transaction a form should never give.

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
session, as Android itself stored it, home cannot read (``/update/reopened/*/session``), but where that is what
CommCare does itself with any app HQ builds (``proof.checks.hq_own_reports``).

One symptom is one difference. Two walks that opened another case at a list are compared as far as that list
(``/list/chose``), since every screen past it is of another case; a list that shows its cases in another
order is that (``/list/order``), and its rows are then compared case by case; the walk of a case the other
device's list does not show is that list's difference and no walk one device lacks; and a language one
device's app does not offer is that walk's one difference (``/walks/*/language/offered``). A walk whose
screens are not the same screens in the same order is that difference, named by where the two part
(``/walks/*/screens/after-<the last screen both showed>:<the baseline's next>:<the other's next>``, each side's
whole walk its value; the screen a walk stopped at is named with the alert it holds for the worker,
``FormEntryActivity!Error Saving your Form``), and its steps are compared one against another only as far as
both showed the same screens, the screen they part after among them (a search the server refused, say, shows
there what the worker read on it). A form
that takes another path of screens is that (``/form/path``); a list whose rows are another kind of view is
that (``/list/rowClass``); an archive Android does not install is that (``/install``) and nothing of its app
is compared. What a reader keys by a name is compared by that name and never by position: a menu's items by
their ids, a Sort choice's order by the choice, a search's matches by its term, the cases a device holds by
their ids (each case one value), the home screen's hidden buttons by their names.

Each address of a request the device sends HQ that its answer holds (the form post address its profile reader
gives, each search's URL and each post's) is handed to the spelling rules given for one (``REQUEST_URL``): a
device on A sends HQ's release's id where a device on Nova's local archive sends the working app's, which the rule
``runtime_url_app_id`` reads as one.

What is left out of a comparison, each because it names an install and not what a worker reads, or says again
what a reader beside it says: the app's id and version (proof 1's), the profile's stored values (each
reader's answer is compared, so a stored value no reader reads differently is no difference), the apps the
device holds, and the media check's flags beside its reader (``CommCareApp.areMMResourcesValidated``).
"""

from __future__ import annotations

import copy
import json

from proof.checks import hq_own_reports
from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.spelling import normalized
from proof.checks.differences import ANDROID, ANDROID_TABLET, Difference, pointer_token

LOCAL = f"{ANDROID}@local.ccz"
REPUBLISH = f"{ANDROID}@B"
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
        "/walks/*/steps/*/query/typed/given",
        "/walks/*/steps/*/query/typed/RemoteQuerySessionManager.getRawQueryParams",
        "/walks/*/steps/*/query/typed/RemoteQuerySessionManager.getErrors",
        "/walks/*/steps/*/post/params",
        "/walks/*/steps/*/form/saved/cases",
    }
)
# What names an install, never what a worker reads of it.
APP_LEFT_OUT = ("uniqueId", "versionNumber", "installedApps", "resourcesValidated")
# The artifact a spelling rule names to read the address of a request a reader sent HQ (``proof.rules``).
REQUEST_URL = "request-url"
# The profile reader that gives the address the device sends a completed form to.
POST_URL_READER = "FormSubmissionHelper.getFormPostURL"


SEPARATOR = " | "


def _joined(values) -> str:
    return SEPARATOR.join("" if value is None else str(value) for value in values)


def _list(step: dict) -> None:
    """A case list as compared: the order it shows its cases in, its Sort menu and each search's matches one
    value each, each Sort choice's order by the choice."""
    held = step.get("list")
    if not isinstance(held, dict):
        return
    drawn = held.pop("drawn", None)
    if isinstance(drawn, dict):
        # What a worker sees of the header and of each row, drawn, kept with the row it is a picture of, so a
        # row is compared with the same case's row whatever order the list shows them in.
        held["headerDrawn"] = drawn.get("header")
        rows = drawn.get("rows")
        if isinstance(rows, list) and isinstance(held.get("rows"), list) and len(rows) == len(held["rows"]):
            held["rows"] = [{**row, "drawn": picture} for row, picture in zip(held["rows"], rows, strict=True)]
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
    if isinstance(found.get("signIn"), str):
        found["signIn"] = signed_in(found["signIn"])
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


def _addressed(answer: dict, rules) -> dict:
    """A comparable ``app`` answer with each address of a request the device sends HQ read by the spelling rules
    given for one (``REQUEST_URL``): the form post address its profile reader gives, and each search's and each
    post's URL."""
    readers = (answer.get("profile") or {}).get("readers")
    if isinstance(readers, dict) and isinstance(readers.get(POST_URL_READER), str):
        readers[POST_URL_READER] = normalized(REQUEST_URL, readers[POST_URL_READER], rules)
    for walk in (answer.get("walks") or {}).values():
        for step in (walk.get("steps") or []) if isinstance(walk, dict) else []:
            for kind in ("query", "post"):
                held = step.get(kind) if isinstance(step, dict) else None
                if isinstance(held, dict) and isinstance(held.get("url"), str):
                    held["url"] = normalized(REQUEST_URL, held["url"], rules)
    return answer


def signed_in(result: str) -> str:
    """The app's own sign-in result (``LoginController``'s ``LoginResult``) as a worker meets it: ``Success``, or
    the failure the app reports. A success's own fields name the install (the app's id) and the worker, which
    every state shares."""
    return "Success" if result.startswith("Success(") else result


def _stopped_at(step: dict) -> str | None:
    """The title of the alert the screen a walk stopped at holds for the worker: a form's (as it opens, or as
    it refuses to save), a list's after a tap, home's."""
    form = step.get("form") if isinstance(step.get("form"), dict) else {}
    saved = form.get("saved") if isinstance(form.get("saved"), dict) else {}
    held = step.get("list") if isinstance(step.get("list"), dict) else {}
    for alert in (saved.get("alert"), form.get("alert"), held.get("alertAfterChoice"), step.get("alert")):
        if isinstance(alert, dict) and alert.get("title"):
            return str(alert["title"])
    return None


def _screens(walk: dict) -> str:
    """A walk's screens in order; the one it stopped at with the alert it holds, where it holds one
    (``FormEntryActivity!Error Saving your Form``)."""
    if "raised" in walk:
        return "raised"
    screens = [str(step.get("screen")) for step in walk.get("steps") or []]
    if screens:
        alert = _stopped_at(walk["steps"][-1])
        if alert is not None:
            screens[-1] = f"{screens[-1]}!{alert}"
    return _joined(screens)


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


def _without_picture(value):
    if isinstance(value, dict):
        return {name: _without_picture(item) for name, item in value.items() if name != "picture"}
    if isinstance(value, list):
        return [_without_picture(item) for item in value]
    return value


def _pictures_where_alone(before, after):
    """Two drawn things (a row, a header) with their pictures compared only where nothing else of them differs:
    a picture of a row whose text or layout differs is that difference again, so it is left out of both."""
    if _without_picture(before) == _without_picture(after):
        return before, after
    return _without_picture(before), _without_picture(after)


def _drawn_alone(before: dict, after: dict) -> tuple[dict, dict]:
    """Two list steps with each row's and the header's pictures kept only where nothing else of them differs."""
    a, b = before.get("list"), after.get("list")
    if not isinstance(a, dict) or not isinstance(b, dict):
        return before, after
    a, b = dict(a), dict(b)
    if "headerDrawn" in a and "headerDrawn" in b:
        a["headerDrawn"], b["headerDrawn"] = _pictures_where_alone(
            {"header": a.get("header"), "drawn": a["headerDrawn"]},
            {"header": b.get("header"), "drawn": b["headerDrawn"]},
        )
        a["headerDrawn"], b["headerDrawn"] = a["headerDrawn"]["drawn"], b["headerDrawn"]["drawn"]
    rows_a, rows_b = a.get("rows"), b.get("rows")
    if isinstance(rows_a, dict) and isinstance(rows_b, dict):
        for case in set(rows_a) & set(rows_b):
            rows_a[case], rows_b[case] = _pictures_where_alone(rows_a[case], rows_b[case])
    elif isinstance(rows_a, list) and isinstance(rows_b, list):
        pairs = [_pictures_where_alone(x, y) for x, y in zip(rows_a, rows_b, strict=False)]
        rows_a = [x for x, _ in pairs] + rows_a[len(pairs) :]
        rows_b = [y for _, y in pairs] + rows_b[len(pairs) :]
        a["rows"], b["rows"] = rows_a, rows_b
    return {**before, "list": a}, {**after, "list": b}


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
    before, after = _drawn_alone(before, after)
    a, b = _row_classes(before.get("list")), _row_classes(after.get("list"))
    if a is not None and b is not None and a != b:
        kept = ("rows", "header", "headerDrawn")
        before = {**before, "list": {**{k: v for k, v in before["list"].items() if k not in kept}, "rowClass": a}}
        after = {**after, "list": {**{k: v for k, v in after["list"].items() if k not in kept}, "rowClass": b}}
    return before, after


def _shared_steps(walk_a: dict, walk_b: dict) -> list:
    """The steps two walks took on the same screens before they part, each paired with the other's: what each
    showed there, up to and at the last screen both showed."""
    steps_a, steps_b = walk_a.get("steps"), walk_b.get("steps")
    if "raised" in walk_a or "raised" in walk_b or not isinstance(steps_a, list) or not isinstance(steps_b, list):
        return []
    shared = []
    for a, b in zip(steps_a, steps_b, strict=False):
        if a.get("screen") != b.get("screen"):
            break
        shared.append((a, b))
    if shared:
        # The alert a walk stopped at is in the name of where the two part already.
        shared[-1] = (_without_alert(shared[-1][0]), _without_alert(shared[-1][1]))
    return shared


def _without_alert(step: dict) -> dict:
    """A step without the alerts ``_stopped_at`` reads."""
    step = {name: value for name, value in step.items() if name != "alert"}
    if isinstance(step.get("form"), dict):
        form = {name: value for name, value in step["form"].items() if name != "alert"}
        if isinstance(form.get("saved"), dict):
            form["saved"] = {name: value for name, value in form["saved"].items() if name != "alert"}
        step["form"] = form
    if isinstance(step.get("list"), dict):
        step["list"] = {name: value for name, value in step["list"].items() if name != "alertAfterChoice"}
    return step


# A walk's choice of a case at a list (``Screens.java``, ``CASE``), and the name of the walk that chose nothing.
CASE = "@case:"
ROOT = "root"


def _listed(walk) -> list | None:
    """The cases the list a walk ended at shows, in its order; None where it ended at no list that says."""
    steps = walk.get("steps") if isinstance(walk, dict) else None
    held = steps[-1].get("list") if steps else None
    order = held.get("order") if isinstance(held, dict) else None
    if isinstance(order, str):
        return order.split(SEPARATOR)
    return list(order) if isinstance(order, list) else None


def _without_unlisted_cases(walks: dict, others: dict) -> dict:
    """``walks`` without each walk of a case the other device's list does not show. Two lists that show other
    cases are that list's one difference (``/list/order``, at the walk that ended there on both devices); the
    walk of a case only one of them shows, and every walk on from it, is that difference again, and has no
    walk of the other device to be compared with."""
    kept = dict(walks)
    for name in set(walks) - set(others):
        parts = name.split("/")
        for at, part in enumerate(parts):
            if not part.startswith(CASE):
                continue
            ended = "/".join(parts[:at]) or ROOT
            listed = _listed(others.get(ended)) if ended in walks else None
            if listed is None:
                break
            if part[len(CASE) :] not in listed:
                del kept[name]
                break
    return kept


def one_symptom(before: dict, after: dict) -> tuple[dict, dict]:
    """The two comparable answers with each walk whose screens differ reduced to its screens, as one value, and
    the steps both took before they part; each step reduced as ``_one_step`` reduces it; and without the walks
    of a case the other device's list does not show (``_without_unlisted_cases``)."""
    if not isinstance(before.get("walks"), dict) or not isinstance(after.get("walks"), dict):
        return before, after
    before, after = dict(before), dict(after)
    before["walks"], after["walks"] = (
        _without_unlisted_cases(before["walks"], after["walks"]),
        _without_unlisted_cases(after["walks"], before["walks"]),
    )
    for name in set(before["walks"]) & set(after["walks"]):
        unoffered = [
            (walk.get("language") or {}).get("unoffered") for walk in (before["walks"][name], after["walks"][name])
        ]
        if any(unoffered):
            # A language one device's app does not offer is that walk's one difference, the languages its Change
            # Language dialog offers: the walk goes no further.
            for held in (before["walks"], after["walks"]):
                offered = (held[name].get("language") or {}).get("offered") or []
                held[name] = {"language": {"offered": _joined(offered)}}
            continue
        walk_a, walk_b = _to_first_other_choice(before["walks"][name], after["walks"][name])
        before["walks"][name], after["walks"][name] = walk_a, walk_b
        a, b = _screens(walk_a), _screens(walk_b)
        if a != b:
            parted = _parted(a.split(SEPARATOR), b.split(SEPARATOR))
            steps = [_one_step(x, y) for x, y in _shared_steps(walk_a, walk_b)]
            before["walks"][name] = {"screens": {parted: a}, "steps": [x for x, _ in steps]}
            after["walks"][name] = {"screens": {parted: b}, "steps": [y for _, y in steps]}
        elif "steps" in walk_a and "steps" in walk_b:
            steps = [_one_step(x, y) for x, y in zip(walk_a["steps"], walk_b["steps"], strict=True)]
            before["walks"][name] = {**walk_a, "steps": [x for x, _ in steps]}
            after["walks"][name] = {**walk_b, "steps": [y for _, y in steps]}
    return before, after


def app_differences(before, after, *, check, document, artifact, rules=()) -> list:
    """Every difference between what a device shows of two archives: ``before`` the baseline's ``app`` answer,
    ``after`` the other's, each address of a request the device sends HQ read by the spelling rules given
    (``_addressed``)."""
    a, b = comparable_app(before), comparable_app(after)
    if a is None or b is None:
        return []
    a, b = _addressed(a, rules), _addressed(b, rules)
    if a.get("install") != INSTALLED or b.get("install") != INSTALLED:
        a, b = {"install": a.get("install")}, {"install": b.get("install")}
    else:
        a, b = one_symptom(a, b)
    return compare_json(a, b, check=check, document=document, artifact=artifact, data_maps=DATA_MAPS)


# Proof 3 ------------------------------------------------------------------------------------------------------


# What Nova's suite sends in place of a search value that holds both quote marks, which no XPath string can
# hold: a function HQ's query compiler knows none of, so HQ refuses the search (finding 48).
UNQUOTABLE = "search-value-mixes-quote-marks()"
A = f"{ANDROID}@A"


def _sends_unquotable(entry) -> bool:
    """Whether a device's request (a record's ``hq`` entry, ``proof.android.hq.Exchange``) sent the placeholder
    in its search query."""
    from urllib.parse import parse_qs, urlsplit

    query = parse_qs(urlsplit(entry.get("url") or "").query, keep_blank_values=True)
    return UNQUOTABLE in query.get("_xpath_query", [])


def refused_searches(answer: dict | None, asked=()) -> list[tuple[str, str, dict, int | None]]:
    """Each search screen of an ``app`` answer that sent, for an answer holding both quote marks, the query HQ
    refuses: ``(structural path, concrete path, what it sent, what HQ's search view answered it and what the
    screen then showed, the place in ``asked`` of the request that sent it)``. It stands on its own of one
    archive: Formplayer stops the same search at the screen, and a device sends it whatever errors Core holds for
    its prompts, which the screen never reads (its Search button calls ``QueryRequestActivity.makeQueryRequest``
    unconditionally, ``QueryRequestUiController.setupUI``). ``asked`` is every request the device made of HQ (a
    record's ``hq``), in which the walk's request carrying the placeholder is that search's, and HQ's answer to
    it is part of the one symptom."""
    sending = {}
    for place, entry in enumerate(asked or ()):
        if _sends_unquotable(entry):
            sending.setdefault(entry.get("walk"), []).append(place)
    found = []
    for name, walk in sorted(((answer or {}).get("walks") or {}).items()):
        for index, step in enumerate(walk.get("steps") or []):
            probe = (step.get("query") or {}).get("withAnswer") if isinstance(step.get("query"), dict) else None
            if not probe:
                continue
            sent = (probe.get("RemoteQuerySessionManager.getRawQueryParams") or {}).get("_xpath_query") or []
            if UNQUOTABLE in sent:
                shown = (probe.get("afterServerAnswers") or probe.get("afterServerAnswers400") or {}).get("errorText")
                places = sending.get(name) or []
                place = places.pop(0) if places else None
                hq = None
                if place is not None:
                    hq = {key: asked[place].get(key) for key in ("url_name", "status", "said", "raised")}
                at = f"/walks/{pointer_token(name)}/steps/{index}/query/withAnswer/sent-unquotable-search"
                value = {"sent": sent, "hq": hq, "shown": shown}
                found.append(("/walks/*/steps/*/query/withAnswer/sent-unquotable-search", at, value, place))
    return found


def applied_though_refused(answer: dict | None) -> list[tuple[str, str, dict]]:
    """Each form of an ``app`` answer the device did not save and yet left a mark of: the cases it holds after
    are not the cases it held as the form opened (``(structural path, concrete path, what the device said and
    holds)``). Android applies a form's case blocks in one transaction, so a refused form should leave none;
    this stands on its own of one archive, and a run that reports it has found a device that keeps half a form."""
    found = []
    for name, walk in sorted(((answer or {}).get("walks") or {}).items()):
        for index, step in enumerate(walk.get("steps") or []):
            saved = (step.get("form") or {}).get("saved") if isinstance(step.get("form"), dict) else None
            if isinstance(saved, dict) and saved.get("casesAsTheFormOpened") is False:
                alert = saved.get("alert") if isinstance(saved.get("alert"), dict) else {}
                at = f"/walks/{pointer_token(name)}/steps/{index}/form/saved/applied-though-refused"
                value = {"alert": alert.get("title"), "cases": saved.get("cases")}
                found.append(("/walks/*/steps/*/form/saved/applied-though-refused", at, value))
    return found


def _applied(check: str, document: str, artifact: str, answer: dict | None) -> list:
    return [
        Difference(check, document, artifact, path, at, "error", None, value)
        for path, at, value in applied_though_refused(answer)
    ]


def signed_in_differences(document: str, a: dict | None, local: dict | None) -> list:
    """Where a device on Nova's local archive signs in, against a device on HQ's release of A
    (``/network/signIn``): the local archive names no server (finding 59), so its device asks Android's own
    defaults, where HQ's build's asks the project space."""
    if not a or not local or a.get("install") != INSTALLED or local.get("install") != INSTALLED:
        return []
    before, after = signed_in(str(a.get("signIn"))), signed_in(str(local.get("signIn")))
    if before == after:
        return []
    path = "/network/signIn"
    return [Difference("proof3", document, LOCAL, path, path, "changed", before, after)]


# The artifacts of what a tablet alone shows: a tablet's difference the phone shows too is the phone's symptom.
TABLET = ANDROID_TABLET


def tablet_only(phone: list, tablet: list) -> list:
    """The differences a tablet shows (judged as ``device=TABLET``) that the phone does not show at the same
    place of the same artifact: a symptom both show is one symptom, the phone's, and what only a tablet shows
    (its side by side screens, its wider rows) is the tablet's own."""
    shown = {(d.check, d.artifact.removeprefix(f"{ANDROID}@"), d.at) for d in phone}
    return [d for d in tablet if (d.check, d.artifact.removeprefix(f"{TABLET}@"), d.at) not in shown]


def behavior(document: str, record: dict, *, device: str = ANDROID, rules=()) -> list:
    """Proof 3's differences in what one kind of device (``device``: ``android``, a phone, or ``TABLET``) did,
    each address of a request a device sends HQ read by the spelling rules given (``rules``)."""
    local_artifact, a_artifact, republish = (f"{device}@local.ccz", f"{device}@A", f"{device}@B")
    found = []
    for name in sorted(record.get("configurations") or {}):
        held = record["configurations"][name]
        local = (held.get("local") or {}).get("app")
        found += _applied("proof3", document, local_artifact, local)
        a = (held.get("A") or {}).get("app")
        if a is None:
            continue
        refused = refused_searches(a, (held.get("A") or {}).get("hq"))
        found += [
            Difference("proof3", document, a_artifact, path, at, "error", None, value) for path, at, value, _ in refused
        ]
        # Each request of the device's HQ's own views refused while A was served (a search a device built from
        # a typed answer, compiled by HQ's own search view, among them), judged against what HQ's views refused
        # Formplayer's walk of the same state: a refusal of the same view, status and cause is Formplayer's
        # symptom (``formplayer@A``), and the device's own is what Formplayer's walk never met. HQ's refusal of
        # a search that sent the placeholder is that search's symptom, reported with it just above.
        from proof.checks import served

        found += served.refusal_differences(
            device_only_refusals(held.get("A") or {}, beside={place for *_, place in refused}),
            check="proof3",
            document=document,
            artifact=a_artifact,
        )
        found += _applied("proof3", document, a_artifact, a)
        if local is not None:
            found += app_differences(a, local, check="proof3", document=document, artifact=local_artifact, rules=rules)
        found += signed_in_differences(document, a, (held.get("local") or {}).get("asIs"))
        b = (held.get("B") or {}).get("app")
        if b is not None:
            found += _applied("proof3", document, republish, b)
            found += app_differences(a, b, check="proof3", document=document, artifact=republish, rules=rules)
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


def editability(document: str, record: dict, *, device: str = ANDROID) -> list:
    """Proof 4's differences in what one kind of device (``device``) did."""
    found = []
    for name in sorted(record.get("configurations") or {}):
        held = record["configurations"][name]
        for state in ("B", "B-edit"):
            base = ((held.get("proof4") or {}).get(state) or {}).get("app")
            if base is None:
                continue
            left = {None: base}
            for save in (held.get("saves") or {}).get(state) or []:
                if save.get("app") is None:
                    continue
                artifact = f"{device}@{save['editor']}@{state}@{name}"
                over = left.get(save.get("over"), base)
                found += _applied("proof4", document, artifact, save["app"])
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


class ReaderRaised(AssertionError):
    """The Android reader raised where it reads what the device does, so its answer holds no observation of the
    app: the reader's own failure, which no register entry holds and no difference stands in for."""


def not_reopened(update: dict | None, artifact: str) -> list[tuple[str, str, object, object]]:
    """Each form a worker left incomplete before an update that the device does not open after it, on the
    archive ``artifact`` names: ``(structural path, concrete path, before, after)``. Where home could not read
    the session Android itself kept for the form, that is the symptom (``/update/reopened/*/session``: before,
    the session as Android stored it; after, what home raised reading it), and it is the form's own, whatever the
    update was, but where it is CommCare's own reading of grouped tiles, which the set of HQ's own reports
    decides (``proof.checks.hq_own_reports``). Else (``/update/reopened/*``) before is how the device held and
    opened the form, after what it holds and shows. Where the reader itself raised reading the form
    (``raised``, not home's ``homeRaised``), there is nothing to compare, and that fails by name
    (``ReaderRaised``)."""
    if not update or update.get("install") != INSTALLED:
        return []
    found = []
    saved = update.get("incompleteForms") or {}
    for command, after in sorted((update.get("reopened") or {}).items()):
        if isinstance(after.get("raised"), dict):
            raised = after["raised"]
            raise ReaderRaised(
                f"The Android reader raised {raised.get('class')} ({raised.get('message')}) on {artifact} while it"
                f" read what home does with the form {command} left incomplete before the update, so its answer"
                " says nothing of the app. Fix the reader where its stack (the answer's reopened"
                f" {command} raised) points; no register entry holds a reader's own failure."
            )
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
            if hq_own_reports.held(artifact, "/update/reopened/*/session", after):
                continue
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

    def reopened(update, artifact):
        for path, at, before, after in not_reopened(update, artifact):
            found.append(Difference("proof1", document, artifact, path, at, "changed", before, after))

    for name in sorted(record.get("configurations") or {}):
        held = record["configurations"][name]
        local = held.get("local") or {}
        reopened(local.get("update"), LOCAL)
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


# The records ---------------------------------------------------------------------------------------------------


def _answer(held, blobs):
    """A device's answer as a record keeps it (``proof.android.observe``), or None where it keeps none."""
    if not isinstance(held, dict) or not held.get("answer"):
        return None
    return blobs.get_json(held["answer"])


def _asked(held, blobs) -> list:
    """Every request a device made of HQ with HQ's answer, as a record keeps them (``proof.android.hq``)."""
    if not isinstance(held, dict) or not held.get("hq"):
        return []
    return blobs.get_json(held["hq"])


def hq_refusals(asked, *, beside=frozenset()) -> list:
    """Each request of a device's HQ's views did not answer 2xx, as a served state's ``hq`` entries are written
    (``proof.checks.served.refusal_differences``): the view, its status, what HQ said or raised. ``beside`` names
    the places in ``asked`` of requests another difference already reports with HQ's answer."""
    return [
        {
            "view": entry.get("url_name"),
            "status": entry.get("status"),
            "said": entry.get("said"),
            "raised": entry.get("raised"),
        }
        for place, entry in enumerate(asked or [])
        if not 200 <= int(entry.get("status") or 0) < 400 and place not in beside
    ]


def _refusal_class(entry) -> tuple:
    from proof.checks import served

    cause = entry.get("raised") or served.refusal_cause(entry.get("said"))
    return (entry.get("view") or "unresolved", entry.get("status"), cause)


def device_only_refusals(held: dict, *, beside=frozenset()) -> list:
    """The device's refused requests of a served state (``hq_refusals``, but those ``beside`` names) whose view,
    status and cause HQ's views did not refuse Formplayer's walk of the same state with (``formplayerHq``, a
    served state's record of its walk's refusals)."""
    met = {_refusal_class(entry) for entry in held.get("formplayerHq") or []}
    return [entry for entry in hq_refusals(held.get("hq"), beside=beside) if _refusal_class(entry) not in met]


def _editor(view, section) -> str:
    scope = view["scope"]
    place = "" if scope[0] is None else f":m{scope[0]}" + ("" if scope[1] is None else f".f{scope[1]}")
    return f"{section['section']}{place}"


def _saves(proof4: dict, blobs, key: str = "android") -> list:
    """Each editor save of a proof 4 record a device read, as ``{label, editor, over, app, update}``: ``over``
    the label of the save it was made over (None: the state the record is of). A save whose app was not served
    (its build and what the client reads are the state's it was saved over) is not one a device reads apart."""
    found = []

    def entry(label, editor, over, saved):
        served = saved.get("served") if isinstance(saved, dict) else None
        if not isinstance(served, dict) or "refused" in served or not served.get(key):
            return False
        found.append(
            {
                "label": label,
                "editor": editor,
                "over": over,
                "app": _answer(served[key], blobs),
                "update": _answer(served.get("androidUpdate"), blobs) if key == "android" else None,
            }
        )
        return True

    for view in proof4.get("views") or ():
        for section in view.get("sections") or ():
            entry(_editor(view, section), section["section"], None, section)
    for form in proof4.get("vellum") or ():
        m, f = form["scope"]
        over = None
        for editor, run in zip(("vellum", "vellum again"), form.get("runs") or (), strict=False):
            label = f"{editor}:m{m}.f{f}"
            if entry(label, editor, over, run):
                over = label
    return found


def document_record(records, *, tablet: bool = False) -> dict:
    """One document's devices as the judges read them (the module's docstring), gathered from its part
    records: the phones', or with ``tablet`` the tablets' (which install, sign in and update as phones do, so
    the installs, the update and the local archive's own sign-in are the phones' alone)."""
    blobs = records.blobs
    key, delivered = ("androidTablet", "androidDeliveredTablet") if tablet else ("android", "androidDelivered")
    found = {"configurations": {}}
    for name in sorted(records.configurations):
        parts = records.configurations[name]
        held = {}
        served_a = (((parts.a or {}).get("hooks") or {}).get("served") or {}).get("A") or {}
        a = _answer(served_a.get(key), blobs)
        if a is not None:
            held["A"] = {
                "app": a,
                "hq": _asked(served_a.get(key), blobs),
                "formplayerHq": (served_a.get("formplayer") or {}).get("hq") or [],
            }
        aligned = (parts.b_aligned or {}).get("served") or {}
        b = _answer((aligned.get("B") or {}).get(key), blobs)
        if b is not None:
            held["B"] = {"app": b}
        # The local archive's device given the input the lane gives Core over it is the one its walks are
        # compared from; the one that meets Android's own defaults is judged for where it signs in.
        served_local = aligned.get("local") or {}
        local = {}
        walked = _answer(served_local.get(delivered), blobs)
        if walked is not None:
            local["app"] = walked
        own = None if tablet else _answer(served_local.get("android"), blobs)
        if own is not None:
            local["asIs"] = own
        devices = {} if tablet else aligned.get("devices") or {}
        for role, target in (("local", local), ("republish", held)):
            pair = devices.get(role) or {}
            for kind in ("installs", "update"):
                answer = _answer(pair.get(kind), blobs)
                if answer is not None:
                    target[kind] = answer
        if local:
            held["local"] = local
        for part, state in (("b", "B"), ("b_edit", "B-edit")):
            record = parts.part(part) or {}
            proof4 = record.get("proof4") or {}
            base = _answer((proof4.get("served") or {}).get(key), blobs)
            if base is None:
                continue
            held.setdefault("proof4", {})[state] = {"app": base}
            held.setdefault("saves", {})[state] = _saves(proof4, blobs, key)
        found["configurations"][name] = held
    return found
