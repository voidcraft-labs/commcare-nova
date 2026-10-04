"""HQ's speed seams change no byte HQ computes: ``proof.hq.speed``.

Contract: with DEBUG left on, the cached template loader, the template
engine's debug option off, the query log off, the memoized webpack manifest
and the memoized settings YAML make HQ faster and nothing else. The plausible
failures: a template whose output depends on the loader that compiled it or on
the engine's debug option, a cached template that keeps state from one render
into the next, a manifest or YAML parse that differs from a fresh read, and a
YAML structure shared between callers that mutate it (HQ's settings loaders
pop and rewrite what they parse).

Each page is rendered three times over one state under one operation key (so
its CSRF token and clock are the same): with the seams, with HQ's DEBUG boot
(``speed.off()``, where the engine is shown to be the uncached debug one), and
with the seams again from the cache the first render filled (the same cached
loader, holding every template the first render compiled). The pages are
HQ's own views over HQ's suite-test apps as the editors' tests publish them.

Every comparison opens the seams with ``speed.on()`` and closes them with
``speed.off()``, so it holds whichever the process booted with
(``PROOF_HQ_SPEED``).
"""

from __future__ import annotations

import copy
import gc
import hashlib
import io
import json
import os

import pytest

from proof.editors.conftest import ADVANCED_APP, SUITE_APP, publish_hq_app
from proof.hq import determinism, operations, speed
from proof.hq import requests as hq_requests
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.determinism import operation

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
SEAMED = speed.SEAMED_ENGINE
DEBUG_BOOT = speed.DEBUG_ENGINE


def _render(state, path):
    """The page HQ's URLconf and view answer for ``path``, rendered as HQ's server renders it."""
    from corehq.apps.hqwebapp.utils.bootstrap import clear_bootstrap_version
    from django.urls import resolve

    match = resolve(path)
    request = hq_requests.get(state, path)
    try:
        response = match.func(request, *match.args, **match.kwargs)
        if hasattr(response, "render") and not getattr(response, "is_rendered", True):
            response.render()
    finally:
        clear_bootstrap_version()
    assert response.status_code == 200, (path, response.status_code)
    return response.content


def _pages(state, suite_id, advanced_id):
    from django.urls import reverse

    suite = operations.held_app(state, suite_id)
    advanced = operations.held_app(state, advanced_id)
    return {
        "app_settings": reverse("app_settings", args=[state.domain, suite_id]),
        "view_module": reverse("view_module", args=[state.domain, suite_id, suite.modules[0].unique_id]),
        "view_form": reverse("view_form", args=[state.domain, suite_id, suite.modules[0].forms[0].unique_id]),
        "view_module (advanced)": reverse(
            "view_module", args=[state.domain, advanced_id, advanced.modules[0].unique_id]
        ),
    }


def _template_cache():
    from django.template import engines

    (loader,) = engines["django"].engine.template_loaders
    return loader, {
        template.origin.template_name for template in loader.get_template_cache.values() if hasattr(template, "origin")
    }


def test_each_page_renders_the_same_bytes_with_and_without_the_seams(hq, core_runner, monkeypatch):
    # The renders compare under one key whatever PROOF_HQ_DETERMINISM says.
    monkeypatch.setattr(determinism, "ENABLED", True)
    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        suite_id = publish_hq_app(state, SUITE_APP)
        advanced_id = publish_hq_app(state, ADVANCED_APP)
        for name, path in _pages(state, suite_id, advanced_id).items():
            key = hashlib.sha256(f"proof speed test|{path}".encode()).digest()
            with speed.on():
                assert speed.template_engine_state() == SEAMED
                with operation(key, 1):
                    seamed = _render(state, path)
                loader, compiled = _template_cache()
                with speed.off():
                    assert speed.template_engine_state() == DEBUG_BOOT
                    with operation(key, 1):
                        debug_boot = _render(state, path)
                # The cached loader is back with the templates the first render
                # compiled, so this render reads every one of them from its cache.
                assert speed.template_engine_state() == SEAMED
                assert _template_cache() == (loader, compiled), name
                with operation(key, 1):
                    cached = _render(state, path)
                assert _template_cache() == (loader, compiled), name
            assert seamed == debug_boot == cached, name
            assert b"csrfmiddlewaretoken" in seamed, name


def test_on_and_off_put_back_the_engine_and_seams_the_process_booted_with(hq):
    def state():
        return speed.template_engine_state(), speed.installed(), gc.get_threshold()

    seamed = (SEAMED, True, speed.COLLECTOR_THRESHOLDS)
    booted = state()
    # Python's own thresholds where the process booted without the seams.
    assert booted == (seamed if hq.speed else (DEBUG_BOOT, False, (2000, 10, 10)))
    with speed.on():
        assert state() == seamed
        with speed.off():
            assert (*state(), speed.XPATH.running) == (DEBUG_BOOT, False, (2000, 10, 10), False)
        assert state() == seamed
    assert state() == booted
    with speed.off():
        assert state() == (DEBUG_BOOT, False, (2000, 10, 10))
    assert state() == booted


