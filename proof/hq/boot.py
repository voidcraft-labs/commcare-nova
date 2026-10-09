"""The one HQ boot every HQ-side check shares.

``boot()`` brings CommCare HQ up in this process with the steps HQ's own test
boot takes (``corehq/tests/pytest_hooks.py::pytest_load_initial_conftests``:
``init_hq_python_path``, ``run_patches``, ``django.setup``), offline:

1. ``CCHQ_TESTING=1``, ``DJANGO_SETTINGS_MODULE=testsettings`` and
   ``CUSTOMSETTINGS=proof.hq.localsettings`` (HQ's ``settings.py`` imports that
   module in place of ``localsettings``).
2. Every Python socket connection, UDP send and host name lookup is refused
   except to the lane's Postgres. libpq opens its own sockets below Python, so
   Postgres is reached whatever this guard does; every other service HQ names
   (Couch, Redis, Elasticsearch, S3, Formplayer, Kafka, any external host) is
   reached through Python sockets and refused, and each attempt is recorded,
   but the harness's own services, each admitted at its own loopback address
   as it starts (``_NetworkGuard.admit``). HQ's Elasticsearch client is
   watched from the boot on, and answers only inside a unit
   (``proof.hq.elasticsearch.install``).
3. HQ's root is ``sys.path[0]`` and the working directory (HQ opens
   ``submodules/langcodes/langs.json`` relative to it, and
   ``submodules/langcodes/urls.py`` would shadow HQ's ``urls.py`` if anything
   else came first), then ``manage.init_hq_python_path()`` and
   ``manage.run_patches()`` (HQ's locked setuptools ships no ``pkg_resources``,
   which ``eulxml`` imports; ``patch_pkg_resources`` supplies it).
4. ``django.setup()``.
5. Every Django cache alias moves to local memory, and every reference HQ
   took to an alias's backend before then is pointed at its replacement:
   each quickcache tier, and each module global, instance attribute or
   default argument that captured a backend when its module was imported
   (a settings override alone reaches none of them). No backend from before
   the boot stays reachable. HQ's helper for a raw Redis client
   (``dimagi/utils/couch/cache/cache_core::get_redis_client``, for locks and
   Redis commands no local cache serves) is refused like a Redis connection,
   except while this process runs the Redis the harness starts for HQ's
   locks (``proof.hq.redis``), whose backend it then returns.

6. HQ runs at production speed with ``DEBUG`` left on (``proof.hq.speed``):
   the template engine is set before Django builds it, the other seams
   right after the setup.
7. HQ's soft assertions behave as production's: noted, never raised
   (``corehq/util/soft_assert/core.py::SoftAssert._call`` raises whenever
   ``is_hard_mode()``, which is ``settings.UNIT_TESTING``, or, for
   ``fail_if_debug``, ``settings.DEBUG``; production has neither, and returns
   the assertion to HQ's code). ``soft_assertions()`` yields the notes HQ
   makes inside its block, each with its message, its value and the HQ frame
   HQ attributes it to; every check's seams keep them in its record
   (``proof.hq.seams.SeamRecord.soft_assertions``). In production the request
   that notes one also counts
   it in a cache entry only soft assertions read
   (``corehq/util/cache_utils.py::ExponentialBackoff``) and enqueues an email
   on Celery's email queue (``soft_assert/api.py::soft_assert``,
   ``send_mail_async.delay``); a Celery worker sends it later, and that task,
   not the request, reads the ``BLOCKED_EMAIL_DOMAIN_RECIPIENTS`` flag and the
   bounced-email table (``corehq/util/models.py::
   BouncedEmail.get_hard_bounced_emails``). The harness's Celery runs tasks
   inline, which production's request never does, so the harness neither
   counts nor enqueues, and HQ's code after the assertion runs as
   production's does.
8. Every entropy reader is routed through ``proof.hq.determinism`` before HQ
   is imported, so ``determinism.operation`` can seed them.
9. ``gc.collect()`` and ``gc.freeze()``: what the boot built is never
   traversed by a later collection, and a forked worker shares it unwritten.
   A frozen object is invisible to ``gc.get_objects()`` and
   ``gc.get_referrers()``; ``tracked_objects()`` lists every live tracked
   object, frozen ones included.

The boot runs once per process; calling ``boot()`` again returns the first
boot's report. ``warm()`` fills the caches of HQ's immutable inputs, and
``prepare_for_fork()`` makes the process safe to fork into workers.
"""

