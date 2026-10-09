"""What HQ reads from outside its state, answered from the check's configuration.

Each seam is a context manager owned by the test that opens it, and each
records what HQ asked it into the check's ``SeamRecord``:

- ``flags``: every feature flag is off unless the configuration names it. The
  seam decides at the methods where HQ decides a flag, ``StaticToggle.enabled``
  and ``enabled_for_request`` and each subclass override
  (``PredictablyRandomToggle.enabled``, inherited by
  ``DynamicallyPredictablyRandomToggle`` and ``FeatureRelease``;
  ``FrozenPrivilegeToggle`` and ``FeaturePreview`` inherit
  ``StaticToggle``'s), so a read that HQ would answer before reaching
  ``toggle_enabled`` (a namespace mismatch, ``relevant_environments``,
  ``enabled_for_new_domains_after``) is recorded too. ``toggle_enabled``
  itself refuses, so no flag read escapes the record.
- ``privileges``: every binding of ``accounting/utils::domain_has_privilege``,
  of the request-based ``django_prbac.utils.has_privilege`` and of
  ``accounting/utils::get_privileges`` (the list a page's JavaScript reads)
  answers from the configuration.
- ``previous_build``: ``_get_version_comparison_build`` returns the given
  build, so HQ's own ``set_form_versions`` decides each form's version.
- ``form_validation``: HQ's request to Formplayer's ``validate_form``
  endpoint is answered by Formplayer's own application
  (``formplayer_validation``: the session's validation Formplayer,
  ``proof.observe.services.validator``), sent with the headers HQ wrote and
  the digest HQ signed it with, under the key the two share; HQ's request
  and its reading of the answer run whole. Every form HQ sends is recorded;
  the answer to bytes already validated in this process is the one kept for
  them (``FORM_VALIDATIONS``, switched on by ``proof.hq.speed``).
- ``resource_overrides``: HQ's own ``patch_get_xform_resource_overrides``.
- ``project_space``: CommTrack and sync-cases-on-form-entry through HQ's
  own ``app_manager/tests/util.py`` seams.
- Soft assertions: every one HQ notes while the seams are open, as
  production notes it (``proof.hq.boot.soft_assertions``), so an assertion
  that would have raised in a test boot is evidence in the record instead.

``check_seams`` opens the seams every path runs under, and ``build_seams``
the ones a build adds.
"""

import atexit
import collections
import ctypes
import hashlib
import json
import os
import re
import sys
import types
import weakref
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from unittest import mock

from proof.hq.boot import HarnessRefusal, SoftAssertNote, soft_assertions
from proof.hq.configuration import Configuration


@dataclass(frozen=True)
class FlagRead:
    symbol: str | None
    slug: str
    toggle_class: str
    item: object
    namespace: object
    via: str  # "enabled" or "enabled_for_request"
    verdict: bool


@dataclass(frozen=True)
class PrivilegeRead:
    slug: str
    symbol: str | None
    domain: str | None
    via: str  # "domain_has_privilege" or "has_privilege"
    verdict: bool


@dataclass(frozen=True)
class FormValidation:
    xml: bytes
    response: dict


@dataclass
class SeamRecord:
    flags: list[FlagRead] = field(default_factory=list)
    privileges: list[PrivilegeRead] = field(default_factory=list)
    form_validations: list[FormValidation] = field(default_factory=list)
    elasticsearch_reads: list[tuple] = field(default_factory=list)
    elasticsearch_refusals: list[tuple] = field(default_factory=list)
    # Every soft assertion HQ noted while the seams were open, in order.
    soft_assertions: list[SoftAssertNote] = field(default_factory=list)

    def privilege_slugs_read(self):
        return sorted({r.slug for r in self.privileges})


class SeamRefused(HarnessRefusal):
    """HQ asked a seam something the check's configuration does not answer."""


# With PROOF_VERIFY_MEMOS=1 every kept answer is computed again and compared
# (the form validation memo), and every module scan is checked against a read
# of the whole of sys.modules.
VERIFY_MEMOS = os.environ.get("PROOF_VERIFY_MEMOS") == "1"


