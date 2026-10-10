"""Proof 3, behavioral equivalence: the same sessions behave the same on two builds of one document.

Two comparisons, each over the document's case database
(``proof.checks.casedata``):

- **the two export paths**, always (decision 15): Nova's local archive
  (``local.ccz``) against ``build(A)``, HQ's build of what Nova's first
  publish left there;
- **two publishes**, wherever proof 2 still finds a difference between
  ``build(A)`` and the build of B aligned to A (``proof.checks.proof2``):
  that build against ``build(A)``.

Sessions run only on an HQ build a runtime can install. HQ makes a release
only when ``validate_app()`` lists no error
(``app_manager/models/applications.py::Application.make_build`` raises
``AppValidationError``), and serves Web Apps the archive of the saved app on
the same condition (``app_manager/views/cli.py::get_direct_ccz`` answers 400);
both then write the default files (``create_all_files()``). So a build whose
validation failed, or whose default files HQ could not write, is a refused
comparison (``unbuildable``), and the bar reports why.

The script is derived on ``build(A)``, the baseline: the Core runner opens
every menu command and every reachable form with the first case of each
list (``CoreRunner.session`` with no script). The same script replays on the
other build, and the two complete traces are compared (``trace@<other>``)
after the registered spelling rules (``proof.rules``); a step that cannot
replay is itself a difference. The spelling rules registered for the
``trace`` and ``case_blocks`` artifacts apply to every comparison of them,
whichever build it compares. Each build reads lookup tables the way its
path delivers them: HQ's builds from HQ's restore, which serves the tables
Nova's push uploaded (``casedata.lookup_fixtures``), the local archive from
the tables it carries.

Every session's submission is then given to HQ's case processing
(``proof.hq.operations.process_case_blocks``) over the same cases, on both
sides, and what HQ read and made of it is compared (``case_blocks@<other>``,
``compare_case_processing``): the case blocks, the refusal HQ answers with,
and each case the submission touched. HQ applies a submission's blocks case
by case, not in their order in the form (``casexml/apps/case/xform.py::
get_case_updates``: sorted by case id, each case's blocks by their first
action in ``const.CASE_ACTIONS``, then in the form's order), so the blocks
are compared as HQ applies them (``blocks_by_case``): keyed by case id, and
each case's by where the form holds each block (the path the observation
records, ``proof.observe.sessions.block_paths``, written as
``compare.names.block_path`` writes it, one JSON Pointer token: a guard's is
``/runs/*/blocks/*/__nova_operations~1__nova_guard_*~1case``). The blocks a
repeat's rows write share HQ's path, so one key's blocks pair by position.
So two blocks of two cases the forms write in another order are no
difference, and a block one side holds and the other does not is that one
difference at its own place, whatever the case's other blocks are; where a
whole case is one side's, each of its blocks is. HQ reads no block by where
the form holds it, so a block one build writes where the other writes no
block at all moved, and is compared with the case's block the other build
writes where the first writes none (``moved_blocks_paired``: HQ's build
writes a child case's block in ``subcase_<n>``, Nova's local archive in the
repeat's row), named at the baseline's place. HQ applies one case's blocks
in its order and the later update wins, so where both sides hold blocks of a
case in another order that is one difference naming both orders
(``/runs/*/blocks/*/order()``). A block with an empty case id is no case's:
HQ refuses it (``form_processor/casedb_base.py::AbstractCaseDbCache.get``,
``IllegalCaseId``), so the empty id is kept in a path apart from every case's
(``*``), with the action HQ applies the block at first (``first_action``:
``/runs/*/blocks//create/<block>``, ``/runs/*/blocks//update/<block>``), an
empty id on a block that opens a case and on one that writes an existing case
being two symptoms. A block's
``create`` and ``update`` keep the names HQ and Core read as the case's own
fields (``compare.names.CASE_FIELDS``: ``case_name``, ``owner_id``...), and
every other is a case property, ``*``. HQ's refusal is keyed by its
exception class, its cause (``/runs/*/refusal/IllegalCaseId``), and an empty
case id's refusal also by the block HQ refused: the empty id sorts before
every other, so HQ refuses the first empty-id block it applies before any
other (``/runs/*/refusal/IllegalCaseId/<its action>/<that block>``). HQ applies
no case of a submission it refuses, and the observation records none for it,
so where only one side's submission is refused, each case the other side's
touched is that refusal's difference, under its path
(``/runs/*/refusal/IllegalCaseId/<action>/<block>/cases/*``): each cause of a
refusal is its own class.

The runner marks each id the runtime generated in a run
(``@generated:uuid:<n>``, ``proof/core/src/nova/proof/core/Generated.java``),
and HQ's processing of the run holds the same marks
(``proof.observe.sessions``, which gives HQ each mark's value and its record
the mark back). Both sides' marks are named by the first place both runs
hold one (``compare.trace.generated_labels``), once for the trace and HQ's
processing of it, so a case keeps its key whatever order the ids were drawn
in.

A comparison that cannot run is a ``refused`` difference whose path names
its cause, unless the bar already reports that cause, where nothing more is
reported (decision 12: one class per symptom): HQ refused A's publish
(``import@A``), A is unbuildable (``validate_app@A``, ``<step>@A``: a build
HQ makes no archive of always holds one or the other, since
``create_all_files()`` writes the files or raises, ``unbuildable_cause_held``), Core
did not admit A's build or the local archive (``admission@<state or
archive>``), or HQ answered the lookup workbook's upload as failed
(``lookups@<state>``). The causes reported here: ``/no-local-archive``,
``/unbuildable/...`` of B aligned to A (each of its ``validate_app`` errors
at the bar's path, ``/unbuildable/validate_app/modules/*/forms/*/<type>``,
and each step it raised, ``/unbuildable/raised/<step>/<class>``),
``/not_admitted/problems/*/<stage>/<class>`` of a build Core did not admit
for its sessions where the bar admitted the same build or holds no
admission of it (B aligned to A, which the bar does not admit),
``/lookups-not-served/<why>``, and a run whose case processing needs the
form's files (``/runs/*/needs-files/<class>``).

What a trace compares:

- everything the runner records of each run: screens, commands, rows, case
  details, questions, answers, the submission and the case database after
  it (both parsed as XML and compared structurally, ``compare.xml_tree``),
  and the stack after submit; a step that stopped short by its cause
  (``compare.trace.stops_by_cause``): Core's refusal of a submission and an
  exception Core raised running the step, each by its class and the line
  of Core's that made it (for a case block missing a case id, the block,
  written as HQ's refused block is), with what the stop leaves out of the
  run under the same cause; not how many ids a run generated, which is the
  difference where they are again (``compare.trace.uncounted``);
- between A's build and B's, a submission's version as proof 2's version
  clause holds it (``proof.checks.proof4.trace_versions``, as proof 4 holds
  a save's build to the build it was saved over): where a form's built
  content differs between the two builds, HQ's ``set_form_versions`` gives
  it a new version, which its submissions carry, so the version is read as
  the same value on both sides; anywhere else it is compared as it is;
- of the profile, its required version and only the properties a runtime
  that runs both builds reads (``PROFILE_PROPERTIES``): Android installs a
  local archive (commcare-android
  ``activities/InstallArchiveActivity.java::OnUnzipSuccessful``), while Web
  Apps installs only the archive HQ builds of the saved app (formplayer
  ``util/SessionUtils.java::getReferenceToLatest``, ``latest=save``, which
  HQ's ``app_manager/views/cli.py::direct_ccz`` serves), so the two export
  paths are compared on what Android reads, and two HQ builds on what either
  reads. Android reads a property through the app preferences its profile
  installer writes, honoring ``force``
  (``android/resource/installers/ProfileAndroidInstaller.java::initProperties``);
  Formplayer through Core's property manager (commcare-core
  ``suite/model/Profile.java::initializeProperties``, formplayer
  ``util/FormplayerPropertyManager.java``).

A search's query parameters (``params``, on its step and on each request the
step made) hold CommCare's own keys (``case_type``, ``_xpath_query``, every
key a suite ``<data>`` names) beside the keys of the search's prompts, which
are the app's case properties. Only a key the step's own prompts name
(``prompts[*].key``) is the app's data, ``*`` in a difference's path; every
other key is the query's vocabulary and stays in the path, so a lost
``case_type`` and a lost prompt are two classes. A prompt's errors are keyed
by its prompts alone.

Identity is proof 1's: before the local archive's trace is compared, each
form ``xmlns`` it carries is mapped to the one ``build(A)`` carries for the
same suite entry (command id), in the trace and in the submission's
namespaces. The B build is aligned to A already.

The sessions, HQ's restores and HQ's case processing are observed over B's
state, or A's where HQ refused B (``proof.observe.sessions``), and kept in
the ``b_aligned`` record; this module judges that record. The observation
runs the B build's sessions wherever the raw builds differ (no spelling
rules); the judge compares them where proof 2, after the rules, still finds
a difference. What decides a record (a run, its script, whether a build is
installable, the ``xmlns`` mapping) is the observation's
(``proof.observe.runs``), and named here for the judges that read it.
"""

