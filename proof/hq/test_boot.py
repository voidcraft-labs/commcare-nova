"""The boot is offline and pinned: the image's self-test.

Contract: HQ boots from the image's pinned checkouts, reaches no service but
the lane's Postgres, and caches nothing in a network cache. The plausible
failures: a socket the guard lets through (a client that resolves a name or
connects its own way), a Redis client HQ asks for that fails with an error a
broad handler swallows, a quickcache tier or any other reference still bound
to the Redis backend it captured at import (a module global, an instance's
attribute), or an image built from other commits than the pins.

Each service is reached through the client HQ itself uses for it, so a
refusal here is the refusal a path would meet. The lane's Postgres is the
paired acceptance: the same guard lets it through.
"""

from __future__ import annotations

import datetime
import gc
import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit

import pytest

import proof
from proof.hq.boot import GUARD, REDIS_CLIENT_SERVICE, NetworkRefused, cache_census, quickcache_census
from proof.hq.configuration import Configuration
from proof.hq.state import hq_state

PINS = json.loads((Path(proof.__file__).parent / "pins.json").read_text())
# The research's Vellum pin (docs/plans/hq-round-trip/README.md). Vellum is
# not pinned on its own: the harness runs the build HQ vendors at its pin.
RESEARCH_VELLUM = "01215f251c5716d98cc49ed10b3dc63f0d50f36e"


def _redis(hq):
    from corehq.apps.users.device_rate_limiter import device_rate_limiter

    device_rate_limiter.client.ping()


def _redis_client(hq):
    # A lock, as HQ's CriticalSection takes one.
    from dimagi.utils.couch import get_redis_lock

    get_redis_lock("proof", timeout=5, name="proof")


def _couch(hq):
    from corehq.apps.app_manager.models import Application

    Application.get_db().info()


def _elasticsearch(hq):
    from corehq.apps.es.client import manager

    manager.info()


def _s3(hq):
    from corehq.blobs.s3db import S3BlobDB

    # dev_settings.py's blob store for tests, the S3 HQ's settings fall back to.
    S3BlobDB({"url": "http://localhost:9980", "access_key": "admin-key", "secret_key": "admin-secret"})._s3_bucket(
        create=True
    )


def _formplayer(hq):
    from corehq.apps.formplayer_api.form_validation import validate_form

    validate_form(b"<h:html xmlns:h='http://www.w3.org/1999/xhtml'/>")


def _external_host(hq):
    import requests

    requests.get("https://www.commcarehq.org/", timeout=5)


SERVICES = [
    ("redis", _redis, "127.0.0.1:6379"),
    ("redis client", _redis_client, REDIS_CLIENT_SERVICE),
    ("couch", _couch, "127.0.0.1:5984"),
    ("elasticsearch", _elasticsearch, "localhost:9200"),
    ("s3", _s3, "localhost:9980"),
    ("formplayer", _formplayer, "localhost:8080"),
    ("external host", _external_host, "www.commcarehq.org:443"),
]


@pytest.mark.parametrize(("service", "reach", "address"), SERVICES, ids=[s[0] for s in SERVICES])
def test_every_service_hq_names_is_refused(hq, network, service, reach, address):
    before = len(GUARD.attempts)
    with pytest.raises(NetworkRefused):
        reach(hq)
    attempts = GUARD.attempts[before:]
    assert attempts and not attempts[-1].allowed
    assert attempts[-1].address == address, attempts
    network.expect(attempts[-1])


def test_the_lanes_postgres_is_reachable(hq):
    host = os.environ["PROOF_POSTGRES_HOST"]
    port = int(os.environ.get("PROOF_POSTGRES_PORT", "5432"))
    before = len(GUARD.attempts)
    with socket.create_connection((host, port), timeout=10):
        pass
    assert [a.allowed for a in GUARD.attempts[before:]] == [True]

    with hq_state(Configuration()) as state:
        from django.db import connection

        with connection.cursor() as cursor:
            cursor.execute("select current_database()")
            (name,) = cursor.fetchone()
    assert name == state.database