# CPython's dict watcher API (3.12 and later, Include/cpython/dictobject.h):
# the callback type and the events of PyDict_WatchEvent this scan reads.
_WATCH_CALLBACK = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
_DICT_ADDED, _DICT_MODIFIED, _DICT_CLONED = 0, 1, 3


def _dict_watcher_api():
    api = ctypes.pythonapi
    try:
        add, watch, unwatch, clear = (
            api.PyDict_AddWatcher,
            api.PyDict_Watch,
            api.PyDict_Unwatch,
            api.PyDict_ClearWatcher,
        )
    except AttributeError:
        raise RuntimeError(
            f"The proof harness reads the modules HQ imports through CPython's dict watchers (Python 3.12 and "
            f"later), and this interpreter ({sys.version.split()[0]}) has none. Run it in the proof image."
        ) from None
    add.argtypes, add.restype = [_WATCH_CALLBACK], ctypes.c_int
    watch.argtypes, watch.restype = [ctypes.c_int, ctypes.py_object], ctypes.c_int
    unwatch.argtypes, unwatch.restype = [ctypes.c_int, ctypes.py_object], ctypes.c_int
    clear.argtypes, clear.restype = [ctypes.c_int], ctypes.c_int
    return add, watch, unwatch, clear


class _Modules:
    """Every module ``sys.modules`` has held, each once, in the order the harness first saw it.

    ``sync()`` appends the modules put into ``sys.modules`` since the last
    call. The list holds each module, so no id it records is reused by a
    later module.

    ``sys.modules`` itself says what was put into it: a CPython dict watcher
    on it (``PyDict_Watch``) receives every value as it is put in, under a
    new name or in place of another, and every dict merged into it whole, so
    ``sync()`` reads only what was put in since its last call, and nothing
    when nothing was. The first call reads the whole dict, and so does the
    call after one the watcher failed to record. ``PROOF_VERIFY_MEMOS=1``
    checks every call against a read of the whole dict.
    """

    def __init__(self):
        self.seen: list[types.ModuleType] = []
        self._ids: set[int] = set()
        # What the watcher saw put into sys.modules since the last sync. The
        # watcher runs before the dict changes, on the thread that changes
        # it, so a value can be here a moment before sys.modules holds it.
        self._put: collections.deque = collections.deque()
        self._whole = True
        self._watched: dict | None = None
        self._watcher: int | None = None
        self._callback = _WATCH_CALLBACK(self._changed)
        self.read = 0  # values read, for measuring

    def _changed(self, event, mapping, key, value):
        try:
            if event in (_DICT_ADDED, _DICT_MODIFIED) and value:
                self._put.append(ctypes.cast(value, ctypes.py_object).value)
            elif event == _DICT_CLONED and key:
                # An empty dict given every entry of another (``key``) at once.
                self._put.extend(ctypes.cast(key, ctypes.py_object).value.values())
        except BaseException:
            self._whole = True
        return 0

    def _watch(self, modules):
        add, watch, unwatch, _ = _dict_watcher_api()
        if self._watcher is None:
            self._watcher = add(self._callback)
            atexit.register(self._close)
        if self._watched is not None:
            unwatch(self._watcher, self._watched)
        watch(self._watcher, modules)
        self._watched = modules
        self._whole = True

    def _close(self):
        # Before the interpreter tears its modules down, which sys.modules sees.
        _, _, unwatch, clear = _dict_watcher_api()
        if self._watched is not None:
            unwatch(self._watcher, self._watched)
            self._watched = None
        if self._watcher is not None:
            clear(self._watcher)
            self._watcher = None

    def _take(self, values):
        for module in values:
            self.read += 1
            if isinstance(module, types.ModuleType) and id(module) not in self._ids:
                self._ids.add(id(module))
                self.seen.append(module)

    def _drain(self):
        while True:
            try:
                yield self._put.popleft()
            except IndexError:
                return

    def sync(self):
        modules = sys.modules
        if modules is not self._watched:
            self._watch(modules)
        if self._whole:
            self._whole = False
            self._take(list(modules.values()))
        self._take(self._drain())
        if VERIFY_MEMOS:
            self._verify(modules)

    def _verify(self, modules):
        held = list(modules.items())
        # Everything put in before that read was handed to the watcher first.
        self._take(self._drain())
        missed = [name for name, module in held if isinstance(module, types.ModuleType) and id(module) not in self._ids]
        if missed:
            raise SeamRefused(
                f"The seams' module scan missed modules sys.modules holds: {missed[:10]}. Its dict watcher "
                "(proof/hq/seams.py::_Modules) did not see them put in, so a binding rebound must patch could "
                "be left unread."
            )


