"""Two served states compared as their readers read them: Formplayer's traces and the Web Apps client's screens.

A document's unit serves a state of its app to Formplayer and to the Web
Apps client (``proof.observe.served``) and keeps Formplayer's trace of its
walk (``proof.formplayer.walk``) and the client's screens on that walk
(``proof.webapps.observe``). Proof 3 compares two states' records (Nova's
local archive and B aligned to A, each with A) and proof 4 a save's with
the state it was made over; both compare them here, and nothing here runs
either reader.

**Formplayer's trace** (``formplayer_differences``) is Formplayer's own JSON
for every request of every run, compared as a tree after it is read the way
the client reads it (``comparable_trace``):

- a list of cases (a response's ``entities``) is read by the case each row
  selects, as the client keys a row, with the order the rows came in beside
  it (``entityOrder``), so a list that comes in another order shows that
  once and not again as every field of every row it moved;
- a form's answers are each the question, the value sent and whether
  Formplayer took it; the form's question tree is compared once, as it
  stands after the last answer (every answer's response carries the whole
  tree again);
- each XML document Formplayer hands back or sends (a form's instance, a
  submission HQ received) is parsed and compared as a tree, its names read
  as a form's data and whitespace-only text as none (``compare.xml_tree``;
  Formplayer writes an instance indented);
- what names a build and not what a worker reads is left out: the app's
  version in ``appVersion`` (each build HQ makes has its own, as proof 2's
  version clause holds), the address in a refused request's ``url`` (the
  runner's port), and how many ids a run generated (the difference is where
  they are). An id Formplayer or Core drew is read as one drawn there
  (``@generated``), whichever of a run's ids it was;
- one symptom is one difference (``one_symptom``). Where the two sides
  answer one request with screens of two kinds (a list on one side, an
  error on the other), that is the difference, at the response's ``type``,
  with each side's kind and what Formplayer said, and the screens' fields
  are not compared one by one; the same for the screen a submission leads
  to. The run has then left the walk, so what either side did after it is
  not compared. Where one side's submission was taken and the other's
  refused, that is the difference, at the submit's ``status``, with what
  Formplayer said, and what follows from it (the submission HQ did not
  receive, the screen that did not come next, how the run ended) is not
  reported again.

Where the two sides' forms carry other namespaces (Nova's local archive
against HQ's build: proof 1 holds identity), ``xmlns`` maps the other side's
to the baseline's, in the trace's values and in its XML documents.

Where a question's value is not one of its choices, Core names the question
in its message by the id of its label's text
(``javarosa/core/model/data/helper/Selection.java::attachChoice``). HQ's
build keeps one id for every group of texts that are the same in every
language and rewrites each reference to the others
(``xform.py::XForm.normalize_itext``), so the same question of the same form
is named by another id on HQ's build than on Nova's local archive.
``text_ids`` maps the local archive's id to HQ's (``merged_text_ids``, read
from the two forms themselves: the reference in the same place of HQ's form
names another id, and the local form holds the same texts under both), and
the local side's messages are read with it. A
message that names another question stays a difference.

**The client's screens** (``webapps_differences``) are compared the same
way: a case list's rows by the case each selects with their order beside
them, the client's own home tiles by their kind, without the build's
version, which the page writes into a corner, and one symptom one
difference (``one_screen``): two screens of two kinds are their kinds, and
a run the client stopped following is where it stopped; what became of a
form's answers and Submit is compared only where both runs followed the walk
to it.

**HQ's refusals** (``refusal_differences``) are absolute: each request an HQ
view did not answer 2xx while a state was walked is a difference of that
state, by the view, the status, and what HQ said or raised
(``/hq/<view>/<status>/<what HQ said>``, ``/hq/<view>/<status>/<class>``).
A worker sees each as an error.
"""

from __future__ import annotations

import copy
import re
from dataclasses import replace

from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.spelling import normalized
from proof.checks.compare.trace import map_strings, renamespace
from proof.checks.compare.xml_tree import XmlNotWellFormed, compare_xml_trees, parse_xml
from proof.checks.differences import Difference, pointer_token

