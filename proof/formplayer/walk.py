"""Formplayer's sessions over one app: every screen a worker reaches in Web Apps, and what Formplayer answers.

``walk`` runs scripted sessions against Formplayer as the Core runner runs
them against Core (``proof/core/src/nova/proof/core/SessionOp.java``), each a
sequence of the requests the Web Apps client sends (``proof.formplayer.
webapps``). Without a script one is derived: every command of every menu,
depth first in menu order; at each case list the first case Formplayer lists;
at each search screen the search a worker sends after typing the answer
table's search answers into its prompts (``typed_inputs``, a step of its own
that HQ's search view answers), then the search sent with the prompts as
Formplayer shows them, which the run goes on with. With a script, each run
replays it, and a choice the screen cannot take ends that run as
``unreplayable``. A run that reaches a form answers its
questions from the lane's fixed answer table (``proof/core/answers.json``,
whose values are already in the encoding Web Apps sends Formplayer; a file
question, signature included, is given the table's file for its kind from
``proof/core/captures``, uploaded as the client uploads one, ``media_kind``
and ``WebApps.answer_media``), submits
it as the client does, and records Formplayer's answer, the submission HQ
received and the screen Formplayer's end of form navigation names next.

Every run starts as a worker starts after clearing their data in Web Apps
(Formplayer's ``clear_user_data``), so each reads the restore afresh and none
sees the cases an earlier run's submission made, as every Core run starts
from the request's case data, and with Formplayer's in-memory caches empty
(``FormplayerRunner.forget_caches``): they keep a search's results for five
minutes of the machine's time, which ``clear_user_data`` leaves, so a run
would otherwise ask HQ or not by how long ago an earlier one ran, and with no
row of an earlier run's uploads (``FormplayerRunner.forget_media``: an
upload's id is drawn from the seeded random source, so two runs draw the same
ones). Every walk starts by having Formplayer drop the
app's install (``delete_application_dbs``), so each starts from the app as
Formplayer installs it, whatever the same Formplayer ran on it before.

The trace is Formplayer's own JSON for every request, in order, with what it
asked HQ during each (``asked``), marked and encoded by
``proof.formplayer.canonical``. Nothing is summarized: what a judge compares
is what the Web Apps client is handed.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from proof.core.client import DEFAULT_CLOCK
from proof.formplayer import canonical
from proof.formplayer.client import FormplayerRunner, HqHandler
from proof.formplayer.webapps import FormplayerRefused, WebApps

ANSWERS_PATH = Path(__file__).resolve().parents[1] / "core" / "answers.json"
MAX_RUNS = 500
MAX_SCREENS = 400
# A walk's whole budget; a document's sessions take seconds.
MAX_SECONDS = 300.0
MAX_TRIES = 3
MAX_QUESTIONS = 2000
# Formplayer's name for a question's data type (api/json/PromptToJson.java) to the answer table's.
DATA_TYPES = {
    "str": "text",
    "int": "integer",
    "longint": "long",
    "float": "decimal",
    "date": "date",
    "time": "time",
    "datetime": "dateTime",
    "select": "choice",
    "multiselect": "choiceList",
    "geo": "geopoint",
    "barcode": "barcode",
}
# The files a worker gives a file question, the ones every reader's walk gives (the answer table's novaKinds name
# them), with the type a browser gives each file it uploads (by its extension).
CAPTURES_DIR = Path(__file__).resolve().parents[1] / "core" / "captures"
CONTENT_TYPES = {
    "proof-image.jpg": "image/jpeg",
    "proof-audio.mp3": "audio/mpeg",
    "proof-video.mp4": "video/mp4",
    "proof-file.pdf": "application/pdf",
    "proof-signature.png": "image/png",
}
# A file question's control (Formplayer's ``control``, Core's ``Constants.CONTROL_*``) to the answer table's kind.
MEDIA_CONTROLS = {10: "image", 12: "audio", 13: "video", 14: "file"}
# What Web Apps sends in a multi-select list's selection once the cases are chosen
# (commcare-core MultiSelectEntityScreen.USE_SELECTED_VALUES).
USE_SELECTED_VALUES = "use_selected_values"


def typed_inputs(displays, answers) -> dict[str, str]:
    """What a worker types into a search screen's prompts, as Web Apps sends it (``query_data`` inputs): the
    answer table's ``searchPrompts`` by each prompt's input, a text prompt its text and a single select or a
    checkbox prompt the key of the option the table names (``itemsetChoicesKey``, by its 1-based index). A
    prompt of another input (a date range, an address) is left as the screen leaves it; empty where the table
    holds no search answers or the screen no prompt to type into."""
    typed: dict[str, str] = {}
    if not answers:
        return typed
    for display in displays:
        # A prompt the screen hides (the suite's ``hidden``) takes nothing a worker types.
        if not isinstance(display, dict) or not display.get("id") or str(display.get("hidden")).lower() == "true":
            continue
        name = display.get("input") or "text"
        if name == "text":
            typed[display["id"]] = answers["text"]
        elif name in ("select1", "checkbox") and name in answers:
            keys = display.get("itemsetChoicesKey") or ()
            index = int(answers[name])
            if 0 < index <= len(keys):
                typed[display["id"]] = keys[index - 1]
    return typed


def media_kind(question: Mapping[str, Any]) -> str | None:
    """The kind of file a file question takes, as the Web Apps client draws its widget (``entries.js::getEntry``
    for a binary question: an image control with the ``signature`` appearance draws a signature pad, and an image,
    audio, video or document control a file chooser), or None for a question that takes no file (a binary
    question of another control draws no widget a worker answers)."""
    if question.get("datatype") != "binary":
        return None
    kind = MEDIA_CONTROLS.get(question.get("control"))
    style = question.get("style") if isinstance(question.get("style"), dict) else {}
    if kind == "image" and "signature" in str(style.get("raw") or "").split():
        return "signature"
    return kind


def load_answer_table(path: Path = ANSWERS_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def screen_kind(response: Any) -> str:
    """What a response shows: ``form``, ``commands``, ``entities``, ``query``, or ``notification`` for anything else."""
    if not isinstance(response, dict):
        return "notification"
    if response.get("session_id") and isinstance(response.get("tree"), list):
        return "form"
    if response.get("type") in ("commands", "entities", "query"):
        return response["type"]
    return "notification"


def fresh_actions(response, actions, ran):
    """A list's actions as script choices, but those the run already took from a list of the same title."""
    title = response.get("title")
    return [
        {"action": index, "list": title} for index in range(len(actions)) if {"action": index, "list": title} not in ran
    ]