import gc
import ipaddress
import os
import socket
import sys
import threading
import time
import traceback
import types
from contextlib import contextmanager
from dataclasses import dataclass, field

HQ_ROOT = os.environ.get("PROOF_HQ", "/opt/hq")
SETTINGS_MODULE = "testsettings"
LOCAL_SETTINGS_MODULE = "proof.hq.localsettings"

# What the guard records when HQ asks for a raw Redis client.
REDIS_CLIENT_SERVICE = "a raw Redis client (cache_core.get_redis_client)"

# The local-memory store each cache alias moves to. Each alias keeps its own
# store, as its Redis database did.
LOCAL_CACHE_LOCATION = "proof-hq-{alias}"


class HarnessRefusal(BaseException):
    """The harness refused something HQ asked of it.

    It derives from BaseException, as pytest's own outcomes do, so HQ's broad
    ``except Exception`` handlers (which turn a failed service call into a
    warning, a default, or an error of their own) cannot swallow or reword it:
    a refusal always ends the check that reached it.
    """


class NetworkRefused(HarnessRefusal):
    """A network reach the harness refuses: HQ asked for a service offline."""


@dataclass(frozen=True)
class NetworkAttempt:
    """One refused or allowed reach for the network, as the guard saw it."""

    kind: str  # "connect", "sendto", "lookup" or "service"
    address: str
    allowed: bool
    where: tuple[str, ...]


@dataclass
class BootReport:
    hq_root: str
    seconds: float
    quickcache_tiers_rebound: int
    quickcache_tiers_total: int
    # Where HQ held a cache backend from before the boot, each now pointed at
    # its local-memory replacement.
    backend_references_rebound: tuple[str, ...] = ()
    steps: dict[str, float] = field(default_factory=dict)
    # PYTHONHASHSEED as the process started (the lane sets "0", so string
    # hashing and set order are the same in every process), and whether the
    # interpreter randomizes hashes.
    python_hash_seed: str | None = None
    hash_randomization: bool = True
    # Whether proof.hq.speed's seams apply, and the template engine they set.
    speed: bool = False
    template_engine: dict = field(default_factory=dict)
    # The clock HQ's operations start from (proof.hq.determinism.EPOCH), where
    # it was read, and whether operations seed entropy and freeze the clock.
    epoch: str = ""
    epoch_source: str = ""
    determinism: bool = False
    # Objects gc.freeze() moved out of every later collection.
    frozen_objects: int = 0


