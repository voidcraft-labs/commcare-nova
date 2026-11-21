"""The closed set of reports that are what HQ, CommCare or Connect does itself, each proven on an app HQ's own
editors made (proof/README.md, "Spelling rules and the registers").

A check reports what a reader made of Nova's export. A few of those reports
are no part of Nova's export at all: an app made in HQ's own pages, with no
Nova bytes in it, meets the same report, and nothing Nova can spell removes
it. Each such report is a member of ``HQ_OWN_REPORTS``,
``HqOwnReport(id, artifacts, paths, applies, proof)``: the artifacts (globs)
and the structural paths of the reports it names, and ``applies``, the
condition under which a report it names is HQ's own, read from what the
check holds of the state. A check asks the set (``held``) for each report it
makes at one of a member's paths, and leaves out a report only where a
member names it and that member's condition holds; no check carries a
condition of its own for it.

The set is closed and proven, as the spelling rules are (``proof.rules``):
every member names the lane test module that holds its proof, and that
module holds a test named ``test_<member id>`` that runs HQ's own editors,
with no Nova export, to the same report (``unproven``). A proof whose
reader is served runs where that reader runs (``reader`` mark), so the pull
request lane leaves it to the nightly.

The members:

- ``registration_alert_child_case`` (finding 50): Vellum's pre-save alert
  "This registration form is missing a case name" on a follow-up form that
  opens one child case outside a repeat. HQ counts such a form a
  registration form (``models/forms.py::Form.get_registration_actions``,
  ``is_registration_form``: ``open_case`` where it is active, and every
  subcase with no ``repeat_context``, exactly one in all), and maps a case
  name only from the form's own case (``form_action_diff.py::
  get_case_mappings``), so its form designer hands Vellum a registration
  form with no name mapped and Vellum's case management raises the alert
  (Vellum ``caseManagement.js::preSaveValidation``).
- ``android_grouped_tile_reopen`` (finding 67): a form left incomplete under
  grouped tiles, for a case with no connection of the grouping's name, that
  home cannot reopen on Android. HQ's build gives every form under grouped
  tiles the datum ``<case datum>_parent_ids``
  (``suite_xml/sections/entries.py::EntriesHelper.get_extra_case_id_datums``),
  whose value is empty for such a case; commcare-core writes a session as
  its steps joined by spaces and trims it
  (``session/SessionDescriptorUtil.createSessionDescriptor``), so the line
  ends at the datum's id, and its reader splits the line on spaces and reads
  a value after every datum's id (``loadSessionFromDescriptor``), which
  commcare-android calls to reopen the form
  (``models/AndroidSessionWrapper.loadFromStateDescription``) and which
  raises ``ArrayIndexOutOfBoundsException``.
- ``connect_block_renamed`` (defect 15's Connect forwarding): what Connect
  does with a block whose id changed under an opportunity that holds the
  old one. Connect keys an opportunity's rows by each block's id
  (commcare-connect ``form_receiver/processor.py::get_or_create_learn_module``,
  ``get_or_create_deliver_unit``, ``process_task_modules``), so any app
  whose block id changes meets the same refusals and new rows, whoever
  changed it. A renamed task in a form of its own reaches Connect, which
  takes its payload and completes no task the worker was assigned under
  the old id (``task-completed-nothing``).
- ``settings_page_writes_unset_settings``: the app settings page's save
  adding each of the fifteen settings Nova seeds where the app's stored
  profile holds no value for it, in the stored app, each built profile and
  Core's reading of the profile, on a document made in HQ. The page posts
  every setting it shows, an unset one at the value it shows for it
  (``settings/bootstrap5/commcare_settings.js::serialize``), and HQ stores
  each (``views/settings.py::edit_commcare_profile``), on any app. Nova's
  publish over an app it brought in leaves an unset setting unset
  (``targetOverlay.ts::projectProfileForTarget``, ``seeds: "target"``), so
  proof 4's save over B of such an app meets what the same save over the app
  HQ made meets. An app Nova made holds each of the fifteen, since Nova seeds
  them, so there a setting the save writes is Nova's (finding 40, whose
  fixed entries the control ``case-operation-query`` keeps showing).

- ``android_settings_page_writes_unset_settings``: the three Android
  preference readers and the two worker settings whose value changes when
  HQ's own settings page first saves its defaults. A and B must both lack
  the setting, HQ's page must add its exact default and the device must
  report the same transition observed on an app made entirely in HQ.

This module reads records only: it imports neither HQ nor Django
(``test_judge_purity``), and nothing beyond the standard library, since the
Android reader's own checks import it through ``proof.checks.android`` on a
runner's Python with no image (``proof/android/test_standard_library.py``).
Which blocks two builds' forms renamed is read from their XML, so the Connect
judge reads it (``proof.checks.connect.renamed_blocks``) and hands this
module the answer.
"""