from __future__ import annotations

import copy
import functools
from dataclasses import dataclass, replace

from proof.checks import proof2
from proof.checks.bar import error_path
from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.names import CASE_FIELDS, block_path
from proof.checks.compare.trace import compare_traces as compare_trace_documents
from proof.checks.compare.trace import generated_labels, relabel_generated
from proof.checks.differences import Difference, pointer_token
from proof.observe.runs import Run as Run
from proof.observe.runs import script_of as script_of
from proof.observe.runs import submission_of as submission_of
from proof.observe.runs import unbuildable as unbuildable
from proof.observe.runs import xmlns_alignment as xmlns_alignment
from proof.rules import RULES, normalized

CHECK = "proof3"
ANDROID = "android"
WEB_APPS = "web-apps"
# The runtimes that run each comparison's two builds: a local archive installs
# only on Android, an HQ build on both. A run of sessions (``Run.side``) is
# compared under its side's runtimes.
RUNTIMES = {"local.ccz": frozenset({ANDROID}), "B": frozenset({ANDROID, WEB_APPS})}
# A block's empty case id is no case's: HQ refuses it (``form_processor/casedb_base.py::AbstractCaseDbCache.get``,
# ``IllegalCaseId``), so a path keeps it (``/runs/*/blocks/``) apart from every case's id (``*``).
EMPTY_CASE_ID = ""
ILLEGAL_CASE_ID = "IllegalCaseId"
# What each child of a case block holds, as a map of the app's names: create and update keep the case's own fields
# (``compare.names.CASE_FIELDS``), index identifiers and attachment names are all the app's.
BLOCK_CHILD_MAPS = {"create": CASE_FIELDS, "update": CASE_FIELDS, "index": frozenset(), "attachment": frozenset()}
# Objects in a case processing record whose keys are the app's data (case ids,
# case property names, index identifiers and attachment names), each with the
# keys a reader gives meaning to, which stay in the path. HQ touches no case
# with an empty id (it refuses the block first, ``AbstractCaseDbCache.get``),
# so every key of ``cases`` is a case's id. Each case's blocks, keyed by where
# the form holds them, are named per comparison (``_case_data_maps``).
CASE_DATA_MAPS = {
    "/runs/*/cases": frozenset(),
    "/runs/*/cases/*/properties": frozenset(),
    "/runs/*/cases/*/indices": frozenset(),
    "/runs/*/blocks": frozenset({EMPTY_CASE_ID}),
}
# Where a case's blocks are compared in the order HQ applies them: one difference naming both orders.
BLOCK_ORDER = "order()"
# HQ's order of a case block's actions (``casexml/apps/case/const.py::CASE_ACTIONS``); each block is applied at
# its first action's place (``casexml/apps/case/xform.py::_update_order_index``).
CASE_ACTIONS = ("create", "update", "index", "close", "attachment", "commtrack", "rebuild")


@dataclass(frozen=True)
class PropertyReaders:
    """Where the manifest holds one profile property as app content, and the runtime code that reads it."""

    setting: str
    android: str | None = None
    web_apps: str | None = None

    def read_by(self, runtimes):
        return (ANDROID in runtimes and self.android is not None) or (
            WEB_APPS in runtimes and self.web_apps is not None
        )


_HIDDEN = "commcare-android app/src/org/commcare/preferences/HiddenPreferences.java"
_MAIN = "commcare-android app/src/org/commcare/preferences/MainConfigurablePreferences.java"
_FORMPLAYER = "formplayer org/commcare/formplayer/util/FormplayerPropertyManager.java"
_BANNER = "commcare-android app/src/org/commcare/views/CustomBanner.java::getBannerURI"