class _NetworkGuard:
    """Refuses every Python-level network reach except the lane's Postgres."""

    def __init__(self):
        self.attempts: list[NetworkAttempt] = []
        self._installed = False
        self._allowed_hosts: set[str] = set()
        self._allowed_port: int | None = None
        # Loopback services the harness itself started for HQ (``admit``).
        self._admitted: set[tuple[str, int]] = set()

    def install(self, postgres_host, postgres_port):
        if self._installed:
            return
        real_getaddrinfo = socket.getaddrinfo
        self._allowed_port = int(postgres_port)
        self._allowed_hosts = {postgres_host}
        try:
            for info in real_getaddrinfo(postgres_host, self._allowed_port):
                self._allowed_hosts.add(info[4][0])
        except OSError:
            # Postgres may not be resolvable yet; its name stays allowed.
            pass

        guard = self
        real_connect = socket.socket.connect
        real_connect_ex = socket.socket.connect_ex
        real_sendto = socket.socket.sendto

        def connect(sock, address):
            guard._check("connect", address)
            return real_connect(sock, address)

        def connect_ex(sock, address):
            guard._check("connect", address)
            return real_connect_ex(sock, address)

        def sendto(sock, data, *args):
            address = args[-1]
            guard._check("sendto", address)
            return real_sendto(sock, data, *args)

        def getaddrinfo(host, port, *args, **kwargs):
            guard._check_lookup(host, port)
            return real_getaddrinfo(host, port, *args, **kwargs)

        socket.socket.connect = connect
        socket.socket.connect_ex = connect_ex
        socket.socket.sendto = sendto
        socket.getaddrinfo = getaddrinfo
        # create_connection resolves through socket.getaddrinfo and connects
        # through socket.socket.connect, both guarded above.
        self._installed = True

    def _where(self):
        # The frames' files and functions alone: reading each frame's source line would open files of the
        # checkout, which an observation's read guard holds to its partition (proof.store.guard).
        frames = traceback.StackSummary.extract(traceback.walk_stack(None), lookup_lines=False)
        frames.reverse()
        frames = frames[:-3]
        return tuple(
            f"{frame.filename}::{frame.name}" for frame in frames[-8:] if "/proof/hq/boot.py" not in frame.filename
        )

    def _allows(self, host, port):
        return (host in self._allowed_hosts and port == self._allowed_port) or (host, port) in self._admitted

    def admit(self, host, port):
        """Admit one more address: a service the harness itself started for HQ on a loopback address of this
        process's own (``proof.hq.redis``, HQ's lock service). Never a host name, and never beyond loopback."""
        if ipaddress.ip_address(host) not in ipaddress.ip_network("127.0.0.0/8"):
            raise ValueError(f"The network guard admits only loopback addresses the harness serves; {host} is not one.")
        self._admitted.add((host, int(port)))

    def _check(self, kind, address):
        if isinstance(address, tuple) and len(address) >= 2:
            host, port = address[0], address[1]
            allowed = self._allows(host, port)
            shown = f"{host}:{port}"
        else:
            allowed = False
            shown = repr(address)
        self.attempts.append(NetworkAttempt(kind, shown, allowed, self._where()))
        if not allowed:
            raise NetworkRefused(
                f"The proof harness refused a network {kind} to {shown}. HQ runs "
                "offline here: only the lane's Postgres is reachable, so this "
                "read needs a seam in proof/hq (see the recorded attempt's "
                "call site)."
            )

    def refuse_service(self, service):
        """Refuse and record a service HQ asked for before opening any socket."""
        self.attempts.append(NetworkAttempt("service", service, False, self._where()))
        raise NetworkRefused(
            f"The proof harness refused HQ {service}. HQ runs offline here: only the "
            "lane's Postgres is reachable, so this read needs a seam in proof/hq "
            "(see the recorded attempt's call site)."
        )

    def _check_lookup(self, host, port):
        if host is None:
            return
        name = host.decode() if isinstance(host, bytes) else str(host)
        try:
            ipaddress.ip_address(name.split("%")[0])
            return  # a literal address needs no lookup; connect decides
        except ValueError:
            pass
        if name in self._allowed_hosts:
            return
        self.attempts.append(NetworkAttempt("lookup", f"{name}:{port}", False, self._where()))
        raise NetworkRefused(
            f"The proof harness refused to look up the host {name!r}. HQ runs "
            "offline here: only the lane's Postgres is reachable, so this read "
            "needs a seam in proof/hq (see the recorded attempt's call site)."
        )


GUARD = _NetworkGuard()
_REPORT: BootReport | None = None