from __future__ import annotations

import ast
import fnmatch
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree

WORKTREE = Path(__file__).resolve().parents[2]
# A module that proves a member: its name says so, and a member names it. The set's own test is no member's proof.
PROOF_MODULES = "test_hq_own_*.py"
OWN_TEST = "proof/checks/test_hq_own_reports.py"


@dataclass(frozen=True)
class HqOwnReport:
    id: str
    # The artifacts the member's reports are made on, as globs over the artifact as the check names it where it
    # asks the set.
    artifacts: tuple[str, ...]
    # The structural paths of the reports it names, each exactly as the check writes it.
    paths: tuple[str, ...]
    # Whether a report it names is HQ's own, from what the check holds of the state (each member's own arguments).
    applies: Callable[..., bool]
    # The lane test module, from the repository's root, that holds ``test_<id>``: the report on an app HQ's own
    # editors made.
    proof: str
    description: str

    def names(self, artifact: str, path: str) -> bool:
        return path in self.paths and any(fnmatch.fnmatchcase(artifact, glob) for glob in self.artifacts)


# Finding 50 ------------------------------------------------------------------------------------------------------

# The conditions HQ reads as active (``models/form_actions.py::FormActionCondition.is_active``).
ACTIVE_CONDITIONS = frozenset({"if", "always"})
# Vellum's alert as proof 4 keys it (``proof.checks.proof4.vellum_report``, ``message_key``): its text with what
# its quotes hold written ``*``, the button Vellum's case management adds after it among them.
REGISTRATION_ALERT = (
    "/modules/*/forms/*/pre_save_alerts/This registration form is missing a case name. Assign the <code>name<~1code>"
    ' property to a question.<div> <button type="*" class="*"> Auto-assign case name <~1button> <~1div>'
)


def registers_one_child_case(form) -> bool:
    """Whether HQ counts a stored form (its app document's form) a registration form for one child case alone:
    ``open_case`` is not active (``models/forms.py::Form.active_actions`` leaves it out of a form that requires a
    case, and holds it elsewhere where its condition is active) and exactly one subcase has no
    ``repeat_context``."""
    if not isinstance(form, dict):
        return False
    actions = form.get("actions") or {}
    condition = (actions.get("open_case") or {}).get("condition") or {}
    opens_its_own = form.get("requires") != "case" and condition.get("type") in ACTIVE_CONDITIONS
    outside = [subcase for subcase in actions.get("subcases") or [] if not subcase.get("repeat_context")]
    return not opens_its_own and len(outside) == 1


# Finding 67 ------------------------------------------------------------------------------------------------------

# commcare-core's descriptor steps (``session/SessionFrame``): the command, and the three datum steps
# ``loadSessionFromDescriptor`` reads an id and a value after.
COMMAND_STEP = "COMMAND_ID"
DATUM_STEPS = frozenset({"CASE_ID", "COMPUTED_DATUM", "STATE_UNKNOWN"})
# HQ names the datum after the case datum whose parents it reads (``f"{case_datum_id}_parent_ids"``): ``case_id``'s
# for a single selection, ``selected_cases``'s for a multiple one.
PARENT_IDS_SUFFIX = "_parent_ids"
PARENT_IDS_DATUM = f"case_id{PARENT_IDS_SUFFIX}"
OUT_OF_BOUNDS = "java.lang.ArrayIndexOutOfBoundsException"
REOPENED_SESSION = "/update/reopened/*/session"


def _is_parent_ids(datum: str) -> bool:
    """Whether a datum's id is the one HQ's build gives a form under grouped tiles: a case datum's id, then
    ``_parent_ids``."""
    return datum.endswith(PARENT_IDS_SUFFIX) and len(datum) > len(PARENT_IDS_SUFFIX)