LOCAL_BACKENDS = {
    "django.core.cache.backends.locmem.LocMemCache",
    "django.core.cache.backends.dummy.DummyCache",
    "proof.hq.localcache.RedisShaped",
}


def test_no_cache_hq_holds_reaches_a_network_cache(hq, network):
    census = quickcache_census()
    assert census, "HQ registered no quickcache tiers, so the census proves nothing"
    # Local memory alone: Django's own backend, and the harness's for the aliases HQ gives Redis
    # (proof.hq.localcache, the same backend with the two calls HQ's rate counters make).
    assert set(census) <= LOCAL_BACKENDS and "django.core.cache.backends.locmem.LocMemCache" in census, census
    assert hq.quickcache_tiers_rebound == hq.quickcache_tiers_total
    # Every backend alive, wherever HQ holds it (module globals such as the
    # rate counters' shared cache, instance attributes, default arguments).
    assert hq.backend_references_rebound, "HQ held no backend outside quickcache, so the census proves less"
    assert set(cache_census()) <= LOCAL_BACKENDS, cache_census()

    # A cached read is served from local memory: after the first fetch, the
    # document it cached can leave Couch and the next fetch still returns it.
    configuration = Configuration(commcare_version="2.57.0")
    with hq_state(configuration) as state:
        from corehq.apps.builds.models import CommCareBuildConfig

        first = CommCareBuildConfig.fetch().get_default()
        del state.couch.mock_docs[CommCareBuildConfig._ID]
        second = CommCareBuildConfig.fetch().get_default()
    assert first.version == second.version == "2.57.0"

    # The control: a tier on the Redis backend HQ's settings name reaches the network.
    from django_redis.cache import RedisCache
    from quickcache.cache_helpers import CacheWithPresets

    redis_tier = CacheWithPresets(RedisCache("redis://127.0.0.1:6379/0", {}), 60)
    before = len(GUARD.attempts)
    with pytest.raises(NetworkRefused):
        redis_tier.get("proof")
    network.expect(GUARD.attempts[before:][-1])