# What stands where a pulled XML document was (the document itself is compared as a tree).
XML = "<xml>"
# The artifact a spelling rule names to read Formplayer's trace as it is compared (``proof.rules``).
FORMPLAYER = "formplayer"
# A generated id's mark as a trace writes it (``proof.formplayer.canonical.TOKEN`` and its number), and as read.
GENERATED_MARK = re.compile(r"@generated:uuid:[0-9]+")
GENERATED = "@generated"
# Where Formplayer's trace holds an XML document: a submission's instance, and a form's instance as an answer or
# a submission's response hands it back (``instanceXml.output``).
XML_KEYS = frozenset({"instance", "output"})
# Maps of a trace whose keys are the app's data: a list's cases by the case each row selects, and a search's
# inputs by its prompts.
TRACE_DATA_MAPS = frozenset(
    {
        "/runs/*/steps/*/response/entities",
        "/runs/*/steps/*/response/translations",
        "/runs/*/steps/*/request/query_data",
        "/runs/*/steps/*/request/query_data/*/inputs",
        "/runs/*/steps/*/submit/nextScreen/entities",
    }
)
SCREEN_DATA_MAPS = frozenset({"/runs/*/screens/*/list/rows", "/home/list/rows"})
# The home screen's tile for an app, as the client classes it; every other tile is the client's own, one of a kind.
APP_TILE = "default"
# Fields that name a build or the runner, never what a worker reads.
TRACE_LEFT_OUT = frozenset({"appVersion", "url"})
SCREEN_LEFT_OUT = frozenset({"version"})


def _without(value, names):
    if isinstance(value, dict):
        return {key: _without(item, names) for key, item in value.items() if key not in names}
    if isinstance(value, list):
        return [_without(item, names) for item in value]
    return value


def _keyed(rows, key):
    """A list of rows as ``(rows by key, the keys in order)``, or None where a row has no key or two share one."""
    if not isinstance(rows, list) or not all(isinstance(row, dict) and row.get(key) is not None for row in rows):
        return None
    keys = [str(row[key]) for row in rows]
    if len(set(keys)) != len(keys):
        return None
    return {str(row[key]): {name: value for name, value in row.items() if name != key} for row in rows}, keys


def _by_case(value):
    """Every ``entities`` list of a Formplayer answer read by the case each row selects, its order beside it."""
    if isinstance(value, dict):
        shown = {key: _by_case(item) for key, item in value.items()}
        keyed = _keyed(value.get("entities"), "id")
        if keyed is not None:
            shown["entities"], shown["entityOrder"] = keyed
        return shown
    if isinstance(value, list):
        return [_by_case(item) for item in value]
    return value


def _form_step(step):
    """A form's step as compared: each answer, and each the client sent of its own (``resent``), as the question,
    the value and Formplayer's verdict (a resent answer with the place of the answer it followed), and the
    question tree once, as it stands after the last of them."""
    shown = dict(step)
    tree = None

    def summary(sent):
        nonlocal tree
        response = sent.get("response") or {}
        if isinstance(response.get("tree"), list):
            tree = response["tree"]
        return {
            "ix": sent.get("ix"),
            "value": sent.get("value"),
            "status": response.get("status"),
            "reason": response.get("reason"),
            "type": response.get("type"),
        }

    answers, resent = [], []
    sent_after = {}
    for sent in step.get("resent") or []:
        sent_after.setdefault(sent.get("after"), []).append(sent)
    for position, answer in enumerate(step.get("answers") or []):
        answers.append(summary(answer))
        resent.extend({**summary(sent), "after": position} for sent in sent_after.get(position, ()))
    if "resent" in step:
        shown["resent"] = resent
    shown["answers"] = answers
    if tree is not None:
        shown["tree"] = tree
    return shown