def test_the_seams_refuse_a_template_engine_built_without_them(hq, monkeypatch):
    """``install()`` refuses an engine Django built before ``configure_templates`` ran: inside ``off()`` the
    engine is the DEBUG boot's. The boot's own engine is the accepted case: seamed when the boot applied the
    seams, and left as Django built it when ``PROOF_HQ_SPEED=0`` told the boot to apply none."""
    assert hq.template_engine == (SEAMED if hq.speed else DEBUG_BOOT)
    with speed.off():
        monkeypatch.setattr(speed, "ENABLED", True)
        try:
            with pytest.raises(RuntimeError, match="before proof/hq/speed.py::configure_templates ran"):
                speed.install()
        finally:
            speed._uninstall()  # only had install() not refused
        monkeypatch.undo()
    assert speed.installed() is hq.speed
    assert speed.template_engine_state() == hq.template_engine


def _settings_files():
    from corehq.apps.app_manager import commcare_settings

    directory = os.path.join(os.path.dirname(commcare_settings.__file__), "static", "app_manager", "json")
    return [os.path.join(directory, name) for name in sorted(os.listdir(directory)) if name.endswith(".yml")]


def test_the_settings_yaml_seam_parses_as_yaml_does_and_shares_nothing(hq):
    import yaml
    from corehq.apps.app_manager import commcare_settings

    with speed.on():
        memo = commcare_settings.yaml
    assert isinstance(memo, speed.YamlMemo)
    paths = _settings_files()
    assert len(paths) >= 3
    for path in paths:
        with open(path, encoding="utf-8") as stream:
            fresh = yaml.safe_load(stream)
        hits = memo.hits
        with open(path, encoding="utf-8") as stream:
            first = memo.safe_load(stream)
        with open(path, encoding="utf-8") as stream:
            second = memo.safe_load(stream)
        assert memo.hits > hits
        assert first == fresh == second
        # Unshared: a caller's mutation reaches neither the next caller nor the parse kept.
        snapshot = copy.deepcopy(second)
        first.clear() if isinstance(first, dict) else first.append("mutated")
        assert second == snapshot
        with open(path, encoding="utf-8") as stream:
            assert memo.safe_load(stream) == fresh

    # Content decides the parse, not the name: the same name with other content parses anew.
    one, two = io.StringIO("a: 1\n"), io.StringIO("a: 2\n")
    one.name = two.name = paths[0]
    assert (memo.safe_load(one), memo.safe_load(two)) == ({"a": 1}, {"a": 2})


def test_hqs_settings_readers_get_from_the_seam_what_they_get_from_yaml(hq, core_runner):
    """HQ's own consumer, which pops and rewrites what it parses, gives the same layout either way, every time."""
    from corehq.apps.app_manager import commcare_settings

    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, _):
        app = operations.held_app(state, publish_hq_app(state, SUITE_APP))
        with speed.on():
            assert isinstance(commcare_settings.yaml, speed.YamlMemo)
            seamed = [commcare_settings._load_commcare_settings_layout(app) for _ in range(2)]
        with speed.off():
            assert not isinstance(commcare_settings.yaml, speed.YamlMemo)
            debug_boot = commcare_settings._load_commcare_settings_layout(app)
    assert seamed[0] == seamed[1] == debug_boot
    assert seamed[0] is not seamed[1]


def test_the_manifest_memo_equals_a_fresh_read(hq):
    from corehq.apps.hqwebapp.utils import webpack

    with speed.on():
        for name in ("manifest.json", "manifest_b3.json"):
            fresh = json.loads((webpack.WEBPACK_BUILD_DIR / name).read_text(encoding="utf-8"))
            assert webpack.get_webpack_manifest(name) == fresh
            # Memoized as HQ memoizes it when DEBUG is off: the same object every time.
            assert webpack.get_webpack_manifest(name) is webpack.get_webpack_manifest(name)
        assert webpack.get_webpack_manifest() == webpack.get_webpack_manifest("manifest.json")
    with speed.off():
        assert webpack.get_webpack_manifest("manifest.json") is not webpack.get_webpack_manifest("manifest.json")


def test_queries_are_logged_only_when_a_test_asks_for_them(hq, core_runner):
    from django.conf import settings
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    assert settings.DEBUG is True
    with hq_check(CONFIGURATION, validate=core_runner.validate_form):
        with speed.on():
            assert connection.queries_logged is False
            with CaptureQueriesContext(connection) as captured:
                assert connection.queries_logged is True
                with connection.cursor() as cursor:
                    cursor.execute("select 1")
            assert [query["sql"] for query in captured.captured_queries] == ["select 1"]
        with speed.off():
            assert connection.queries_logged is True