_MODULES = _Modules()


class _Bindings:
    """Where one function is bound at module level, and how many of ``_MODULES.seen`` were read for it.

    ``places`` holds each ``(namespace, name)`` pair once.
    """

    def __init__(self):
        self.places: list[tuple[dict, str]] = []
        self._known: set[tuple[int, str]] = set()
        self.read = 0

    def _record(self, namespace, name):
        key = (id(namespace), name)
        if key not in self._known:
            self._known.add(key)
            self.places.append((namespace, name))

    def scan(self, *values, start=None):
        """Record each binding of any of ``values`` in ``_MODULES.seen[start:]`` (by default, the modules not read yet).

        Returns the namespaces read, so a caller can act on what it found there.
        """
        _MODULES.sync()
        modules = _MODULES.seen[self.read if start is None else start :]
        for module in modules:
            namespace = vars(module)
            for name, value in list(namespace.items()):
                if any(value is wanted for wanted in values):
                    self._record(namespace, name)
        self.read = max(self.read, len(_MODULES.seen))
        return [vars(module) for module in modules]


# The bindings of each function ``rebound`` has patched, kept for the process.
_BINDINGS: "weakref.WeakKeyDictionary[object, _Bindings]" = weakref.WeakKeyDictionary()


def _bindings_of(original):
    try:
        found = _BINDINGS.get(original)
    except TypeError:  # an object a weak reference cannot name is read afresh each time
        return _Bindings()
    if found is None:
        found = _Bindings()
        _BINDINGS[original] = found
    return found


@contextmanager
def rebound(original, replacement):
    """Every module-level binding of ``original`` reads ``replacement`` inside the block.

    HQ binds many functions by ``from x import f``, so patching ``x.f`` alone
    misses the copies. At exit every module-level binding of ``replacement``
    goes back to ``original``: the ones the block patched, and those of every
    module imported since the block began, which bound the replacement where
    they imported the function, including modules a nested block read first.

    HQ binds these functions only where a module imports or defines them, at
    the module's import: no HQ module assigns one later (no ``global`` or
    ``setattr`` of one, and no module-level assignment other than an import or
    a definition). So the bindings found are kept for the process, per
    function: entering a block reads only the modules imported since that
    function's bindings were last read, and leaving it reads only the modules
    imported since the block began. Every module ``sys.modules`` holds,
    whenever it was imported, is read before a block patches its bindings.
    """
    bindings = _bindings_of(original)
    bindings.scan(original)
    began = len(_MODULES.seen)
    for namespace, name in bindings.places:
        if namespace.get(name) is original:
            namespace[name] = replacement
    try:
        yield
    finally:
        for namespace, name in bindings.places:
            if namespace.get(name) is replacement:
                namespace[name] = original
        # A module imported inside the block bound the replacement where it
        # imported the function; it binds the original from here on. A nested
        # block of the same function may have read such a module already,
        # while it held this block's replacement, so every module imported
        # since this block began is read again here.
        for namespace in bindings.scan(original, replacement, start=began):
            for name, value in list(namespace.items()):
                if value is replacement:
                    namespace[name] = original


def _toggle_classes():
    from corehq.toggles import StaticToggle

    classes, pending = [], [StaticToggle]
    while pending:
        cls = pending.pop()
        classes.append(cls)
        pending.extend(cls.__subclasses__())
    return classes