def _unnumbered(value):
    """Each generated id's mark (``@generated:uuid:<n>``) read as ``GENERATED``: an id's number is its place among
    the ids its own trace generated, which another trace's differences move."""
    if isinstance(value, str):
        return GENERATED_MARK.sub(GENERATED, value) if "@generated:uuid:" in value else value
    if isinstance(value, dict):
        return {_unnumbered(key): _unnumbered(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_unnumbered(item) for item in value]
    return value


def _kind(response):
    """What a response shows: Formplayer's ``type`` for a screen, ``form`` for a form, ``error`` for a refusal."""
    if not isinstance(response, dict):
        return None
    if response.get("status") == "error":
        return "error"
    if response.get("session_id") and isinstance(response.get("tree"), list):
        return "form"
    return response.get("type")


def _said(response):
    """A response's kind and, for an error, what Formplayer said, in place of its fields, where two sides' kinds
    differ: one value, so the difference is one."""
    if not isinstance(response, dict):
        return response
    kind = _kind(response)
    if kind != "error":
        return {"type": kind}
    notification = response.get("notification") if isinstance(response.get("notification"), dict) else {}
    return {"type": f"error: {notification.get('message') or _first_line(response.get('exception'))}"}


def _first_line(text):
    if not isinstance(text, str):
        return None
    line = text.strip().splitlines()[0] if text.strip() else ""
    # An HQ page handed back whole (a 404 or a 500 as HQ renders it) is named, not quoted.
    return "<an HTML page>" if line.lower().startswith(("<!doctype", "<html")) else line[:300]


def _one_kind(holder_a, holder_b, key):
    """Where two sides hold screens of two kinds under ``key``, each side's kind in place of its fields; whether
    they did."""
    a, b = holder_a.get(key), holder_b.get(key)
    if isinstance(a, dict) and isinstance(b, dict) and _kind(a) != _kind(b):
        holder_a[key], holder_b[key] = _said(a), _said(b)
        return True
    return False


def one_symptom(before, after):
    """Two comparable traces with each symptom left as one difference (the module's last point).

    A response of another kind is its kind alone on both sides, and so is the screen a submission leads to; the
    run has then left the walk, so what either side did after that step is not compared (its later steps, its
    script and how it ended). A submission one side had taken and the other refused is its status and what
    Formplayer said, with what follows from it taken out of both.
    """
    for run_a, run_b in zip(before.get("runs") or [], after.get("runs") or [], strict=False):
        if not isinstance(run_a, dict) or not isinstance(run_b, dict):
            continue
        steps_a, steps_b = run_a.get("steps") or [], run_b.get("steps") or []
        left = None
        for index, (step_a, step_b) in enumerate(zip(steps_a, steps_b, strict=False)):
            if not isinstance(step_a, dict) or not isinstance(step_b, dict):
                continue
            if _one_kind(step_a, step_b, "response"):
                left = index
                break
            submit_a, submit_b = step_a.get("submit"), step_b.get("submit")
            if isinstance(submit_a, dict) and isinstance(submit_b, dict):
                if submit_a.get("status") != submit_b.get("status"):
                    left = index
                    for step, submit in ((step_a, submit_a), (step_b, submit_b)):
                        notification = submit.get("notification")
                        said = notification.get("message") if isinstance(notification, dict) else None
                        step["submit"] = {"status": f"{submit.get('status')}: {said}" if said else submit.get("status")}
                        for consequence in ("submissions", "asked"):
                            step.pop(consequence, None)
                    break
                if _one_kind(submit_a, submit_b, "nextScreen"):
                    left = index
                    break
        if left is not None:
            for run in (run_a, run_b):
                run["steps"] = (run.get("steps") or [])[: left + 1]
                run.pop("end", None)
                run.pop("script", None)
    return before, after


def comparable_trace(trace):
    """Formplayer's trace as it is compared (the module's first list)."""
    shown = _unnumbered(copy.deepcopy(trace))
    for name in ("derived", "generated"):
        shown.pop(name, None)
    for run in shown.get("runs") or []:
        if not isinstance(run, dict):
            continue
        run["steps"] = [
            _form_step(step) if isinstance(step, dict) and "answers" in step else step
            for step in run.get("steps") or []
        ]
    return _by_case(_without(shown, TRACE_LEFT_OUT))


def _rows_by_case(value):
    """Every case list of a screen read by the case each row selects, its order beside it."""
    if isinstance(value, dict):
        shown = {key: _rows_by_case(item) for key, item in value.items()}
        listed = value.get("list")
        if isinstance(listed, dict):
            keyed = _keyed(listed.get("rows"), "id")
            if keyed is not None:
                shown["list"] = {**shown["list"], "rows": keyed[0], "rowOrder": keyed[1]}
        return shown
    if isinstance(value, list):
        return [_rows_by_case(item) for item in value]
    return value


def _tiles_by_kind(value):
    """Every screen's home tiles (``apps``) read as the client classes them: the apps' own tiles in their order,
    and each of the client's own tiles (Incomplete Forms, Sync, Settings) by its kind, so a tile that is gone is
    that tile and moves no other."""
    if isinstance(value, dict):
        shown = {key: _tiles_by_kind(item) for key, item in value.items()}
        tiles = value.get("apps")
        if isinstance(tiles, list) and all(isinstance(tile, dict) for tile in tiles):
            own = [tile for tile in tiles if tile.get("kind") != APP_TILE]
            kinds = [str(tile.get("kind")) for tile in own]
            if len(set(kinds)) == len(kinds):
                shown["apps"] = [tile for tile in tiles if tile.get("kind") == APP_TILE]
                shown["tiles"] = {str(tile.get("kind")): tile for tile in own}
        return shown
    if isinstance(value, list):
        return [_tiles_by_kind(item) for item in value]
    return value


def _screen_kind(screen):
    """What a screen of the client shows: its form, a case's detail (over the list it was opened from), a search,
    a case list, a menu or the home screen's tiles."""
    if not isinstance(screen, dict):
        return None
    for kind in ("form", "detail", "query", "list", "commands", "apps", "tiles"):
        if screen.get(kind) is not None:
            return kind
    return "none"


def one_screen(before, after):
    """Two comparable screen records with each symptom one difference: where the two sides show screens of two
    kinds at one place of a run, each side's kind and alerts stand for the screen (``kind``), and the run has
    left the walk, so its later screens are not compared; a run one side stopped following is where it stopped."""
    for run_a, run_b in zip(before.get("runs") or [], after.get("runs") or [], strict=False):
        screens_a, screens_b = run_a.get("screens") or [], run_b.get("screens") or []
        left = "stopped" in run_a or "stopped" in run_b
        for index, (a, b) in enumerate(zip(screens_a, screens_b, strict=False)):
            if _screen_kind(a) != _screen_kind(b):
                left = True
                for run, screens, screen in ((run_a, screens_a, a), (run_b, screens_b, b)):
                    said = {"kind": _screen_kind(screen), "alerts": (screen or {}).get("alerts") or []}
                    run["screens"] = [*screens[:index], said]
                    run.pop("stopped", None)
                    run.pop("script", None)
                break
        if left:
            # A run that left the walk (or that one side stopped following) never reached the form the walk
            # answers there: what became of its answers and its Submit follows from where it went.
            for run in (run_a, run_b):
                run.pop("answers", None)
                run.pop("submit", None)
        for run in (run_a, run_b):
            if isinstance(run.get("stopped"), dict):
                run["stopped"] = {
                    "after": run["stopped"].get("after"),
                    "kind": _screen_kind(run["stopped"].get("screen")),
                }
    return before, after


def comparable_screens(record):
    """The client's screens as they are compared: without the runtime and the build's version."""
    shown = {key: copy.deepcopy(value) for key, value in record.items() if key not in ("runtime", "build")}
    return _tiles_by_kind(_rows_by_case(_without(shown, SCREEN_LEFT_OUT)))


def _pull_xml(value, pointer, structural, found):
    """``value`` with each XML document taken out into ``found`` by its JSON Pointer (and structural path)."""
    if isinstance(value, dict):
        kept = {}
        for key, item in value.items():
            token = pointer_token(key)
            if key in XML_KEYS and isinstance(item, str) and item.lstrip().startswith("<"):
                found[f"{pointer}/{token}"] = (f"{structural}/{token}", item)
                kept[key] = XML
            else:
                kept[key] = _pull_xml(item, f"{pointer}/{token}", f"{structural}/{token}", found)
        return kept
    if isinstance(value, list):
        return [_pull_xml(item, f"{pointer}/{index}", f"{structural}/*", found) for index, item in enumerate(value)]
    return value


def _restore(value, pointer, text):
    tokens = [token.replace("~1", "/").replace("~0", "~") for token in pointer.split("/")[1:]]
    holder = value
    for token in tokens[:-1]:
        holder = holder[int(token)] if isinstance(holder, list) else holder[token]
    holder[tokens[-1]] = text


def _content_version(root, changed):
    """The document's root with its ``version`` read as the content's own (``compare.versions.CONTENT_VERSION``)
    where it is the version of a form whose built content differs between the two builds (``changed``: that
    side's ``{xmlns: version}``): HQ gives such a form a new version, which its instance and its submissions
    carry, as proof 2's version clause holds."""
    from lxml import etree

    from proof.checks.compare.versions import CONTENT_VERSION

    if (
        changed
        and etree.QName(root).namespace in changed
        and root.get("version") == changed[etree.QName(root).namespace]
    ):
        root.set("version", CONTENT_VERSION)
    return root


ITEXT_REFERENCE = re.compile(r"^jr:itext\('([^']*)'\)$")
# Core's message for a value that is not one of a question's choices, as far as the question it names.
NAMES_A_QUESTION = ("could not be loaded into question ", "is a valid option for question ")


def _local_name(element):
    return element.tag.rsplit("}", 1)[-1] if isinstance(element.tag, str) else None


def _text_references(root):
    """Every reference a form's body makes to a text, in document order: (the element, the text's id)."""
    found = []
    for element in root.iter():
        if _local_name(element) in ("text", "value", None):
            continue
        match = ITEXT_REFERENCE.match(element.get("ref") or "")
        if match:
            found.append((_local_name(element), match.group(1)))
    return found


def _texts(root):
    """Each text of a form by its id: per language, its values by their form."""
    from lxml import etree

    found = {}
    for translation in root.iter():
        if _local_name(translation) != "translation":
            continue
        for text in translation:
            if _local_name(text) != "text":
                continue
            values = sorted(
                (value.get("form") or "", etree.tostring(value, method="c14n", with_tail=False))
                for value in text
                if _local_name(value) == "value"
            )
            found.setdefault(text.get("id"), {})[translation.get("lang")] = values
    return found


def merged_text_ids(built, local) -> dict:
    """``{the local archive's text id: HQ's}`` for each text reference HQ's build rewrote to another id whose
    texts are the same (``XForm.normalize_itext``), read from the two builds' forms: ``built`` and ``local`` are
    each ``{path: bytes}``. Only a form both hold, whose bodies make the same references in the same places, is
    read; a reference HQ's build makes to an id whose texts in the local form are not the local id's maps
    nothing, and neither does an id two forms would map two ways or one that HQ's build of any form kept, since
    a message does not say which form its question is of."""
    found, refused = {}, set()
    for path in sorted(set(built) & set(local)):
        try:
            root_built, root_local = parse_xml(built[path]), parse_xml(local[path])
        except XmlNotWellFormed:
            continue
        references_built, references_local = _text_references(root_built), _text_references(root_local)
        if [name for name, _ in references_built] != [name for name, _ in references_local]:
            continue
        texts_local = _texts(root_local)
        for (_, id_built), (_, id_local) in zip(references_built, references_local, strict=True):
            if id_local in refused:
                continue
            if id_built == id_local:
                # A form whose reference to the id HQ's build kept: a message does not say which form it is of.
                refused.add(id_local)
                found.pop(id_local, None)
                continue
            # HQ merges two ids of one form whose texts are the same, and the local form holds both.
            same = texts_local.get(id_built) is not None and texts_local.get(id_built) == texts_local.get(id_local)
            if not same or found.get(id_local, id_built) != id_built:
                refused.add(id_local)
                found.pop(id_local, None)
                continue
            found[id_local] = id_built
    return found


def _named_by(value, text_ids):
    """``value`` with each of Core's messages naming a question by a merged text's id naming it by HQ's."""
    if isinstance(value, str):
        if any(phrase in value for phrase in NAMES_A_QUESTION):
            for local, built in text_ids.items():
                for phrase in NAMES_A_QUESTION:
                    value = value.replace(f"{phrase}{local}.", f"{phrase}{built}.")
        return value
    if isinstance(value, list):
        return [_named_by(item, text_ids) for item in value]
    if isinstance(value, dict):
        return {key: _named_by(item, text_ids) for key, item in value.items()}
    return value


def formplayer_differences(
    before, after, *, check, document, artifact, xmlns=None, versions=None, text_ids=None, rules=()
):
    """Every difference between two of Formplayer's traces, as ``artifact``: ``before`` the baseline state's.

    ``versions`` is each side's ``{xmlns: version}`` of the forms whose built content differs between the two
    builds (``proof.checks.proof4.content_versions``), whose versions are read as one (``_content_version``).
    ``rules`` are the spelling rules given (``compare.spelling``): those for ``formplayer`` are applied to each
    trace as it is compared (what Formplayer hands the client), and those for ``instance`` to each XML document
    the traces hold (a form's instance as Formplayer hands it back, a submission HQ received).
    """
    xmlns = xmlns or {}
    versions = versions or ({}, {})
    if text_ids:
        after = _named_by(after, text_ids)
    shown_before, shown_after = one_symptom(
        normalized(FORMPLAYER, comparable_trace(before), rules),
        normalized(FORMPLAYER, map_strings(comparable_trace(after), xmlns), rules),
    )
    documents_before, documents_after = {}, {}
    shown_before = _pull_xml(shown_before, "", "", documents_before)
    shown_after = _pull_xml(shown_after, "", "", documents_after)
    for pointer, (_, text) in documents_before.items():
        if pointer not in documents_after:
            _restore(shown_before, pointer, text)
    for pointer, (_, text) in documents_after.items():
        if pointer not in documents_before:
            _restore(shown_after, pointer, text)
    found = compare_json(
        shown_before, shown_after, check=check, document=document, artifact=artifact, data_maps=TRACE_DATA_MAPS
    )
    for pointer in sorted(set(documents_before) & set(documents_after)):
        structural, text_before = documents_before[pointer]
        _, text_after = documents_after[pointer]
        if text_before == text_after and not xmlns and not any(versions):
            continue
        try:
            root_before, root_after = parse_xml(text_before), parse_xml(text_after)
        except XmlNotWellFormed:
            if text_before != text_after:
                found.append(
                    Difference(check, document, artifact, structural, pointer, "changed", text_before, text_after)
                )
            continue
        compared = compare_xml_trees(
            normalized("instance", _content_version(root_before, versions[0]), rules),
            normalized("instance", _content_version(renamespace(root_after, xmlns), versions[1]), rules),
            check=check,
            document=document,
            artifact=artifact,
            naming="data",
        )
        for difference in compared:
            path = structural if difference.path == "/" else f"{structural}{difference.path}"
            at = pointer if difference.at == "/" else f"{pointer}{difference.at}"
            found.append(replace(difference, path=path, at=at))
    return found


def webapps_differences(before, after, *, check, document, artifact):
    """Every difference between the client's screens on two states, as ``artifact``: ``before`` the baseline's."""
    shown_before, shown_after = one_screen(comparable_screens(before), comparable_screens(after))
    return compare_json(
        shown_before, shown_after, check=check, document=document, artifact=artifact, data_maps=SCREEN_DATA_MAPS
    )


def refusal_cause(said) -> str:
    """What HQ said refusing a request, as a path names it: its words, without the values it quotes (an answer,
    a date, a name), so one refusal is one class on every document."""
    words = [word for word in re.split(r"[^A-Za-z]+", str(said or "")) if word]
    return "-".join(words[:10]).lower() or "-"


def refusal_differences(refusals, *, check, document, artifact):
    """Each request an HQ view did not answer 2xx while a state was walked (a side record's ``hq``), as that
    state's difference: ``/hq/<view>/<status>/<what HQ said>`` (``refusal_cause``), or what HQ raised where it
    raised."""
    found = []
    for index, entry in enumerate(refusals or []):
        path = f"/hq/{pointer_token(entry.get('view') or 'unresolved')}/{entry.get('status')}"
        cause = entry["raised"] if entry.get("raised") else refusal_cause(entry.get("said"))
        path = f"{path}/{pointer_token(cause)}"
        found.append(Difference(check, document, artifact, path, f"{path}/{index}", "error", None, entry))
    return found