def boot() -> BootReport:
    """Boot HQ once for this process and return the boot's report."""
    global _REPORT
    if _REPORT is not None:
        return _REPORT
    started = time.perf_counter()
    steps = {}

    def step(name, since):
        now = time.perf_counter()
        steps[name] = round(now - since, 3)
        return now

    from proof.hq import determinism

    determinism.install()

    os.environ["CCHQ_TESTING"] = "1"
    os.environ["DJANGO_SETTINGS_MODULE"] = SETTINGS_MODULE
    os.environ["CUSTOMSETTINGS"] = LOCAL_SETTINGS_MODULE
    # HQ imports ddtrace; offline, it must neither trace, report telemetry
    # (its writer posts to a local agent at exit) nor poll remote config.
    os.environ.update(
        {
            "DD_TRACE_ENABLED": "false",
            "DD_DOGSTATSD_DISABLE": "true",
            "DD_INSTRUMENTATION_TELEMETRY_ENABLED": "false",
            "DD_REMOTE_CONFIGURATION_ENABLED": "false",
        }
    )

    GUARD.install(
        os.environ.get("PROOF_POSTGRES_HOST", ""),
        os.environ.get("PROOF_POSTGRES_PORT", "5432"),
    )

    if not os.path.isfile(os.path.join(HQ_ROOT, "manage.py")):
        raise RuntimeError(
            f"The proof harness looked for CommCare HQ at {HQ_ROOT} and found no "
            "manage.py there. The harness runs inside the proof image, which "
            "holds HQ at /opt/hq (PROOF_HQ names another checkout)."
        )
    while HQ_ROOT in sys.path:
        sys.path.remove(HQ_ROOT)
    sys.path.insert(0, HQ_ROOT)
    os.chdir(HQ_ROOT)

    t = time.perf_counter()
    import manage

    manage.init_hq_python_path()
    manage.run_patches()
    t = step("hq_python_path_and_patches", t)

    import django
    from django.conf import settings

    from proof.hq import speed

    speed.configure_templates(settings)
    django.setup()
    t = step("django_setup", t)

    _check_celery()
    rebound, total, references = _move_caches_to_local_memory()
    _refuse_redis_clients()
    t = step("caches", t)

    # HQ's Elasticsearch client answers only inside a unit that holds the indexes (proof.hq.elasticsearch).
    from proof.hq import elasticsearch

    elasticsearch.install()

    speed.install()
    _install_production_soft_asserts()
    t = step("seams", t)

    gc.collect()
    gc.freeze()
    t = step("gc_freeze", t)

    _REPORT = BootReport(
        hq_root=HQ_ROOT,
        seconds=round(time.perf_counter() - started, 3),
        quickcache_tiers_rebound=rebound,
        quickcache_tiers_total=total,
        backend_references_rebound=references,
        steps=steps,
        python_hash_seed=os.environ.get("PYTHONHASHSEED"),
        hash_randomization=bool(sys.flags.hash_randomization),
        speed=speed.installed(),
        template_engine=speed.template_engine_state(),
        epoch=determinism.EPOCH.isoformat(),
        epoch_source=determinism.EPOCH_SOURCE,
        determinism=determinism.ENABLED,
        frozen_objects=gc.get_freeze_count(),
    )
    return _REPORT


def warm() -> float:
    """Fill the caches of HQ's immutable inputs, so no worker pays for them; returns the seconds it took.

    Each holds what HQ reads from the image and nothing a check writes or a
    request's language changes:

    - Django's URL resolver, populated (``URLResolver._populate``: every
      pattern compiled and the reverse lookup built), which HQ's first
      ``reverse`` or ``resolve`` would otherwise do;
    - the parse of each settings YAML file (``proof.hq.speed.YamlMemo``), not
      HQ's memoized settings, which hold text translated into the language of
      the request that first asked;
    - HQ's JavaScript translation catalog (``proof.editors.hq.javascript_catalog``),
      with the language the command activates put back as it was;
    - the compiled templates of the app settings, module and form pages, in
      the cached template loader.
    """
    boot()
    started = time.perf_counter()
    from django.conf import settings
    from django.template.loader import get_template
    from django.urls import get_resolver
    from django.utils.translation import trans_real

    from proof.hq import speed

    get_resolver()._populate()
    if speed.installed():
        from corehq.apps.app_manager import commcare_settings

        directory = os.path.join(os.path.dirname(commcare_settings.__file__), "static", "app_manager", "json")
        for name in WARM_SETTINGS_FILES:
            with open(os.path.join(directory, name), encoding="utf-8") as stream:
                commcare_settings.yaml.safe_load(stream)
        for name in WARM_TEMPLATES:
            get_template(name)

    from proof.editors.hq import javascript_catalog

    active = getattr(trans_real._active, "value", _NOTHING_ACTIVE)
    try:
        javascript_catalog(settings.LANGUAGE_CODE)
    finally:
        if active is _NOTHING_ACTIVE:
            if hasattr(trans_real._active, "value"):
                del trans_real._active.value
        else:
            trans_real._active.value = active
    return round(time.perf_counter() - started, 3)


# The settings files app_manager/commcare_settings.py parses.
WARM_SETTINGS_FILES = ("commcare-profile-settings.yml", "commcare-app-settings.yml", "commcare-settings-layout.yml")
# The page templates of views/view_generic.py for the app settings, module
# (views/modules.py::get_module_template, basic and advanced) and form pages.
WARM_TEMPLATES = (
    "app_manager/app_view_settings.html",
    "app_manager/bootstrap3/module_view.html",
    "app_manager/bootstrap3/module_view_advanced.html",
    "app_manager/form_view.html",
)
_NOTHING_ACTIVE = object()


class ForkRefused(RuntimeError):
    """The process holds something a forked worker cannot share."""