# The profile properties the manifest holds as app content (HELD or HELD-NEW)
# that a runtime reads, by the key HQ's profile writes them under, each with
# its setting (a surface key, or the entry naming it) and its readers. Logos
# are written under ANDROID_LOGO_PROPERTY_MAPPING's keys
# (app_manager/models/applications.py::Application.create_profile), and the two
# Web Apps settings under the keys HQ's profile template gives them
# (app_manager/templates/app_manager/profile.xml). The Web Apps logo's
# property (brand-banner-web-apps) is read by no runtime: Web Apps shows the
# logo HQ holds for the app, not the profile's. test_proof3_behavior.py holds
# this table to the manifest.
PROFILE_PROPERTIES = {
    "cc-autoup-freq": PropertyReaders(
        "setting:properties.cc-autoup-freq",
        android="commcare-android app/src/org/commcare/update/UpdateHelper.java::getAutoUpdateFrequency",
    ),
    "cc-days-form-retain": PropertyReaders(
        "setting:properties.cc-days-form-retain",
        android="commcare-android app/src/org/commcare/tasks/PurgeStaleArchivedFormsTask.java"
        "::getArchivedFormsValidityInDays",
    ),
    "logenabled": PropertyReaders("setting:properties.logenabled", android=f"{_HIDDEN}::getLogsEnabled"),
    "cc-autosync-freq": PropertyReaders(
        "setting:properties.cc-autosync-freq",
        android="commcare-android app/src/org/commcare/utils/PendingCalcs.java::getPendingSyncStatus",
        web_apps="formplayer org/commcare/formplayer/services/RestoreFactory.java::getSyncFreqency",
    ),
    "cc-content-valid": PropertyReaders(
        "setting:properties.cc-content-valid",
        android="commcare-android app/src/org/commcare/CommCareApp.java::areMMResourcesValidated",
    ),
    "unsent-number-limit": PropertyReaders(
        "setting:properties.unsent-number-limit",
        android="commcare-android app/src/org/commcare/utils/SyncDetailCalculations.java"
        "::unsentFormNumberLimitExceeded",
    ),
    "unsent-time-limit": PropertyReaders(
        "setting:properties.unsent-time-limit",
        android="commcare-android app/src/org/commcare/utils/SyncDetailCalculations.java::unsentFormTimeLimitExceeded",
    ),
    "cc-show-saved": PropertyReaders("setting:properties.cc-show-saved", android=f"{_HIDDEN}::isSavedFormsEnabled"),
    "cc-show-incomplete": PropertyReaders(
        "setting:properties.cc-show-incomplete", android=f"{_HIDDEN}::isIncompleteFormsEnabled"
    ),
    "cc-resize-images": PropertyReaders("setting:properties.cc-resize-images", android=f"{_HIDDEN}::getResizeMethod"),
    "cc-fuzzy-search-enabled": PropertyReaders(
        "setting:properties.cc-fuzzy-search-enabled",
        android=f"{_MAIN}::isFuzzySearchEnabled",
        web_apps=f"{_FORMPLAYER}::isFuzzySearchEnabled",
    ),
    "cc-log-entity-detail-enabled": PropertyReaders(
        "setting:properties.cc-log-entity-detail-enabled", android=f"{_HIDDEN}::isEntityDetailLoggingEnabled"
    ),
    "cc-login-duration-seconds": PropertyReaders(
        "setting:properties.cc-login-duration-seconds", android=f"{_HIDDEN}::getLoginDuration"
    ),
    "cc-inflation-target-density": PropertyReaders(
        "setting:properties.cc-inflation-target-density",
        android=f"{_HIDDEN}::isSmartInflationEnabled and ::getTargetInflationDensity",
    ),
    "cc-gps-auto-capture-accuracy": PropertyReaders(
        "setting:properties.cc-gps-auto-capture-accuracy", android=f"{_HIDDEN}::getGpsAutoCaptureAccuracy"
    ),
    "cc-maps-default-layer": PropertyReaders(
        "setting:properties.cc-maps-default-layer", android=f"{_HIDDEN}::getMapsDefaultLayer"
    ),
    "cc-enable-tts": PropertyReaders("setting:properties.cc-enable-tts", android=f"{_MAIN}::isTTSEnabled"),
    "cc-label-required-questions-with-asterisk": PropertyReaders(
        "setting:properties.cc-label-required-questions-with-asterisk",
        android=f"{_HIDDEN}::shouldLabelRequiredQuestionsWithAsterisk",
    ),
    "brand-banner-home": PropertyReaders("setting:properties.logo_android_home", android=_BANNER),
    "brand-banner-login": PropertyReaders("setting:properties.logo_android_login", android=_BANNER),
    "brand-banner-home-demo": PropertyReaders("setting:properties.logo_android_demo", android=_BANNER),
    "cc-persistent-menu": PropertyReaders(
        "setting:hq.persistent_menu", web_apps=f"{_FORMPLAYER}::isPersistentMenuEnabled"
    ),
    "cc-breadcrumbs-enabled": PropertyReaders(
        "setting:hq.show_breadcrumbs", web_apps=f"{_FORMPLAYER}::isBreadcrumbsEnabled"
    ),
    "cc-index-case-search-results": PropertyReaders(
        "application-and-settings/profile-custom-properties-cc-index-case-search-results-equal-to",
        web_apps=f"{_FORMPLAYER}::isIndexCaseSearchResults",
    ),
}


class RecordIncomplete(AssertionError):
    """The record holds less than the judge reads: the observation and the judge disagree on what to run."""


# Traces ---------------------------------------------------------------------


def comparable_trace(trace, runtimes):
    """The trace as proof 3 compares it: the profile's required version and its runtime-read properties."""
    shown = copy.deepcopy(trace)
    shown.pop("derived", None)
    profile = shown.pop("profile", {}) or {}
    properties = {}
    for prop in profile.get("properties") or []:
        readers = PROFILE_PROPERTIES.get(prop.get("key"))
        if readers is not None and readers.read_by(runtimes):
            # Each later setter of a key overwrites an earlier one, as Android's installer writes them in order.
            properties[prop["key"]] = {"value": prop.get("value"), "force": prop.get("force")}
    shown["profile"] = {"requiredVersion": profile.get("requiredVersion"), "properties": properties}
    return shown


