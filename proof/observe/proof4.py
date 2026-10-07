"""Proof 4's observation: HQ's editors save over B, each save in a fork of B, recorded raw for the judge.

``observe_b(ctx)`` runs at B and at B-edit (``proof.observe.unit``: the unit
at that state's mark, ``ctx.build`` the bar's build of it, made with
saved(build(A)) as HQ's previous build). Every save is made over B itself
(plan work item 11, proof 4: "each app-manager page saves over it ... the
saved app is built and traced against B"):

- **the app-manager views**, in HQ's order: the app settings view (app
  settings, add-ons, UI translations), then each module's view (module
  settings, case list, case detail) followed by each of its forms' views
  (form settings, case management basic or advanced by the module's type,
  user properties). Each view runs in a fork of B (``unit.fork()``) and is
  loaded once (``proof.editors.pages.run_view``): its navigation is answered
  ahead of the page (``pages.navigate``), every section HQ offers is armed and
  clicked in HQ's order with its save held, and each held save is released
  into a fork of the view's own (``on_section``), where HQ answers it and
  what the page asks after it, and the saved app is read before the fork
  ends. Which sections HQ offers is decided as HQ's page decides it: the
  form view's from the context ``view_generic`` itself computes while it
  renders the navigation (``views/forms.py::get_form_view_context``, held
  for that one request, ``_capturing``), the others from the app and the
  module (``add_ons_offer``, ``ui_translations_offer``, ``case_list_offer``,
  ``case_detail_offer``);
- **Vellum**, for each form with a source HQ opens in Vellum, in a fork of B
  of its own: the form opened and saved (``proof.editors.vellum``, the
  driver's warm host) with the options HQ's form designer computes from that
  state, then opened and saved again over what the first save left, with the
  options computed again, unless the first did not save.

After each save, in its fork, what it left is compared with the state it
was made over (``Base``: its stored app and its build): B for every page
and a form's first Vellum save, and what the first save left for the second
(whose sessions the judge compares with the first save's, as the record
holds them). HQ's stored app (its document without what every save
rewrites, ``BOOKKEEPING``, each form's source and every other attachment) is
compared with that state's; where it changed, the saved app is built with
the build HQ keeps of that state as its previous build (``saved_build``:
HQ's own copy keeping the form versions that state's build decided, so a
form keeps its version wherever the save left its content as the state
had it) and compared raw with that state's build under proof 2's version
clause (no spelling rule); where that differs, Core admits the saved build
and replays the sessions derived once on build(B)
(``proof.observe.runs.script_of``) over the document's case data and HQ's
restore, and HQ processes every submission, with HQ's soft assertions as
production runs them (``proof.hq.boot``), in an operation named for the
save's editor (``processing_label``), so what HQ notes there is that save's.
Every built form and stored source that respelled an attribute Core's
parser reads (as XPath on the element it is on, ``XPATH_ATTRIBUTES`` and
``ITEMSET_PATHS``, or as an itemset label, ``ITEMSET_LABEL``:
``xpath_reading``) has each such pair read by Core (the Core runner's
``xpathSame``), so the judge compares them as Core reads them, never by
their text.

Builds are kept within one B by what the build reads of the app (its stored
document with its version, sources and attachments) and the previous build
it is made over (the configuration is the B's), and traces by the built
files, a kept trace's case processing logged again under the save's own
operation with what HQ noted when it ran; under HQ's determinism the same
inputs give the same bytes, and with ``PROOF_VERIFY_MEMOS=1`` every kept
build and trace is made again and must be equal (``MemoMismatch``). What is
read once for a whole B is read once: build(B) parsed (``ParsedBuild``: a
saved app's build is read only where it can differ from the build of the
state it was made over, ``raw_builds_differ``), and B's stored app, whose app
object stands for the app wherever HQ still holds B's app document (the
views and forms proof 4 runs, what a view offers, which forms Vellum opens:
``_Observation.read_app``); a saved app's build builds the app read for its
stored app. ``PROOF_VERIFY_MEMOS=1`` holds each of these to the same reading
made whole and afresh.

A view or Vellum run is looked up among the browser transcripts
(``proof.editors.transcripts``): the store's (``ctx.store.transcripts``) or,
without one, those this process recorded for the document; a view by its
run spec and the digest of HQ's answer to its navigation, a Vellum run by
its run spec alone (nothing is answered before Vellum asks; the replay
verifies the first answer as it does every other). A found transcript is
replayed (HQ answers every recorded request again, in its fork); where an
answer differs the view's fork is put back and the browser runs live.
``PROOF_TRANSCRIPTS=off`` runs every view and Vellum run live.

The record (``observe_b``'s return) is canonical JSON with no timing and no
name of the state it was observed at: B's stored app, B's sessions, and per
view and Vellum form what HQ offered and each save's raw editor report (as a
blob), its stored app as an RFC 6902 patch against the stored app of the
state it was made over (a blob), its build's files that differ from that
state's build (blobs), and its trace: a form's second Vellum run is recorded
against what its first left, every other save against B.
``proof.checks.proof4`` judges it.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path

from proof.observe.browser import browser_fingerprint
from proof.observe.build import archive_record, device_archive
from proof.observe.record import bytes_digest, canonical, digest

CHECK = "proof4"
# What every save of an app rewrites, whatever the editor: CouchDB's revision (``_rev``), the time and the
# version ``ApplicationBase.save`` sets on each save (``last_modified``, ``version``: the build's version clause
# accounts for the version, ``proof.checks.compare.versions``), and the blob store's references to the app's
# attachments (``external_blobs``: their keys and lengths, whose contents are compared as each form's source and
# each other attachment's bytes). ``_attachments`` is CouchDB's inline attachment map, which a blob-backed app
# leaves null.
BOOKKEEPING = ("_rev", "last_modified", "version", "external_blobs", "_attachments")

OFFERED = "offered"
SKIPPED = "skipped"
WITHHELD = "withheld"

VELLUM = "vellum"
VELLUM_AGAIN = "vellum again"

# The operation HQ processes a build's submissions in: B's own sessions under ``PROCESSING``, a save's under
# ``processing_label(editor)``, so each note HQ makes there (``proof.checks.observations.soft_assertion_differences``,
# ``soft_assert:<label>@<state>``) names the editor whose save it was made over.
PROCESSING = "proof4-case-processing"


def processing_label(editor):
    """The operation a save's sessions' case processing runs in: ``proof4-case-processing@<editor>``."""
    return f"{PROCESSING}@{editor}"


VERIFY_ENVIRONMENT = "PROOF_VERIFY_MEMOS"
TRANSCRIPTS_ENVIRONMENT = "PROOF_TRANSCRIPTS"

# The editor driver's own files: the browser's code, fingerprinted apart from the observation partition
# (``proof.observe.partition.OBSERVATION_EXCLUDED``), which a view's or Vellum run's outputs depend on
# (``proof.observe.browser``).
# How Core's parser reads an XForm's attributes (commcare-core ``xform/parse/XFormParser.java``): the attributes it
# parses as XPath, each named as ``proof.checks.compare.xml_tree`` names it in a path, with the elements it parses
# it on (``XPATH``, read through ``XPathParseTool.parseXPath`` or ``XPathReference.getPathExpr``):
# - a bind's ``nodeset`` and its ``relevant``, ``required``, ``readonly``, ``constraint`` and ``calculate``
#   (``parseBind``: an ``XPathReference`` and ``XPathConditional``s);
# - a control's ``ref`` (``parseControl``: input, secret, select, select1, trigger; ``parseUpload``: upload);
# - a group's ``ref``, and a repeat's ``nodeset`` and ``jr:count`` (``parseGroup``: a group binds by ``ref``
#   alone and a repeat by ``nodeset`` alone, so a group's ``nodeset`` and a repeat's ``ref`` are never Core's);
# - an itemset's ``nodeset`` (``parseItemset``);
# - a ``setvalue``'s ``ref`` and ``value`` (``parseSetValueAction``), an ``output``'s ``ref`` and ``value``
#   (``parseOutput``), a ``submission``'s ``ref`` and ``targetref`` (``parseSubmission``).
# Core reads a control's, group's or setvalue's ``ref`` and a repeat's ``nodeset`` only where the element has no
# ``bind``, and an output's ``value`` only where it has no ``ref``; a comparison path names no sibling attribute, so
# those are read as XPath here wherever they are.
# Core's controls (``setupGroupLevelHandlers``).
CONTROLS = frozenset({"input", "secret", "select", "select1", "trigger", "upload"})
XPATH_ATTRIBUTES = {
    "nodeset": frozenset({"bind", "repeat", "itemset"}),
    "relevant": frozenset({"bind"}),
    "required": frozenset({"bind"}),
    "readonly": frozenset({"bind"}),
    "constraint": frozenset({"bind"}),
    "calculate": frozenset({"bind"}),
    "ref": CONTROLS | {"group", "setvalue", "output", "submission"},
    "value": frozenset({"setvalue", "output"}),
    "jr:count": frozenset({"repeat"}),
    "targetref": frozenset({"submission"}),
}
# The children of an ``itemset`` whose ``ref`` Core reads as a path (``parseItemsetValueElement``,
# ``parseItemsetCopyElement``, ``parseItemsetSortElement``: ``XPathReference.getPathExpr``).
ITEMSET_PATHS = frozenset({"value", "copy", "sort"})
# An itemset's ``label``'s ``ref`` is read by ``ItemSetParsingUtils.setLabel`` (``ITEMSET_LABEL``): its text is
# first tested for the ``jr:itext(`` opening and ``)`` closing, which make it an itext named by the path between
# them, and only then read as a path, so ``jr:itext(name) `` is a function call Core refuses where ``jr:itext(name)``
# is an itext. Every other ``label``'s ``ref``, and a ``hint``'s, ``help``'s or ``alert``'s, is text: it names an
# itext by its exact opening ``jr:itext('`` and closing ``')`` (``getItextReference``, ``parseHelperText``,
# ``parseItem``), and any other spelling is a "malformed ref" Core refuses, so two spellings of one are always two
# values.
XPATH = "xpath"
ITEMSET_LABEL = "itemsetLabel"


class DriverMissing(TypeError):
    """Proof 4's observation was asked for without the editor driver its saves run in."""