@pytest.mark.parametrize(
    ("checkout", "pin"),
    [("/opt/hq", "commcare-hq"), ("/opt/core", "commcare-core"), ("/opt/android", "commcare-android")],
)
def test_each_checkout_is_at_its_pin(checkout, pin):
    head = subprocess.run(
        ["git", "-C", checkout, "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert head == PINS[pin]["commit"]


def test_hq_vendors_the_research_vellum():
    version = Path("/opt/hq/corehq/apps/app_manager/static/app_manager/js/vellum/version.txt")
    assert version.read_text().strip() == RESEARCH_VELLUM


def test_hqs_xpath_validator_runs_in_the_image(hq):
    """HQ's build checks every module and form filter with a Node program
    (``app_manager/xpath_validator/wrapper.py::validate_xpath``) that loads
    ``xpath`` and ``underscore`` from HQ's ``node_modules``. Node exits 1 when
    a module is missing, which HQ reads as an invalid expression with an empty
    message, so without them every filter fails HQ's build. HQ's own process
    per expression is asked here, and the long-lived child the speed seam
    answers from (``proof.hq.speed.XPATH``) loads the same modules."""
    from proof.hq import speed

    hqs_own = speed.hq_validate_xpath()
    assert hqs_own.__module__ == "corehq.apps.app_manager.xpath_validator.wrapper"
    for validate_xpath in (hqs_own, speed.XPATH):
        assert validate_xpath("true()") == (True, None)
        refused = validate_xpath("#case/@case_id = ''", allow_case_hashtags=True)
        assert not refused.is_valid
        assert b"Expecting 'QNAME', got 'AT'" in refused.message


# What makes HQ's operations reproducible and its process fork-safe ------------------------------


def test_the_boot_reports_what_its_operations_are_reproducible_from(hq):
    """The lane fixes the hash seed, HQ's clock starts at its pin's commit time, and the boot froze its heap.

    The audit switches (``PROOF_HQ_DETERMINISM``, ``PROOF_HQ_SPEED``) decide
    the rest, and the report says what the process booted with.
    """
    from proof.hq import determinism, seams, speed

    assert (hq.python_hash_seed, hq.hash_randomization) == ("0", False), (
        "The lane runs HQ with PYTHONHASHSEED=0 (proof/compose.yaml), so every process orders HQ's sets and "
        f"dicts of strings alike; this one runs with {hq.python_hash_seed!r}."
    )
    assert determinism.installed()
    assert hq.determinism is (os.environ.get("PROOF_HQ_DETERMINISM", "1") != "0")
    history = subprocess.run(["git", "-C", "/opt/hq", "log", "-1", "--format=%cI"], capture_output=True, text=True)
    if history.returncode == 0:
        assert determinism.EPOCH == datetime.datetime.fromisoformat(history.stdout.strip())
    assert hq.epoch == determinism.EPOCH.isoformat()
    seamed = os.environ.get("PROOF_HQ_SPEED", "1") != "0"
    engine = speed.SEAMED_ENGINE if seamed else speed.DEBUG_ENGINE
    assert hq.speed is seamed is speed.installed() is seams.FORM_VALIDATIONS.enabled
    assert hq.template_engine == engine == speed.template_engine_state()
    assert hq.frozen_objects > 0


def test_warm_fills_the_caches_of_immutable_inputs_and_leaves_the_language_as_it_was(hq):
    """With the seams, the settings YAML and the three pages' templates too; without them HQ keeps neither."""
    from corehq.apps.app_manager import commcare_settings
    from django.conf import settings
    from django.template import engines
    from django.urls import get_resolver
    from django.utils.translation import trans_real

    from proof.editors import hq as editors_hq
    from proof.hq import speed
    from proof.hq.boot import WARM_TEMPLATES, warm

    active_before = getattr(trans_real._active, "value", None)
    seconds = warm()
    assert seconds >= 0
    assert getattr(trans_real._active, "value", None) is active_before
    assert get_resolver()._populated
    assert settings.LANGUAGE_CODE in editors_hq._CATALOG
    if not speed.installed():
        assert not isinstance(commcare_settings.yaml, speed.YamlMemo)
        assert speed.template_engine_state() == speed.DEBUG_ENGINE
        return
    assert len(commcare_settings.yaml.parsed) >= 3
    (loader,) = engines["django"].engine.template_loaders
    cached = {
        template.origin.template_name for template in loader.get_template_cache.values() if hasattr(template, "origin")
    }
    assert set(WARM_TEMPLATES) <= cached


def test_prepare_for_fork_leaves_nothing_a_forked_worker_would_share(hq):
    """The lane's parent boots HQ, calls ``prepare_for_fork()`` and forks its workers.

    The plausible failures: a database socket or the XPath validator's pipes
    inherited by every worker (their protocols interleave), a thread whose
    locks a worker inherits held, a fork inside an operation (its frozen clock
    and seeded entropy would run on in each worker), a refusal that closes the
    caller's connection before it refuses, and a worker that cannot open its
    own connection and child afterwards. This test's own process runs the
    session's Core runner threads, so the parent is a fresh process, as the
    lane's is.
    """
    completed = subprocess.run(
        [sys.executable, "-c", "from proof.hq.test_boot import fork_preparation; fork_preparation()"],
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr[-4000:]
    seen = json.loads(completed.stdout.strip().splitlines()[-1])
    assert seen == {
        "held before": {"connection": True, "xpath child": True},
        "with a thread running": "refused: proof-held-thread",
        "inside an operation": "refused: inside an HQ operation",
        "held after refusals": {"connection": True, "xpath child": True},
        "held after": {"connection": False, "xpath child": False},
        "frozen": True,
        "worker": 0,
    }


def fork_preparation():
    """The lane parent's sequence, reported as JSON on stdout; run by the test above in a fresh process."""
    from django.db import connection

    from proof.hq import speed
    from proof.hq.boot import ForkRefused, boot, prepare_for_fork
    from proof.hq.determinism import operation

    boot()
    connection.ensure_connection()
    speed.XPATH("true()")
    seen = {"held before": {"connection": connection.connection is not None, "xpath child": speed.XPATH.running}}

    release = threading.Event()
    thread = threading.Thread(target=release.wait, name="proof-held-thread")
    thread.start()
    try:
        prepare_for_fork()
        seen["with a thread running"] = "accepted"
    except ForkRefused as refused:
        seen["with a thread running"] = (
            "refused: proof-held-thread" if "proof-held-thread" in str(refused) else str(refused)
        )
    finally:
        release.set()
        thread.join()
    try:
        with operation(b"proof fork test", 1):
            prepare_for_fork()
        seen["inside an operation"] = "accepted"
    except ForkRefused as refused:
        text = str(refused)
        seen["inside an operation"] = "refused: inside an HQ operation" if "inside an HQ operation" in text else text
    # Each refusal changed nothing: the connection and the child are still there.
    seen["held after refusals"] = {"connection": connection.connection is not None, "xpath child": speed.XPATH.running}

    prepare_for_fork()
    seen["held after"] = {"connection": connection.connection is not None, "xpath child": speed.XPATH.running}
    seen["frozen"] = gc.get_freeze_count() > 0

    worker = os.fork()
    if worker == 0:
        # A worker opens its own connection and starts its own XPath child,
        # and joins that child before os._exit, which runs no atexit handler.
        code = 1
        try:
            with connection.cursor() as cursor:
                cursor.execute("select 1")
            code = 0 if speed.XPATH("true()").is_valid else 2
        finally:
            speed.stop_children()
            os._exit(code if not speed.XPATH.running else 3)
    _, status = os.waitpid(worker, 0)
    seen["worker"] = os.waitstatus_to_exitcode(status)
    print(json.dumps(seen))


# HQ's soft assertions, as production runs them --------------------------------------------------

DATE_MODIFIED = "2026-09-30T10:00:00.000000Z"


def _case_submission(case_id, date_modified):
    return f"""<?xml version='1.0' ?>
<data xmlns="http://example.com/proof/soft-assert" name="Visit">
  <case xmlns="http://commcarehq.org/case/transaction/v2" case_id="{case_id}" date_modified="{date_modified}"
      user_id="u-1"><create><case_type>person</case_type><case_name>A</case_name><owner_id>u-1</owner_id></create></case>
  <meta xmlns="http://openrosa.org/jr/xforms"><instanceID>form-1</instanceID><userID>u-1</userID>
    <timeStart>2026-09-30T10:00:00Z</timeStart><timeEnd>2026-09-30T10:00:01Z</timeEnd></meta>
</data>""".encode()


def test_hq_notes_a_soft_assertion_and_goes_on_to_its_own_refusal(hq, core_runner):
    """An empty ``date_modified`` is a soft assertion in
    ``casexml/apps/case/util.py::validate_phone_datetime``: production notes
    it and HQ goes on, here to its own refusal of the empty case id
    (``IllegalCaseId``). The note is recorded with the HQ frame that made it,
    by the block that asked for HQ's notes and in the check's own record."""
    from casexml.apps.case.exceptions import IllegalCaseId

    from proof.hq import operations
    from proof.hq.boot import soft_assertions
    from proof.hq.check import hq_check

    with hq_check(Configuration(), validate=core_runner.validate_form) as (state, record):
        with soft_assertions() as noted:
            refused = operations.process_case_blocks(state, _case_submission("", ""))
    with hq_check(Configuration(), validate=core_runner.validate_form) as (state, quiet_record):
        with soft_assertions() as quiet:
            accepted = operations.process_case_blocks(state, _case_submission("c-1", DATE_MODIFIED))
    assert isinstance(refused.refusal, IllegalCaseId)
    # process_case_blocks reads the case blocks for its report, and HQ's case
    # step reads them again: one note each time HQ checks the date.
    assert {(note.message, note.where) for note in noted} == {
        (
            "phone datetime should never be empty",
            "corehq/ex-submodules/casexml/apps/case/util.py::validate_phone_datetime",
        )
    }
    assert all(note.value == "{'form_id': 'form-1'}" for note in noted)
    assert record.soft_assertions == noted and record.soft_assertions is not noted
    assert accepted.refusal is None and quiet == [] and quiet_record.soft_assertions == []


def test_nested_recorders_each_receive_every_note_once(hq):
    """Two open blocks whose lists are equal (both empty) are still two recorders; closing one leaves the other."""
    from corehq.util.metrics.metrics import _enforce_prefix

    from proof.hq.boot import soft_assertions

    with soft_assertions() as outer:
        with soft_assertions() as inner:
            pass
        _enforce_prefix("proof.after_inner", "commcare")
        with soft_assertions(outer) as same:
            _enforce_prefix("proof.in_both", "commcare")
    assert inner == [] and same is outer
    assert [note.message.split("'")[1] for note in outer] == ["commcare.proof.after_inner", "commcare.proof.in_both"]


def test_a_soft_assertion_hq_raises_under_debug_is_noted_as_production_notes_it(hq):
    """``soft_assert(fail_if_debug=True)`` raises when ``settings.DEBUG``; the
    harness keeps DEBUG on, and production, where it is off, notes it."""
    from corehq.util.metrics.metrics import _enforce_prefix
    from django.conf import settings

    from proof.hq.boot import soft_assertions

    assert settings.DEBUG is True
    with soft_assertions() as noted:
        _enforce_prefix("proof.metric", "commcare")
    with soft_assertions() as quiet:
        _enforce_prefix("commcare.proof", "commcare")
    assert [(note.message, note.where) for note in noted] == [
        (
            "Did you mean to call your metric 'commcare.proof.metric'? ",
            "corehq/util/metrics/metrics.py::_enforce_prefix",
        )
    ]
    assert quiet == []


# HQ's own address ----------------------------------------------------------------------------------------


def test_a_built_app_names_novas_server_wherever_hq_writes_its_own_address(hq, core_runner):
    """HQ writes ``DEFAULT_PROTOCOL://BASE_ADDRESS`` (``dimagi/utils/web.py::
    get_url_base``) into the profile (``ApplicationBase.url_base``) and into
    the suite's remote requests (``corehq/util/view_utils.py::absolute_reverse``).
    The corpus is captured from Nova's publish to its production server, so
    every such URL names that server."""
    from lxml import etree

    from proof.hq import operations
    from proof.hq.check import hq_check
    from proof.hq.conftest import hq_test_app, nova_shaped_upload
    from proof.hq.seams import build_seams

    configuration = Configuration(privileges={"CLOUDCARE"}, case_search_enabled=True)
    with hq_check(configuration, validate=core_runner.validate_form) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty

        app = operations.held_app(state, app_id)
        app.modules[0].search_config = CaseSearch(properties=[CaseSearchProperty(name="name", label={"en": "Name"})])
        app.save()
        with build_seams():
            built = operations.build(operations.held_app(state, app_id), record)

    urls = {}
    profile = etree.fromstring(built.files["profile.xml"])
    urls["profile update"] = [profile.get("update")]
    urls["profile properties"] = [
        element.get("value")
        for element in profile.iter("property")
        if element.get("key") in {"ota-restore-url", "ota-restore-url-testing", "PostURL", "PostTestURL", "key_server"}
    ]
    urls["remote resources"] = [
        element.text for element in profile.iter("location") if element.get("authority") == "remote"
    ]
    suite = etree.fromstring(built.files["suite.xml"])
    urls["suite remote requests"] = [
        element.get("url") for request in suite.iter("remote-request") for element in request.iter("post", "query")
    ]
    assert all(urls.values()), urls
    for kind, found in urls.items():
        for url in found:
            parts = urlsplit(url)
            assert (parts.scheme, parts.netloc) == ("https", "www.commcarehq.org"), (kind, url)