def reopen_ends_at_empty_parent_ids(reopened) -> bool:
    """Whether a reopened form's answer (``proof.android``'s ``update``, one form of ``reopened``) is the grouped
    tiles' own: the session Android stored for it ends at a datum whose id is a case datum's ``_parent_ids`` with
    no value after it, read as ``SessionDescriptorUtil.loadSessionFromDescriptor`` reads it, and home raised
    ``ArrayIndexOutOfBoundsException`` reopening it."""
    if not isinstance(reopened, dict):
        return False
    raised = reopened.get("homeRaised")
    descriptor = reopened.get("SessionStateDescriptor.getSessionDescriptor")
    if not isinstance(raised, dict) or raised.get("class") != OUT_OF_BOUNDS or not isinstance(descriptor, str):
        return False
    tokens = descriptor.split(" ")
    current = 0
    while current < len(tokens):
        step = tokens[current]
        if step == COMMAND_STEP:
            current += 2
        elif step in DATUM_STEPS:
            if current + 2 >= len(tokens):
                return current + 2 == len(tokens) and _is_parent_ids(tokens[current + 1])
            current += 3
        else:
            current += 1
    return False


# Defect 15's Connect forwarding ----------------------------------------------------------------------------------

# Which side of a rename a report names a block by: the id the opportunity holds, or the id the edit gave it.
OLD = "old"
NEW = "new"
CONNECT_RENAMED = (
    "/ids/deliver/moved",
    "/ids/task/moved",
    "/ids/module/moved",
    "/runs/*/refused/400/payment-unit-is-not-configured-for-the-deliver-unit",
    "/runs/*/catalog/learnModules/added",
    "/runs/*/task-completed-nothing",
)


def connect_report_renamed(renamed, subjects) -> bool:
    """Whether every block a Connect report names (``subjects``: ``(kind, id, OLD or NEW)``) is one side of a block
    renamed between A's forms and B-edit's (``renamed``, their
    ``proof.checks.connect.renamed_blocks``); a report that names no block is
    no rename's."""
    sides = {OLD: {(kind, old) for kind, old, _ in renamed}, NEW: {(kind, new) for kind, _, new in renamed}}
    return bool(subjects) and all((kind, block) in sides.get(side, ()) for kind, block, side in subjects)


# The settings page writes the settings an app holds no value for -------------------------------------------------

# The editor proof 4 names the app settings page's save by (``proof.editors.pages.APP_SETTINGS``).
SETTINGS_PAGE = "app settings"
# The fifteen settings Nova seeds on an app it made and leaves as the project space holds them on an app it brought
# in (``lib/commcare/targetOverlay.ts::projectProfileForTarget``, ``seeds: "target"``), fixed here by hand as
# ``proof.checks.intent.NOVA_PROFILE_CONSTANTS`` fixes their names, which ``test_hq_own_reports`` holds equal. Values are what HQ's untouched page posts and stores,
# checked against the request, the built profiles and Core's installed setters by the native witness.
UNSEEDED_SETTINGS = {
    "cc-autosync-freq": "freq-never",
    "cc-autoup-freq": "freq-never",
    "cc-content-valid": "yes",
    "cc-days-form-retain": "-1",
    "cc-enable-tts": "no",
    "cc-fuzzy-search-enabled": "yes",
    "cc-gps-auto-capture-accuracy": "5",
    "cc-inflation-target-density": "none",
    "cc-label-required-questions-with-asterisk": "no",
    "cc-login-duration-seconds": "86400",
    "cc-maps-default-layer": "normal",
    "cc-resize-images": "none",
    "logenabled": "Enabled",
    "unsent-number-limit": "5",
    "unsent-time-limit": "5",
}
# Where proof 4 reports a setting: in the stored app's profile and in a Core trace's reading of the profile
# (``/profile/properties/<key>``), and in each built profile (``/profile/property[@key=<key>]``).
STORED_SETTING = "/profile/properties/"
BUILT_SETTING = "/profile/property[@key="
SETTING_PATHS = tuple(
    path for key in UNSEEDED_SETTINGS for path in (f"{STORED_SETTING}{key}", f"{BUILT_SETTING}{key}]")
)
SETTINGS_ARTIFACTS = tuple(
    f"{artifact}@{SETTINGS_PAGE}"
    for artifact in ("app.json", "profile.xml", "profile.ccpr", "media_profile.xml", "media_profile.ccpr", "trace")
)


def setting_of(path: str) -> str | None:
    """The setting a report at one of ``SETTING_PATHS`` names, or None for any other path."""
    if path.startswith(STORED_SETTING):
        return path[len(STORED_SETTING) :]
    if path.startswith(BUILT_SETTING) and path.endswith("]"):
        return path[len(BUILT_SETTING) : -1]
    return None


def settings_added(authored, published, saved):
    """The first settings-page save's exact defaults, only where the source HQ app and Nova's republish lack the key."""

    def properties(doc):
        if not isinstance(doc, dict):
            return None
        profile = doc.get("profile", {})
        return profile.get("properties", {}) if isinstance(profile, dict) else None

    original, before, after = map(properties, (authored, published, saved))
    if not all(isinstance(held, dict) for held in (original, before, after)):
        return {}
    return {
        key: value
        for key, value in UNSEEDED_SETTINGS.items()
        if key not in original and key not in before and after.get(key) == value
    }