class MemoMismatch(AssertionError):
    """A kept build or trace differs from the same one made again (``PROOF_VERIFY_MEMOS=1``)."""


def _json(value):
    return json.loads(json.dumps(value, default=str))


# What the observation reads beyond its part's own inputs ---------------------------------------------------


def inputs(document, state):
    """What proof 4's record reads beyond its B's part: the browser's code (the image holds the rest)."""
    return {"browser": browser_fingerprint()}


# The stored app as JSON, and patches over it ------------------------------------------------------------


def _attachment(content):
    if isinstance(content, str):
        return {"text": content}
    try:
        return {"text": bytes(content).decode("utf-8")}
    except UnicodeDecodeError:
        import base64

        return {"base64": base64.b64encode(bytes(content)).decode("ascii")}


def stored_app(state, app_id):
    """What HQ stores for the app, as JSON, and the digest of everything HQ's build reads of it.

    The JSON is ``{"doc", "langs", "sources", "attachments"}``: HQ's app
    document without ``BOOKKEEPING``, its languages, each form's source by
    its position (``"<m>.<f>"``), and every attachment that is no form's
    source by its name (``{"text"}`` or ``{"base64"}``). The digest adds the
    app's version, which every save moves and HQ's build writes into what it
    builds.
    """
    held = _StoredApp.read(state, app_id)
    return held.stored, held.key


class _StoredApp:
    """``stored_app`` as read once: the JSON, its digest, its canonical bytes, and the app HQ was read into."""

    def __init__(self, stored, key, canonical_bytes, app):
        self.stored, self.key, self.canonical, self.app = stored, key, canonical_bytes, app

    @classmethod
    def read(cls, state, app_id):
        from proof.hq import operations

        app = operations.held_app(state, app_id)
        full = _json(app.to_json())
        doc = {key: value for key, value in full.items() if key not in BOOKKEEPING}
        sources, source_names = {}, set()
        for m, module in enumerate(app.modules):
            for f, form in enumerate(module.forms):
                sources[f"{m}.{f}"] = form.source or ""
                source_names.add(f"{form.unique_id}.xml")
        attachments = {
            name: _attachment(app.lazy_fetch_attachment(name))
            for name in sorted(app.external_blobs)
            if name not in source_names
        }
        stored = {"doc": doc, "langs": list(app.langs), "sources": sources, "attachments": attachments}
        held = canonical(stored)
        # ``canonical({"stored": stored, "version": version})``, spelled from the stored app's own canonical bytes:
        # sorted keys put "stored" first, and canonical JSON has no space between its parts.
        key = hashlib.sha256(b'{"stored":' + held + b',"version":' + canonical(full.get("version")) + b"}").digest()
        return cls(stored, key, held, app)


def _same(a, b):
    """JSON equality that tells a number from a boolean and an integer from a float, as JSON's own texts do."""
    return type(a) is type(b) and a == b


def _token(key):
    return str(key).replace("~", "~0").replace("/", "~1")


def json_patch(before, after, path=""):
    """An RFC 6902 patch taking ``before`` to ``after``: ``add``, ``remove`` and ``replace`` operations.

    Objects are compared key by key, arrays of one length position by
    position; an array whose length changed, or any other value that
    changed, is replaced whole.
    """
    if isinstance(before, dict) and isinstance(after, dict):
        found = []
        for key in sorted(before):
            if key not in after:
                found.append({"op": "remove", "path": f"{path}/{_token(key)}"})
        for key in sorted(after):
            if key not in before:
                found.append({"op": "add", "path": f"{path}/{_token(key)}", "value": after[key]})
            else:
                found += json_patch(before[key], after[key], f"{path}/{_token(key)}")
        return found
    if isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        found = []
        for index, (a, b) in enumerate(zip(before, after, strict=True)):
            found += json_patch(a, b, f"{path}/{index}")
        return found
    if _same(before, after):
        return []
    return [{"op": "replace", "path": path, "value": after}]


def _tokens(pointer):
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise ValueError(f"A JSON pointer starts with '/' or is empty; {pointer!r} does neither.")
    return [token.replace("~1", "/").replace("~0", "~") for token in pointer[1:].split("/")]


def _index(container, token):
    return int(token) if isinstance(container, list) else token


def apply_patch(document, patch):
    """``document`` with an RFC 6902 patch's ``add``, ``remove`` and ``replace`` operations applied, a new value."""
    found = copy.deepcopy(document)
    for operation in patch:
        tokens = _tokens(operation["path"])
        if not tokens:
            if operation["op"] != "replace":
                raise ValueError(f"A patch can only replace the whole document, not {operation['op']} it.")
            found = copy.deepcopy(operation["value"])
            continue
        parent = found
        for token in tokens[:-1]:
            parent = parent[_index(parent, token)]
        last = _index(parent, tokens[-1])
        if operation["op"] == "remove":
            del parent[last]
        elif operation["op"] == "add" and isinstance(parent, list):
            parent.insert(last, copy.deepcopy(operation["value"]))
        elif operation["op"] in ("add", "replace"):
            parent[last] = copy.deepcopy(operation["value"])
        else:
            raise ValueError(f"The patch holds an operation this reader does not apply: {operation['op']}.")
    return found


# A build as a record holds it, against build(B) -------------------------------------------------------------


def _files_delta(files, base, blobs):
    base = base or {}
    return {
        "files": {path: blobs.put(content) for path, content in sorted(files.items()) if base.get(path) != content},
        "removed": sorted(path for path in base if path not in files),
    }


def build_delta(outcome, base, blobs):
    """A saved app's build as a record holds it: what differs from build(B) (``base``), every file a blob."""
    profiles = {
        profile_id: _files_delta(files, base.profile_files.get(profile_id), blobs)
        for profile_id, files in sorted(outcome.profile_files.items())
    }
    return {
        "appVersion": outcome.app_version,
        "errors": outcome.errors,
        "raised": outcome.raised,
        "files": None if outcome.files is None else _files_delta(outcome.files, base.files, blobs),
        "profileFiles": profiles,
        "profilesRemoved": sorted(set(base.profile_files) - set(outcome.profile_files)),
    }


def _files_from(delta, base, blobs):
    files = {path: content for path, content in (base or {}).items() if path not in delta["removed"]}
    files.update({path: blobs.get(ref) for path, ref in delta["files"].items()})
    return dict(sorted(files.items()))


def outcome_from_delta(delta, base, blobs, state):
    """The build a ``build_delta`` record holds, read over build(B) (``base``) as the build of ``state``."""
    from proof.observe.outcome import BuildOutcome

    return BuildOutcome(
        state=state,
        app_version=delta["appVersion"],
        errors=delta["errors"],
        raised=delta["raised"],
        files=None if delta["files"] is None else _files_from(delta["files"], base.files, blobs),
        profile_files={
            profile_id: _files_from(entry, base.profile_files.get(profile_id), blobs)
            for profile_id, entry in delta["profileFiles"].items()
        },
    )