def prepare_for_fork() -> None:
    """Make this booted process safe to fork: no connection, no child, one thread, everything frozen.

    It refuses, changing nothing, while an HQ operation is open (its frozen
    clock and seeded entropy belong to the parent's block; it refuses with
    ``PROOF_HQ_DETERMINISM=0`` too, so the lane runs alike either way) or
    while any thread but the main one runs (a lock another thread holds at the fork
    stays held in the child). Otherwise every database connection is closed
    (a forked worker sharing the parent's socket would interleave its
    protocol), the XPath validator's node child is joined (each process
    starts its own), and then ``gc.collect(); gc.freeze()``, so the workers
    share the parent's heap without writing to it.

    A forked worker starts its own children (the XPath validator's) as it
    needs them. One that ends with ``os._exit``, which runs no ``atexit``
    handler, calls ``proof.hq.speed.stop_children()`` first, so each child is
    joined by the process that started it.
    """
    from django.db import connections

    from proof.hq import determinism, speed

    if determinism._STACK:
        raise ForkRefused("The process is inside an HQ operation (proof.hq.determinism.operation); fork outside it.")
    others = [thread.name for thread in threading.enumerate() if thread is not threading.main_thread()]
    if others:
        raise ForkRefused(
            f"The process runs threads besides its main thread ({', '.join(others)}), and a forked worker "
            "would hold copies of their locks with nothing to release them. Join them before forking."
        )
    connections.close_all()
    speed.stop_children()
    gc.collect()
    gc.freeze()


def tracked_objects() -> list:
    """Every live object the garbage collector tracks, those the boot froze included.

    A frozen object is listed only once it is unfrozen, and ``gc.freeze()``
    freezes every tracked object, so in a process whose heap is frozen this
    unfreezes it, collects what is garbage, lists what is left and freezes
    that again: every object live at the call joins the frozen set, and a
    cycle among them is never collected afterwards. For one-off readings (the
    surface extraction, the caches' census in tests), never a lane worker's
    path.
    """
    frozen = gc.get_freeze_count() > 0
    if frozen:
        gc.unfreeze()
        gc.collect()
    try:
        return gc.get_objects()
    finally:
        if frozen:
            gc.freeze()


# Soft assertions ---------------------------------------------------------------


@dataclass(frozen=True)
class SoftAssertNote:
    """One soft assertion HQ made that did not hold, as production notes it."""

    message: str | None
    # repr() of the value HQ passed with it.
    value: str
    # The HQ frame HQ attributes it to (its own key frame): file::function and line.
    where: str
    line: int


# The lists open recorders fill, outermost first.
_SOFT_ASSERT_RECORDERS: list[list[SoftAssertNote]] = []


@contextmanager
def soft_assertions(notes: list[SoftAssertNote] | None = None):
    """Yield a list that receives every soft assertion HQ notes inside the block: ``notes``, or a new one.

    Recorders nest: a note made inside several open blocks reaches each of
    their lists, once each.
    """
    notes = [] if notes is None else notes
    _SOFT_ASSERT_RECORDERS.append(notes)
    try:
        yield notes
    finally:
        # By identity: two recorders' lists can be equal (both empty) and still be two lists.
        for index in range(len(_SOFT_ASSERT_RECORDERS) - 1, -1, -1):
            if _SOFT_ASSERT_RECORDERS[index] is notes:
                del _SOFT_ASSERT_RECORDERS[index]
                break


def _note(soft_assert, message, value):
    # The frame HQ's own traceback attributes the assertion to: SoftAssert
    # skips `skip_frames + 3` frames from inside get_traceback, called from
    # _call, called from __call__; this function is called from the one
    # function that stands for __call__ and _call alike, so the same count
    # reaches the same frame.
    frames = traceback.extract_stack(limit=soft_assert.tb_skip)
    frame = frames[0]
    path = frame.filename
    root = HQ_ROOT.rstrip("/") + "/"
    if path.startswith(root):
        path = path[len(root) :]
    note = SoftAssertNote(message, repr(value), f"{path}::{frame.name}", frame.lineno or 0)
    filled = set()
    for notes in _SOFT_ASSERT_RECORDERS:
        if id(notes) not in filled:
            filled.add(id(notes))
            notes.append(note)