def compare_traces(document, artifact, baseline, other, *, runtimes, xmlns=None, labels=None):
    """Every difference between the baseline build's trace and the other build's, as ``artifact``.

    Each trace is read as ``comparable_trace`` reads it under ``runtimes``;
    ``xmlns`` maps the other build's form namespaces to the baseline's
    (``xmlns_alignment``), in the trace's values and in its XML documents
    (``proof.checks.compare.trace``). ``labels`` names each run's generated
    ids (``generated_labels(baseline, other)``), made here where the caller
    gives none.
    """
    return compare_trace_documents(
        comparable_trace(baseline, runtimes),
        comparable_trace(other, runtimes),
        check=CHECK,
        document=document,
        rules=RULES,
        artifact=artifact,
        xmlns=xmlns,
        labels=labels,
    )


# Submissions ----------------------------------------------------------------


def _block_actions(block):
    """A case block's actions as HQ reads them (``casexml/apps/case/xml/parser.py::CaseUpdate.__init__``): each
    block with data, ``close`` wherever it is, and an update (a no-op's slug) where there is none."""
    found = [name for name in ("create", "update") if block.get(name)]
    if "close" in block:
        found.append("close")
    found += [name for name in ("index", "attachment") if block.get(name)]
    return found or ["update"]


def block_key(path):
    """A case block's key by where the form holds it: HQ's path to it (``proof.observe.sessions.block_paths``),
    each key, then ``case``, joined by ``/`` (``__nova_operations/__nova_guard_<uuid>_text/case``)."""
    return "/".join([*path, "case"])


@functools.lru_cache(maxsize=4096)
def _written_block_key(key):
    """A ``block_key`` as a path writes it (``compare.names.block_path``), as one JSON Pointer token."""
    return pointer_token(block_path(key.split("/")[:-1]))


def applied_blocks(blocks, paths):
    """A submission's case blocks in the order HQ applies them, each ``(case id, block_key, block)``
    (``casexml/apps/case/xform.py::get_case_updates`` and ``order_updates``: by case id, then each case's by
    its first action in ``CASE_ACTIONS``, stable sorts, so blocks of one rank keep the form's order). ``paths``
    is where the form holds each block, in ``blocks``' order."""

    def rank(block):
        return min(CASE_ACTIONS.index(action) for action in _block_actions(block))

    held = [
        (str(block.get("@case_id", block.get("case_id", ""))), block_key(path), block)
        for block, path in zip(blocks, paths, strict=True)
    ]
    return sorted(held, key=lambda entry: (entry[0], rank(entry[2])))


def first_action(block):
    """The action HQ applies a case block at (``_block_actions``, first in ``CASE_ACTIONS``): ``create`` for a
    block that opens a case, ``update`` for one that only writes it, and so on."""
    return min(_block_actions(block), key=CASE_ACTIONS.index)


def blocks_by_case(applied):
    """``applied_blocks`` as the comparison reads them: by case id, each case's by ``block_key``, each key's blocks
    in HQ's order (a repeat's rows share one key, so they pair by position). The empty case id's blocks are no
    case's, so they are by the action HQ applies each at first (``first_action``), then by ``block_key``: an empty
    id on a block that opens a case and on one that writes an existing case are two symptoms."""
    by_case = {}
    for case_id, key, block in applied:
        held = by_case.setdefault(case_id, {})
        if case_id == EMPTY_CASE_ID:
            held = held.setdefault(first_action(block), {})
        held.setdefault(key, []).append(block)
    return by_case


def _block_order(applied):
    """Each case's blocks in the order HQ applies them, by key, ``{case id: [block_key, ...]}``; none for the
    empty case id, whose blocks HQ applies none of (it refuses the first, which the refusal's path names)."""
    order = {}
    for case_id, key, _ in applied:
        if case_id != EMPTY_CASE_ID:
            order.setdefault(case_id, []).append(key)
    return order


def _applied(run, index):
    """One run's blocks as HQ applies them (``applied_blocks``), keyed by where the form holds each; None where the
    run holds no blocks (it did not submit, or its processing needs the form's files)."""
    if "blocks" not in run:
        return None
    blocks = run["blocks"] or []
    paths = run.get("blockPaths")
    if paths is None or len(paths) != len(blocks):
        raise RecordIncomplete(
            f"HQ's case processing of run {index} holds {len(blocks)} case blocks and"
            f" {'no' if paths is None else len(paths)} paths for them; the observation"
            " (proof.observe.sessions.case_processing) records where the form holds each block HQ read beside"
            " it (blockPaths), so a record without them was made by other code."
        )
    return applied_blocks(blocks, paths)


def moved_blocks_paired(before, after):
    """``after``'s applied blocks (``applied_blocks``) with each block written where ``before`` writes no block
    keyed as the block of the same case ``before`` writes where ``after`` writes none, in HQ's order.

    HQ reads no block by where the form holds it, and one build may write a
    case's block where the other writes no block at all (HQ's build writes
    a child case's block in ``subcase_<n>``, ``OpenSubCaseAction.
    form_element_name``, Nova's local archive in the repeat's row), so such
    a block moved and is compared with the moved block it replaces, as HQ
    applies it. A block at a place both builds write blocks at is that
    place's: one more or less there is that one block.
    """
    held_before = {key for _, key, _ in before}
    held_after = {key for _, key, _ in after}
    moved = {}
    for case_id, key, _ in before:
        if key not in held_after:
            moved.setdefault(case_id, []).append(key)
    taken = {}
    paired = []
    for case_id, key, block in after:
        partners = moved.get(case_id) or []
        if key not in held_before and taken.get(case_id, 0) < len(partners):
            key = partners[taken.get(case_id, 0)]
            taken[case_id] = taken.get(case_id, 0) + 1
        paired.append((case_id, key, block))
    return paired


def _as_applied(run, applied):
    """One run's case processing record as the comparison reads it, and its blocks' order (``_block_order``):
    its blocks as HQ applies them (``applied``, ``blocks_by_case``), and its refusal by its class, an empty case
    id's by the block HQ refused too (the first empty-id block it applies: ``""`` sorts before every case id)."""
    shown = dict(run)
    shown.pop("blockPaths", None)
    refused_at = None
    order = {}
    if applied is not None:
        shown["blocks"] = blocks_by_case(applied)
        order = _block_order(applied)
        refused_at = next(
            ((first_action(block), key) for case_id, key, block in applied if case_id == EMPTY_CASE_ID), None
        )
    if "refusal" in shown:
        refusal = shown["refusal"]
        if refusal is None:
            shown["refusal"] = {}
        elif refusal.get("class") == ILLEGAL_CASE_ID and refused_at is not None:
            action, key = refused_at
            shown["refusal"] = {ILLEGAL_CASE_ID: {action: {key: refusal.get("message")}}}
        else:
            shown["refusal"] = {str(refusal.get("class")): refusal.get("message")}
    return shown, order