def settings_page_wrote_unset(difference, added) -> bool:
    """The saved app's property, the complete property HQ built, or the same setter Core read at admission."""
    key = setting_of(difference.path)
    if key not in added or added[key] != UNSEEDED_SETTINGS[key] or difference.kind != "added":
        return False
    value = added[key]
    force = key != "cc-maps-default-layer"
    artifact = difference.artifact.split("@", 1)[0]
    if artifact == "app.json":
        return difference.path == f"{STORED_SETTING}{key}" and difference.after == value
    if artifact == "trace":
        return (
            difference.path == f"{STORED_SETTING}{key}"
            and isinstance(difference.after, dict)
            and difference.after == {"value": value, "force": force}
            and difference.after["force"] is force
        )
    if difference.path != f"{BUILT_SETTING}{key}]" or not isinstance(difference.after, str):
        return False
    try:
        parser = ElementTree.XMLParser(target=ElementTree.TreeBuilder(insert_comments=True, insert_pis=True))
        element = ElementTree.fromstring(difference.after, parser=parser)
    except ElementTree.ParseError:
        return False
    attributes = {"key": key, "value": value}
    if force:
        attributes["force"] = "true"
    return element.tag == "property" and element.attrib == attributes and not len(element) and not element.text


# Android's preference readers apply their own defaults when a profile omits the setting. The update
# reader first sets the two preferences through the worker's settings UI. Each tuple is the stored key,
# the default HQ's page writes and the exact before/after Android observations (including the worker's own).
ANDROID_SETTINGS = {
    "/profile/readers/CommCareApp.areMMResourcesValidated": ("cc-content-valid", "yes", False, True),
    "/profile/readers/HiddenPreferences.getGpsAutoCaptureAccuracy": ("cc-gps-auto-capture-accuracy", "5", 10, 5),
    "/profile/readers/MainConfigurablePreferences.isFuzzySearchEnabled": (
        "cc-fuzzy-search-enabled",
        "yes",
        False,
        True,
    ),
    "/update/workerSettings/cc-autoup-freq": ("cc-autoup-freq", "freq-never", "freq-daily", "freq-never"),
    "/update/workerSettings/cc-enable-tts": ("cc-enable-tts", "no", "yes", "no"),
}


ANDROID_INSTALLED_SEARCH = "/walks/*/steps/*/list/searches/asInstalled/*"


def _search_modes(app, walk, step):
    walks = (app or {}).get("walks") or {}
    steps = (walks.get(walk) or {}).get("steps") or []
    if not step.isdecimal() or int(step) >= len(steps):
        return {}
    return (steps[int(step)].get("list") or {}).get("searches") or {}


def android_settings_page_wrote_unset(difference, added, original_device=None, saved_device=None, next_build=None):
    """Only the exact Android transition on a key HQ's page added that neither A nor B held."""
    if difference.path == ANDROID_INSTALLED_SEARCH:
        # Android's list runs each query with the installed preference and then with fuzzy search forced
        # on and off. Require the same two independently observed result sets on both installations.
        if added.get("cc-fuzzy-search-enabled") != "yes" or difference.kind != "changed":
            return False
        _, _, walk, _, step, _, _, _, term = difference.at.split("/")
        walk = walk.replace("~1", "/").replace("~0", "~")
        term = term.replace("~1", "/").replace("~0", "~")
        before = _search_modes(original_device, walk, step)
        after = _search_modes(saved_device, walk, step)
        reader = "MainConfigurablePreferences.isFuzzySearchEnabled"
        off, on = before.get("fuzzyOff"), before.get("fuzzyOn")
        return (
            before.get(reader) is False
            and after.get(reader) is True
            and isinstance(off, dict)
            and isinstance(on, dict)
            and term in off
            and term in on
            and off[term] != on[term]
            and off == after.get("fuzzyOff")
            and on == after.get("fuzzyOn")
            and before.get("asInstalled") == off
            and after.get("asInstalled") == on
        )
    key, setting, before, after = ANDROID_SETTINGS[difference.path]
    if difference.path.startswith("/update/workerSettings/"):
        # The saved release reset a real choice. Require its in-place control to have installed and kept it.
        control = next_build or {}
        if (
            control.get("updated") != "Installed"
            or key not in (control.get("workerSettings") or ())
            or any(((control.get(side) or {}).get("stored") or {}).get(key) != before for side in ("before", "after"))
        ):
            return False
    return (
        added.get(key) == setting
        and difference.kind == "changed"
        and type(difference.before) is type(before)
        and difference.before == before
        and type(difference.after) is type(after)
        and difference.after == after
    )