def _flat_files(outcome):
    """Every file of a build by the path ``proof.observe.builds.parsed_build`` keys it by, with its build profile."""
    found = {path: (None, content) for path, content in (outcome.files or {}).items()}
    for profile_id, files in sorted(outcome.profile_files.items()):
        for path, content in files.items():
            if path in found:
                raise ValueError(f"HQ's build of the profile {profile_id} and another build both wrote {path}.")
            found[path] = (profile_id, content)
    return found


class ParsedBuild:
    """build(B) as ``raw_builds_differ`` compares saved apps' builds with it: each file's bytes, and each parsed.

    ``parsed`` is None where reading build(B) raised; every comparison then
    reads both builds whole, raising as that reading raises.
    """

    def __init__(self, outcome):
        from proof.observe.builds import parsed_build

        self.outcome = outcome
        self.flat = self.parsed = None
        if outcome.files is not None:
            try:
                self.flat = _flat_files(outcome)
                self.parsed = parsed_build(outcome, rules=())
            except Exception:  # noqa: BLE001 - a build that cannot be read is read whole at every comparison
                self.flat = self.parsed = None


# The roots whose ``version`` the version clause reads as the build's own version wherever it equals its build's
# app version (``proof.checks.compare.versions._mark_build_version``).
_BUILD_VERSION_ROOTS = ("profile", "suite")


def _root_name(built):
    from lxml import etree

    return etree.QName(built.parsed).localname if built.kind == "xml" and built.parsed is not None else None


def _raw_builds_differ_whole(before, after):
    from proof.checks.compare.build_files import compare_parsed_builds
    from proof.checks.compare.versions import apply_version_clause
    from proof.observe.builds import parsed_build

    parsed_a, parsed_b = apply_version_clause(
        parsed_build(before, rules=()),
        parsed_build(after, rules=()),
        app_version_before=before.app_version,
        app_version_after=after.app_version,
    )
    return bool(compare_parsed_builds(parsed_a, parsed_b, check=CHECK, document="-"))


def _raw_builds_differ_changed(base, after):
    """``_raw_builds_differ_whole(base.outcome, after)``, reading only what can differ (see ``raw_builds_differ``)."""
    from proof.checks.compare.build_files import (
        as_read,
        comparator_kind,
        compare_parsed_builds,
        default_strings_path,
        parse_build_files,
    )
    from proof.checks.compare.versions import apply_version_clause

    flat = _flat_files(after)
    if any(comparator_kind(path) is None for path in flat):
        return _raw_builds_differ_whole(base.outcome, after)
    changed = sorted(path for path, (_, content) in flat.items() if base.flat.get(path, (None, None))[1] != content)
    by_profile = {}
    for path in changed:
        profile_id, content = flat[path]
        by_profile.setdefault(profile_id, {})[path] = content
    parsed_after = {}
    for profile_id, files in sorted(by_profile.items(), key=lambda item: (item[0] is not None, item[0] or "")):
        parsed_after.update(parse_build_files(files, rules=(), profile_id=profile_id))
    if set(flat) != set(base.flat):
        return True
    same = [path for path in flat if path not in parsed_after]
    if any(base.parsed[path].error for path in same):
        return True
    kept = [path for path in same if _root_name(base.parsed[path]) in _BUILD_VERSION_ROOTS]
    # A language's app strings are read over its default file's (``as_read``), so a changed language file is
    # compared with the default beside it, on both sides, whether or not the default's bytes changed.
    kept += [
        default for default in sorted({default_strings_path(path) for path in parsed_after} - {None}) if default in same
    ]
    for path in kept:
        parsed_after[path] = base.parsed[path]
    before = {path: base.parsed[path] for path in parsed_after}
    parsed_a, parsed_b = apply_version_clause(
        before,
        parsed_after,
        app_version_before=base.outcome.app_version,
        app_version_after=after.app_version,
    )
    # ``compare_parsed_builds`` compares file by file, so the builds differ where any one file does; a file
    # whose two trees serialize alike (or whose two strings maps are equal) is the same in every part the
    # comparators read.
    parsed_a, parsed_b = as_read(parsed_a), as_read(parsed_b)
    for path in sorted(parsed_a):
        a, b = parsed_a[path], parsed_b[path]
        if not (a.error or b.error) and _same_parse(a, b):
            continue
        if compare_parsed_builds({path: a}, {path: b}, check=CHECK, document="-"):
            return True
    return False


def _same_parse(a, b):
    from lxml import etree

    if a.kind == "xml":
        return etree.tostring(a.parsed) == etree.tostring(b.parsed)
    return a.parsed == b.parsed


def raw_builds_differ(before, after, base=None, *, verify=False):
    """Whether two builds differ in anything proof 2 compares, under its version clause and no spelling rule.

    ``base``, when given, is ``before`` parsed once (``ParsedBuild``), and
    only the files that can differ are read: those whose bytes differ, and
    every file whose root the version clause reads as the build's (a profile
    or a suite, which carry each build's own version and each form's). A file
    of the same bytes in both builds parses the same, and the clause leaves
    it as it found it on both sides (it changes a profile's or suite's own
    version, a form's data node version where the form's content differs,
    and a suite's resource versions, each kept above), so it differs in
    nothing; a file that does not parse is a difference on both sides alike.
    With ``verify`` both builds are also read whole and the two answers must
    agree (``MemoMismatch``).
    """
    from proof.checks.compare.json_tree import compare_json

    for artifact, value_a, value_b in (
        ("validate_app", before.errors, after.errors),
        ("build", before.raised, after.raised),
    ):
        if compare_json(value_a, value_b, check=CHECK, document="-", artifact=artifact):
            return True
    if before.files is None or after.files is None:
        return False
    if base is None or base.parsed is None or base.outcome is not before:
        return _raw_builds_differ_whole(before, after)
    found = _raw_builds_differ_changed(base, after)
    if verify and found != _raw_builds_differ_whole(before, after):
        raise MemoMismatch(
            "Proof 4 compared a saved app's build with build(B) reading only the files that can differ, and"
            " reading both builds whole gave the other answer. A file of the same bytes in both builds differed"
            " once compared; look at what the version clause changes in the files left unread."
        )
    return found


# XPath read by Core ----------------------------------------------------------------------------------------


def _path_steps(path):
    """A comparison path's steps (``proof.checks.compare.xml_tree``): split at each ``/`` outside a predicate."""
    steps, step, depth = [], [], 0
    for character in path:
        if character == "/" and depth == 0:
            steps.append("".join(step))
            step = []
            continue
        depth += {"[": 1, "]": -1}.get(character, 0)
        step.append(character)
    steps.append("".join(step))
    return [step for step in steps if step]


def _element_name(step):
    return step.split("[", 1)[0]


def xpath_reading(path):
    """How Core's parser reads the attribute a comparison path (``proof.checks.compare.xml_tree``) ends at, on the
    element it is on: ``XPATH`` (``XPATH_ATTRIBUTES``, ``ITEMSET_PATHS``), ``ITEMSET_LABEL``, or None for an
    attribute Core reads as text or not at all, which is compared as written."""
    steps = _path_steps(path)
    if len(steps) < 2 or not steps[-1].startswith("@"):
        return None
    attribute, element = steps[-1][1:], _element_name(steps[-2])
    if attribute == "ref" and len(steps) >= 3 and _element_name(steps[-3]) == "itemset":
        if element == "label":
            return ITEMSET_LABEL
        if element in ITEMSET_PATHS:
            return XPATH
    return XPATH if element in XPATH_ATTRIBUTES.get(attribute, ()) else None


def _changed_xpath(before, after):
    """Each (reading, before, after) of an attribute Core's parser reads (``xpath_reading``) two XForm sources spell
    differently."""
    from proof.checks.compare.xml_tree import XmlNotWellFormed, compare_xml_trees, parse_xml

    try:
        root_a, root_b = parse_xml(before), parse_xml(after)
    except XmlNotWellFormed:
        return set()
    found = set()
    for difference in compare_xml_trees(root_a, root_b, check=CHECK, document="-", artifact="-"):
        reading = xpath_reading(difference.path) if difference.kind == "changed" else None
        if reading is not None:
            found.add((reading, difference.before, difference.after))
    return found


def _built_forms(outcome):
    """Every form a build wrote, default and build profiles, by (profile id or None, path)."""
    from proof.checks.compare.build_files import artifact_for

    found = {}
    for profile_id, files in ((None, outcome.files or {}), *sorted(outcome.profile_files.items())):
        for path, content in files.items():
            if "form:" in artifact_for(path, profile_id):
                found[(profile_id, path)] = content
    return found