def _install_production_soft_asserts():
    """Every entry to ``SoftAssert`` notes and returns the assertion, as production's request does."""
    from corehq.util.soft_assert import core

    def noting_call(self, assertion, msg=None, obj=None):
        if not assertion:
            _note(self, msg, obj)
        return assertion

    core.SoftAssert.__call__ = noting_call
    core.SoftAssert.call = noting_call
    core.SoftAssert._call = noting_call


def _check_celery():
    from corehq.apps.celery import app

    if not (app.conf.task_always_eager and app.conf.task_eager_propagates):
        raise RuntimeError(
            "The proof harness booted HQ, but Celery would not run tasks inline "
            f"with their exceptions propagating (task_always_eager="
            f"{app.conf.task_always_eager}, task_eager_propagates="
            f"{app.conf.task_eager_propagates}). Check that HQ read "
            "proof.hq.localsettings through CUSTOMSETTINGS."
        )


def _move_caches_to_local_memory():
    from django.conf import settings
    from django.core.cache import caches
    from django.core.cache.backends.dummy import DummyCache
    from django.core.cache.backends.locmem import LocMemCache
    from django.test import override_settings
    from django_redis.cache import RedisCache
    from quickcache.cache_helpers import CacheWithPresets, TieredCache

    discarded_connections = caches._connections
    before = {alias: caches[alias] for alias in settings.CACHES}
    override_settings(
        CACHES={
            alias: (
                # HQ's "dummy" alias caches nothing on purpose; it stays so.
                settings.CACHES[alias]
                if isinstance(backend, DummyCache)
                else {
                    # A Redis alias also answers the two django-redis calls HQ's rate counters make
                    # (proof.hq.localcache).
                    "BACKEND": (
                        "proof.hq.localcache.RedisShaped"
                        if isinstance(backend, RedisCache)
                        else "django.core.cache.backends.locmem.LocMemCache"
                    ),
                    "LOCATION": LOCAL_CACHE_LOCATION.format(alias=alias),
                }
            )
            for alias, backend in before.items()
        }
    ).enable()
    # The override gives Django a new connection store; the one it discarded
    # still holds the backends from before.
    for alias in before:
        if hasattr(discarded_connections, alias):
            delattr(discarded_connections, alias)
    after = {id(backend): caches[alias] for alias, backend in before.items()}
    stale = [backend for alias, backend in before.items() if caches[alias] is not backend]
    del before, discarded_connections

    rebound = 0
    total = 0
    for obj in gc.get_objects():
        # type(), not isinstance(): isinstance reads __class__, which makes a
        # Django lazy object evaluate what it wraps.
        if not issubclass(type(obj), TieredCache):
            continue
        members = []
        for member in obj.caches:
            total += 1
            replacement = after.get(id(member.cache))
            if replacement is None:
                raise RuntimeError(
                    "The proof harness found a quickcache tier holding a cache "
                    f"backend no Django cache alias names ({type(member.cache)!r}). "
                    "It cannot move that tier to local memory, so a cached read "
                    "could reach a network cache."
                )
            if replacement is not member.cache:
                member = CacheWithPresets(replacement, member.timeout, member.prefix_function)
                rebound += 1
            members.append(member)
        obj.caches = members
    references = _rebind_stale_backends(stale, after)
    for alias in settings.CACHES:
        if not isinstance(caches[alias], (LocMemCache, DummyCache)):
            raise RuntimeError(f"The proof harness could not move the {alias!r} cache to local memory.")
    return rebound, total, references


def _rebind_stale_backends(stale, replacement_by_id):
    """Point every reference to a backend in ``stale`` at its replacement.

    A backend's references are found through the garbage collector: module
    globals and other dictionaries, instance attributes, closure cells, lists
    and functions' default arguments. A reference of any other kind cannot be
    rebound, so the boot fails rather than leave a cache from before it
    reachable. Returns where each rebound reference was, for the report.
    """
    gc.collect()
    rebound = []
    harness_owned = {id(stale)}
    for old in stale:
        new = replacement_by_id[id(old)]
        # The backend's own parts (its Redis client, which points back at it)
        # go with it.
        own_parts = {id(part) for part in gc.get_referents(old)}
        for holder in gc.get_referrers(old):
            if id(holder) in harness_owned or id(holder) in own_parts or isinstance(holder, types.FrameType):
                continue
            rebound.append(_rebind_in(holder, old, new))
    gc.collect()
    for old in stale:
        own_parts = {id(part) for part in gc.get_referents(old)}
        left = [
            _dict_owner(holder) if isinstance(holder, dict) else type(holder).__name__
            for holder in gc.get_referrers(old)
            if id(holder) not in harness_owned
            and id(holder) not in own_parts
            and not isinstance(holder, types.FrameType)
        ]
        if left:
            raise RuntimeError(
                f"The proof harness moved every cache to local memory, but a {type(old).__name__} "
                f"from before the boot is still held by {left}, so a cached read could still reach it."
            )
    return tuple(sorted(rebound))