# The set ---------------------------------------------------------------------------------------------------------

HQ_OWN_REPORTS: tuple[HqOwnReport, ...] = (
    HqOwnReport(
        id="registration_alert_child_case",
        artifacts=("editor:vellum", "editor:vellum again"),
        paths=(REGISTRATION_ALERT,),
        applies=registers_one_child_case,
        proof="proof/editors/test_hq_own_registration_alert.py",
        description=(
            "Vellum's alert that a registration form lacks a case name, on a follow-up form that opens one child"
            " case outside a repeat (finding 50)."
        ),
    ),
    HqOwnReport(
        id="android_grouped_tile_reopen",
        artifacts=("android@*",),
        paths=(REOPENED_SESSION,),
        applies=reopen_ends_at_empty_parent_ids,
        proof="proof/android/test_hq_own_grouped_tile_reopen.py",
        description=(
            "Home raising on a form left incomplete under grouped tiles for a case with no connection (finding 67)."
        ),
    ),
    HqOwnReport(
        id="connect_block_renamed",
        artifacts=("connect@B-edit@*",),
        paths=CONNECT_RENAMED,
        applies=connect_report_renamed,
        proof="proof/connect/test_hq_own_rename.py",
        description="What Connect does with a block renamed under an opportunity that holds its old id (defect 15).",
    ),
    HqOwnReport(
        id="settings_page_writes_unset_settings",
        artifacts=SETTINGS_ARTIFACTS,
        paths=SETTING_PATHS,
        applies=settings_page_wrote_unset,
        proof="proof/editors/test_hq_own_settings_page.py",
        description=(
            "The app settings page's save writing each setting an app made in HQ holds no value for, which Nova's"
            " publish over it seeds none of."
        ),
    ),
    HqOwnReport(
        id="android_settings_page_writes_unset_settings",
        artifacts=("android@app settings", "android-tablet@app settings"),
        paths=(*ANDROID_SETTINGS, ANDROID_INSTALLED_SEARCH),
        applies=android_settings_page_wrote_unset,
        proof="proof/android/test_hq_own_settings_page.py",
        description="Android's reading and update after HQ's own settings page first saved an unset setting.",
    ),
)


def held(artifact: str, path: str, *evidence, members=None) -> HqOwnReport | None:
    """The member that names a report (its artifact as the check names it, and its structural path) and whose
    condition holds on ``evidence``, the member's own arguments; None where the report is the export's."""
    for member in HQ_OWN_REPORTS if members is None else members:
        if member.names(artifact, path) and member.applies(*evidence):
            return member
    return None


def _test_names(path: Path) -> set[str]:
    """Every test function a Python file defines (read with ``ast``, never imported: a proof imports its reader)."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return set()
    return {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")
    }


def unproven(members=None, worktree: Path = WORKTREE) -> list[str]:
    """Why the set is not closed and proven, as person-readable problems; empty when it is.

    Every member names a proof module that holds ``test_<member id>``,
    no two members share an id, and every module of the lane named as a
    proof (``test_hq_own_*.py``) is a member's: a proof with no member, or
    a member with no proof, fails.
    """
    members = HQ_OWN_REPORTS if members is None else members
    problems = []
    ids = [member.id for member in members]
    for member_id in sorted({i for i in ids if ids.count(i) > 1}):
        problems.append(f"Two members of HQ_OWN_REPORTS share the id {member_id}.")
    named = set()
    for member in members:
        path = worktree / member.proof
        named.add(path.resolve())
        if not path.exists():
            problems.append(
                f"The member {member.id} names {member.proof} as its proof, and there is no such file. Its proof"
                " runs HQ's own editors, with no Nova export, to the report the member leaves out."
            )
        elif f"test_{member.id}" not in _test_names(path):
            problems.append(
                f"The member {member.id} names {member.proof} as its proof, which holds no test_{member.id}. Name"
                " the test that shows the report on an app HQ's own editors made after the member."
            )
    for path in sorted((worktree / "proof").rglob(PROOF_MODULES)):
        if path.resolve() not in named and path.resolve() != (worktree / OWN_TEST).resolve():
            problems.append(
                f"{path.relative_to(worktree)} proves a report HQ makes itself, and no member of HQ_OWN_REPORTS"
                " names it. List the member in proof/checks/hq_own_reports.py or remove the module."
            )
    return problems