def _case_data_maps(*sides):
    """``CASE_DATA_MAPS`` with each case's blocks of both sides named: each ``block_key`` written as a path writes
    it (``compare.names.block_path``), and each block's children named as ``BLOCK_CHILD_MAPS`` names them."""
    maps = dict(CASE_DATA_MAPS)
    keys = set()
    for side in sides:
        for run in side["runs"]:
            for case_id, held in (run.get("blocks") or {}).items():
                for by_key in held.values() if case_id == EMPTY_CASE_ID else (held,):
                    keys |= set(by_key)
            refused = (run.get("refusal") or {}).get(ILLEGAL_CASE_ID)
            if isinstance(refused, dict):
                for by_key in refused.values():
                    keys |= set(by_key) if isinstance(by_key, dict) else set()
    maps["/runs/*/blocks/*"] = _written_block_key
    # The empty case id's blocks, by the action HQ applies each at first, CommCare's own names.
    maps[f"/runs/*/blocks/{EMPTY_CASE_ID}"] = frozenset(CASE_ACTIONS)
    maps[f"/runs/*/refusal/{ILLEGAL_CASE_ID}"] = frozenset(CASE_ACTIONS)
    for action in CASE_ACTIONS:
        maps[f"/runs/*/blocks/{EMPTY_CASE_ID}/{action}"] = _written_block_key
        maps[f"/runs/*/refusal/{ILLEGAL_CASE_ID}/{action}"] = _written_block_key
    for written in {_written_block_key(key) for key in keys}:
        for case in ("*", *(f"{EMPTY_CASE_ID}/{action}" for action in CASE_ACTIONS)):
            for child, kept in BLOCK_CHILD_MAPS.items():
                maps[f"/runs/*/blocks/{case}/{written}/*/{child}"] = kept
    return maps


def _order_differences(document, artifact, index, before, after):
    """A case both sides apply blocks of in another order (``_block_order``): one difference at
    ``/runs/*/blocks/*/order()`` naming both orders, of the blocks both sides hold (each key's ``n``-th block is
    one block, as the comparison pairs them), so a block more or less changes no order."""
    found = []
    for case_id in sorted(set(before) & set(after)):
        held = []
        for keys in (before[case_id], after[case_id]):
            seen = {}
            numbered = []
            for key in keys:
                seen[key] = seen.get(key, 0) + 1
                numbered.append((key, seen[key]))
            held.append(numbered)
        common = set(held[0]) & set(held[1])
        orders = [[key for key, n in numbered if (key, n) in common] for numbered in held]
        if orders[0] != orders[1]:
            found.append(
                Difference(
                    CHECK,
                    document,
                    artifact,
                    f"/runs/*/blocks/*/{BLOCK_ORDER}",
                    f"/runs/{index}/blocks/{pointer_token(case_id)}/{BLOCK_ORDER}",
                    "changed",
                    orders[0],
                    orders[1],
                )
            )
    return found


def _refusal_place(run, index):
    """Where a run's refusal is reported, ``(path, at)``: ``/runs/*/refusal/<class>``, an empty case id's with the
    action HQ applies the block it refused at and that block (``/runs/*/refusal/IllegalCaseId/<action>/<block>``);
    None where HQ refused nothing."""
    refusal = run.get("refusal")
    if not refusal:
        return None
    (cause, held), *_ = refusal.items()
    path, at = f"/runs/*/refusal/{pointer_token(cause)}", f"/runs/{index}/refusal/{pointer_token(cause)}"
    if cause == ILLEGAL_CASE_ID and isinstance(held, dict) and held:
        (action, by_key), *_ = held.items()
        (key, _), *_ = by_key.items()
        path = f"{path}/{action}/{_written_block_key(key)}"
        at = f"{at}/{action}/{pointer_token(key)}"
    return path, at


def _under_refusal(differences, places):
    """The differences in the cases of a run only one side's processing refused, each under that refusal's path
    (``_refusal_place``, then ``/cases/...``): HQ applies no case of a submission it refuses, so the refusing
    side holds none and every case the other side holds is that refusal's difference."""
    found = []
    for difference in differences:
        tokens = difference.at.split("/")
        if len(tokens) > 3 and tokens[1] == "runs" and tokens[3] == "cases" and int(tokens[2]) in places:
            path, at = places[int(tokens[2])]
            rest = difference.path.split("/")[3:]
            difference = replace(difference, path="/".join([path, *rest]), at="/".join([at, *tokens[3:]]))
        found.append(difference)
    return found


