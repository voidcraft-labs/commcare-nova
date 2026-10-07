"""What CommCare Connect made of a state's submissions, judged: two states compared, and what stands on its own.

A Connect document's unit forwards every state it serves to one opportunity
in Connect and keeps, for each run that reached HQ's receiver, what HQ's
receiver answered, each payload as it reached Connect with Connect's answer,
the tasks Connect ran and the rows Connect then held
(``proof.observe.connect``). Nothing here runs Connect or HQ: every function
reads those records.

**Two states compared** (``differences``). Connect is the reader, so what is
compared is what Connect did: its answer to each payload, the tasks it ran
and the rows it holds (``comparable``), run by run, each reader's runs
paired by name. A payload is never compared: two payloads Connect answers
alike and makes the same rows of are two spellings to it, which is what the
comparison then shows. One symptom is one difference: where Connect answers
the two sides' payloads differently (one taken, one refused), that is the
difference (``/runs/*/posts/*/answer``), and the rows that follow from
it are not reported again. A run only one side holds, or one HQ's receiver
answered the two sides differently, is not compared: Formplayer's refusal of
a submit and HQ's of a submission are the walks' and the case processing's
to report (``proof.checks.served``, ``proof.checks.proof3``).

What is left out of the rows: what names a submission or a build and not
what a worker did (a form's id, the build's id and version).

A run is ``/runs/*`` in a path whichever reader made its submission (Core or
Formplayer: one symptom is one path), and ``/runs/<reader>:<run>`` in ``at``.

**What stands on its own** (``absolute``), of one state:

- ``/runs/*/refused/<status>/<cause>``: Connect did not take a payload that
  holds a Connect block. The cause is the class a view raised (Connect
  answers 500, and HQ retries the forward until it gives up) or what
  Connect said, without the names it quotes. A form with no Connect block
  is forwarded too, since HQ's repeater forwards every form of the project
  space, and Connect answers that it holds nothing of its own: that is no
  refusal of anything Connect was to read;
- ``/runs/*/visit-rejected-for-the-task-its-form-completes``: the rows
  hold a visit rejected for the worker's pending task and that task
  completed by the same form (finding 61);
- ``/runs/*/catalog/<rows>/added``: after the form, Connect holds a learn
  module, deliver unit or task type the opportunity did not hold when it was
  made: Connect's receiver made one of its own for an id it did not know;
- ``/runs/*/task-completed-nothing``: the payload holds a task and no
  task of the worker's was completed by it;
- ``/ids/<kind>/moved`` (``moved_ids``): the state's payloads name a module,
  deliver unit or task the opportunity does not hold, while the opportunity
  holds one that no payload of the state names: an id Connect keys its rows
  by moved under an opportunity that holds the old one (defect 15).

Proof 3 reports A's own (``connect@A``) and compares Nova's local archive and
B aligned to A with A; proof 4 compares each save with the state it was made
over, and reports of B and of B-edit what stands on its own there and not at
A (``beyond``): an edit changes what a form submits, so its rows are not
held to A's, and what it breaks in Connect is.
"""

from __future__ import annotations

import copy
import re

from proof.checks.compare.json_tree import compare_json
from proof.checks.differences import Difference, pointer_token

CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn"
GENERATED_MARK = re.compile(r"@generated:uuid:[0-9]+")
GENERATED = "@generated"
# Row fields that name a submission or a build, never what a worker did.
ROW_LEFT_OUT = frozenset({"xform", "appBuildId", "appBuildVersion"})
# The opportunity's rows Connect reads from an app's build, by the Connect block that names each.
CATALOG = {"module": "learnModules", "deliver": "deliverUnits", "task": "taskTypes"}
TAKEN = 200


