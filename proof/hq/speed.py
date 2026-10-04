"""HQ at production speed, with DEBUG left on: only DEBUG's speed effects, none of its behavior.

The harness boots HQ's ``testsettings``, where ``DEBUG`` is True, and keeps
it: HQ branches on ``settings.DEBUG`` in what it does, not only in how fast it
does it (``views/forms.py::get_form_view_context`` raises an unexpected error
instead of turning it into the form error "Unexpected System Error";
``domain/models.py::Domain.get_by_name``, ``domain/utils.py::
normalize_domain_name``, ``hqwebapp/models.py::ServerLocation.get_envs`` and
``soft_assert(fail_if_debug=True)`` also read it). These seams take DEBUG's
speed effects alone, each a cache or a skipped log of something no check
reads, each computing exactly what HQ computes without it:

- **Templates.** HQ's ``settings.py`` wraps its template loaders in Django's
  cached loader only ``if not DEBUG``, and sets the engine's ``debug`` option
  to ``DEBUG``. ``configure_templates`` does both to ``settings.TEMPLATES``
  before Django builds its engines. The engine's ``debug`` only annotates a
  template error with its source position (``django/template/base.py``:
  ``Template.compile_nodelist`` and ``Node.render_annotated``) and keeps a
  missing template's exception for the cached loader to raise again
  (``loaders/cached.py::Loader.get_template``); no rendered byte depends on it.
- **Query log.** ``BaseDatabaseWrapper.queries_logged`` is
  ``force_debug_cursor or settings.DEBUG``; with DEBUG on, every query is
  timed and appended to ``connection.queries_log``, which no HQ path on the
  lane reads. It becomes ``force_debug_cursor`` alone, as production has it,
  so a test that asks Django to capture queries still gets them.
- **Webpack manifest.** ``hqwebapp/utils/webpack.py::get_webpack_manifest``
  is memoized at import only when DEBUG is off (``cache_unless_debug``); it
  reads the image's immutable editor build. Every binding of it reads the
  ``memoized`` copy, as production's.
- **Settings YAML.** ``app_manager/commcare_settings.py`` parses three YAML
  files whenever the app settings page or a build asks for its settings
  (``get_commcare_settings_layout`` is memoized per app object, and each
  request wraps a new one). Its ``yaml.safe_load`` parses each file once per
  (path, content digest) and returns a deep copy of that parse each time:
  the callers mutate what they get (``setting.pop('values')``,
  ``section['title'] = ...``), and an unshared copy equal to a fresh parse is
  what a parse returns.
- **XPath validator.** ``app_manager/xpath_validator/wrapper.py::
  validate_xpath`` starts ``node`` for every expression it checks (module and
  form filters in every build, search properties on the case list save).
  ``XPathValidator`` answers it from one long-lived node child per process
  (``xpath/server.mjs``) running HQ's own validator code with a fresh parser
  per expression. It sends exactly the bytes the wrapper writes to node's
  standard input (its whitespace collapse, then UTF-8), and returns the
  wrapper's ``(is_valid, message)``: valid on exit code 0, and on exit code 1
  invalid with the bytes the script printed. The child starts on the
  process's first validation, is joined when the process exits, and must not
  exist when the process forks (``stop_children``).
- **Core's form validation.** The validate seam keeps one answer per form
  (``proof.hq.seams.FORM_VALIDATIONS``); it is switched on here.
- **The build's repeated work.** eulxml's XPath evaluations compiled once,
  lxml's ElementPath selectors kept past its cache of 100, LooseVersion's
  parse of each version text, the previous build's files read from the bytes
  the harness put, every other attachment kept by the blob it read while its
  metadata row and file are as they were, a form's questions kept past the
  harness's cache clears (with the flag reads that compute them made again),
  and the language names file parsed once (``proof.hq.buildcache``).
- **The cyclic collector.** Python examines its youngest generation every
  2,000 net allocations of container objects and the older two after every
  10 of the one below (``gc.get_threshold()`` is (2000, 10, 10)). HQ's app
  reads, saves and builds make millions of short-lived objects in reference
  cycles (the containers and properties jsonobject wraps each module, form
  and case-list detail in; lxml's element builders), so most young
  collections examine objects still in use and move them into the older
  generations, which are examined again and again. ``COLLECTOR_THRESHOLDS``
  gives the youngest generation 50,000, so more of them are garbage before
  any collection examines them. The collector frees the same garbage, later:
  what is reachable, and so every value HQ computes, is the same whenever it
  runs. A computation could see the difference only through a finalizer or a
  weak reference's callback on an object in a cycle, or through an order
  taken from objects' addresses (freed memory is reused in another order);
  the comparison of records and evidence with the seams off
  (``PROOF_HQ_SPEED=0``) is what rules those out on the lane's paths.

``PROOF_HQ_SPEED=0`` leaves every one of them out, so the lane can be run with
and without them and compared. Whatever the process booted with, ``on()``
applies every seam for a block and ``off()`` takes every one away for a
block, so a test compares HQ with and without them in one process.
"""

