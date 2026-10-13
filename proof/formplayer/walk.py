"""Formplayer's sessions over one app: every screen a worker reaches in Web Apps, and what Formplayer answers.

``walk`` runs scripted sessions against Formplayer as the Core runner runs
them against Core (``proof/core/src/nova/proof/core/SessionOp.java``), each a
sequence of the requests the Web Apps client sends (``proof.formplayer.
webapps``). Without a script one is derived: every command of every menu,
depth first in menu order; at each case list every case Formplayer lists, each
a run of its own (``proof.observe.walks.cases_opened``); at each search
screen each search a worker can send, each a run of its own
(``search_ways``): the prompts as Formplayer shows them, which is what the
client's Search sends of a screen no one touched (``shown_inputs``); the
prompts cleared (the client's Clear), where a default fills one and none is
required; and the prompts typed with the answer table's search answers
(``typed_inputs``), where that changes what is sent. Typing asks Formplayer
to validate each prompt as the client does (a request with ``execute``
false, marked ``validating``), and a prompt whose answer Formplayer refuses
is typed again with the table's next one (``retyped``), as a worker corrects
what the screen marks. A search the client would keep back, a prompt in
error or a required one left blank (``unsendable``), is never sent: the run
records what it held (``unsent``) and ends ``search-refused``.
Every derived run is then walked again in each other
language the app holds, the language chosen at the app's first screen as a
worker chooses it in Web Apps (``proof.observe.walks``): the client then
sends that locale on every request. With a script, each run replays it, and
a choice the screen cannot take ends that run as ``unreplayable``. A run that reaches a form answers its
questions from the lane's fixed answer table (``proof/core/answers.json``,
whose values are already in the encoding Web Apps sends Formplayer; a file
question, signature included, is given the table's file for its kind from
``proof/core/captures``, uploaded as the client uploads one, ``media_kind``
and ``WebApps.answer_media``), clears a question that refused every value
the table holds for it, as a worker who cannot satisfy it leaves it blank
(``CLEARED``), adds to each repeat a worker adds to as many instances as the
table says (``addable``, the table's ``repeats.add``, the count Core's and
Android's walks add), submits
it as the client does (``submission``: every question the client holds valid,
with the answer Formplayer last handed it, and ``prevalidated`` only where it
holds every one valid), and records Formplayer's answer, the submission HQ
received and the screen Formplayer's end of form navigation names next.

A run's ``end`` says where it ended. Three are the app's own: ``submitted``,
``empty-menu`` and ``empty-list``. Every other (``notification``,
``submit-refused``, ``search-refused``, ``search-not-run``, ``refused``,
``unreplayable``, ``language-unoffered``) is a stop, which
``proof.checks.stops`` holds to ``proof/walk-stops.json`` by name. The
walk's bounds (``MAX_RUNS``, ``MAX_SCREENS``, ``MAX_QUESTIONS``) are no end:
reaching one raises ``WalkBound``.

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
from collections.abc import Callable, Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from proof.core.client import DEFAULT_CLOCK
from proof.formplayer import canonical
from proof.formplayer.client import FormplayerRunner, HqHandler
from proof.formplayer.webapps import FormplayerRefused, WebApps
from proof.observe import walks

ANSWERS_PATH = Path(__file__).resolve().parents[1] / "core" / "answers.json"
# The walk's bounds: safety nets against a session that does not end, far past what any app the lane walks
# reaches (runs of a derived walk, screens of a run, answers of a form). Reaching one raises ``WalkBound``; none is
# a run's end, and none is a time, which a loaded machine would reach where an idle one does not.
MAX_RUNS = 500
MAX_SCREENS = 400
MAX_QUESTIONS = 2000
# The answers the walk tries a question with before it leaves it unanswered.
MAX_TRIES = 3
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
# The answer the client sends for a question a worker cleared (``form_entry/const.js``, ``NO_ANSWER``: every
# entry's cleared widget, ``entries.js``): no answer, which a trace keeps as JSON's null.
CLEARED = None


# How the client joins a prompt's several values, and writes a date range (``menus/views/query.js``:
# ``selectDelimiter``, which Formplayer uses too, ``serverPrefix``, ``serverSeparator`` and the picker's own
# separator between the two dates of a default).
SELECT_DELIMITER = "#,#"
RANGE_PREFIX = "__range__"
RANGE_SEPARATOR = "__"
RANGE_SHOWN = " to "


def shown_inputs(displays) -> dict[str, str]:
    """What the client sends of a search screen a worker has not touched (``query_data`` inputs), from the
    prompts as Formplayer hands them: each prompt's value as the client reads it into its field and writes it
    back (``menus/views/query.js``, ``decodeValue`` then ``encodeValue``, which ``getAnswers`` sends for every
    prompt, a hidden one too): a default as it stands, a select's or a checkbox's several joined as Formplayer
    joins them, a date range as the range the server reads, and nothing for a prompt that holds none (or an
    address, which the client never sends)."""
    sent: dict[str, str] = {}
    for display in displays or ():
        if not isinstance(display, dict) or not display.get("id"):
            continue
        value, name = display.get("value"), display.get("input")
        if name == "address" or not isinstance(value, str):
            continue
        held = [part for part in value.split(SELECT_DELIMITER) if part != ""]
        if name in ("select", "checkbox"):
            if held:
                sent[display["id"]] = SELECT_DELIMITER.join(held)
        elif len(held) == 1:
            if name == "daterange":
                dates = held[0].replace(RANGE_PREFIX, "").replace(RANGE_SHOWN, RANGE_SEPARATOR)
                sent[display["id"]] = RANGE_PREFIX + dates
            else:
                sent[display["id"]] = held[0]
    return sent


def unsendable(displays, inputs: Mapping[str, str]) -> list[str]:
    """The prompts for which the client keeps a search from being sent, by id (``menus/views/query.js``,
    ``inputsHaveErrors`` over each prompt's ``getError``): one Formplayer's last answer marks in error, and a
    required one that holds nothing (or blank space alone). The client then shows "Please check the following
    fields" and asks Formplayer nothing."""
    kept = []
    for display in displays or ():
        if not isinstance(display, dict) or not display.get("id"):
            continue
        answer = inputs.get(display["id"])
        blank = answer is None or (answer != "" and "".join(answer.split()) == "")
        if display.get("error") or (display.get("required") and blank):
            kept.append(display["id"])
    return kept


def search_ways(key: str, displays, answers) -> list[dict]:
    """The searches a worker can send from a search screen, each a choice of a script: the prompts as the screen
    shows them (``{"search": key}``, a default left in its prompt); where a prompt holds a default and none is
    required, the screen's own Clear first (``walks.CLEARED``); and where the answer table types something the
    screen does not already show, its search answers typed in (``walks.TYPED``)."""
    shown = shown_inputs(displays)
    ways = [{"search": key}]
    required = any(isinstance(display, dict) and display.get("required") for display in displays or ())
    if shown and not required:
        ways.append({"search": key, walks.PROMPTS: walks.CLEARED})
    if {**shown, **typed_inputs(displays, answers)} != shown:
        ways.append({"search": key, walks.PROMPTS: walks.TYPED})
    return ways


def retyped(display: Mapping[str, Any], answers) -> list[str]:
    """What a worker types next into a prompt whose answer the screen refused (Formplayer's validation of it, the
    error the client shows under the field): the answer table's ``searchPrompts.retyped`` for the prompt's input,
    in order, as a form's question is tried with the table's next value. Only a text prompt has another answer
    to give (a capitalised text, a whole number, a place: what a prompt's validation asks for); an option is the
    one the screen offers."""
    name = display.get("input") or "text"
    return [str(value) for value in ((answers or {}).get("retyped") or {}).get(name) or ()]


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


# The data types the Web Apps client draws a widget for (``entries.js::getEntry``, Formplayer's names as
# ``form_entry/const.js`` holds them): a question of any other (a date and time) is drawn as unsupported, with
# nothing a worker can answer it with.
CLIENT_DATA_TYPES = frozenset(
    {"str", "barcode", "int", "longint", "float", "select", "multiselect", "date", "time", "geo", "info"}
)
# Formplayer's name for a question's style that asks for an address, which the client answers only with the
# geocoder (``const.js``, ``ADDRESS``).
ADDRESS = "address"


def answerable(question: Mapping[str, Any]) -> bool:
    """Whether the Web Apps client draws a widget a worker answers ``question`` with (``entries.js::getEntry``):
    a question of a data type it supports, but an address (which needs the project space's geocoder, which no
    Nova export asks for) and a file question of a control it draws no chooser for. The walk answers only what a
    worker in Web Apps can, so its submission is the client's."""
    datatype = question.get("datatype")
    if datatype == "binary":
        return media_kind(question) is not None
    style = question.get("style") if isinstance(question.get("style"), dict) else {}
    if datatype in ("str", "barcode") and ADDRESS in str(style.get("raw") or "").split():
        return False
    return datatype in CLIENT_DATA_TYPES


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


def chosen_as_the_client_answers(question: Mapping[str, Any], value: str) -> str:
    """A choice the answer table gives a select or a multi-select (its options' 1-based indices, space-separated)
    as the Web Apps client answers it: the client binds each option to its label (``entry_select.html``,
    ``checkedValue: $data``), so options that share a label are one choice, and the answer it sends names the
    first option of each chosen label (``entries.js``, ``SingleSelectEntry`` and ``MultiSelectEntry``:
    ``_.indexOf(choices, value)``)."""
    style = question.get("style") if isinstance(question.get("style"), dict) else {}
    styles = set(str(style.get("raw") or "").split())
    # The styles under which the client draws another widget (``entries.js::getEntry``: a drop-down, a
    # combobox, buttons, a table of choice labels), each of which answers by the option's own index.
    drawn_otherwise = {"minimal", "label"} | (
        {"combobox", "button-select", "list-nolabel"} if question.get("datatype") == "select" else set()
    )
    if styles & drawn_otherwise:
        return value
    choices = list(question.get("choices") or [])
    found: list[str] = []
    for index in str(value).split():
        if not index.isdigit() or not 0 < int(index) <= len(choices):
            found.append(index)
            continue
        first = str(choices.index(choices[int(index) - 1]) + 1)
        if first not in found:
            found.append(first)
    return " ".join(found)


# An attempt of a form's step that is no answer: a repeat's Add pressed (``{"ix": ..., "repeat": "add"}``).
REPEAT = "repeat"


def addable(node: Mapping[str, Any], adds: int) -> bool:
    """Whether ``node`` is a repeat's Add a worker presses: where a repeat a worker adds to ends, Formplayer hands
    the client a group that does not exist yet with the text of its Add button (``add-choice``), at the index the
    next repetition takes (``<repeat>_<n>``), and the walk presses it while the repeat holds fewer than the
    answer table adds (``repeats.add``, as the Core runner adds them)."""
    if node.get("type") != "sub-group" or node.get("repeatable") != "true" or node.get("exists") != "false":
        return False
    _, _, held = str(node.get("ix") or "").rpartition("_")
    return held.isdigit() and int(held) < adds


# What the client holds as the answer of a question it draws no widget for, from the moment it draws the question
# until Formplayer's next answer brings the form's own (``entries.js::UnsupportedEntry`` sets it as the entry is
# made; ``form_ui.js``, ``Container.fromJS`` then maps Formplayer's answer over it on every later answer).
UNSUPPORTED = "Not Supported by Web Entry"


def drawn_with(question: Mapping[str, Any]) -> Any:
    """What the client holds of a question as it first draws it: Formplayer's answer, or, for a question it draws
    no widget for (``answerable``), the text its unsupported entry puts there (``UNSUPPORTED``)."""
    return question.get("answer") if answerable(question) else UNSUPPORTED


def submission(
    tree: Sequence[Mapping[str, Any]], refused: set[str], held: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """What the Web Apps client submits of a form (``web_form_session.js::submitForm``, ``accumulateAnswers``):
    each question it holds valid, by its index, with the answer Formplayer last handed it (a label's as ``OK``),
    and ``prevalidated`` only where it holds every question valid. A question is not valid while Formplayer's
    last answer to it was a validation error (``form_ui.js``, ``session.reconcile`` sets its ``serverError``, and
    the next answer it takes clears it): ``refused`` holds those, by index. A question the client drew no widget
    for after Formplayer's last answer still holds its unsupported entry's text, which the client submits as its
    answer: ``held`` is what the client holds of each question (``Walk._fill``), and names those."""
    answers, prevalidated = {}, True
    for node in questions(tree):
        if node.get("type") != "question":
            continue
        if str(node.get("ix")) in refused:
            prevalidated = False
            continue
        if node.get("datatype") == "info":
            answers[node["ix"]] = "OK"
        elif held is not None and not answerable(node) and held.get(str(node.get("ix"))) == UNSUPPORTED:
            answers[node["ix"]] = UNSUPPORTED
        else:
            answers[node["ix"]] = node.get("answer")
    return {"answers": answers, "prevalidated": prevalidated}


def _echoed(tree, ix) -> tuple[bool, Any]:
    """Whether Formplayer's tree holds the question at ``ix``, and its answer there."""
    node = next((node for node in questions(tree or ()) if str(node.get("ix")) == str(ix)), None)
    return node is not None, None if node is None else node.get("answer")


def _sent_alike(echo, sent) -> bool:
    """Whether Formplayer's answer for a question is the one the client sent it: the client sends a number as a
    number and a multiple choice as a list of numbers (``entries.js``, each entry's ``onPreProcess``), where the
    walk writes each as text, so the two are read alike in those spellings."""
    if echo == sent:
        return True
    if isinstance(echo, list):
        return " ".join(str(item) for item in echo) == str(sent)
    if isinstance(echo, (int, float)) and not isinstance(echo, bool):
        try:
            return float(sent) == float(echo)
        except (TypeError, ValueError):
            return False
    return False


def _held_after(tree, ix, sent, kind, held):
    """What the client holds of the question it just answered once Formplayer's answer arrives (``form_ui.js``,
    the mapping's ``update``): Formplayer's answer where it is the one sent (the question no longer dirty), else
    what was sent (still dirty, kept as the person left it); a file question keeps whatever Formplayer hands
    back."""
    found, echo = _echoed(tree, ix)
    if not found:
        return held.get(str(ix))
    if kind is not None or _sent_alike(echo, sent):
        return echo
    return sent


class WalkBound(AssertionError):
    """A run of the walk reached one of the walk's own bounds. A bound is a safety net against a session that does
    not end, and reaching one fails the observation by its name: a run cut short at one would have every check
    pass with the rest of it unseen."""


def _search(inputs: Mapping[str, str], selections: Sequence[str]) -> dict[str, Any]:
    """A search's entry of ``query_data`` as Web Apps writes it, but whether it is run (``utils.js::
    CloudcareUrl.setQueryData``): the prompts' values, the search forced to wait for the worker's Search (every
    search Web Apps shows beside its list is: ``router.js``, ``menu:query``, and ``query.js``'s own question of
    whether the prompts hold), and the selections that led to the screen."""
    return {"inputs": dict(inputs), "force_manual_search": True, "selections": list(selections)}


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
    # The languages the app holds, its default first (``proof.observe.walks``): a run starts in the default, and
    # a derived walk is walked again in each other.
    languages: Sequence[str] = ()
    # The locale every request names until a run chooses another; by default the app's default language, which
    # is what the Web Apps page sends for a worker who never chose one.
    locale: str | None = None
    answer_table: Mapping[str, Any] = field(default_factory=load_answer_table)
    clock: str = DEFAULT_CLOCK
    # The place the Web Apps client's map gave each location question of a run (``proof.webapps.observe.
    # places_given``), by the run's choices (``walks.run_key``) and the question's index: a derived run that
    # reaches its form answers each such question with it, and keeps it in its script (``{"places": ...}``).
    places: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    # The places a phone's map gave, where they are not a desktop's: each such run is walked again with them, as
    # the run the phone replays (``walks.WINDOW``).
    small_places: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    # The answer table's places the worker dragged each location question's map toward to give its place, by the
    # run and the question's index (``walks.TOWARD``), which the walk keeps with each place for the client's
    # replay to make the same drags.
    toward: Mapping[str, Mapping[str, Sequence[str]]] = field(default_factory=dict)
    # What each run happens inside: a context manager made from the run's name. Where HQ answers with its own
    # views over a unit's state (``proof.formplayer.hq.Served.run``) it is a fork of that state with the worker
    # signed in, so no run reads what another's submission left in HQ.
    scope: Callable[[str], Any] = lambda name: nullcontext()

    @classmethod
    def of(cls, served, *, runner=None, app_id: str | None = None, scope=None, places=None) -> Walk:
        """The walk of a state HQ serves (``proof.formplayer.hq.Served``) in every language its app holds, each
        run in a run of the state (``Served.run``) unless ``scope`` says otherwise; ``app_id`` names an archive HQ
        does not hold in place of the released build (Nova's local archive), and ``places`` the place the
        client's map gave each location question on a desktop and on a phone (``proof.observe.walks.Places``)."""
        return cls(
            runner or served.runner,
            served.hq,
            domain=served.domain,
            app_id=app_id or served.build_id,
            languages=served.languages,
            scope=scope or served.run,
            places=dict(places.desktop) if places else {},
            small_places=dict(places.small) if places else {},
            toward=dict(places.toward) if places else {},
        )

    # -- one execution -----------------------------------------------------

    def _client(self) -> WebApps:
        """The worker's browser: the session HQ holds for them."""
        return WebApps(
            self.runner,
            self.hq,
            domain=self.domain,
            username=self.hq.username,
            app_id=self.app_id,
            locale=self.locale if self.locale is not None else walks.default_language(self.languages),
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

    def _values(self, question: Mapping[str, Any], given: Mapping[str, Any] | None = None) -> list[Any]:
        if not answerable(question):
            # Nothing a worker in Web Apps can give it.
            return []
        if given and question.get("datatype") == "geo" and str(question.get("ix")) in given:
            # The place the client's map gave it: the client answers a location question with its map's centre,
            # to the pixel a drag brings it, so the walk gives what the client gives.
            return [given[str(question.get("ix"))]]
        if question.get("datatype") == "info":
            return list(self.answer_table["controls"]["trigger"])
        kind = media_kind(question)
        if kind is not None:
            return list(self.answer_table["novaKinds"].get(kind, ()))
        name = DATA_TYPES.get(question.get("datatype"))
        values = list(self.answer_table["dataTypes"].get(name, ())) if name else []
        today = self.clock.split("T", 1)[0]
        values = [value.replace("@clock:today", today).replace("@clock:now", self.clock) for value in values]
        if question.get("datatype") in ("select", "multiselect"):
            values = list(dict.fromkeys(chosen_as_the_client_answers(question, value) for value in values))
        return values

    def _fill(
        self, web: WebApps, form: Mapping[str, Any], given: Mapping[str, Any] | None = None, toward=None
    ) -> tuple[list[dict], list[Mapping[str, Any]], set[str], list[dict], dict[str, Any]]:
        """Answers each question once from the table, in the order Formplayer lists them as they become relevant,
        clears one that refused every value the table holds for it (``CLEARED``), and presses each repeat's Add
        where a worker reaches it (``addable``); with the attempts, the form's tree as the last accepted answer
        left it, the questions whose last answer Formplayer refused as invalid (``submission``), what the
        client sent of its own along the way (``_reconcile``), and what the client holds of each question at the
        end. A location question ``given`` a place is answered
        with it, its attempt keeping the table's places the client's map was dragged ``toward`` to give it."""
        session, tree = form["session_id"], form["tree"]
        tried: set[str] = set()
        refused: set[str] = set()
        attempts: list[dict] = []
        # What the client holds of each question it has drawn: the answer Formplayer last handed it, or the one it
        # last sent while that request is in flight (``form_ui.js``, ``pendingAnswer``); as it opens the form,
        # what it draws each question with (``drawn_with``).
        held = {str(node.get("ix")): drawn_with(node) for node in questions(tree) if node.get("type") == "question"}
        resent: list[dict] = []
        adds = int((self.answer_table.get("repeats") or {}).get("add") or 0)
        for _ in range(MAX_QUESTIONS):
            pending = next(
                (
                    node
                    for node in questions(tree)
                    if node.get("ix") not in tried
                    and (
                        addable(node, adds)
                        or (
                            node.get("type") == "question"
                            and node.get("datatype") != "info"
                            and self._values(node, given)
                        )
                    )
                ),
                None,
            )
            if pending is None:
                break
            tried.add(pending["ix"])
            if addable(pending, adds):
                # The repeat's own Add, pressed where a worker reaches it (``form_ui.js``, ``Group.newRepeat``;
                # ``web_form_session.js::newRepeat``): Formplayer hands back the form with the new repetition,
                # whose questions are then answered in their turn, and the client reconciles it as any answer.
                added = web.form_request("new-repeat", session, ix=pending["ix"])
                attempts.append({"ix": pending["ix"], REPEAT: "add", "response": added})
                if isinstance(added.get("tree"), list):
                    tree = self._reconcile(
                        web, session, added["tree"], held, refused, resent, pending, len(attempts) - 1
                    )
                continue
            kind = media_kind(pending)
            values = list(self._values(pending, given)[:MAX_TRIES])
            if kind is None:
                # Where the form refuses every answer the table holds for the question, a worker leaves it
                # unanswered: the widget cleared (``CLEARED``), which the client sends as no answer and Formplayer
                # takes unless the question is required. The form's validation then stands in the way of nothing
                # else, and the run goes on to what the form does once it is submitted.
                values.append(CLEARED)
            for value in values:
                if value is CLEARED and str(pending["ix"]) not in refused:
                    break
                if kind is None:
                    answered = web.answer(session, pending["ix"], value)
                    attempt = {"ix": pending["ix"], "value": value, "response": answered}
                    if given and str(pending["ix"]) in given and (toward or {}).get(str(pending["ix"])):
                        attempt[walks.TOWARD] = list(toward[str(pending["ix"])])
                    attempts.append(attempt)
                else:
                    content = (CAPTURES_DIR / value).read_bytes()
                    answered = web.answer_media(session, pending["ix"], value, content, CONTENT_TYPES[value])
                    attempts.append({"ix": pending["ix"], "value": value, "media": kind, "response": answered})
                # The client marks a question invalid on a validation error and valid again on the next answer
                # Formplayer takes (``form_ui.js``, ``session.reconcile``).
                if answered.get("status") == "validation-error":
                    refused.add(str(pending["ix"]))
                else:
                    refused.discard(str(pending["ix"]))
                if answered.get("status") == "accepted":
                    held[str(pending["ix"])] = _held_after(answered.get("tree"), pending["ix"], value, kind, held)
                    tree = self._reconcile(
                        web, session, answered.get("tree", tree), held, refused, resent, pending, len(attempts) - 1
                    )
                    break
        else:
            raise WalkBound(
                f"The form {form.get('title')!r} still held a question to answer after {MAX_QUESTIONS} of them"
                " (proof/formplayer/walk.py::MAX_QUESTIONS); the walk stopped, and the form has no end to record."
            )
        return attempts, tree, refused, resent, held

    def _reconcile(self, web, session, tree, held, refused, resent, answered_node, after):
        """The client's own answers after Formplayer's answer to one of its requests (``form_ui.js``,
        ``session.reconcile``): each question the client has drawn takes the answer Formplayer handed back, but
        the one whose answer was just sent, which keeps what was sent, and one Formplayer last refused, which
        keeps its own; and a question whose answer that changes sends it to Formplayer as its answer
        (``entries.js``, ``onAnswerChange``: a single answer, or a list of them that differs, calls the
        question's ``onchange``), whose answer the client reconciles in turn. Formplayer hands back a stored
        text answer trimmed once it reads the form again, so the client sends the trimmed text as that
        question's answer; the walk sends what the client sends, in the form's order, until nothing changes,
        and returns the tree Formplayer last handed back. Each answer sent so is kept in ``resent``, with the
        place of the attempt it followed (``after``)."""
        just = str(answered_node.get("ix"))
        for _ in range(MAX_QUESTIONS):
            changed = None
            for node in questions(tree):
                if node.get("type") != "question":
                    continue
                ix = str(node.get("ix"))
                if ix not in held:
                    # A question the client draws now for the first time is made with Formplayer's answer, or,
                    # with no widget for it, with its unsupported entry's text.
                    held[ix] = drawn_with(node)
                    continue
                if ix == just or ix in refused or node.get("answer") == held[ix]:
                    continue
                held[ix] = node.get("answer")
                if changed is None and self._resends(node):
                    changed = node
            if changed is None:
                return tree
            ix = str(changed.get("ix"))
            sent = held[ix]
            answered = web.answer(session, changed["ix"], sent)
            resent.append({"ix": changed["ix"], "value": sent, "after": after, "response": answered})
            just = ix
            if answered.get("status") != "accepted":
                return tree
            tree = answered.get("tree", tree)
            held[ix] = _held_after(tree, ix, sent, None, held)
        raise WalkBound(
            f"Formplayer went on changing the form's answers after the client had sent {MAX_QUESTIONS} of them back"
            " (proof/formplayer/walk.py::MAX_QUESTIONS); the walk stopped, and the form has no end to record."
        )

    @staticmethod
    def _resends(node: Mapping[str, Any]) -> bool:
        """Whether the client sends a question's answer when Formplayer changes it: a question it draws a widget
        for that holds an answer of its own (``entries.js``: every single-answer and multiple-answer entry), not a
        label, an unsupported question or a file, whose widget ignores what Formplayer hands back."""
        return answerable(node) and node.get("datatype") != "info" and media_kind(node) is None

    def _submit(self, web: WebApps, form: Mapping[str, Any], tree, refused: set[str], held) -> tuple[dict, Any]:
        """The submission as the client makes it (``submission``), and Formplayer's answer to it."""
        sent = submission(tree, refused, held)
        return sent, web.submit(form["session_id"], sent["answers"], prevalidated=sent["prevalidated"])

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
                if cursor < len(script) and walks.LANGUAGE in script[cursor]:
                    # A language chosen as a worker chooses it in Web Apps, from the menu over the app's screens
                    # (``menus/views.js::LanguageOptionView``): the client asks for the same screen in that locale
                    # (``web_form_session.js::changeLang``, ``menus/api.js``), and names it on every request after.
                    choice = script[cursor]
                    cursor += 1
                    if kind not in ("commands", "entities", "query"):
                        # The client draws that menu over a menu, a list or a search screen alone
                        # (``menus/controller.js::showMenu``).
                        end = "language-unoffered"
                        break
                    ran.append(choice)
                    web.locale = choice[walks.LANGUAGE]
                    response = navigate(locale=web.locale)
                    continue
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
                    elif derive and (len(entities) > 1 or fresh_actions(response, actions, ran)):
                        # A list branches: each case it lists (``proof.observe.walks.cases_opened``), then each
                        # action this run has not taken from this list already (a search's results are the same
                        # list again, offering the same search).
                        cases = [{"entity": case} for case in walks.cases_opened([e["id"] for e in entities])]
                        return None, [*cases, *fresh_actions(response, actions, ran)], ran
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
                        # Formplayer answered the search with the search screen again (its own check of the
                        # prompts refused it).
                        end = "search-not-run"
                        break
                    searched.add(key)
                    displays = response.get("displays") or ()
                    ways = search_ways(key, displays, self.answer_table.get("searchPrompts"))
                    if cursor < len(script):
                        choice = script[cursor]
                        cursor += 1
                        if choice.get("search") != key:
                            end = "unreplayable"
                            break
                    elif derive and len(ways) > 1:
                        # A search screen branches: each search a worker can send from it is a run of its own.
                        return None, ways, ran
                    else:
                        choice = ways[0]
                    ran.append(choice)
                    # What the client sends for the search: the prompts as it shows them, emptied by the
                    # screen's Clear, or with the answer table's search answers typed over them, each typed
                    # prompt followed by the client's own question to Formplayer of whether the prompts hold
                    # (``query.js::_updateModelsForValidation``), whose answer it reads each prompt's error from.
                    inputs = shown_inputs(displays)
                    selected = list(selections)
                    if choice.get(walks.PROMPTS) == walks.CLEARED:
                        # Clear empties every prompt and forgets each one's error (``QueryView.clear``).
                        inputs = {}
                        displays = [{**display, "error": None} for display in displays if isinstance(display, dict)]
                    elif choice.get(walks.PROMPTS) == walks.TYPED:
                        answers = self.answer_table.get("searchPrompts")
                        prompts = {each.get("id"): each for each in displays if isinstance(each, dict)}
                        for prompt, first in typed_inputs(displays, answers).items():
                            # The table's answer, then, while the screen refuses what was typed, its next one.
                            for value in (first, *retyped(prompts[prompt], answers)):
                                if inputs.get(prompt) == value:
                                    # A field that already holds the answer does not change, and the client
                                    # asks nothing for it.
                                    break
                                inputs = {**inputs, prompt: value}
                                asking = {
                                    **query_data,
                                    key: {**_search(inputs, selected), "execute": False},
                                }
                                checked = web.navigate(selections, query_data=asking)
                                record({"selections": selected, "query_data": asking, "validating": prompt}, checked)
                                if screen_kind(checked) != "query":
                                    break
                                displays = checked.get("displays") or ()
                                if not any(
                                    isinstance(each, dict) and each.get("id") == prompt and each.get("error")
                                    for each in displays
                                ):
                                    break
                    kept = unsendable(displays, inputs)
                    if kept:
                        # The client sends nothing: it marks the prompts and stays (``query.js::performSubmit``).
                        steps.append({"unsent": {"search": key, "inputs": inputs, "prompts": kept}})
                        end = "search-refused"
                        break
                    query_data = {**query_data, key: {**_search(inputs, selected), "execute": True}}
                    response = navigate()
                elif kind == "form":
                    # The places the client's map gave the form's location questions, with the table's places it
                    # was dragged toward to give them: the script's own, where it is replayed, else those the walk
                    # was handed for this run.
                    given, toward = None, None
                    if cursor < len(script) and walks.PLACES in script[cursor]:
                        given, toward = script[cursor][walks.PLACES], script[cursor].get(walks.TOWARD)
                        ran.append(dict(script[cursor]))
                        cursor += 1
                    elif cursor >= len(script):
                        key = walks.run_key(ran)
                        given, toward = self.places.get(key), self.toward.get(key, {})
                        if given:
                            ran.append(walks.places_choice(given, toward))
                    attempts, tree, refused, resent, held = self._fill(web, response, given, toward)
                    sent, submitted = self._submit(web, response, tree, refused, held)
                    steps.append(
                        {
                            "answers": attempts,
                            "resent": resent,
                            "submitted": sent,
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
                # A safety net, never a run's end: no app the lane walks comes near it.
                raise WalkBound(
                    f"Formplayer's run of the choices {list(ran)!r} met more than {MAX_SCREENS} screens"
                    " (proof/formplayer/walk.py::MAX_SCREENS); the walk stopped, and the run has no end to record."
                )
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
        """Every run's trace: derived where ``script`` is None, each derived run then walked again in each other
        language the app holds (``proof.observe.walks.in_every_language``), and each run a phone gives other places
        walked again with them (``small_places``); else each of the script's runs replayed."""
        runs = []
        with self.scope("forget-app"):
            self._forget_app()
        if script is not None:
            for steps in script:
                runs.append(self.execute(list(steps), derive=False)[0])
        else:
            pending: list[list[Mapping[str, Any]]] = [[]]
            while pending:
                if len(runs) + len(pending) > MAX_RUNS:
                    raise WalkBound(
                        f"Formplayer's derived script grew past {MAX_RUNS} runs (proof/formplayer/walk.py::MAX_RUNS;"
                        f" {len(runs)} run, {len(pending)} pending); the walk stopped exploring this app."
                    )
                run, branches, ran = self.execute(pending.pop(), derive=True)
                if branches is not None:
                    pending.extend([*ran, branch] for branch in reversed(branches))
                else:
                    runs.append(run)
            derived = [list(run["script"]) for run in runs]
            for steps in walks.in_every_language(derived, self.languages)[len(derived) :]:
                runs.append(self.execute(steps, derive=False)[0])
            # Each run whose places a phone's map gives otherwise, walked again with the phone's.
            for run in list(runs):
                key = walks.run_key(run["script"])
                small = self.small_places.get(key)
                if small and small != walks.places_of(run["script"]):
                    chosen = walks.places_choice(small, self.toward.get(key, {}), window="small")
                    runs.append(self.execute([*walks.navigation(run["script"]), chosen], derive=False)[0])
        locale = self.locale if self.locale is not None else walks.default_language(self.languages)
        return {"derived": script is None, "clock": self.clock, "locale": locale, "runs": runs}


def script_of(trace: Mapping[str, Any]) -> list[list[Mapping[str, Any]]]:
    """The script a trace's runs ran, to replay on another build."""
    return [list(run["script"]) for run in trace["runs"]]


def marked(trace: Mapping[str, Any], *, archives: Sequence[bytes], restore: bytes) -> dict[str, Any]:
    """A trace with every id Formplayer generated marked (``canonical.mark``), the app and the restore its inputs."""
    given = canonical.given_ids([restore], archives)
    value, generated = canonical.mark(trace, given)
    return {**value, "generated": generated}