def _toggle_symbols():
    import corehq.feature_previews as previews
    import corehq.toggles as toggles

    symbols = {}
    scopes = [vars(toggles), vars(previews)]
    for module_name in toggles.custom_toggle_modules():
        scopes.append(vars(__import__(module_name, fromlist=["_"])))
    for scope in scopes:
        for name, value in scope.items():
            if isinstance(value, toggles.StaticToggle) and not name.startswith("_"):
                symbols.setdefault(id(value), name)
    return symbols


# The attribute the flag seam's refusal of ``toggle_enabled`` keeps HQ's own function under.
_REFUSED_ORIGINAL = "__proof_hq_original__"
# Called with every flag read the open flag seams answer through ``enabled`` or ``enabled_for_request``, as
# ``(toggle, item, namespace, via, verdict)``, ``namespace`` Ellipsis where HQ named none.
FLAG_READ_LISTENERS: list = []
# The verdict each open flag seam gives ``toggle.enabled(item, namespace)``, innermost (the one HQ reads) last;
# asking it records nothing.
FLAG_ANSWERS: list = []


@contextmanager
def flags(configuration: Configuration, record: SeamRecord):
    import corehq.toggles as toggles
    import corehq.toggles.shortcuts as shortcuts

    enabled_ids = {id(toggle) for toggle in configuration.flag_toggles().values()}
    symbols = _toggle_symbols()

    def read(toggle, item, namespace, via, verdict):
        record.flags.append(
            FlagRead(
                symbol=symbols.get(id(toggle)),
                slug=toggle.slug,
                toggle_class=type(toggle).__name__,
                item=item,
                namespace=None if namespace is Ellipsis else namespace,
                via=via,
                verdict=verdict,
            )
        )
        for listener in FLAG_READ_LISTENERS:
            listener(toggle, item, namespace, via, verdict)
        return verdict

    def answer(toggle, item, namespace=Ellipsis):
        # StaticToggle.enabled: a namespace the toggle does not carry is off.
        normalized = None if namespace == toggles.NAMESPACE_USER else namespace
        applies = namespace is Ellipsis or normalized in toggle.namespaces
        return applies and id(toggle) in enabled_ids

    def enabled(self, item, namespace=Ellipsis):
        return read(self, item, namespace, "enabled", answer(self, item, namespace))

    def enabled_for_request(self, request):
        # StaticToggle.enabled_for_request: the request must carry what one of
        # the toggle's namespaces identifies.
        applies = (
            (None in self.namespaces and hasattr(request, "user"))
            or (toggles.NAMESPACE_DOMAIN in self.namespaces and hasattr(request, "domain"))
            or (toggles.NAMESPACE_EMAIL_DOMAIN in self.namespaces and hasattr(request, "user"))
        )
        return read(
            self,
            getattr(request, "domain", None),
            None,
            "enabled_for_request",
            bool(applies) and id(self) in enabled_ids,
        )

    def toggle_enabled(slug, item, namespace=None):
        raise SeamRefused(
            f"HQ read the flag {slug!r} through toggle_enabled, outside the toggle "
            "methods the flag seam answers, so the read would go unrecorded. Add "
            "the reader to proof/hq/seams.py::flags."
        )

    # HQ's own toggle_enabled, also where a flag seam is open around this one
    # (a sensitivity flip inside the unit's seams): there every binding already
    # holds the outer seam's refusal, which refuses as this one does, so this
    # block leaves them as they are. Rebinding the outer refusal instead would
    # make each new outer block's first nested one read every module again for
    # a function no module bound at import.
    current = shortcuts.toggle_enabled
    original = getattr(current, _REFUSED_ORIGINAL, current)
    setattr(toggle_enabled, _REFUSED_ORIGINAL, original)

    with ExitStack() as stack:
        for cls in _toggle_classes():
            if "enabled" in vars(cls):
                stack.enter_context(mock.patch.object(cls, "enabled", enabled))
            if "enabled_for_request" in vars(cls):
                stack.enter_context(mock.patch.object(cls, "enabled_for_request", enabled_for_request))
        stack.enter_context(rebound(original, toggle_enabled))
        FLAG_ANSWERS.append(answer)
        stack.callback(FLAG_ANSWERS.remove, answer)
        yield record