def compare_case_processing(document, artifact, baseline, other, *, traces=None, labels=None):
    """Every difference between HQ's case processing of two traces' runs, as ``artifact``.

    Each side is what ``proof.observe.sessions.processed_runs`` recorded.
    ``traces`` are the two traces the runs were processed from (baseline,
    other), whose generated ids name each side's
    (``compare.trace.generated_labels``), or ``labels``, those labels made
    once by a caller that names the traces' own comparison with them too;
    with neither, each side's marks are compared as the runner numbered
    them. A run HQ could not process on either side for want of the form's
    files (``needsFiles``) is one ``refused`` difference at
    ``/runs/<n>/needs-files/<class>``, naming what HQ asked for on each
    side, and only whether each side submitted is compared for it: what HQ
    would have made of it is not known.
    """
    before = normalized("case_blocks", baseline)
    after = normalized("case_blocks", other)
    if labels is None and traces is not None:
        labels = generated_labels(*traces)
    for index, pair in enumerate(labels or ()):
        for side, named in zip((before, after), pair, strict=True):
            if index < len(side["runs"]):
                side["runs"][index] = relabel_generated(side["runs"][index], named)
    found = []
    for index, (run_before, run_after) in enumerate(zip(before["runs"], after["runs"], strict=False)):
        if "needsFiles" in run_before or "needsFiles" in run_after:
            needs = run_before.get("needsFiles") or run_after.get("needsFiles")
            cause = f"/needs-files/{pointer_token(needs.get('class'))}"
            found.append(
                Difference(
                    CHECK,
                    document,
                    artifact,
                    f"/runs/*{cause}",
                    f"/runs/{index}{cause}",
                    "refused",
                    run_before.get("needsFiles"),
                    run_after.get("needsFiles"),
                )
            )
            before["runs"][index] = {"submitted": run_before["submitted"]}
            after["runs"][index] = {"submitted": run_after["submitted"]}
    applied = [[_applied(run, index) for index, run in enumerate(side["runs"])] for side in (before, after)]
    for index, (held_before, held_after) in enumerate(zip(*applied, strict=False)):
        if held_before is not None and held_after is not None:
            applied[1][index] = moved_blocks_paired(held_before, held_after)
    orders = []
    for side, held in zip((before, after), applied, strict=True):
        shown = [_as_applied(run, blocks) for run, blocks in zip(side["runs"], held, strict=True)]
        side["runs"] = [run for run, _ in shown]
        orders.append([order for _, order in shown])
    places = {}
    for index, (run_before, run_after) in enumerate(zip(before["runs"], after["runs"], strict=False)):
        found += _order_differences(document, artifact, index, orders[0][index], orders[1][index])
        held = (_refusal_place(run_before, index), _refusal_place(run_after, index))
        if (held[0] is None) != (held[1] is None):
            places[index] = held[0] or held[1]
    compared = compare_json(
        before, after, check=CHECK, document=document, artifact=artifact, data_maps=_case_data_maps(before, after)
    )
    return found + _under_refusal([split for difference in compared for split in _by_block(difference)], places)


# Where the comparison holds what is keyed by a block (``block_key``): each case's blocks, and the empty case id's
# blocks and an empty case id's refusal, each under the action HQ applies a block at first (``first_action``).
BY_BLOCK = frozenset(
    {
        "/runs/*/blocks/*",
        *(f"/runs/*/blocks/{EMPTY_CASE_ID}/{action}" for action in CASE_ACTIONS),
        *(f"/runs/*/refusal/{ILLEGAL_CASE_ID}/{action}" for action in CASE_ACTIONS),
    }
)
BY_ACTION = frozenset({f"/runs/*/blocks/{EMPTY_CASE_ID}", f"/runs/*/refusal/{ILLEGAL_CASE_ID}"})


def _by_block(difference):
    """A difference in what is keyed by a block, one per block: where only one side holds a case's blocks (the
    empty case id's too, by each block's first action), or an empty case id's refusal, each block key is its own
    difference at that key (``/runs/*/blocks/*/<block>``, ``/runs/*/blocks//<action>/<block>``,
    ``/runs/*/refusal/IllegalCaseId/<action>/<block>``), as where both sides hold them."""
    if difference.kind not in ("added", "removed"):
        return [difference]
    held = difference.after if difference.kind == "added" else difference.before
    if not isinstance(held, dict):
        return [difference]
    if difference.path in BY_ACTION:
        return [
            split
            for action, by_key in sorted(held.items())
            for split in _by_block(
                replace(
                    difference,
                    path=f"{difference.path}/{action}",
                    at=f"{difference.at}/{action}",
                    before=by_key if difference.kind == "removed" else None,
                    after=by_key if difference.kind == "added" else None,
                )
            )
        ]
    if difference.path not in BY_BLOCK:
        return [difference]
    return [
        replace(
            difference,
            path=f"{difference.path}/{_written_block_key(key)}",
            at=f"{difference.at}/{pointer_token(key)}",
            before=value if difference.kind == "removed" else None,
            after=value if difference.kind == "added" else None,
        )
        for key, value in sorted(held.items())
    ]


# The check ------------------------------------------------------------------


def _refused(document, artifact, cause, reason):
    """One refused comparison, its cause the path (``/<cause>/...``) and ``reason`` the value."""
    return [Difference(CHECK, document, artifact, cause, cause, "refused", None, reason)]


def unbuildable_refusals(document, artifact, outcome):
    """Why HQ makes no installable archive of a build (``unbuildable``), each cause its own refused difference:
    each ``validate_app`` error at the bar's path under ``/unbuildable/validate_app``, and each step that
    raised at ``/unbuildable/raised/<step>/<class>`` (``unbuildable_cause_held``)."""
    unbuildable_cause_held(outcome)
    found = []
    for error in outcome.errors or []:
        path, at = error_path(error)
        found.append(
            Difference(
                CHECK,
                document,
                artifact,
                f"/unbuildable/validate_app{path}",
                f"/unbuildable/validate_app{at}",
                "refused",
                None,
                error,
            )
        )
    for step, raised in sorted(outcome.raised.items()):
        cause = f"/unbuildable/raised/{pointer_token(step)}/{pointer_token((raised or {}).get('class', '?'))}"
        found.append(Difference(CHECK, document, artifact, cause, cause, "refused", None, raised))
    return found


def unbuildable_cause_held(outcome):
    """Raise where a build ``unbuildable`` reads as making no archive names no cause: ``validate_app`` listed no
    error and no step raised.

    ``create_all_files()`` writes the files or raises, and the observation
    records what it raised (``proof.observe.build.build_state``), so every
    build it records that HQ makes no archive of holds a ``validate_app``
    error or a step that raised, each of which the bar reports
    (``proof.checks.bar.build_differences``).
    """
    if not (outcome.errors or outcome.raised):
        raise RecordIncomplete(
            f"The record of HQ's build of {outcome.state} holds no files, yet validate_app listed no error and no"
            " build step raised. The observation (proof.observe.build.build_state) records what create_all_files"
            " raised whenever it wrote no files, so this record was made by other code."
        )


def admission_refusals(document, artifact, admission):
    """A build or archive Core did not admit, each problem at ``/not_admitted/problems/*/<stage>/<class>``, as the
    bar names an admission's problems (``proof.checks.bar.admission_differences``)."""
    from proof.checks.bar import admission_differences

    found = [
        Difference(
            CHECK, document, artifact, f"/not_admitted{d.path}", f"/not_admitted{d.at}", "refused", None, d.after
        )
        for d in admission_differences(document, "-", admission)
        if d.path.startswith("/problems/")
    ]
    return found or _refused(document, artifact, "/not_admitted", {"admitted": False, "problems": None})


