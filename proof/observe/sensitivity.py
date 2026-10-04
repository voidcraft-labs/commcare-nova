"""Configuration sensitivity's observation: what HQ's build of A reads, and A built again with each gate flipped.

While A's plain build runs (``plain_build``: the unit's own build of A,
``proof.observe.unit``), the seams record every gate HQ reads: each feature
flag (``proof.hq.seams.flags``), and each of the three project-space
settings HQ's build reads (``project_space_reads``):

- CommTrack: ``models/applications.py::Application.commtrack_enabled``, read
  for every form's entry (``suite_xml/sections/entries.py::
  EntriesHelper.entry_for_module``) and by an advanced module's details and
  validation, and the project's own ``domain/models.py::
  Domain.commtrack_enabled``, which ``Domain.uses_locations`` reads where
  ``helpers/validators.py::ModuleDetailValidatorMixin.validate_detail_columns``
  meets a location column;
- sync cases on form entry: ``entries.py``'s binding of
  ``case_search/models.py::case_search_sync_cases_on_form_entry_enabled_for_domain``,
  read only for a module that offers search (``EntriesHelper.
  include_post_in_entry`` and ``::add_post_to_entry``);
- the flat location fixture: ``locations/models.py::
  LocationFixtureConfiguration.sync_flat_fixture``, which
  ``suite_xml/post_process/instances.py::location_fixture_instances`` reads
  for an ``instance('locations')`` only while ``HIERARCHICAL_LOCATION_FIXTURE``
  is on, and otherwise never.

Whether case search is on (``CaseSearchConfig.enabled``) is read by the
module settings page (``views/modules.py``), never by the build.

Then A is built again once per gate read (``flip_plan``), each in a fork
of A's state, with that one gate flipped and everything else
as it was (``flipped``): a flag through the flag seam; CommTrack through
HQ's own test seam (``app_manager/tests/util.py::commtrack_enabled``) and
the project's ``Domain`` document together, as the unit's seeding sets both
from the configuration (``proof.hq.state``); sync on form entry through
HQ's test seam (``::case_search_sync_cases_on_form_entry_enabled_for_domain``)
or that binding answering no; the flat location fixture through the
project's ``LocationFixtureConfiguration`` row, holding the opposite of what
the plain build read (with no row HQ syncs it). Every build is HQ's whole
build (``proof.observe.build.build_state``) of the app freshly read, with the
caches emptied first, so nothing one build computed answers the next.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, replace

# Each gate's entry id (``lib/commcare/surface/entries/gates.json``): a flag's, by its constant, and each
# project-space setting HQ's build reads.
COMMTRACK = "project-space-setting/Domain.commtrack_enabled"
SYNC_ON_FORM_ENTRY = "project-space-setting/CaseSearchConfig.sync_cases_on_form_entry"
FLAT_FIXTURE = "project-space-setting/LocationFixtureConfiguration.sync_flat_fixture"
FLAG_GATE_PREFIX = "toggle/"


def flag_gate(symbol):
    """The gate entry id of a flag HQ reads, by its constant."""
    return f"{FLAG_GATE_PREFIX}{symbol}"


# The flips ------------------------------------------------------------------


@dataclass(frozen=True)
class Flip:
    """One gate of the plain build, flipped: the configuration the flipped build runs under.

    A configuration does not hold the flat location fixture, so its flip
    keeps the plain configuration and turns the unit's database instead
    (``flipped``).
    """

    gate: str
    configuration: object  # proof.hq.configuration.Configuration
    accepted: bool  # Nova's publish accepts the configuration (decision 19)


def flip_plan(configuration, flags_read, settings_read):
    """One flip per gate the plain build read, each flipped configuration, before decision 19 is asked.

    Each flag, then CommTrack, sync on form entry and the flat fixture;
    ``accepted`` is left True, for the judge to decide
    (``proof.checks.sensitivity.flips``).
    """
    found = []
    for symbol in sorted(flags_read):
        found.append(
            Flip(flag_gate(symbol), replace(configuration, flags=frozenset(set(configuration.flags) ^ {symbol})), True)
        )
    if COMMTRACK in settings_read:
        found.append(Flip(COMMTRACK, replace(configuration, commtrack=not configuration.commtrack), True))
    if SYNC_ON_FORM_ENTRY in settings_read:
        # HQ reads the setting only from an enabled case search config, so the
        # project space that syncs on form entry has case search on.
        on = not configuration.sync_cases_on_form_entry
        turned = replace(
            configuration,
            sync_cases_on_form_entry=on,
            case_search_enabled=configuration.case_search_enabled or on,
        )
        found.append(Flip(SYNC_ON_FORM_ENTRY, turned, True))
    if FLAT_FIXTURE in settings_read:
        # A configuration does not hold this setting: the flip turns what the
        # unit's database holds, and Nova's publish asks nothing about it yet.
        found.append(Flip(FLAT_FIXTURE, configuration, True))
    return found


class _CountedReads:
    """A field of an HQ model, read through its own descriptor, each read on an instance counted under ``gate``.

    A data descriptor, so it sees a read even where the value sits in the
    instance's ``__dict__`` (a Django field's ``DeferredAttribute`` is not
    one); a write goes where the field's own descriptor puts it.
    """

    def __init__(self, original, name, gate, reads):
        self.original, self.name, self.gate, self.reads = original, name, gate, reads

    def __get__(self, instance, owner=None):
        if instance is not None:
            self.reads[self.gate] = self.reads.get(self.gate, 0) + 1
        return self.original.__get__(instance, owner)

    def __set__(self, instance, value):
        setter = getattr(type(self.original), "__set__", None)
        if setter is None:
            instance.__dict__[self.name] = value
        else:
            setter(self.original, instance, value)


def _counted(model, name, gate, reads):
    import inspect
    from unittest import mock

    return mock.patch.object(model, name, new=_CountedReads(inspect.getattr_static(model, name), name, gate, reads))


@contextmanager
def project_space_reads(configuration, reads):
    """Counts each read of a project-space setting HQ's build reads, in ``reads`` by gate, answering as before.

    The unit's seams answer CommTrack and sync on form entry from the
    configuration (``proof.hq.seams.project_space``) and the unit holds the
    project's ``Domain`` document from it (``proof.hq.state``); these answer
    the same. The flat location fixture is read from the unit's database,
    where HQ's default (no row: it syncs) holds.
    """
    from unittest import mock

    from corehq.apps.app_manager.models import Application
    from corehq.apps.app_manager.suite_xml.sections import entries
    from corehq.apps.domain.models import Domain
    from corehq.apps.locations.models import LocationFixtureConfiguration

    def commtrack(app):
        reads[COMMTRACK] = reads.get(COMMTRACK, 0) + 1
        return configuration.commtrack

    def sync_on_form_entry(domain):
        reads[SYNC_ON_FORM_ENTRY] = reads.get(SYNC_ON_FORM_ENTRY, 0) + 1
        return configuration.sync_cases_on_form_entry

    with (
        mock.patch.object(Application, "commtrack_enabled", new=property(commtrack)),
        _counted(Domain, "commtrack_enabled", COMMTRACK, reads),
        mock.patch.object(entries, "case_search_sync_cases_on_form_entry_enabled_for_domain", new=sync_on_form_entry),
        _counted(LocationFixtureConfiguration, "sync_flat_fixture", FLAT_FIXTURE, reads),
    ):
        yield reads


@contextmanager
def _commtrack_flipped(state, enabled):
    """CommTrack as given wherever HQ's build reads it: the app's (HQ's test seam) and the project's ``Domain``."""
    from corehq.apps.app_manager.tests import util as app_manager_test_util

    from proof.hq.state import domain_document

    docid = domain_document(state.configuration)["_id"]
    held = state.couch.open_doc(docid)
    with app_manager_test_util.commtrack_enabled(enabled):
        state.couch.seed({**held, "commtrack_enabled": enabled})
        try:
            yield
        finally:
            state.couch.seed(held)


@contextmanager
def _flat_fixture_flipped(domain):
    """The project's ``LocationFixtureConfiguration`` holding the opposite of its flat fixture, restored afterwards."""
    from corehq.apps.locations.models import LocationFixtureConfiguration

    held = LocationFixtureConfiguration.objects.filter(domain=domain).first()
    syncs = LocationFixtureConfiguration.for_domain(domain).sync_flat_fixture
    LocationFixtureConfiguration.objects.update_or_create(domain=domain, defaults={"sync_flat_fixture": not syncs})
    try:
        yield
    finally:
        if held is None:
            LocationFixtureConfiguration.objects.filter(domain=domain).delete()
        else:
            held.save()


def _setting_flipped(flip, state):
    """The seam that turns a project-space setting as the flip says; none for a flag, whose seam is the flags'."""
    from contextlib import nullcontext
    from unittest import mock

    from corehq.apps.app_manager.suite_xml.sections import entries
    from corehq.apps.app_manager.tests import util as app_manager_test_util

    if flip.gate.startswith(FLAG_GATE_PREFIX):
        return nullcontext()
    if flip.gate == COMMTRACK:
        return _commtrack_flipped(state, flip.configuration.commtrack)
    if flip.gate == SYNC_ON_FORM_ENTRY:
        if flip.configuration.sync_cases_on_form_entry:
            return app_manager_test_util.case_search_sync_cases_on_form_entry_enabled_for_domain()
        return mock.patch.object(entries, "case_search_sync_cases_on_form_entry_enabled_for_domain", return_value=False)
    if flip.gate == FLAT_FIXTURE:
        return _flat_fixture_flipped(state.domain)
    raise ValueError(f"The sensitivity check has no seam for the gate {flip.gate!r}.")


@contextmanager
def flipped(flip, state):
    """The flip's gate turned, for one build in ``state``, and everything as it was afterwards.

    The flag seam answers from the flip's configuration (the plain one's
    flags, but for a flag's flip) and records what HQ reads under the flip
    apart, so the state's own record holds only what its plain build read.
    Once the flip is undone the caches are emptied, so nothing computed
    under it answers a later build in the state.
    """
    from proof.hq import seams
    from proof.hq.boot import clear_caches

    try:
        with seams.flags(flip.configuration, seams.SeamRecord()), _setting_flipped(flip, state):
            yield
    finally:
        clear_caches()


@dataclass
class Built:
    """One HQ build: its outcome, HQ's ``Build``, and the app object it built (read freshly, or the caller's)."""

    outcome: object  # proof.observe.outcome.BuildOutcome
    hq_build: object
    app: object


def build(state, record, app_id, name, previous=None, *, app=None) -> Built:
    """HQ's whole build of the app as HQ holds it, freshly read, with every cache emptied first.

    ``app``, when given, is the app as ``state`` holds it, read by the caller
    (``proof.observe.proof4``, which reads the stored app first) and built in
    place of a fresh read; the build changes it.
    """
    from proof.hq import operations
    from proof.hq.boot import clear_caches
    from proof.hq.seams import build_seams
    from proof.observe.build import build_state

    clear_caches()
    if app is None:
        app = operations.held_app(state, app_id)
    with build_seams(previous=previous):
        outcome, hq_build = build_state(app, record, name)
    return Built(outcome, hq_build, app)


def flags_read(reads):
    """The flags HQ read (``FlagRead``s), by constant; a flag no constant names cannot be flipped, so it refuses."""
    found = set()
    for read in reads:
        if read.symbol is None:
            raise ValueError(
                f"HQ read the flag {read.slug!r} ({read.toggle_class}) while building A, and no constant in"
                " corehq/toggles or corehq/feature_previews names it, so the check cannot flip it by symbol."
            )
        found.add(read.symbol)
    return sorted(found)


def plain_build(unit, record, app_id, configuration):
    """A's plain build (``build``), and the flags and project-space settings it read: ``(Built, flags, settings)``.

    The unit's A is this build (``proof.observe.unit``), so what it counts
    is what the flips are planned from.
    """
    reads = {}
    first = len(record.flags)
    with project_space_reads(configuration, reads):
        built = build(unit, record, app_id, "A")
    return built, flags_read(record.flags[first:]), sorted(reads)


def flip_builds(unit, record, app_id, plan, scope=None):
    """Each planned flip's build of A (``flip_plan``), each in a fork of the unit's state.

    ``scope(flip)`` is the context each build runs in (the unit's operation for
    it); returns ``[(flip, outcome)]`` in the plan's order.
    """
    from contextlib import nullcontext

    found = []
    for flip in plan:
        with unit.fork(), scope(flip) if scope is not None else nullcontext():
            with flipped(flip, unit):
                built = build(unit, record, app_id, "A")
        found.append((flip, built.outcome))
    return found