from __future__ import annotations

import atexit
import base64
import copy
import gc
import hashlib
import json
import os
import re
import selectors
import subprocess
import threading
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path

from proof.hq.boot import HarnessRefusal

ENABLED = os.environ.get("PROOF_HQ_SPEED", "1") != "0"

CACHED_LOADER = "django.template.loaders.cached.Loader"
# The template engine with the seams, and as HQ's DEBUG boot builds it.
SEAMED_ENGINE = {"cached_loader": True, "debug": False}
DEBUG_ENGINE = {"cached_loader": False, "debug": True}
XPATH_SERVER = Path(__file__).resolve().parent / "xpath" / "server.mjs"
# How long one expression may take before the harness gives up on the child.
XPATH_DEADLINE_SECONDS = 60.0
# The cyclic collector's thresholds with the seams (``gc.set_threshold``): its youngest generation, then how many
# collections of each generation the next one waits for.
COLLECTOR_THRESHOLDS = (50000, 10, 10)

# The template options HQ's DEBUG boot has, kept so ``off()`` can rebuild them.
_DEBUG_TEMPLATE_OPTIONS: dict | None = None
_INSTALLED: ExitStack | None = None


class XPathValidatorFailed(HarnessRefusal):
    """The long-lived XPath validator child stopped answering."""


# Templates ------------------------------------------------------------------


def configure_templates(settings) -> None:
    """Make HQ's template engine as HQ's non-DEBUG settings make it; call before Django builds its engines."""
    global _DEBUG_TEMPLATE_OPTIONS
    (template,) = settings.TEMPLATES
    options = template["OPTIONS"]
    _DEBUG_TEMPLATE_OPTIONS = copy.deepcopy({"loaders": options["loaders"], "debug": options["debug"]})
    if not ENABLED:
        return
    # settings.py, its `else:` branch of `if DEBUG:`.
    options["loaders"], options["debug"] = _seamed_template_options()


def template_engine_state():
    """What HQ's template engine is now: whether it caches templates and its ``debug`` option."""
    from django.template import engines
    from django.template.loaders.cached import Loader

    engine = engines["django"].engine
    cached = len(engine.template_loaders) == 1 and isinstance(engine.template_loaders[0], Loader)
    return {"cached_loader": cached, "debug": engine.debug}


def _engine_parts():
    """The template engine's loader configuration, its debug option and the loaders it built."""
    from django.template import engines

    engine = engines["django"].engine
    return engine.loaders, engine.debug, engine.template_loaders


def _seamed_template_options():
    """The loaders and ``debug`` option HQ's settings give the engine when DEBUG is off."""
    return [[CACHED_LOADER, copy.deepcopy(_DEBUG_TEMPLATE_OPTIONS["loaders"])]], False


def _set_engine(loaders, debug, built=None):
    """Give the template engine ``loaders`` and ``debug``; ``built`` puts back loaders it built before."""
    from django.template import engines

    engine = engines["django"].engine
    engine.loaders = loaders
    engine.debug = debug
    engine.__dict__.pop("template_loaders", None)
    if built is not None:
        # Engine.template_loaders is a cached_property; this is its value.
        engine.__dict__["template_loaders"] = built


# Query log ------------------------------------------------------------------


def _production_queries_logged(self):
    # BaseDatabaseWrapper.queries_logged with settings.DEBUG off.
    return self.force_debug_cursor


# Settings YAML --------------------------------------------------------------