# Privileges the project space's plan grants beside its configuration's, while ``also_granted`` holds them.
ALSO_GRANTED: set[str] = set()


@contextmanager
def also_granted(slug: str):
    """For the block, the project space's plan also grants the privilege ``slug``.

    A configuration grants what a document's content needs to build and be edited
    (``proof.checks.configurations``). A privilege that decides something else about the project space, which a
    part of the lane states of it, is granted here for that part alone and recorded as every privilege read is:
    HQ forwards a form to Connect only where the project space can forward data (``DATA_FORWARDING``,
    ``motech/repeaters/models.py::domain_can_forward``), which the project space of a Connect opportunity can.
    """
    held = slug in ALSO_GRANTED
    ALSO_GRANTED.add(slug)
    try:
        yield
    finally:
        if not held:
            ALSO_GRANTED.discard(slug)


# Project spaces beside the configuration's that a part of the lane makes, by name, with the privilege slugs each
# one's plan grants, while ``another_project_space`` holds them.
OTHER_SPACES: dict[str, frozenset[str]] = {}


@contextmanager
def another_project_space(domain: str, privilege_symbols):
    """For the block, a second project space ``domain`` exists beside the configuration's, its plan granting the
    privileges ``privilege_symbols`` (``corehq/privileges.py`` names) and nothing else, each read of it recorded as
    every privilege read is. A part of the lane that states two project spaces (a linked app's upstream and
    downstream, ``proof/views/test_linked_logos.py``) names the second here; its flags are the configuration's."""
    from proof.hq.configuration import resolve_privilege

    if domain in OTHER_SPACES:
        raise SeamRefused(f"The project space {domain!r} was named twice; name each second project space once.")
    OTHER_SPACES[domain] = frozenset(resolve_privilege(symbol) for symbol in privilege_symbols)
    try:
        yield
    finally:
        del OTHER_SPACES[domain]


@contextmanager
def privileges(configuration: Configuration, record: SeamRecord):
    import corehq.privileges as privilege_constants
    import django_prbac.utils as prbac_utils
    from corehq.apps.accounting import utils as accounting_utils

    granted = configuration.privilege_slugs()
    symbol_by_slug = {}
    for name, value in sorted(vars(privilege_constants).items()):
        if name.isupper() and isinstance(value, str):
            symbol_by_slug.setdefault(value, name)

    def decide(slug, domain, via):
        if domain in OTHER_SPACES:
            verdict = slug in OTHER_SPACES[domain]
            record.privileges.append(PrivilegeRead(slug, symbol_by_slug.get(slug), domain, via, verdict))
            return verdict
        if domain is not None and domain != configuration.domain:
            raise SeamRefused(
                f"HQ asked whether the project space {domain!r} has the privilege "
                f"{slug!r}; the check's configuration describes {configuration.domain!r} only."
            )
        verdict = slug in granted or slug in ALSO_GRANTED
        record.privileges.append(PrivilegeRead(slug, symbol_by_slug.get(slug), domain, via, verdict))
        return verdict

    def domain_has_privilege(domain, privilege_slug, **assignment):
        name = getattr(domain, "name", domain)
        return decide(privilege_slug, name, "domain_has_privilege")

    def has_privilege(request, slug, **assignment):
        return decide(slug, getattr(request, "domain", None), "has_privilege")

    def get_privileges(plan_version):
        # Every privilege the project space's plan grants, as the page frame's
        # context processor (util/context_processors.py::js_privileges) lists
        # them for the page's JavaScript (hqwebapp/js/privileges.js).
        for slug in sorted(granted):
            record.privileges.append(PrivilegeRead(slug, granted[slug], configuration.domain, "get_privileges", True))
        return set(granted)

    with (
        rebound(accounting_utils.domain_has_privilege, domain_has_privilege),
        rebound(prbac_utils.has_privilege, has_privilege),
        rebound(accounting_utils.get_privileges, get_privileges),
    ):
        yield record