def xpath_pairs(stored_before, stored_after, built_before, built_after):
    """Every (reading, before, after) of one attribute Core's parser reads that a save respelled, in the stored
    sources and the built forms."""
    pairs = set()
    for position, source in stored_after["sources"].items():
        before = stored_before["sources"].get(position)
        if before is not None and before != source:
            pairs |= _changed_xpath(before, source)
    if built_before is not None and built_after is not None:
        forms_before, forms_after = _built_forms(built_before), _built_forms(built_after)
        for place, content in forms_after.items():
            before = forms_before.get(place)
            if before is not None and before != content:
                pairs |= _changed_xpath(before, content)
    return sorted(pairs)


def read_xpath(core_runner, pairs):
    """Core's reading of each (reading, a, b) (``xpathSame``): ``[[reading, a, b, {"same", "trees", "errors"}]]``,
    in order."""
    if not pairs:
        return []
    request = [[a, b, reading] for reading, a, b in pairs]
    results = core_runner.request("xpathSame", deadline=60.0, pairs=request)["results"]
    return [[reading, a, b, result] for (reading, a, b), result in zip(pairs, results, strict=True)]


# Which sections HQ offers ---------------------------------------------------------------------------------


def _display_lang(state, app, path):
    from corehq.apps.app_manager.views.utils import get_langs

    from proof.hq import requests as hq_requests

    lang, _ = get_langs(hq_requests.get(state, path), app)
    return lang


def ui_translations_offer(state, app):
    """The UI translations page saves only the translations the app holds in its display language.

    ``view_generic`` gives the page ``app.translations.get(lang, {})``, and
    ``translations/js/bootstrap5/translations.js`` fires the Save button only
    from a saved translation's value (a translation still being added is not
    ``solid``), so an app with none has nothing to save without a change.
    """
    from django.urls import reverse

    lang = _display_lang(state, app, reverse("app_settings", args=[state.domain, app._id]))
    if app.translations.get(lang):
        return OFFERED, None
    return SKIPPED, f"the app holds no UI translation in {lang}"


def add_ons_offer(state, app):
    """``partials/settings/add_ons.html`` shows the add-ons only when they are not all enabled for the project."""
    from corehq.apps.domain.models import all_app_manager_add_ons_enabled

    if all_app_manager_add_ons_enabled(state.domain):
        return SKIPPED, "every add-on is enabled for the project"
    return OFFERED, None


def case_list_offer(module):
    """A module page holds the Case List tab unless the module lists no cases.

    ``bootstrap3/module_view.html`` includes ``case_list.html`` only
    ``if not module.is_surveys`` (a module with no case type), and the page is
    saved from a column's header (``proof.editors.pages.CASE_LIST``), which
    ``details/bootstrap3/screen.js`` shows for every short-screen column except
    the legacy ``filter`` format.
    """
    if module.is_surveys:
        return SKIPPED, "the module lists no cases"
    details = getattr(module, "case_details", None)
    columns = [column for column in (details.short.columns if details else []) if column.format != "filter"]
    if not columns:
        return SKIPPED, "the module's case list has no column the page shows"
    return OFFERED, None


def case_detail_offer(module):
    """A module page holds the Case Detail tab beside the Case List's, saved from a case detail column's header.

    ``bootstrap3/module_view.html`` includes ``case_detail.html`` for each
    detail whose ``long`` the context holds (every module that lists cases,
    ``views/modules.py::_get_module_details_context``); with no case detail
    column there is nothing the page saves without a change
    (``proof.editors.pages.CASE_DETAIL``).
    """
    if module.is_surveys:
        return SKIPPED, "the module lists no cases"
    details = getattr(module, "case_details", None)
    if details is None or not details.long.columns:
        return SKIPPED, "the module's case detail has no column"
    return OFFERED, None


def _form_errors(context):
    if context["form_errors"] or context["xform_validation_errored"]:
        return {
            "form_errors": [str(error) for error in context["form_errors"]],
            "xform_validation_errored": context["xform_validation_errored"],
        }
    return None


def case_management_decided(form, context):
    """Whether HQ's form page holds the case management editor, from the page's own context.

    ``form_view.html`` shows the Case Management tab only for a form that
    ``uses_cases``, and inside it the editor only when the page's context
    (``views/forms.py::get_form_view_context``) found no ``form_errors`` and
    no ``xform_validation_errored``, and the form has a source; otherwise it
    shows "There are errors in your form. Fix your form in order to view and
    edit Case Management." That is HQ withholding the editor from the form.
    ``context`` is None where the page's render never reached that call;
    the page then fails as a whole, and the section is attempted with it.
    """
    if not form.uses_cases:
        return SKIPPED, "the form uses no cases"
    if not form.source:
        return SKIPPED, "the form has no source"
    errors = None if context is None else _form_errors(context)
    if errors is not None:
        return WITHHELD, errors
    return OFFERED, None


def user_properties_decided(form, context):
    """Whether HQ's form page holds the user properties editor, with something to save, from the page's context.

    ``form_view.html`` shows the User Properties tab for a basic module's
    form (``form_type == 'module_form'``) when the project has ``USERCASE``
    or the form uses the user case, and in it the same errors notice as case
    management's; its Save button only when the project has ``USERCASE``
    (``usercase_config.html``, ``allow_usercase``), and with no user property
    the form writes or reads (``FormBase.uses_usercase``) nothing to save
    without a change.
    """
    if form.form_type != "module_form":
        return SKIPPED, "HQ shows user properties only for a basic module's form"
    if not form.uses_usercase():
        return SKIPPED, "the form writes and reads no user property"
    if not form.source:
        return SKIPPED, "the form has no source"
    if context is None:
        return OFFERED, None
    errors = _form_errors(context)
    if errors is not None:
        return WITHHELD, errors
    if not context["allow_usercase"]:
        return WITHHELD, {"allow_usercase": False}
    return OFFERED, None


def form_view_context(state, app, form):
    """``views/forms.py::get_form_view_context`` for the form, called as ``view_generic`` calls it."""
    from corehq.apps.app_manager.views.forms import get_form_view_context
    from corehq.apps.app_manager.views.utils import get_langs
    from corehq.apps.hqwebapp.utils.bootstrap import clear_bootstrap_version, set_bootstrap_version5
    from django.urls import reverse

    from proof.hq import requests as hq_requests

    request = hq_requests.get(state, reverse("view_form", args=[state.domain, app._id, form.unique_id]))
    lang, langs = get_langs(request, app)
    set_bootstrap_version5()
    try:
        return get_form_view_context(request, state.domain, form, langs, lang)
    finally:
        clear_bootstrap_version()


def case_management_offer(state, app, form):
    """``case_management_decided`` with the page's context computed here as ``view_generic`` computes it."""
    if not form.uses_cases or not form.source:
        return case_management_decided(form, None)
    return case_management_decided(form, form_view_context(state, app, form))


def user_properties_offer(state, app, form):
    """``user_properties_decided`` with the page's context computed here as ``view_generic`` computes it."""
    if form.form_type != "module_form" or not form.uses_usercase() or not form.source:
        return user_properties_decided(form, None)
    return user_properties_decided(form, form_view_context(state, app, form))


@contextmanager
def _capturing(captured):
    """``view_generic``'s call of ``get_form_view_context``, its return kept in ``captured["context"]``."""
    from unittest import mock

    from corehq.apps.app_manager.views import view_generic

    held = view_generic.get_form_view_context

    def kept(*args, **kwargs):
        context = held(*args, **kwargs)
        captured["context"] = context
        return context

    with mock.patch.object(view_generic, "get_form_view_context", kept):
        yield captured


# The saves' raw reports -------------------------------------------------------------------------------------


def _text(body):
    if body is None:
        return None
    if isinstance(body, str):
        return body
    try:
        return bytes(body).decode("utf-8")
    except UnicodeDecodeError:
        return f"{len(body)} bytes"


def _exchange(exchange):
    """One request the page made and HQ's answer, as a report keeps it (the end of a raising view's traceback)."""
    return {
        "method": exchange.method,
        "urlName": exchange.url_name,
        "status": exchange.status,
        "messages": list(exchange.messages),
        "raised": exchange.raised,
        "refusal": exchange.refusal,
        "error": None if not exchange.error else exchange.error.rstrip().splitlines()[-3:],
    }


def page_report(saved, shown_before=None):
    """What one section's save showed and HQ answered, as data (``proof.editors.pages.PageSave``).

    ``alerts`` are the alerts the save added; ``alertsShownBefore`` those the
    page showed just before the save was released (notices the page carries
    before any save), or None where the run kept none. A save the page never
    sent has no ``save`` and names the dialog it answered Save with
    (``unsent``).
    """
    report = {
        "kind": "page",
        "save": None if saved.save is None else {**_exchange(saved.save), "body": _text(saved.save.response)},
        "exchanges": [_exchange(exchange) for exchange in saved.exchanges],
        "alerts": list(saved.alerts),
        "alertsShownBefore": None if shown_before is None else list(shown_before),
        "barState": saved.bar_state,
        "pageErrors": list(saved.run.get("pageErrors", [])),
        "dialogs": _json(list(saved.run.get("dialogs", []))),
    }
    if saved.unsent is not None:
        report["unsent"] = _json(saved.unsent)
    return report


