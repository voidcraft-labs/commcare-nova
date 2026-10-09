"""One HQ unit: HQ's state for one (document, configuration), branched by marks.

``hq_unit(configuration, root_key=...)`` gives its owner a
``proof.hq.branch.Unit``:

- Postgres: one transaction on the worker's database (``proof.hq.database``:
  a clone of the database HQ's migrations create, made once per worker),
  always rolled back at exit, after which every sequence is set back to the
  template's value, so every unit starts from the template's state;
- an in-memory Couch every HQ document class reads and writes
  (``proof.hq.couch``), installed through HQ's own
  ``corehq/util/test_utils.py::mock_out_couch``;
- HQ's temporary filesystem blob store
  (``corehq/blobs/tests/util.py::TemporaryFilesystemBlobDB``), pushed as the
  blob store every path reads, with its metadata rows in the unit's
  transaction;
- a change feed that records what HQ publishes for its pillows
  (``change_feed/producer.py::ChangeProducer.send_change``; saving a
  location publishes one) instead of sending it to Kafka, each change a
  write of the unit (``Unit.publish``);
- empty caches, at its start and its end;
- the project space, seeded inside the unit's first operation,
  ``unit.operation("seed", configuration.digest())``: its ``Domain``, the
  acting ``WebUser`` (a domain admin, so it may edit apps) and its Django
  ``User``, HQ's CommCare build configuration, whose default build is the
  configuration's CommCare version (HQ's ``get_default_build_spec`` and the
  app settings page both read it), and the project's case search config,
  ``CaseSearchConfig(domain, enabled=True)``, when the configuration turns
  case search on (HQ's ``case_search/models.py::case_search_enabled_for_domain``
  reads it), with its ``sync_cases_on_form_entry`` as the configuration sets
  it (the suite's entries read that through ``proof.hq.seams.project_space``,
  since HQ's own reader answers False under tests);
- the seams every path runs under (``proof.hq.seams.check_seams``), opened
  after the seeding, their ``SeamRecord`` as ``unit.record``, and with them
  HQ's Elasticsearch, every kept index empty at the unit's start and end and
  held to its marks (``proof.hq.elasticsearch.UnitIndexes``, as
  ``unit.indexes``). A unit opened without seams has no Elasticsearch: HQ's
  client is refused there.

Two units opened with the same configuration and root key start from
byte-identical state, on any worker. ``hq_check(configuration)``
is a unit whose root key is the configuration's digest, yielded with its
record as ``(unit, record)``, and lenient about writes outside its
operations, for the checks that predate units. ``hq_state(configuration)``
is the same without the seams.

``open_unit`` is what all three call. With ``transactional=False`` it runs
the unit in autocommit, every statement committed as it runs, in whatever
database HQ's connection names (``proof.hq.database.fresh_database``): the
per-check state of the harness before units, which the branch proofs compare
units with. Such a unit cannot mark. Real ``on_commit`` callbacks are admitted
only while that database is an open fresh clone, whose owner drops it at exit;
rollback units and reusable worker databases refuse them.

Everything is released at exit, in reverse order, whether the owner passed or
failed.
"""

from contextlib import ExitStack, contextmanager

from proof.hq.boot import boot, clear_caches
from proof.hq.configuration import Configuration

WEB_USER_ID = "proof-web-user"
WEB_USER_USERNAME = "proof-editor@example.com"


def domain_document(configuration):
    from corehq.apps.domain.models import Domain

    domain = Domain(
        name=configuration.domain,
        is_active=True,
        # util.py::get_settings_values reads the Domain's own field, so it
        # follows the configuration together with the CommTrack seam.
        commtrack_enabled=configuration.commtrack,
    )
    doc = domain.to_json()
    doc["_id"] = f"domain-{configuration.domain}"
    return doc


def web_user_document(configuration):
    from corehq.apps.users.models import DomainMembership, WebUser

    user = WebUser(
        username=WEB_USER_USERNAME,
        # CouchUser.is_active has no default; None reads as deactivated.
        is_active=True,
        domains=[configuration.domain],
        # A domain admin holds every app-editing permission without a SQL role.
        domain_memberships=[DomainMembership(domain=configuration.domain, is_admin=True)],
        analytics_enabled=False,
    )
    doc = user.to_json()
    doc["_id"] = WEB_USER_ID
    return doc