@contextmanager
def previous_build(build):
    """HQ compares a new build's forms and media with ``build`` (None: no build yet)."""
    from corehq.apps.app_manager.models import ApplicationBase

    classes, pending = [], [ApplicationBase]
    while pending:
        cls = pending.pop()
        classes.append(cls)
        pending.extend(cls.__subclasses__())
    with ExitStack() as stack:
        for cls in classes:
            if "_get_version_comparison_build" in vars(cls):
                stack.enter_context(mock.patch.object(cls, "_get_version_comparison_build", lambda self: build))
        yield


class _ValidationResponse:
    status_code = 200

    def __init__(self, text):
        self._text = text

    def raise_for_status(self):
        return None

    def json(self):
        return json.loads(self._text)


class MemoMismatch(HarnessRefusal):
    """A kept answer differs from the answer computed again for the same input."""


def pure(validate):
    """``validate``, marked as a pure function of the form's bytes, so its answers may be kept."""

    def pure_validation(xml):
        return validate(xml)

    pure_validation.pure_form_validation = True
    return pure_validation


# A Java object written with ``Object.toString``: its class's name, ``@`` and its identity hash, which the JVM
# draws afresh for each object (Core's parser names a node so in its "Bad node" message,
# ``xpath/parser/Parser.java::verifyBaseExpr``; ``proof.observe.intent.IDENTITY_HASH`` is the same pattern).
IDENTITY_HASH = re.compile(r"\b((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*)@[0-9a-f]{1,8}\b")


class _FormValidations:
    """Formplayer's answer to each form, kept by the sha256 of the form's bytes.

    Formplayer's ``validateForm`` (``XFormParser`` with ``JSONReporter``) is
    a function of the bytes HQ posts and nothing else, and what HQ sends with
    them (the content type, and the digest of those bytes under the shared
    key) is too, so the answer to bytes already validated in this process is
    the answer kept for them. Only a validator known to be such a function
    has its answers kept: Formplayer's (``formplayer_validation``, a runner's
    ``validate_form``), or one marked with ``pure``; any other (one that also checks or counts what HQ sends) is
    asked every time. ``proof.hq.speed`` switches the memo on; with
    ``PROOF_VERIFY_MEMOS=1`` every kept answer is computed again and must be
    identical (``MemoMismatch``) but for the identity hashes Core writes into
    a message (``IDENTITY_HASH``), which no two computations share.
    """

    def __init__(self):
        self.enabled = False
        self.verify = VERIFY_MEMOS
        self._answers: dict[bytes, str] = {}
        self.hits = 0
        self.verified = 0

    def answer(self, validate, xml: bytes, headers=None) -> str:
        def asked():
            if headers is not None and getattr(validate, "takes_hq_headers", False):
                return validate(xml, headers=headers)
            return validate(xml)

        if not (self.enabled and _is_pure(validate)):
            return asked()
        digest = hashlib.sha256(xml).digest()
        kept = self._answers.get(digest)
        if kept is None:
            kept = self._answers[digest] = asked()
            return kept
        self.hits += 1
        if self.verify:
            fresh = asked()
            self.verified += 1
            if IDENTITY_HASH.sub(r"\1", fresh) != IDENTITY_HASH.sub(r"\1", kept):
                raise MemoMismatch(
                    f"The validation of a form (sha256 {digest.hex()}) answered {fresh!r} when computed again, "
                    f"where the harness kept {kept!r}. Form validation is not a function of the form's "
                    "bytes alone here, so proof/hq/seams.py must stop keeping its answers."
                )
        return kept

    def clear(self):
        self._answers.clear()


FORM_VALIDATIONS = _FormValidations()


def formplayer_validation(xml: bytes, *, headers=None) -> str:
    """Formplayer's own answer to HQ's form validation request: the session's validation Formplayer
    (``proof.observe.services.validator``), sent the headers HQ wrote where it is given them."""
    from proof.observe import services

    return services.validator().validate_form(xml, headers=headers)