class YamlMemo:
    """``yaml`` as ``commcare_settings`` reads it, with ``safe_load`` parsing each file once.

    Each parse is kept by the stream's path and the sha256 of its content,
    and every call returns a deep copy of it.
    """

    def __init__(self, yaml_module):
        self._yaml = yaml_module
        self.parsed: dict[tuple[str | None, str], object] = {}
        self.hits = 0

    def __getattr__(self, name):
        return getattr(self._yaml, name)

    def safe_load(self, stream):
        text = stream.read() if hasattr(stream, "read") else stream
        content = text.encode("utf-8") if isinstance(text, str) else bytes(text)
        key = (getattr(stream, "name", None), hashlib.sha256(content).hexdigest())
        if key in self.parsed:
            self.hits += 1
        else:
            self.parsed[key] = self._yaml.safe_load(text)
        return copy.deepcopy(self.parsed[key])


# XPath validator ------------------------------------------------------------


class XPathValidator:
    """HQ's ``validate_xpath``, answered by one long-lived node child running HQ's validator code."""

    def __init__(self):
        self._process: subprocess.Popen | None = None
        self._pending = b""
        self._lock = threading.Lock()

    @property
    def running(self) -> bool:
        return self._process is not None

    def __call__(self, xpath, allow_case_hashtags=False):
        from corehq.apps.app_manager.xpath_validator.wrapper import XpathValidationResponse

        # The wrapper's own input: its whitespace collapse ("'\r' mysteriously
        # causes the process to hang"), encoded as it writes it to node's stdin.
        data = re.sub(r"\s+", " ", xpath).encode("utf-8")
        with self._lock:
            answer = self._ask({"text": base64.b64encode(data).decode("ascii"), "caseHashtags": allow_case_hashtags})
        if answer["code"] == 0:
            return XpathValidationResponse(is_valid=True, message=None)
        return XpathValidationResponse(is_valid=False, message=base64.b64decode(answer["stdout"]))

    def _start(self):
        from corehq.apps.app_manager.xpath_validator.config import get_xpath_validator_path

        directory = os.path.dirname(get_xpath_validator_path())
        self._process = subprocess.Popen(
            ["node", str(XPATH_SERVER), directory],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._pending = b""

    def _ask(self, request):
        if self._process is None:
            self._start()
        process = self._process
        try:
            process.stdin.write(json.dumps(request).encode("ascii") + b"\n")
            process.stdin.flush()
        except BrokenPipeError:
            self._fail("stopped before it read the expression")
        return json.loads(self._read_line(process))

    def _read_line(self, process):
        # The clock HQ's operations see is frozen, time.monotonic with it, so
        # the deadline is kept with perf_counter and the wait is selectors'.
        ends = time.perf_counter() + XPATH_DEADLINE_SECONDS
        descriptor = process.stdout.fileno()
        with selectors.DefaultSelector() as selector:
            selector.register(descriptor, selectors.EVENT_READ)
            while b"\n" not in self._pending:
                remaining = ends - time.perf_counter()
                if remaining <= 0:
                    self._fail(f"did not answer within {XPATH_DEADLINE_SECONDS:.0f} s")
                if not selector.select(remaining):
                    continue
                chunk = os.read(descriptor, 65536)
                if not chunk:
                    self._fail("exited")
                self._pending += chunk
        line, _, self._pending = self._pending.partition(b"\n")
        return line

    def _fail(self, what):
        process = self._process
        self._process = None
        stderr = b""
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
            stderr = process.stderr.read() or b""
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
        raise XPathValidatorFailed(
            f"HQ's XPath validator, running in its long-lived node child (proof/hq/xpath/{XPATH_SERVER.name}), "
            f"{what}. HQ's build waits on it for every module and form filter. What node wrote to stderr:\n"
            + (stderr.decode("utf-8", "replace").strip() or "(nothing)")
        )

    def close(self):
        """Join the child, if one is running."""
        with self._lock:
            process = self._process
            self._process = None
            if process is None:
                return
            process.stdin.close()
            process.wait()
            process.stdout.close()
            process.stderr.close()

    def forget(self):
        """In a forked child: let go of the parent's node child without touching it."""
        process = self._process
        self._process = None
        self._lock = threading.Lock()
        if process is not None:
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
            # The node child is the parent's to reap; this process never waits on it.
            process.returncode = 0


XPATH = XPathValidator()
atexit.register(XPATH.close)
os.register_at_fork(after_in_child=XPATH.forget)
# HQ's own functions the seams replace, kept in a dict: a module-level name
# bound to one would be a binding ``rebound`` patches too.
_HQ_ORIGINALS: dict = {}


def hq_validate_xpath():
    """HQ's own ``validate_xpath`` (one node process per expression), whatever its bindings read now."""
    from corehq.apps.app_manager.xpath_validator import wrapper

    return _HQ_ORIGINALS.get("validate_xpath", wrapper.validate_xpath)


# The cyclic collector -------------------------------------------------------


@contextmanager
def collector_thresholds():
    """The cyclic collector at ``COLLECTOR_THRESHOLDS`` for the block, and at the thresholds it had after."""
    held = gc.get_threshold()
    gc.set_threshold(*COLLECTOR_THRESHOLDS)
    try:
        yield
    finally:
        gc.set_threshold(*held)


# Installing -----------------------------------------------------------------


def _seams():
    """Every seam but the template engine's, each a context that applies it until it exits."""
    from unittest import mock

    import yaml
    from corehq.apps.app_manager import commcare_settings
    from corehq.apps.app_manager.xpath_validator import wrapper
    from corehq.apps.hqwebapp.utils import webpack
    from django.db.backends.base.base import BaseDatabaseWrapper
    from memoized import memoized

    from proof.hq import buildcache, seams

    _HQ_ORIGINALS.setdefault("validate_xpath", wrapper.validate_xpath)
    return [
        mock.patch.object(BaseDatabaseWrapper, "queries_logged", property(_production_queries_logged)),
        seams.rebound(webpack.get_webpack_manifest, memoized(webpack.get_webpack_manifest)),
        mock.patch.object(commcare_settings, "yaml", YamlMemo(yaml)),
        seams.rebound(wrapper.validate_xpath, XPATH),
        mock.patch.object(seams.FORM_VALIDATIONS, "enabled", True),
        collector_thresholds(),
        *buildcache.seams(),
    ]


def _applied_seams() -> ExitStack:
    stack = ExitStack()
    try:
        for seam in _seams():
            stack.enter_context(seam)
    except BaseException:
        stack.close()
        raise
    return stack


def install() -> None:
    """Apply every seam for the rest of the process; ``configure_templates`` ran before Django's setup.

    With ``PROOF_HQ_SPEED=0`` it applies none. It refuses a template engine
    Django built before ``configure_templates`` ran, which would leave the
    pages on the DEBUG boot's engine while the boot reports the seams on.
    """
    global _INSTALLED
    if _INSTALLED is not None or not ENABLED:
        return
    state = template_engine_state()
    if state != SEAMED_ENGINE:
        raise RuntimeError(
            "The proof harness set HQ's template engine to cache its templates with its debug option off "
            f"before Django's setup, and the engine Django built has {state}. Something built the engine "
            "before proof/hq/speed.py::configure_templates ran."
        )
    _INSTALLED = _applied_seams()
    # Closed while the interpreter still holds its modules, not when the
    # stack is collected at shutdown.
    atexit.register(_uninstall)


def _uninstall():
    global _INSTALLED
    stack, _INSTALLED = _INSTALLED, None
    if stack is not None:
        stack.close()


def installed() -> bool:
    return _INSTALLED is not None


@contextmanager
def off():
    """Inside the block, HQ runs as its DEBUG boot has it: no seam of this module applies.

    After the block the seams apply again, and the template engine has the
    cached loader it had before, with every template it had compiled.
    """
    global _INSTALLED
    if _INSTALLED is None:
        yield
        return
    stack, _INSTALLED = _INSTALLED, None
    stack.close()
    XPATH.close()
    seamed = _engine_parts()
    _set_engine(copy.deepcopy(_DEBUG_TEMPLATE_OPTIONS["loaders"]), _DEBUG_TEMPLATE_OPTIONS["debug"])
    try:
        yield
    finally:
        _set_engine(*seamed)
        _INSTALLED = _applied_seams()


@contextmanager
def on():
    """Inside the block every seam of this module applies, in a process booted without them (``PROOF_HQ_SPEED=0``).

    The template engine gets the cached loader, with an empty cache, and its
    debug option off, as ``configure_templates`` gives it at boot. After the
    block HQ runs as it did before: its own engine, no seam, no XPath child.
    In a process that has the seams the block changes nothing.
    """
    global _INSTALLED
    if _INSTALLED is not None:
        yield
        return
    before = _engine_parts()
    _set_engine(*_seamed_template_options())
    try:
        _INSTALLED = _applied_seams()
        yield
    finally:
        # The seams applied now, which an off() inside the block may have applied anew.
        stack, _INSTALLED = _INSTALLED, None
        if stack is not None:
            stack.close()
        XPATH.close()
        _set_engine(*before)


def stop_children() -> None:
    """Join every child process this module started; the next call starts a new one."""
    XPATH.close()