def _unnumbered(value):
    if isinstance(value, str):
        return GENERATED_MARK.sub(GENERATED, value) if "@generated:uuid:" in value else value
    if isinstance(value, dict):
        return {_unnumbered(key): _unnumbered(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_unnumbered(item) for item in value]
    return value


def _without(value, names):
    if isinstance(value, dict):
        return {key: _without(item, names) for key, item in value.items() if key not in names}
    if isinstance(value, list):
        return [_without(item, names) for item in value]
    return value


def _cause(text) -> str:
    words = [word for word in re.split(r"[^A-Za-z]+", str(text or "")) if word]
    return "-".join(words[:12]).lower() or "-"


def refusal_cause(post) -> str:
    """Why Connect did not take a payload, as a path names it: the class a view raised, else what Connect said
    up to the names it quotes (a field with its message, or its ``detail`` up to the first colon)."""
    if post.get("raised"):
        return post["raised"][-1]["class"]
    body = post.get("body")
    if isinstance(body, dict) and isinstance(body.get("detail"), str):
        return _cause(body["detail"].split(":")[0])
    if isinstance(body, dict) and body:
        field = sorted(body)[0]
        said = body[field][0] if isinstance(body[field], list) and body[field] else body[field]
        return _cause(f"{field} {said}")
    return _cause(body)


def answer(post) -> str:
    """Connect's answer to one payload, as one value: its status, with why where it did not take it."""
    status = post.get("status")
    return str(status) if status == TAKEN else f"{status}: {refusal_cause(post)}"


def blocks(payload) -> list:
    """Each Connect block of a payload as ``(element name, id)``: every object, at any depth of the payload's
    form, in Connect's namespace, as Connect's receiver finds them."""
    found = []

    def walk(name, value):
        if isinstance(value, dict):
            if value.get("@xmlns") == CONNECT_XMLNS:
                found.append((name, value.get("@id")))
            for key in sorted(value):
                walk(key, value[key])
        elif isinstance(value, list):
            for item in value:
                walk(name, item)

    walk(None, (payload or {}).get("form"))
    return found


def _rows(state):
    """The rows as compared: a visit's flags by the code Connect gives each, and nothing that names a submission."""
    rows = _without(copy.deepcopy(state or {}), ROW_LEFT_OUT)
    for visit in rows.get("visits") or []:
        flags = visit.get("flags")
        if isinstance(flags, list):
            visit["flags"] = {str(code): message for code, message in flags}
    return rows


def comparable(run) -> dict:
    """One run as it is compared (the module's first part)."""
    return _unnumbered(
        {
            "posts": [{"answer": answer(post)} for post in run.get("posts") or []],
            "tasks": [
                {"task": task["task"].rsplit(".", 1)[-1], "state": task["state"], "error": task.get("error")}
                for task in run.get("tasks") or []
            ],
            "state": _rows(run.get("state")),
        }
    )


def _received(run):
    return [received.get("status") for received in run.get("received") or []]


def differences(before, after, *, check, document, artifact, readers=None) -> list:
    """Every difference between what Connect made of two states' submissions, as ``artifact``: ``before`` the
    baseline state's record, ``after`` the other's. ``readers`` pairs the other side's readers with the
    baseline's (``{other: baseline}``; each reader with itself by default)."""
    runs_before, runs_after = (before or {}).get("runs") or {}, (after or {}).get("runs") or {}
    readers = readers or {reader: reader for reader in runs_after}
    shown_before, shown_after = {}, {}
    for other, baseline in sorted(readers.items()):
        named_before = {run["run"]: run for run in runs_before.get(baseline) or []}
        named_after = {run["run"]: run for run in runs_after.get(other) or []}
        for name in sorted(set(named_before) & set(named_after)):
            run_before, run_after = named_before[name], named_after[name]
            if _received(run_before) != _received(run_after):
                continue
            a, b = comparable(run_before), comparable(run_after)
            if [post["answer"] for post in a["posts"]] != [post["answer"] for post in b["posts"]]:
                a, b = {"posts": a["posts"]}, {"posts": b["posts"]}
            shown_before[f"{other}:{name}"] = a
            shown_after[f"{other}:{name}"] = b
    return compare_json(
        {"runs": shown_before},
        {"runs": shown_after},
        check=check,
        document=document,
        artifact=artifact,
        data_maps={"/runs"},
    )


def _own(reader, run) -> list:
    """What stands on its own of one run: ``[(path under the run, value)]``."""
    found = []
    state = run.get("state") or {}
    for post in run.get("posts") or []:
        # A form that holds no Connect block is forwarded all the same (HQ's repeater forwards every form of the
        # project space), and Connect answers that it holds nothing of its own: no refusal of anything Connect
        # was to read.
        if post.get("status") != TAKEN and blocks(post.get("payload")):
            found.append((f"refused/{post.get('status')}/{pointer_token(refusal_cause(post))}", post.get("body")))
    completed = {
        task.get("xform") for task in state.get("assignedTasks") or [] if task.get("status") == "completed"
    } - {None}
    for visit in state.get("visits") or []:
        codes = [code for code, _ in visit.get("flags") or []]
        if "pending_task" in codes and visit.get("xform") in completed:
            found.append(("visit-rejected-for-the-task-its-form-completes", visit.get("deliverUnit")))
    for post in run.get("posts") or []:
        if post.get("status") != TAKEN:
            continue
        named = [block_id for name, block_id in blocks(post.get("payload")) if name == "task"]
        if named and not completed:
            found.append(("task-completed-nothing", named))
    return found


def absolute(record, catalog=None) -> list:
    """What stands on its own of one state's record: ``[(path, at, value)]``, ``catalog`` the opportunity's rows
    as it was made (``{"learnModules", "deliverUnits", "taskTypes"}``)."""
    found = []
    runs = (record or {}).get("runs") or {}
    for reader in sorted(runs):
        token = pointer_token(reader)
        for run in runs[reader]:
            at = f"/runs/{token}:{pointer_token(run['run'])}"
            for path, value in _own(reader, run):
                found.append((f"/runs/*/{path}", f"{at}/{path}", value))
            for rows in CATALOG.values():
                held = {row["slug"] for row in (catalog or {}).get(rows) or []}
                grown = sorted({row["slug"] for row in (run.get("state") or {}).get(rows) or []} - held)
                if catalog is not None and grown:
                    found.append((f"/runs/*/catalog/{rows}/added", f"{at}/catalog/{rows}/added", grown))
    return found


def moved_ids(record, catalog) -> list:
    """``[(path, at, the opportunity's ids no payload names, the payloads' ids the opportunity does not hold)]``
    for each kind of Connect block whose id moved under the opportunity (the module's last point)."""
    named = {kind: set() for kind in CATALOG}
    for runs in ((record or {}).get("runs") or {}).values():
        for run in runs:
            for post in run.get("posts") or []:
                for name, block_id in blocks(post.get("payload")):
                    if name in named and block_id is not None:
                        named[name].add(block_id)
    found = []
    for kind, rows in sorted(CATALOG.items()):
        held = {row["slug"] for row in (catalog or {}).get(rows) or []}
        gone, new = sorted(held - named[kind]), sorted(named[kind] - held)
        if gone and new:
            found.append((f"/ids/{kind}/moved", f"/ids/{kind}/moved", gone, new))
    return found


def absolute_differences(record, catalog, *, check, document, artifact, beyond=None, moved=False) -> list:
    """A state's own differences (``absolute``, and ``moved_ids`` with ``moved``), as ``artifact``; with
    ``beyond`` (another state's record), only those whose path that state does not show."""
    shown = {path for path, _, _ in absolute(beyond, catalog)} if beyond is not None else set()
    found = [
        Difference(check, document, artifact, path, at, "error", None, value)
        for path, at, value in absolute(record, catalog)
        if path not in shown
    ]
    if moved:
        found += [
            Difference(check, document, artifact, path, at, "changed", gone, new)
            for path, at, gone, new in moved_ids(record, catalog)
        ]
    return found