def vellum_report(run):
    """What one Vellum run showed and HQ answered, as data (``proof.editors.vellum.VellumRun``)."""
    return {
        "kind": "vellum",
        "source": run.source,
        "outputs": _json(run.outputs),
        "saves": [
            {"urlName": save.url_name, "status": save.status, "body": _text(save.response)} for save in run.saves
        ],
    }


def broken(failure):
    """An editor run HQ's own views failed, as data; None when the failure was the harness's.

    The driver fails a run when a request the page made broke an HQ view,
    and when one reached something the harness refuses
    (``proof.editors.hq``). Only the first is HQ's answer to the app: a
    harness refusal, a deadline, or a page step that found nothing to act on
    is the harness's own failure.
    """
    failed = [exchange for exchange in getattr(failure, "exchanges", []) if exchange.error]
    if not failed or any(exchange.refusal for exchange in failure.exchanges):
        return None
    return {
        "kind": "broken",
        "failed": [
            {
                "method": exchange.method,
                "view": exchange.url_name,
                "status": exchange.status,
                "raised": exchange.raised,
                "traceback": exchange.error.rstrip().splitlines()[-3:],
            }
            for exchange in failed
        ],
    }


# HQ's saved build, as HQ keeps it --------------------------------------------------------------------------


def saved_build(hq_build):
    """The build as HQ keeps it for the next build's version comparison, with the form versions it decided.

    ``Build.saved_build`` wraps the built app's document as a working copy,
    and ``Application.wrap`` sets every form's version to None on a working
    copy ("make sure all form versions are None on working copies") before
    ``convert_app_to_build`` makes it a build. HQ's own ``make_build`` then
    builds the copy, so ``set_form_versions`` writes each form's version onto
    it; here the working app was built, so its forms hold those versions and
    the copy takes them. Without them the next build reads each form's
    previous version as the copy's app version, and gives every form a new
    version once a version has been kept across one build.
    """
    saved = hq_build.saved_build()
    for built, kept in zip(hq_build.app.get_forms(), saved.get_forms(), strict=True):
        kept.version = built.version
    return saved


def files_key(outcome):
    """What names a build's files: the digest of each path and its bytes' digest, as bytes."""
    return digest(sorted((path, bytes_digest(content)) for path, content in outcome.files.items())).encode()


class Base:
    """A state a save is made over and compared with: B, or what a form's first Vellum save left.

    ``held`` is its stored app as read once (``_StoredApp``) and ``build``
    its build (the bar's build(B), or the first save's build); the sessions
    a save's are compared with are the record's, which the judge reads
    (``proof.checks.proof4.State``). A save over it is built with the build
    HQ keeps of it as HQ's previous build (``previous``, named by
    ``previous_key``): saved(build(B)) for B, made once for the whole B; for
    the first save's state the
    saved copy of its own build, made the first time a save over it is built
    (``_Observation.previous_of``, from ``hq_build``), so the second save's
    build gives a form a new version only where the second save changed it
    (HQ's ``_get_version_comparison_build`` is the latest build), and is
    compared with the first's build like for like under the version clause,
    whether or not ``validate_app`` lists an error of the first's (no
    session runs over such a build either way). Where that state's build
    wrote no files there is no build of it to keep, and HQ's previous build
    is the one before it (``fallback``'s).
    """

    def __init__(self, held, build, *, previous=None, previous_key=b"", hq_build=None, fallback=None):
        self.held, self.build = held, build
        self.previous, self.previous_key = previous, previous_key
        self.hq_build = hq_build
        if hq_build is None and fallback is not None:
            self.previous, self.previous_key = fallback.previous, fallback.previous_key
        self._parsed = None
        # What the state's readers made of it once served (``proof.observe.served``): the digest of Formplayer's
        # trace, and of what HQ's Web Apps page hands the client of the app; None where it was not served.
        self.served_trace = self.served_reads = None
        if fallback is not None:
            self.served_trace, self.served_reads = fallback.served_trace, fallback.served_reads

    def parsed(self):
        """The state's build parsed once (``ParsedBuild``), for the comparisons of saves over it."""
        if self._parsed is None:
            self._parsed = ParsedBuild(self.build)
        return self._parsed


# The transcripts a view or Vellum run is looked up in -----------------------------------------------------


class LocalTranscripts:
    """The transcripts this process recorded for one document, by (run spec digest, first answer's digest).

    A Vellum run's key holds no first answer (None): nothing is answered
    before Vellum asks, and the replay verifies the first answer as it does
    every other.
    """

    def __init__(self):
        self.held = {}

    @staticmethod
    def key_of(transcript):
        return transcript.spec_digest, transcript.first if transcript.spec.get("kind") == "view" else None

    def get(self, spec_digest, first):
        return self.held.get((spec_digest, first))

    def put(self, transcript):
        self.held[self.key_of(transcript)] = transcript


_LOCAL = {"document": None, "transcripts": None}


def _local_transcripts(document_id):
    if _LOCAL["document"] != document_id:
        _LOCAL.update(document=document_id, transcripts=LocalTranscripts())
    return _LOCAL["transcripts"]


def transcripts_off():
    return os.environ.get(TRANSCRIPTS_ENVIRONMENT, "").strip().lower() in ("0", "off", "false", "no")


# The observation ------------------------------------------------------------------------------------------


class _LogMark:
    """Where the part's operation log stood (``proof.observe.unit.OperationLog``), to put it back there when a
    replay that did not stand is undone: its requests are answered again by the live run, and logged then."""

    def __init__(self, unit):
        self.log = getattr(unit, "_log", None)
        self.lengths = None if self.log is None else (len(self.log.log), len(self.log.requests), len(self.log.flags))

    def restore(self):
        if self.log is None:
            return
        operations, requests, flags = self.lengths
        del self.log.log[operations:]
        del self.log.requests[requests:]
        del self.log.flags[flags:]


class Counts:
    """What one ``observe_b`` did, for the measurements beside the record (never in it)."""

    def __init__(self):
        self.views = self.views_replayed = self.vellum = self.vellum_replayed = 0
        self.replay_misses = self.builds = self.build_hits = self.traces = self.trace_hits = 0

    def as_json(self):
        return dict(sorted(vars(self).items()))


# Every ``observe_b``'s counts in this process, last first read by the measurements.
COUNTS: list = []


def _positions(app):
    for m, module in enumerate(app.modules):
        yield m, module, list(enumerate(module.forms))


def _form_entries(app):
    """Every form in HQ's order: ``(m, f, form unique id)``."""
    return [(m, f, form.unique_id) for m, _, forms in _positions(app) for f, form in forms]


def _vellum_skipped(form):
    """Why HQ does not open the form in Vellum, or None where it does."""
    if not form.source:
        return "the form has no source"
    if not form.can_edit_in_vellum:
        return "HQ does not open the form in Vellum"
    return None


def hq_order(items):
    """The order the views, sections and forms run in: HQ's own."""
    return list(items)