formplayer_validation.pure_form_validation = True
formplayer_validation.takes_hq_headers = True


def _is_pure(validate):
    return bool(getattr(validate, "pure_form_validation", False))


@contextmanager
def form_validation(validate, record: SeamRecord):
    """Formplayer's form validation, answered by ``validate(xml: bytes) -> str``: Formplayer's own
    (``formplayer_validation``) on every path of the lane, or a test's own.

    ``validate`` returns Formplayer's JSON verbatim, and one that takes HQ's
    headers (``takes_hq_headers``) is handed the ones HQ's request wrote:
    the content type and the digest HQ signed the form with, under the key
    HQ and Formplayer share (``FORMPLAYER_INTERNAL_AUTH_KEY``, set here to
    the one the lane's Formplayers are started with). HQ caches a verdict per
    app and form (``FormBase.validate_form``); ``proof.hq.operations.build``
    clears each form's verdict first, so every build sends every form here,
    and each is recorded. The answer may be one kept for the same bytes
    (``FORM_VALIDATIONS``).
    """
    from corehq.apps.formplayer_api import const
    from corehq.apps.formplayer_api import form_validation as formplayer
    from django.test import override_settings

    from proof.formplayer.client import AUTH_KEY

    class _Formplayer:
        @staticmethod
        def post(url, data=None, headers=None, **kwargs):
            if not url.endswith(const.ENDPOINT_VALIDATE_FORM):
                raise SeamRefused(f"HQ posted to Formplayer at {url}; the harness answers form validation only.")
            body = data if isinstance(data, bytes) else data.encode("utf-8")
            sent = tuple((str(name), str(value)) for name, value in (headers or {}).items())
            text = FORM_VALIDATIONS.answer(validate, body, sent)
            record.form_validations.append(FormValidation(xml=body, response=json.loads(text)))
            return _ValidationResponse(text)

    with (
        mock.patch.object(formplayer, "requests", _Formplayer),
        override_settings(FORMPLAYER_INTERNAL_AUTH_KEY=AUTH_KEY),
    ):
        yield record


@contextmanager
def resource_overrides():
    from corehq.apps.app_manager.tests.util import patch_get_xform_resource_overrides

    with patch_get_xform_resource_overrides():
        yield


@contextmanager
def project_space(configuration: Configuration):
    from corehq.apps.app_manager.tests import util as app_manager_test_util

    with ExitStack() as stack:
        stack.enter_context(app_manager_test_util.commtrack_enabled(configuration.commtrack))
        if configuration.sync_cases_on_form_entry:
            # HQ's own reader returns False under UNIT_TESTING; its test seam turns it on.
            stack.enter_context(app_manager_test_util.case_search_sync_cases_on_form_entry_enabled_for_domain())
        yield


@contextmanager
def check_seams(configuration: Configuration, record: SeamRecord, *, validate):
    """The seams every path runs under.

    Flags, privileges and the project-space settings answer from the
    configuration, HQ's Elasticsearch client is watched (``proof.hq.elasticsearch``, whose server and indexes
    the unit holds), and Formplayer's form validation is
    ``validate``'s (Formplayer's own, ``formplayer_validation``): HQ asks Formplayer to validate forms while
    it builds, while it renders a form's settings page, and while it imports
    an app that maps media (``hqmedia/models.py::ApplicationMediaMixin.all_media``
    validates each form of a module that uses media). Every soft assertion
    HQ notes meanwhile is kept in ``record.soft_assertions``.
    """
    from proof.hq.elasticsearch import elasticsearch

    with (
        soft_assertions(record.soft_assertions),
        flags(configuration, record),
        privileges(configuration, record),
        project_space(configuration),
        elasticsearch(record),
        form_validation(validate, record),
    ):
        yield record


@contextmanager
def build_seams(*, previous=None):
    """What HQ's build reads beyond the check's seams: the previous build and resource overrides.

    Open it inside ``check_seams``.
    """
    with previous_build(previous), resource_overrides():
        yield