def admitted(admission):
    return bool((admission or {}).get("admitted"))


def lookup_refusal(document, artifact, reason, upload):
    """HQ would not serve the tables Nova's push uploaded (``proof.observe.casedata.LookupTablesNotServed``):
    nothing where the bar reports the upload failed (``upload``, the publish's own, answered not ``success``),
    else the cause at ``/lookups-not-served/<why>``: ``upload-failed`` or ``per-owner-table``."""
    if "errors" in reason:
        if upload is not None and not upload.get("success"):
            return []
        cause = "/lookups-not-served/upload-failed"
    elif "table" in reason:
        cause = "/lookups-not-served/per-owner-table"
    else:
        cause = "/lookups-not-served"
    return _refused(document, artifact, cause, reason)


def compare_runs(document, baseline, baseline_processed, other, other_processed, *, xmlns=None, bar_admission=None):
    """Both comparisons of one other build's sessions with the baseline's: the traces and HQ's case processing.

    The differences are named after the other run's side
    (``trace@<side>``, ``case_blocks@<side>``) and compared under its
    runtimes (``RUNTIMES``); ``baseline_processed`` and ``other_processed``
    are HQ's case processing of each side's trace. Where Core did not admit
    the other build the comparison is refused with Core's problems, unless
    the bar's own admission of the same build (``bar_admission``) reports
    them.
    """
    if other.trace is None:
        if bar_admission is not None and not admitted(bar_admission):
            return []
        return admission_refusals(document, f"trace@{other.side}", other.admission)
    labels = generated_labels(baseline.trace, other.trace)
    found = compare_traces(
        document,
        f"trace@{other.side}",
        baseline.trace,
        other.trace,
        runtimes=RUNTIMES[other.side],
        xmlns=xmlns,
        labels=labels,
    )
    found += compare_case_processing(
        document, f"case_blocks@{other.side}", baseline_processed, other_processed, labels=labels
    )
    return found


def _run(recorded, side, blobs):
    trace = recorded.get("trace")
    return Run(side, recorded["admission"], None if trace is None else blobs.get_json(trace))


def _processed(recorded, blobs):
    return blobs.get_json(recorded["processed"])


def behavioral_equivalence(document, observed, sessions, blobs, *, has_local, local_admission=None):
    """Proof 3's differences for one document under one configuration.

    ``observed`` is the republish's view (``observations.Republish``) and
    ``sessions`` the ``b_aligned`` record's proof 3 observation
    (``proof.observe.sessions``), made whether or not HQ accepted B; proof 2's
    judgment of the same configuration decides whether the B build's sessions
    are compared. ``local_admission`` is Core's admission of the local
    archive the bar holds (``observations.local_reports``).
    """
    if observed.a is None:
        if any(refusal.state == "A" for refusal in observed.refusals):
            return []
        return _refused(document, "trace@local.ccz", "/no-a", "HQ holds no A, so no session runs on HQ's build.")
    if unbuildable(observed.a.build) is not None:
        unbuildable_cause_held(observed.a.build)
        return []
    if not has_local:
        return _refused(document, "trace@local.ccz", "/no-local-archive", "The document carries no local archive.")
    if sessions is None:
        raise RecordIncomplete(
            f"{document}'s b_aligned record holds no proof 3 sessions, though HQ holds a buildable A and the document"
            " a local archive. The observation (proof.observe.unit._Unit.observe_b_aligned) runs them whenever A is"
            " buildable, HQ's refusal of B or not; look for a path through it that returns before the sessions."
        )
    if "refused" in sessions["lookupsA"]:
        return lookup_refusal(document, "trace@A", sessions["lookupsA"]["refused"], observed.lookup_uploads.get("A"))
    baseline = _run(sessions["baseline"], "A", blobs)
    if baseline.trace is None:
        if not admitted(observed.a.build.admission):
            return []
        return admission_refusals(document, "trace@A", baseline.admission)
    baseline_processed = _processed(sessions["baseline"], blobs)
    local = _run(sessions["local"], "local.ccz", blobs)
    found = compare_runs(
        document,
        baseline,
        baseline_processed,
        local,
        _processed(sessions["local"], blobs) if local.trace is not None else None,
        xmlns=xmlns_alignment(local.admission, baseline.admission),
        bar_admission=local_admission,
    )
    if observed.b_aligned is not None and observed.b_aligned.files is not None:
        if [d for d in proof2.build_equivalence(document, observed) if d.kind != "refused"]:
            if unbuildable(observed.b_aligned) is not None:
                return [*found, *unbuildable_refusals(document, "trace@B", observed.b_aligned)]
            if sessions.get("lookupsB") and "refused" in sessions["lookupsB"]:
                return [
                    *found,
                    *lookup_refusal(
                        document, "trace@B", sessions["lookupsB"]["refused"], observed.lookup_uploads.get("B")
                    ),
                ]
            if sessions.get("b") is None:
                raise RecordIncomplete(
                    f"{document}'s record holds no sessions of the B build though proof 2 finds a difference after"
                    " the spelling rules; the observation runs them wherever the raw builds differ, which the"
                    " rules only narrow."
                )
            from proof.checks.proof4 import content_versions, trace_versions

            other = _run(sessions["b"], "B", blobs)
            versions_a, versions_b = content_versions(observed.a.build, observed.b_aligned)
            versioned = replace(baseline, trace=trace_versions(baseline.trace, versions_a))
            if other.trace is not None:
                other = replace(other, trace=trace_versions(other.trace, versions_b))
            found += compare_runs(
                document,
                versioned,
                baseline_processed,
                other,
                _processed(sessions["b"], blobs) if other.trace is not None else None,
            )
    return found


# The observation's names, for proof 4's own sessions ------------------------------


def arrange_build(files, directory):
    """HQ's build files arranged as HQ's archive download arranges them (``proof.observe.build.arrange``)."""
    from proof.observe.build import arrange

    return arrange(files, directory)


def run_sessions(core_runner, side, path, restore, script=None):
    """The build's sessions over the restore (``proof.observe.sessions.run_sessions``)."""
    from proof.observe.sessions import run_sessions as observed

    return observed(core_runner, side, path, restore, script)


def processed_runs(state, database, trace, xmlns=None):
    """HQ's case processing of every run's submission (``proof.observe.sessions.processed_runs``)."""
    from proof.observe.sessions import processed_runs as observed

    return observed(state, database, trace, xmlns)