def _rebind_in(holder, old, new):
    if isinstance(holder, dict):
        names = [name for name, value in holder.items() if value is old]
        for name in names:
            holder[name] = new
        return f"{_dict_owner(holder)}.{','.join(map(str, names))}"
    if isinstance(holder, list):
        holder[:] = [new if value is old else value for value in holder]
        return "list"
    if isinstance(holder, types.CellType):
        holder.cell_contents = new
        return "closure cell"
    if isinstance(holder, tuple):
        owners = [f for f in gc.get_referrers(holder) if isinstance(f, types.FunctionType) and f.__defaults__ is holder]
        if owners:
            for function in owners:
                function.__defaults__ = tuple(new if value is old else value for value in holder)
            return ",".join(f"{f.__module__}.{f.__qualname__} defaults" for f in owners)
    elif hasattr(holder, "__dict__"):
        attributes = vars(holder)
        names = [name for name, value in attributes.items() if value is old]
        if names:
            for name in names:
                attributes[name] = new
            return f"{type(holder).__module__}.{type(holder).__qualname__}.{','.join(names)}"
    raise RuntimeError(
        f"The proof harness cannot move a cache HQ holds in a {type(holder).__name__} to local "
        "memory, so a cached read could reach the network cache it held before the boot. "
        "Teach proof/hq/boot.py::_rebind_in that holder."
    )


def _dict_owner(namespace):
    for module in list(sys.modules.values()):
        if getattr(module, "__dict__", None) is namespace:
            return module.__name__
    for owner in gc.get_referrers(namespace):
        if getattr(owner, "__dict__", None) is namespace:
            return f"{type(owner).__module__}.{type(owner).__qualname__}"
    return "dict"


def _refuse_redis_clients():
    """Every binding of HQ's raw Redis client helper refuses, as a Redis connection is refused.

    With the caches in local memory, HQ's own helper would raise its
    ``RedisClientError``, an ``Exception`` a broad handler can swallow; the
    refusal is a ``NetworkRefused`` and is recorded with the guard's attempts.
    While the harness's own Redis for HQ runs in this process
    (``proof.hq.redis.start``), the helper returns that server's backend.
    """
    from dimagi.utils.couch.cache import cache_core

    original = cache_core.get_redis_client

    def get_redis_client():
        from proof.hq import redis as hq_redis

        held = hq_redis.client()
        if held is not None:
            return held
        GUARD.refuse_service(REDIS_CLIENT_SERVICE)

    for module in list(sys.modules.values()):
        namespace = getattr(module, "__dict__", None)
        if not isinstance(namespace, dict):
            continue
        for name, value in list(namespace.items()):
            if value is original:
                namespace[name] = get_redis_client


def quickcache_census():
    """Every quickcache tier alive now, by the class of the backend it holds."""
    from quickcache.cache_helpers import TieredCache

    census: dict[str, int] = {}
    for obj in tracked_objects():
        if issubclass(type(obj), TieredCache):
            for member in obj.caches:
                name = f"{type(member.cache).__module__}.{type(member.cache).__qualname__}"
                census[name] = census.get(name, 0) + 1
    return census


def cache_census():
    """Every Django cache backend alive now, by class, garbage collected first."""
    from django.core.cache.backends.base import BaseCache

    gc.collect()
    census: dict[str, int] = {}
    for obj in tracked_objects():
        if issubclass(type(obj), BaseCache):
            name = f"{type(obj).__module__}.{type(obj).__qualname__}"
            census[name] = census.get(name, 0) + 1
    return census


def clear_caches():
    """Empty every cache alias, so no check reads what another cached."""
    from django.conf import settings
    from django.core.cache import caches

    for alias in settings.CACHES:
        caches[alias].clear()