def build_config_document(configuration):
    """HQ's own build configuration, with the configuration's version as the default."""
    import copy

    from corehq.apps.app_manager.const import APP_V2
    from corehq.apps.builds.fixtures import commcare_build_config
    from corehq.apps.builds.models import CommCareBuildConfig

    doc = copy.deepcopy(commcare_build_config)
    spec = {"version": configuration.commcare_version, "build_number": None, "latest": True}
    doc["defaults"][doc["application_versions"].index(APP_V2)] = spec
    doc["menu"].append({"build": spec, "label": f"CommCare {configuration.commcare_version}"})
    doc["_id"] = CommCareBuildConfig._ID
    return doc


def _seed(unit, configuration):
    from corehq.apps.users.models import WebUser
    from django.contrib.auth.models import User

    with unit.operation("seed", configuration.digest()):
        unit.couch.seed(domain_document(configuration))
        # The acting web user's Django account, which HQ's own user creation
        # makes beside the Couch document; views that filter HQ's tables by
        # the request's user need it saved.
        User.objects.create(username=WEB_USER_USERNAME, email=WEB_USER_USERNAME, is_active=True)
        unit.couch.seed(build_config_document(configuration))
        unit.web_user = WebUser.wrap(unit.couch.seed(web_user_document(configuration)))
        if configuration.case_search_enabled:
            from corehq.apps.case_search.models import CaseSearchConfig

            CaseSearchConfig.objects.create(
                domain=configuration.domain,
                enabled=True,
                sync_cases_on_form_entry=configuration.sync_cases_on_form_entry,
            )


# Formplayer's own application answers the form validation HQ asks for (``proof.hq.seams.formplayer_validation``):
# what every unit's seams are given unless a test plants a validator of its own.
FORMPLAYER = "formplayer"


@contextmanager
def open_unit(configuration: Configuration, *, root_key: bytes, validate=FORMPLAYER, transactional=True, strict=True):
    """A unit over the database HQ's connection names for it; with ``validate`` None, no seams are opened."""
    boot()
    from unittest import mock

    from corehq.apps.change_feed.producer import ChangeProducer
    from corehq.util.test_utils import mock_out_couch

    from proof.hq import branch, database
    from proof.hq.couch import ComputedViewCouch
    from proof.hq.elasticsearch import UnitIndexes
    from proof.hq.seams import SeamRecord, check_seams, formplayer_validation

    if validate == FORMPLAYER:
        validate = formplayer_validation

    # Before anything of the process's state changes under a unit already open.
    branch.refuse_another_unit()
    name = database.unit_database()
    clear_caches()
    with ExitStack() as stack:
        stack.callback(clear_caches)
        couch = ComputedViewCouch()
        patch = mock_out_couch()
        patch.db = couch
        stack.enter_context(patch)

        blob_db = branch.blob_db()
        stack.callback(blob_db.close)

        unit = branch.Unit(
            configuration,
            root_key,
            couch=couch,
            blob_db=blob_db,
            changes=[],
            database=name,
            transactional=transactional,
            strict=strict,
        )

        def send_change(producer, topic, change_meta):
            unit.publish(topic, change_meta.to_json())

        stack.enter_context(mock.patch.object(ChangeProducer, "send_change", send_change))
        stack.enter_context(unit.opened())
        _seed(unit, configuration)
        if validate is not None:
            unit.record = SeamRecord()
            stack.enter_context(check_seams(configuration, unit.record, validate=validate))
            unit.indexes = UnitIndexes(unit)
            stack.enter_context(unit.indexes.held())
        yield unit


@contextmanager
def hq_unit(configuration: Configuration, *, root_key: bytes, validate=FORMPLAYER):
    """HQ's state for one (document, configuration), named by ``root_key`` (a sha256 digest), with its seams."""
    with open_unit(configuration, root_key=root_key, validate=validate) as unit:
        yield unit


@contextmanager
def hq_check(configuration: Configuration, *, validate=FORMPLAYER):
    """A check's unit and its seams' record, as ``(unit, record)``; writes outside its operations are allowed."""
    with open_unit(configuration, root_key=configuration.digest(), validate=validate, strict=False) as unit:
        yield unit, unit.record


@contextmanager
def hq_state(configuration: Configuration):
    """A check's unit without the seams; writes outside its operations are allowed."""
    with open_unit(configuration, root_key=configuration.digest(), validate=None, strict=False) as unit:
        yield unit