class _Observation:
    def __init__(self, ctx, order):
        self.ctx = ctx
        self.unit = ctx.unit
        self.blobs = ctx.blobs
        self.driver = ctx.editor_driver
        self.core_runner = ctx.core_runner
        self.app_id = ctx.app_id
        self.order = order
        self.b_build = ctx.build
        self.database, self.lookups = ctx.sessions
        self.restore_bytes = ctx.restore
        self.verify = os.environ.get(VERIFY_ENVIRONMENT) == "1"
        self.off = transcripts_off()
        held = getattr(ctx.store, "transcripts", None)
        self.transcripts = held if held is not None else _local_transcripts(ctx.document.id)
        self.builds = {}
        self.traces = {}
        self.script = None
        self.counts = Counts()
        # B as every page and every form's first Vellum save is made over (``Base``), and B's stored app as read
        # once (``_StoredApp``) with the app document HQ held for it (``raw_b``).
        self.b = None
        self.held_b = None
        self.raw_b = None
        # Whether each state is also served to Formplayer and the Web Apps client (``BContext.serve``: the
        # unit's served hook runs), the walk Formplayer derived on B, and what was kept of each served state by
        # its build's files and what the client reads of its app.
        self.serves = bool(getattr(ctx, "serve", False))
        self.walk = None
        self.served_kept = {}
        # The unit's Connect opportunity (``proof.observe.connect``), which B and each save forward to, and
        # Core's sessions on B as their submissions are posted to it.
        self.connect = getattr(ctx, "connect", None)
        self.baseline_trace = None
        # Whether the opportunity was made from this B's release (the app is a Connect app only from here).
        self.opened_here = False

    # The whole B ---------------------------------------------------------------------------------------------

    def prepare(self):
        """What every save over B is judged against, made once: saved(build(B)), B's stored app and B's sessions."""
        record = {}
        previous, previous_key = None, b""
        if self.ctx.hq_build is not None:
            previous_key = files_key(self.b_build)
            with self.unit.operation("proof4-saved-build", previous_key):
                previous = saved_build(self.ctx.hq_build)
        self.held_b = _StoredApp.read(self.unit, self.app_id)
        self.raw_b = copy.deepcopy(self._raw_app())
        record["stored"] = self.blobs.put(self.held_b.canonical)
        record["baseline"] = self.baseline()
        self.b = Base(self.held_b, self.b_build, previous=previous, previous_key=previous_key)
        if self.serves:
            record["served"] = self.serve_b()
        return record

    def observe(self, views=None, forms=None):
        """The whole record, in a fork of B; ``views`` and ``forms`` (predicates over a view's ``(view, scope)`` and
        a form's ``scope``) narrow what runs, for the framework tests."""
        with self.unit.fork():
            record = self.prepare()
            plan, entries = self.read_app(
                lambda app: (self.plan(app), _form_entries(app)), "the views and forms it runs"
            )
            plan = [entry for entry in plan if views is None or views(entry[0], entry[2])]
            found = {}
            for index in self.order(range(len(plan))):
                found[index] = self.view(*plan[index])
            record["views"] = [found[index] for index in range(len(plan))]
            entries = [entry for entry in entries if forms is None or forms([entry[0], entry[1]])]
            found = {}
            for index in self.order(range(len(entries))):
                found[index] = self.vellum(*entries[index])
            record["vellum"] = [found[index] for index in range(len(entries))]
        return record

    def plan(self, app):
        """Every view in HQ's order: ``(view, target unique id, scope [m, f])``."""
        found = [("app_settings", None, [None, None])]
        for m, module, forms in _positions(app):
            found.append(("view_module", module.unique_id, [m, None]))
            for f, form in forms:
                found.append(("view_form", form.unique_id, [m, f]))
        return found

    # B's sessions ---------------------------------------------------------------------------------------------

    def sessions(self, outcome, script, label=PROCESSING):
        """The build's sessions over the restore and HQ's processing of their submissions (in the operation
        ``label``), as the record holds them; with the run, and the processing operation's digest, whether it wrote
        and what HQ noted in it (None where nothing submitted)."""
        from proof.observe.build import arrange
        from proof.observe.sessions import processed_runs, run_sessions

        with tempfile.TemporaryDirectory(prefix="proof4-") as scratch:
            path = arrange(outcome.files, Path(scratch, "build"))
            run = run_sessions(self.core_runner, "proof4", path, self.restore_bytes, script)
        found = {"admission": run.admission, "trace": None, "processed": None}
        processing = None
        if run.trace is not None:
            processing = digest(run.trace).encode()
            with self.unit.operation(label, processing) as scope:
                processed = processed_runs(self.unit, self.database, run.trace)
            processing = (processing, scope.wrote, tuple(scope.soft_assertions))
            found["trace"] = self.blobs.put_json(run.trace)
            found["processed"] = self.blobs.put_json(processed)
        return found, run, processing

    def baseline(self):
        """B's sessions over the document's case data, the script derived on build(B); or why none run."""
        from proof.observe.runs import script_of, unbuildable

        if unbuildable(self.b_build) is not None:
            return {"unbuildable": True}
        if self.restore_bytes is None:
            # Why HQ serves no restore the sessions read: its refusal of the tables (``proof.observe.sessions``).
            return {"restore": self.ctx.restore_outcome["refused"]}
        found, run, _ = self.sessions(self.b_build, None)
        if run.trace is not None:
            self.script = script_of(run.trace)
            self.baseline_trace = run.trace
        return found

    # B and each save, served to Formplayer and the Web Apps client ------------------------------------------

    def _serving(self, label, previous, change=None):
        from proof.observe import served

        return served.serving(
            self.unit,
            self.ctx.document,
            self.app_id,
            driver=self.driver,
            blobs=self.blobs,
            label=label,
            previous=previous,
            change=change,
            edit=self.ctx.over == "B-edit",
        )

    def _forwarded(self, held, label):
        """The served state forwarding to the unit's Connect opportunity (``proof.observe.connect.forwarded``),
        where the document has one."""
        from proof.observe import connect

        if self.connect is not None and self.connect.opportunity is None and connect.is_connect(self.b_build.files):
            # The app holds no Connect block at A and holds one here (an edit made it a Connect app): its
            # opportunity is made from this release, the first there is to make one from.
            self.connect.opportunity = connect.open_opportunity(held.served)
            self.opened_here = True
        opportunity = self.connect.opportunity if self.connect is not None else None
        return connect.forwarded(held.served, opportunity, label)

    def _forwards(self, forwarder, held, trace, core):
        """What a served state forwarded, as its record keeps it: the walk's runs named, Core's submissions of
        ``core`` (its trace on the state's build, or None) posted where the release's profile sends them."""
        from proof.observe import connect

        if forwarder is None:
            return None
        forwarder.walked(trace)
        if core is not None:
            forwarder.devices(core, path=connect.release_post_path(held.served))
        return forwarder.take(self.blobs)

    def serve_b(self):
        """B served (``proof.observe.served``): Formplayer's walk derived on B's release, and the client's
        screens on it; ``{"served": False}`` where HQ releases no build of B."""
        from proof.formplayer.observe import script_of
        from proof.observe import connect, served
        from proof.observe.runs import unbuildable

        if unbuildable(self.b_build) is not None:
            return {"served": False}
        from proof.webapps.hq import ReleaseRefused

        try:
            with (
                self._serving("proof4", self.ctx.previous_build) as held,
                self._forwarded(held, "proof4") as forwarder,
            ):
                with connect.reading(forwarder, "formplayer"):
                    side, trace = held.formplayer()
                self.walk = script_of(trace)
                record = {"served": True, **served._state(held, side, trace, files=self.b_build.files)}
                kept = self._forwards(forwarder, held, trace, self.baseline_trace)
                if kept is not None:
                    record["connect"] = kept
                if self.opened_here:
                    record["opportunity"] = connect.opportunity_record(self.connect.opportunity)
        except ReleaseRefused as error:
            return served.refused(error)
        # What the client reads of the app, from the stored app as read once, as every save's is.
        record["clientReads"] = served.client_reads(self.held_b.stored["doc"])
        self.b.served_trace, self.b.served_reads = side["trace"], record["clientReads"]
        return record

    def served_after(self, over, held, outcome, differs, traced=None):
        """What Formplayer and the client make of a saved app, where it can differ from the state it was saved
        over: its build differs, or what HQ's Web Apps page hands the client of the app does.

        Formplayer replays B's walk on the saved app's release. The client is shown the walk only where
        Formplayer's trace or what the page hands it is not the state's it was saved over: the client reads
        nothing else, so the same answers and the same page show the same screens. A served state is kept by its
        build's files and what the client reads of its app (HQ serves Formplayer the build, and its views read
        nothing else of the app that the build's files do not hold); ``PROOF_VERIFY_MEMOS=1`` serves it again and
        holds the two alike. Returns the record's entry (None where nothing is served) and the state's two digests.
        """
        from proof.observe import connect, served
        from proof.observe.runs import unbuildable

        unchanged = (None, over.served_trace, over.served_reads)
        if not self.serves or self.walk is None or over.served_trace is None:
            return unchanged
        if unbuildable(over.build) is not None or unbuildable(outcome) is not None:
            return unchanged
        reads = served.client_reads(held.stored["doc"])
        if not differs and reads == over.served_reads:
            return unchanged
        key = (files_key(outcome), reads, over.served_trace, over.served_reads)
        kept = self.served_kept.get(key)
        if kept is not None and not self.verify:
            return kept, kept["formplayer"]["trace"], reads
        from proof.webapps.hq import ReleaseRefused

        previous, _ = self.previous_of(over)
        try:
            with (
                self._serving("proof4-save", previous) as serving,
                self._forwarded(serving, "proof4-save") as forwarder,
            ):
                with connect.reading(forwarder, "formplayer"):
                    side, trace = serving.formplayer(self.walk)
                record = {"formplayer": side, "clientReads": reads}
                core = self.blobs.get_json(traced["trace"]) if traced and traced.get("trace") else None
                kept_connect = self._forwards(forwarder, serving, trace, core)
                if kept_connect is not None:
                    record["connect"] = kept_connect
                if side["trace"] != over.served_trace or reads != over.served_reads:
                    shown = serving.webapps(trace)
                    if shown is not None:
                        record["webapps"] = shown
                release = serving.release_differs(outcome.files)
                if release is not None:
                    record["releaseDiffers"] = release
        except ReleaseRefused as error:
            # HQ releases no build of the saved app: what it raised is the save's difference, and the state the
            # save was made over stands for what a worker is still served.
            return {"refused": served.refused(error)["refused"]}, over.served_trace, over.served_reads
        if kept is not None and kept != record:
            raise MemoMismatch(
                "Proof 4 kept what Formplayer and the Web Apps client made of a saved app by its build's files and"
                " what HQ's Web Apps page hands the client of the app, and serving it again gave another record."
                " A served state reads something the key does not name; compare the two records."
            )
        self.served_kept[key] = record
        return record, side["trace"], reads

    # One save's stored app, build and trace ----------------------------------------------------------------

    def after_save(self, over, editor, *, keep=False):
        """What a save left, read in its fork, against the state it was made over (``over``, a ``Base``): the
        stored app against that state's, and where it changed, its build and trace against that state's. Returns
        the record's entry and, with ``keep``, the state the save left (``Base``), for a save made over it."""
        held = _StoredApp.read(self.unit, self.app_id)
        if held.canonical == over.held.canonical:
            return {"stored": None}, over
        stored = held.stored
        found = {"stored": self.blobs.put_json(json_patch(over.held.stored, stored))}
        outcome, hq_build = self.build(held.key, held.app, over=over, keep_hq_build=keep)
        found["build"] = build_delta(outcome, over.build, self.blobs)
        differs = raw_builds_differ(over.build, outcome, over.parsed(), verify=self.verify)
        found["trace"] = self.trace(outcome, over=over, label=processing_label(editor)) if differs else None
        # What a device installs of the saved app where its build is not the one it was saved over: the Android
        # reader's input (``proof.android``).
        found["archive"] = archive_record(device_archive(outcome, held.app), self.blobs) if differs else None
        answers = read_xpath(self.core_runner, xpath_pairs(over.held.stored, stored, over.build, outcome))
        found["xpath"] = self.blobs.put_json(answers) if answers else None
        found["served"], served_trace, served_reads = self.served_after(over, held, outcome, differs, found["trace"])
        if not keep:
            return found, None
        left = Base(held, outcome, hq_build=hq_build, fallback=over)
        left.served_trace, left.served_reads = served_trace, served_reads
        return found, left

    def previous_of(self, over):
        """The build HQ keeps of ``over`` and what names it: B's made once (``prepare``), a first Vellum save's
        made the first time a save over it is built, in an operation of the unit, as the unit keeps B's."""
        if over.hq_build is not None:
            key = files_key(over.build)
            with self.unit.operation("proof4-saved-build", key):
                over.previous = saved_build(over.hq_build)
            over.previous_key, over.hq_build = key, None
        return over.previous, over.previous_key

    @contextmanager
    def _kept(self, label, digest_bytes, wrote, notes=()):
        """The operation a kept build or trace stood for, run without its work: the unit's key, depth and write
        count move as they did when it was made, so what runs after it runs under the same keys either way, and
        what HQ noted when it ran (``notes``) is noted in it again, so it is the operation's whichever ran it."""
        with self.unit.operation(label, digest_bytes) as scope:
            yield scope
            scope.wrote = wrote
            scope.soft_assertions.extend(notes)

    def build(self, key, app=None, *, over=None, keep_hq_build=False):
        """The saved app's build over ``over`` (B where none is given), with the build HQ keeps of that state as
        HQ's previous build (``previous_of``), kept by what HQ's build reads of the app (``key``) and that previous
        build: the outcome, and HQ's ``Build`` of it.

        ``app`` is the app as the state holds it, already read for the stored app; HQ's build builds it (and
        changes it as it builds, so a build made again reads its own). A kept build has no ``Build`` (None); with
        ``keep_hq_build`` it is made again under the same operation, as ``PROOF_VERIFY_MEMOS=1`` makes it, for the
        ``Build`` a save over it is built over.
        """
        from proof.observe.outcome import outcome_record
        from proof.observe.record import Blobs
        from proof.observe.sensitivity import build

        previous, previous_key = self.previous_of(over or self.b)
        key = hashlib.sha256(key + previous_key).digest()
        self.counts.builds += 1
        held = self.builds.get(key)
        if held is not None and not self.verify and not keep_hq_build:
            self.counts.build_hits += 1
            with self._kept("proof4-build", key, held[1]):
                pass
            return held[0], None
        given = app if held is None else None
        if given is not None and self.verify:
            from proof.hq import operations

            if _json(given.to_json()) != _json(operations.held_app(self.unit, self.app_id).to_json()):
                raise MemoMismatch(
                    "Proof 4 built the app it read for the stored app, and the app read afresh for the build holds"
                    " another document. Something between the two reads changed HQ's app; look at what ran after"
                    " the stored app was read."
                )
        with self.unit.operation("proof4-build", key) as scope:
            built = build(self.unit, self.unit.record, self.app_id, "saved", previous, app=given)
        outcome = built.outcome
        if held is not None:
            self.counts.build_hits += 1
            if (canonical(outcome_record(held[0], Blobs())), held[1]) != (
                canonical(outcome_record(outcome, Blobs())),
                scope.wrote,
            ):
                raise MemoMismatch(
                    "Proof 4 kept a build of the saved app by what HQ's build reads of it (its stored document,"
                    " version, sources and attachments, under one configuration and one previous build), and"
                    " building that app again gave other files. The build reads something the key does not"
                    " name; look at what differs between the two builds' files."
                )
        self.builds[key] = (outcome, scope.wrote)
        return outcome, built.hq_build

    def trace(self, outcome, *, over, label):
        """The saved build's sessions, replaying B's script, or its admission alone where B's sessions found no
        trace (Core did not admit build(B)); ``{"ran": False}`` where none run, which the judge reads from the
        builds and B's sessions. ``over`` is the state the save was made over, whose build must be one HQ releases
        too, and ``label`` the operation the case processing runs in (``processing_label``)."""
        from proof.observe.build import admit, arrange
        from proof.observe.runs import unbuildable

        if unbuildable(over.build) is not None or unbuildable(outcome) is not None or self.restore_bytes is None:
            return {"ran": False}
        self.counts.traces += 1
        key = files_key(outcome).decode()
        held = self.traces.get(key)
        if held is not None and not self.verify:
            self.counts.trace_hits += 1
            found, processing = held
            if processing is not None:
                with self._kept(label, *processing):
                    pass
            return found
        processing = None
        if self.script is None:
            with tempfile.TemporaryDirectory(prefix="proof4-") as scratch:
                admission = admit(self.core_runner, arrange(outcome.files, Path(scratch, "build")))
            found = {"admission": admission, "trace": None, "processed": None}
        else:
            found, _, processing = self.sessions(outcome, self.script, label)
        if held is not None:
            self.counts.trace_hits += 1
            if held != (found, processing):
                raise MemoMismatch(
                    "Proof 4 kept the sessions of a saved build by its files, and running them again on the same"
                    " files gave another admission, trace or case processing. The sessions read something the"
                    " key does not name; compare the two records."
                )
        self.traces[key] = (found, processing)
        return found

    # Views ----------------------------------------------------------------------------------------------------

    def _raw_app(self):
        """The app's document as HQ's Couch holds it now, or None where the unit keeps no Couch of its own."""
        documents = getattr(getattr(self.unit, "couch", None), "mock_docs", None)
        return None if documents is None else documents.get(self.app_id)

    def app_now(self):
        """The app as the unit's state holds it: B's as read once while its document is still B's (an app's
        attachments are named by the document, and a blob's key is never put twice), else read afresh."""
        from proof.hq import operations

        raw = self._raw_app()
        if raw is not None and raw == self.raw_b:
            return self.held_b.app
        return operations.held_app(self.unit, self.app_id)

    def read_app(self, reading, what):
        """``reading`` of the app as the state holds it (``app_now``); with ``PROOF_VERIFY_MEMOS=1``, also of the app
        read afresh, which must give the same (``MemoMismatch``). ``what`` names the reading in that failure."""
        found = reading(self.app_now())
        if self.verify:
            from proof.hq import operations

            again = reading(operations.held_app(self.unit, self.app_id))
            if again != found:
                raise MemoMismatch(
                    f"Proof 4 read {what} from B's app as read once, its document unchanged, and the app read afresh"
                    f" gives otherwise: {found} and {again}. That reading depends on something that is not in the"
                    " app's document; look at what ran since B's app was read (a view's navigation, B's sessions)."
                )
        return found

    def offers(self, view, scope, captured):
        return self.read_app(lambda app: self._offers(view, scope, captured, app), "what a view offers")

    def _offers(self, view, scope, captured, app):
        from proof.editors import pages

        m, f = scope
        if view == "app_settings":
            return [
                (pages.APP_SETTINGS, (OFFERED, None)),
                (pages.ADD_ONS, add_ons_offer(self.unit, app)),
                (pages.UI_TRANSLATIONS, ui_translations_offer(self.unit, app)),
            ]
        if view == "view_module":
            module = app.modules[m]
            return [
                (pages.MODULE_SETTINGS, (OFFERED, None)),
                (pages.CASE_LIST, case_list_offer(module)),
                (pages.CASE_DETAIL, case_detail_offer(module)),
            ]
        form = app.modules[m].forms[f]
        advanced = form.get_module().doc_type == "AdvancedModule"
        context = captured.get("context")
        return [
            (pages.FORM_SETTINGS, (OFFERED, None)),
            (
                pages.ADVANCED_CASE_MANAGEMENT if advanced else pages.CASE_MANAGEMENT,
                case_management_decided(form, context),
            ),
            (pages.USER_PROPERTIES, user_properties_decided(form, context)),
        ]

    def navigate(self, view, target):
        from proof.editors import pages
        from proof.editors.hq import HQAnswers

        answers = HQAnswers(self.unit, self.unit)
        captured = {}
        with _capturing(captured) if view == "view_form" else _nothing():
            navigation = pages.navigate(self.driver, answers, pages.ViewSpec(view, self.app_id, target))
        return answers, navigation, captured

    def view(self, view, target, scope):
        from proof.editors import pages
        from proof.editors.hq import EditorRunFailed, HQRefusedPageRequest

        self.counts.views += 1
        with self.unit.fork() as start:
            log = _LogMark(self.unit)
            answers, navigation, captured = self.navigate(view, target)
            offers = self.offers(view, scope, captured)
            offered = [page for page, (status, _) in offers if status == OFFERED]
            spec = pages.ViewSpec(
                view, self.app_id, target, sections=tuple(offered[i] for i in self.order(range(len(offered))))
            )
            # Each section's position in HQ's order, by its position in the run.
            positions = [offered.index(page) for page in spec.sections]
            found = {"view": view, "target": target, "scope": scope}
            found["offers"] = [
                {"section": page.name, "offer": status, "reason": _json(reason)} for page, (status, reason) in offers
            ]
            saved = {}

            def on_section(index):
                return self.section_fork(saved, positions[index], spec.sections[index].name)

            run = None
            transcript = None
            if not self.off:
                transcript = self.transcripts.get(transcripts_spec_digest(spec, self.unit), navigation.response_digest)
            if transcript is not None:
                run = pages.replay_view(transcript, answers, spec, on_section=on_section, navigation=navigation)
                if run is None:
                    self.counts.replay_misses += 1
                    self.unit.restore(start)
                    log.restore()
                    saved.clear()
                    answers, navigation, captured = self.navigate(view, target)
                else:
                    self.counts.views_replayed += 1
            failed = None
            if run is None:
                try:
                    run = pages.run_view(self.driver, answers, spec, on_section=on_section, navigation=navigation)
                except (EditorRunFailed, HQRefusedPageRequest) as failure:
                    failed = broken(failure)
                    if failed is None:
                        raise
                else:
                    if run.transcript is not None and not self.off:
                        self.transcripts.put(run.transcript)
            sections = []
            for position, page in enumerate(offered):
                entry = {"section": page.name}
                if failed is not None:
                    entry["report"] = self.blobs.put_json(failed)
                else:
                    index = spec.sections.index(page)
                    # What the page showed just before the section's release (none kept for a section saved
                    # from a load of its own after a redirect).
                    shown = None if index in run.redone else run.outputs["sections"][index]["preRelease"]["alerts"]
                    entry["report"] = self.blobs.put_json(page_report(run.sections[index], shown))
                entry.update(saved.get(position, {"stored": None}))
                sections.append(entry)
            found["sections"] = sections
        return found

    @contextmanager
    def section_fork(self, saved, position, editor):
        with self.unit.fork():
            yield
            saved[position], _ = self.after_save(self.b, editor)

    # Vellum ---------------------------------------------------------------------------------------------------

    def vellum(self, m, f, form_unique_id):
        # Run at B's state, between the forks every view and Vellum run is made in.
        skipped = self.read_app(lambda app: _vellum_skipped(app.get_form(form_unique_id)), "which forms Vellum opens")
        found = {"scope": [m, f], "target": form_unique_id}
        if skipped is not None:
            found["offer"] = SKIPPED
            found["reason"] = skipped
            return found
        found["offer"] = OFFERED
        with self.unit.fork():
            first, left = self.vellum_run(form_unique_id, self.b, VELLUM)
            runs = [first]
            # The second open and save is over what the first left, and recorded against it, so only where the first
            # saved.
            if first["saved"]:
                runs.append(self.vellum_run(form_unique_id, left, VELLUM_AGAIN)[0])
            else:
                found["again"] = {"offer": SKIPPED, "reason": "Vellum did not save the form before"}
        found["runs"] = [{key: value for key, value in run.items() if key != "saved"} for run in runs]
        return found

    def vellum_run(self, form_unique_id, over, editor):
        """One open and save of the form over ``over`` (a ``Base``), as the record's run: its report, and what the
        save left against ``over`` (``after_save``); and, after the first run (``VELLUM``), the state the save left,
        which the second run is made over."""
        from proof.editors import transcripts as transcript_store
        from proof.editors import vellum
        from proof.editors.hq import EditorRunFailed, HQAnswers, HQRefusedPageRequest

        self.counts.vellum += 1
        with self.unit.operation("proof4-vellum-options", form_unique_id.encode()):
            options = vellum.vellum_options(self.unit, self.app_id, form_unique_id)
        spec = vellum.vellum_spec(options, load_delay=vellum.WARM_LOAD_DELAY)
        saved = {}
        run = None
        transcript = None if self.off else self.transcripts.get(transcript_store.digest(spec), None)
        if transcript is not None:
            start = self.unit.mark()
            log = _LogMark(self.unit)
            run = vellum.replay(
                transcript, HQAnswers(self.unit, self.unit), self.app_id, form_unique_id, options, read_stored=False
            )
            if run is None:
                self.counts.replay_misses += 1
                self.unit.restore(start)
                log.restore()
            else:
                self.counts.vellum_replayed += 1
        failed = None
        if run is None:
            try:
                # HQ's stored app is read after the run (``after_save``), not the form's source alone.
                run = vellum.open_and_save(
                    self.driver,
                    HQAnswers(self.unit, self.unit),
                    self.app_id,
                    form_unique_id,
                    options,
                    read_stored=False,
                )
            except (EditorRunFailed, HQRefusedPageRequest) as failure:
                failed = broken(failure)
                if failed is None:
                    raise
            else:
                if run.transcript is not None and not self.off:
                    self.transcripts.put(run.transcript)
        report = failed if failed is not None else vellum_report(run)
        entry, left = self.after_save(over, editor, keep=editor == VELLUM)
        saved.update(entry)
        return {"report": self.blobs.put_json(report), **saved, "saved": failed is None and run.saved}, left