def questions(tree: Sequence[Mapping[str, Any]]):
    """Every node of a form's tree, depth first in the form's order."""
    for node in tree or ():
        yield node
        yield from questions(node.get("children") or ())


@dataclass
class Walk:
    """One app's sessions on Formplayer."""

    runner: FormplayerRunner
    # HQ's own views over a served state (``proof.formplayer.hq.HqViews``).
    hq: HqHandler
    domain: str
    app_id: str
    locale: str | None = None
    answer_table: Mapping[str, Any] = field(default_factory=load_answer_table)
    clock: str = DEFAULT_CLOCK
    # What each run happens inside: a context manager made from the run's name. Where HQ answers with its own
    # views over a unit's state (``proof.formplayer.hq.Served.run``) it is a fork of that state with the worker
    # signed in, so no run reads what another's submission left in HQ.
    scope: Callable[[str], Any] = lambda name: nullcontext()

    # -- one execution -----------------------------------------------------

    def _client(self) -> WebApps:
        """The worker's browser: the session HQ holds for them."""
        return WebApps(
            self.runner,
            self.hq,
            domain=self.domain,
            username=self.hq.username,
            app_id=self.app_id,
            locale=self.locale,
            # The Django session HQ made for the worker as the run began (``proof.formplayer.hq.Served.run``).
            session_key=self.hq.session_key,
        )

    def _web(self) -> WebApps:
        web = self._client()
        # A worker starting over: their restore and search results are read afresh.
        web.post("/clear_user_data", {"domain": self.domain, "username": self.hq.username, "restoreAs": None})
        # And nothing an earlier session left in Formplayer's five-minute caches answers this one's requests, so
        # what it asks HQ does not depend on how long ago that session ran (FormplayerRunner.forget_caches), and no
        # file an earlier run uploaded holds the id this one's upload draws (FormplayerRunner.forget_media).
        self.runner.forget_caches()
        self.runner.forget_media()
        return web

    def _forget_app(self) -> None:
        """Formplayer's own route for dropping an installed app (what Web Apps sends when a worker clears an
        app's data, and before an update): every walk then starts from the app as Formplayer installs it,
        whatever this Formplayer ran on it before."""
        web = self._client()
        web.post(
            "/delete_application_dbs",
            {"app_id": self.app_id, "domain": self.domain, "username": self.hq.username, "restoreAs": None},
        )

    def _values(self, question: Mapping[str, Any]) -> list[str]:
        if question.get("datatype") == "info":
            return list(self.answer_table["controls"]["trigger"])
        kind = media_kind(question)
        if kind is not None:
            return list(self.answer_table["novaKinds"].get(kind, ()))
        name = DATA_TYPES.get(question.get("datatype"))
        values = list(self.answer_table["dataTypes"].get(name, ())) if name else []
        today = self.clock.split("T", 1)[0]
        return [value.replace("@clock:today", today).replace("@clock:now", self.clock) for value in values]

    def _fill(self, web: WebApps, form: Mapping[str, Any]) -> tuple[list[dict], list[Mapping[str, Any]]]:
        """Answers each question once from the table, in the order Formplayer lists them as they become relevant."""
        session, tree = form["session_id"], form["tree"]
        tried: set[str] = set()
        attempts: list[dict] = []
        for _ in range(MAX_QUESTIONS):
            pending = next(
                (
                    node
                    for node in questions(tree)
                    if node.get("type") == "question"
                    and node.get("datatype") != "info"
                    and node.get("ix") not in tried
                    and self._values(node)
                ),
                None,
            )
            if pending is None:
                break
            tried.add(pending["ix"])
            kind = media_kind(pending)
            for value in self._values(pending)[:MAX_TRIES]:
                if kind is None:
                    answered = web.answer(session, pending["ix"], value)
                    attempts.append({"ix": pending["ix"], "value": value, "response": answered})
                else:
                    content = (CAPTURES_DIR / value).read_bytes()
                    answered = web.answer_media(session, pending["ix"], value, content, CONTENT_TYPES[value])
                    attempts.append({"ix": pending["ix"], "value": value, "media": kind, "response": answered})
                if answered.get("status") == "accepted":
                    tree = answered.get("tree", tree)
                    break
        return attempts, tree

    def _submit(self, web: WebApps, form: Mapping[str, Any], tree) -> Any:
        """The submission as the client makes it: every question's answer as the tree holds it, a label's as OK
        (``web_form_session.js::submitForm``, ``accumulateAnswers``)."""
        answers = {
            node["ix"]: ("OK" if node.get("datatype") == "info" else node.get("answer"))
            for node in questions(tree)
            if node.get("type") == "question"
        }
        return web.submit(form["session_id"], answers)

    def execute(self, script: Sequence[Mapping[str, Any]], derive: bool):
        """One run of ``script``, inside the walk's scope for it; or, while deriving, the choices to branch on
        at the menu the script ends at."""
        with self.scope(json.dumps(list(script), sort_keys=True)):
            # Core's random source is seeded from each request's place in the run, whatever the same Formplayer
            # answered before it.
            self.runner.reseed()
            return self._execute(script, derive)

    def _execute(self, script: Sequence[Mapping[str, Any]], derive: bool):
        web = self._web()
        steps: list[dict] = []
        selections: list[str] = []
        query_data: dict[str, Any] = {}
        searched: set[str] = set()
        ran: list[Mapping[str, Any]] = []
        cursor = 0
        end = None
        asked_from = len(self.hq.asked)
        submissions_from = len(self.hq.submissions)

        def record(request, response):
            nonlocal asked_from
            steps.append({"request": request, "response": response, "asked": self.hq.asked[asked_from:]})
            asked_from = len(self.hq.asked)

        def navigate(**more):
            request = {"selections": list(selections), "query_data": json.loads(json.dumps(query_data)), **more}
            response = web.navigate(selections, query_data=query_data, **more)
            record(request, response)
            return response

        try:
            response = navigate()
            for _ in range(MAX_SCREENS):
                kind = screen_kind(response)
                if isinstance(response, dict) and isinstance(response.get("selections"), list):
                    selections = [str(selection) for selection in response["selections"]]
                if kind == "commands":
                    commands = response.get("commands") or []
                    if cursor < len(script):
                        choice = script[cursor]
                        cursor += 1
                        if "menu" not in choice or not 0 <= choice["menu"] < len(commands):
                            end = "unreplayable"
                            break
                    elif not commands:
                        end = "empty-menu"
                        break
                    elif derive:
                        return None, [{"menu": index} for index in range(len(commands))], ran
                    else:
                        end = "menu"
                        break
                    ran.append(choice)
                    selections = [*selections, str(choice["menu"])]
                    response = navigate()
                elif kind == "entities":
                    entities = response.get("entities") or []
                    actions = response.get("actions") or []
                    if cursor < len(script):
                        choice = script[cursor]
                        cursor += 1
                        taken = "entity" in choice and choice["entity"] in [entity.get("id") for entity in entities]
                        offered = "action" in choice and 0 <= choice["action"] < len(actions)
                        if not (taken or offered):
                            end = "unreplayable"
                            break
                    elif derive and fresh_actions(response, actions, ran):
                        # A list that offers actions (a search, a registration form) branches: its first case,
                        # then each action this run has not taken from this list already (a search's results
                        # are the same list again, offering the same search).
                        first = [{"entity": entities[0]["id"]}] if entities else []
                        return None, [*first, *fresh_actions(response, actions, ran)], ran
                    elif not entities:
                        end = "empty-list"
                        break
                    else:
                        choice = {"entity": entities[0]["id"]}
                    ran.append(choice)
                    if "action" in choice:
                        # The selection Web Apps sends for a list's action (menus/views.js, "action <index>").
                        selections = [*selections, f"action {choice['action']}"]
                        response = navigate()
                    elif response.get("multiSelect"):
                        selections = [*selections, USE_SELECTED_VALUES]
                        response = navigate(selected_values=[choice["entity"]])
                    else:
                        if response.get("hasDetails"):
                            # What the client asks when a worker opens a case before taking it.
                            detail_selections = [*selections, choice["entity"]]
                            detail = web.navigate(detail_selections, query_data=query_data, route="get_details")
                            record({"route": "get_details", "selections": detail_selections}, detail)
                        selections = [*selections, choice["entity"]]
                        response = navigate()
                elif kind == "query":
                    key = response.get("queryKey") or ""
                    if key in searched:
                        end = "search-not-run"
                        break
                    searched.add(key)
                    if cursor < len(script):
                        if script[cursor].get("search") != key:
                            end = "unreplayable"
                            break
                        cursor += 1
                    ran.append({"search": key})
                    typed = typed_inputs(response.get("displays") or (), self.answer_table.get("searchPrompts"))
                    if typed:
                        # First the search a worker sends after typing into its prompts (each a step of its
                        # own, which HQ's search view answers), then the search as Formplayer shows it.
                        probe = {**query_data, key: {"inputs": typed, "execute": True}}
                        try:
                            answered = web.navigate(selections, query_data=probe)
                        except FormplayerRefused as refused:
                            answered = {
                                "refused": {
                                    "status": refused.exchange.response.status,
                                    "body": refused.exchange.response.body.decode("utf-8", "replace"),
                                }
                            }
                        record({"selections": list(selections), "query_data": probe, "typed": True}, answered)
                    query_data = {**query_data, key: {"inputs": {}, "execute": True}}
                    response = navigate()
                elif kind == "form":
                    attempts, tree = self._fill(web, response)
                    submitted = self._submit(web, response, tree)
                    steps.append(
                        {
                            "answers": attempts,
                            "submit": submitted,
                            "asked": self.hq.asked[asked_from:],
                            "submissions": [
                                {"path": sent.path, "instance": sent.instance.decode("utf-8"), "files": len(sent.files)}
                                for sent in self.hq.submissions[submissions_from:]
                            ],
                        }
                    )
                    end = "submitted" if submitted.get("status") == "success" else "submit-refused"
                    break
                else:
                    end = "notification"
                    break
            else:
                end = "too-many-screens"
        except FormplayerRefused as refused:
            exchange = refused.exchange
            steps.append(
                {
                    "refused": {
                        "status": exchange.response.status,
                        "body": exchange.response.body.decode("utf-8", "replace"),
                    }
                }
            )
            end = "refused"
        return {"script": ran, "steps": steps, "end": end}, None, ran

    # -- every run -----------------------------------------------------------

    def run(self, script: Sequence[Sequence[Mapping[str, Any]]] | None = None) -> dict[str, Any]:
        """Every run's trace: derived where ``script`` is None, else each of its runs replayed."""
        runs = []
        started = time.perf_counter()
        with self.scope("forget-app"):
            self._forget_app()
        if script is not None:
            for steps in script:
                runs.append(self.execute(list(steps), derive=False)[0])
        else:
            pending: list[list[Mapping[str, Any]]] = [[]]
            while pending:
                if len(runs) + len(pending) > MAX_RUNS or time.perf_counter() - started > MAX_SECONDS:
                    raise AssertionError(
                        f"Formplayer's derived script grew past {MAX_RUNS} runs or {MAX_SECONDS} s"
                        f" ({len(runs)} run, {len(pending)} pending); the walk stopped exploring this app."
                    )
                run, branches, ran = self.execute(pending.pop(), derive=True)
                if branches is not None:
                    pending.extend([*ran, branch] for branch in reversed(branches))
                else:
                    runs.append(run)
        return {"derived": script is None, "clock": self.clock, "locale": self.locale, "runs": runs}


def script_of(trace: Mapping[str, Any]) -> list[list[Mapping[str, Any]]]:
    """The script a trace's runs ran, to replay on another build."""
    return [list(run["script"]) for run in trace["runs"]]


def marked(trace: Mapping[str, Any], *, archives: Sequence[bytes], restore: bytes) -> dict[str, Any]:
    """A trace with every id Formplayer generated marked (``canonical.mark``), the app and the restore its inputs."""
    given = canonical.given_ids([restore], archives)
    value, generated = canonical.mark(trace, given)
    return {**value, "generated": generated}