# Served states ----------------------------------------------------------------------


def _served_a(records, name):
    """A's served record (the ``served`` hook's, ``proof.observe.served.observe``), or None where the hook did
    not run or HQ releases no build of A."""
    held = ((records.configurations[name].a or {}).get("hooks") or {}).get("served") or {}
    return held["A"] if held.get("served") else None


def _archive_forms(path) -> dict:
    """Each form of a local archive by its path in it."""
    import zipfile
    from pathlib import PurePosixPath

    with zipfile.ZipFile(path) as archive:
        return {
            entry: archive.read(entry)
            for entry in archive.namelist()
            if PurePosixPath(entry).match("modules-*/forms-*.xml")
        }


def served_equivalence(document, records, name, observed, sessions, *, has_local, local_ccz=None):
    """Proof 3's differences in what Formplayer and the Web Apps client make of one configuration's states.

    Where A is served (``proof.observe.served``): every request HQ's own
    views refused while Formplayer walked A (``formplayer@A``,
    ``served.refusal_differences``), and a release whose archive is
    not the build the other checks read (``release@A``); Formplayer's
    sessions on Nova's local archive against A's, always
    (``formplayer@local.ccz``, the forms' namespaces mapped as Core's are);
    and, wherever proof 2 still finds a difference between A's build and
    the build of B aligned to A, Formplayer's sessions and the client's
    screens on that build against A's (``formplayer@B``, ``webapps@B``).

    For a Connect app (``proof.observe.connect``), what CommCare Connect made of each state's submissions
    (``proof.checks.connect``): what stands on its own at A (``connect@A``), and the local archive's and B's
    against A's (``connect@local.ccz``, ``connect@B``).
    """
    from proof.checks import connect, served

    blobs = records.blobs
    a = _served_a(records, name)
    if a is None:
        return []
    found = served.refusal_differences(a["formplayer"]["hq"], check=CHECK, document=document, artifact="formplayer@A")
    if a.get("releaseDiffers"):
        found += _refused(document, "release@A", "/release-differs", a["releaseDiffers"])
    aligned = (records.configurations[name].b_aligned or {}).get("served")
    if aligned is None:
        raise RecordIncomplete(
            f"{document}'s b_aligned record under {name} holds no served states though A was served. The unit"
            " (proof.observe.unit._Unit.observe_b_aligned) records them wherever the served hook ran at A."
        )
    trace_a = blobs.get_json(a["formplayer"]["trace"])
    # A Connect app: what Connect made of A's submissions that stands on its own, and below what it made of the
    # local archive's and of B's against A's (``proof.checks.connect``).
    opportunity = (((records.configurations[name].a or {}).get("hooks") or {}).get("served") or {}).get("connect")
    connect_a = blobs.get_json(a["connect"]) if a.get("connect") else None
    if opportunity is not None:
        found += connect.absolute_differences(
            connect_a, opportunity["catalog"], check=CHECK, document=document, artifact="connect@A"
        )
    if aligned.get("refused"):
        # HQ's make_build refused the state the unit held with b_aligned (B, or B aligned to A), which the bar
        # reports of B's build; nothing was served there to compare.
        return found
    if has_local:
        local = aligned.get("local")
        if local is None:
            raise RecordIncomplete(
                f"{document}'s b_aligned record under {name} holds no Formplayer walk of the local archive, though"
                " the document carries one and A was served (proof.observe.served.aligned)."
            )
        xmlns = None
        if sessions is not None and sessions.get("baseline") and sessions.get("local"):
            xmlns = xmlns_alignment(sessions["local"]["admission"], sessions["baseline"]["admission"])
        found += served.formplayer_differences(
            trace_a,
            blobs.get_json(local["formplayer"]["trace"]),
            check=CHECK,
            document=document,
            artifact="formplayer@local.ccz",
            rules=RULES,
            xmlns=xmlns,
            text_ids=served.merged_text_ids(observed.a.build.files or {}, _archive_forms(local_ccz))
            if local_ccz is not None
            else None,
        )
        if opportunity is not None and local.get("connect"):
            # The archive's submissions as it arranges them (no app named) and under the app's id, each against
            # A's from Core.
            found += connect.differences(
                connect_a,
                blobs.get_json(local["connect"]),
                check=CHECK,
                document=document,
                artifact="connect@local.ccz",
                readers={"formplayer": "formplayer", "core": "core", "core@app": "core"},
            )
    b = aligned.get("B")
    if b is not None and observed.b_aligned is not None and observed.b_aligned.files is not None:
        if [d for d in proof2.build_equivalence(document, observed) if d.kind != "refused"]:
            if b.get("releaseDiffers"):
                found += _refused(document, "release@B", "/release-differs", b["releaseDiffers"])
            from proof.checks.proof4 import content_versions

            found += served.formplayer_differences(
                trace_a,
                blobs.get_json(b["formplayer"]["trace"]),
                check=CHECK,
                document=document,
                artifact="formplayer@B",
                rules=RULES,
                versions=content_versions(observed.a.build, observed.b_aligned),
            )
            if a.get("webapps") is not None and b.get("webapps") is not None:
                found += served.webapps_differences(
                    blobs.get_json(a["webapps"]),
                    blobs.get_json(b["webapps"]),
                    check=CHECK,
                    document=document,
                    artifact="webapps@B",
                )
            if opportunity is not None and b.get("connect"):
                found += connect.differences(
                    connect_a, blobs.get_json(b["connect"]), check=CHECK, document=document, artifact="connect@B"
                )
    return found


def document_behavior(document, records):
    """Proof 3's differences on one document: each configuration it is exported under, judged from its records."""
    from proof.checks import observations

    found = []
    local_admission = observations.local_reports(records).get("local.ccz")
    for name in sorted(document.exports):
        observed = observations.republish_view(records, name)
        sessions = observations.sessions_record(records, name)
        found += behavioral_equivalence(
            document.id,
            observed,
            sessions,
            records.blobs,
            has_local=document.local_ccz is not None,
            local_admission=local_admission,
        )
        found += served_equivalence(
            document.id,
            records,
            name,
            observed,
            sessions,
            has_local=document.local_ccz is not None,
            local_ccz=document.local_ccz,
        )
    from proof.checks import android

    found += android.behavior(document.id, android.document_record(records))
    return found + observations.soft_assertion_differences(records, CHECK)