@contextmanager
def _nothing():
    yield {}


def transcripts_spec_digest(spec, state):
    """The digest a view's transcript is keyed by: its canonical run spec's."""
    from proof.editors import transcripts

    return transcripts.digest(spec.canonical(state.domain))


def observe_b(ctx, *, order=hq_order, views=None, forms=None):
    """Proof 4 over the B ``ctx`` names (``proof.observe.unit.BContext``), as its record; the unit left at B's mark.

    ``order`` gives the order the views, each view's sections and the Vellum
    forms run in (HQ's own by default); the record holds them in HQ's order
    whatever it is, each save having been made over B. ``views`` and
    ``forms`` narrow what runs (``_Observation.observe``); the unit's call
    runs everything.
    """
    if ctx.editor_driver is None:
        raise DriverMissing(
            "Proof 4's observation saves over B in HQ's editors, and it was given no editor driver"
            " (BContext.editor_driver is None). Pass the session's driver to the observation: the corpus checks"
            " pass their editor_driver fixture to proof.checks.observations.records_for, which hands it to"
            " proof.observe.unit.observe_document."
        )
    observation = _Observation(ctx, order)
    record = observation.observe(views, forms)
    COUNTS.append({"document": ctx.document.id, "over": ctx.over, **observation.counts.as_json()})
    return record
