"""Apps HQ's own tests build, harvested as self-check apps.

Each harvested app is built by one of HQ's app-manager tests, run whole
(``setUp``, the test, ``tearDown``) under the harness's HQ boot the way
HQ's runner runs a test without a database: ``DB_ENABLED`` off, so a flag
the test does not turn on reads as off (``toggles/shortcuts.py::toggle_enabled``),
and Django's ``SimpleTestCase`` refusing every query. The app captured is
the first one an ``AppFactory`` built during the test (``AppFactory.__init__``
is recorded), or the test's own ``self.app`` when no factory built one.

HQ's tests build their forms without a source. Each form that is not a
shadow form is given one generated here, so the app can build: a unique
``xmlns`` (fixed by the test and the form's position), a text question for
every form path the form's case configuration reads (each ``question_path``
and each ``preload`` key in its actions) and ``/data/question1``, and one
itext translation per app language, the first the default. The app is then
written as HQ's app source serves it (``ApplicationBase.export_json``), which
is what HQ's import receives.

``TESTS`` names the tests the research harvested, with what it found when it
built each app at CommCare 2.54.0: eight build clean, and three have no
forms or case list HQ can build.
"""

from __future__ import annotations

import hashlib
import importlib
import unittest
from contextlib import ExitStack
from dataclasses import dataclass, field
from unittest import mock


@dataclass(frozen=True)
class HarvestTest:
    module: str  # under corehq.apps.app_manager.tests
    cls: str
    method: str
    expected: str  # "clean" or "errors"

    @property
    def node_id(self):
        return f"corehq/apps/app_manager/tests/{self.module}.py::{self.cls}::{self.method}"

    @property
    def id(self):
        return f"harvest-{self.cls}-{self.method}"


TESTS = (
    HarvestTest("test_suite_remote_request", "RemoteRequestSuiteTest", "test_remote_request", "clean"),
    HarvestTest("test_suite_remote_request", "RemoteRequestSuiteTest", "test_case_search_action", "errors"),
    HarvestTest("test_suite_inline_search", "InlineSearchSuiteTest", "test_inline_search", "clean"),
    HarvestTest("test_suite_inline_search", "InlineSearchSuiteTest", "test_inline_search_multi_select", "clean"),
    HarvestTest(
        "test_suite_multi_select_case_list", "MultiSelectCaseListTests", "test_multi_select_case_list", "clean"
    ),
    HarvestTest("test_suite_session_endpoints", "SessionEndpointTests", "test_multiple_session_endpoints", "clean"),
    HarvestTest("test_case_list_form", "CaseListFormSuiteTests", "test_case_list_registration_form", "clean"),
    HarvestTest("test_form_workflow", "TestFormWorkflow", "test_link_to_child_module_form", "clean"),
    HarvestTest(
        "test_suite_split_screen_case_search",
        "SplitScreenCaseSearchTest",
        "test_split_screen_case_search_removes_search_again",
        "clean",
    ),
    HarvestTest("test_suite_split_screen_case_search", "SearchOnClearSuiteTest", "test_search_on_clear", "errors"),
    HarvestTest(
        "test_suite_split_screen_case_search",
        "SearchOnClearSuiteTest",
        "test_search_on_clear_disable_with_auto_select",
        "errors",
    ),
)


class HarvestFailed(AssertionError):
    """HQ's test did not pass, or built no app to capture."""


@dataclass
class Harvest:
    test: HarvestTest
    app: object  # the Application HQ's test built
    captured_from: str  # "factory0" or "self.app"
    # Every app whose suite HQ built while the test ran, by identity.
    suites_built_for: list = field(default_factory=list)
    factories: list = field(default_factory=list)


# The address HQ's own test run builds under (``settings.py::BASE_ADDRESS`` and
# ``DEFAULT_PROTOCOL``, which ``testsettings`` keeps), and which the suites HQ's
# tests expect name (``dimagi/utils/web.py::get_url_base``). The harness's
# localsettings names the server Nova publishes to instead, so each harvested
# test runs under HQ's own.
HQ_TEST_ADDRESS = {"BASE_ADDRESS": "localhost:8000", "DEFAULT_PROTOCOL": "http"}


def run_test(test: HarvestTest) -> Harvest:
    """Run one HQ test whole, under the address HQ's own test run has, and return the app it built.

    Raises ``HarvestFailed`` when HQ's test fails or errors, since its app
    would then not be the one HQ's assertions accepted.
    """
    from corehq.apps.app_manager.models import Application
    from corehq.apps.app_manager.tests.app_factory import AppFactory
    from django.test import override_settings

    module = importlib.import_module(f"corehq.apps.app_manager.tests.{test.module}")
    case = getattr(module, test.cls)(test.method)
    factories = []
    suites_built_for = []
    real_init = AppFactory.__init__
    real_create_suite = Application.create_suite

    def recording_init(self, *args, **kwargs):
        real_init(self, *args, **kwargs)
        factories.append(self)

    def recording_create_suite(self, *args, **kwargs):
        suites_built_for.append(self)
        return real_create_suite(self, *args, **kwargs)

    captured = {}
    real_tear_down = case.tearDown

    def capturing_tear_down():
        # The app as the test left it, before its tearDown.
        captured["self.app"] = getattr(case, "app", None)
        real_tear_down()

    result = unittest.TestResult()
    with ExitStack() as stack:
        stack.enter_context(override_settings(DB_ENABLED=False, **HQ_TEST_ADDRESS))
        stack.enter_context(mock.patch.object(AppFactory, "__init__", recording_init))
        stack.enter_context(mock.patch.object(Application, "create_suite", recording_create_suite))
        stack.enter_context(mock.patch.object(case, "tearDown", capturing_tear_down))
        unittest.TestSuite([case]).run(result)
    problems = [*result.errors, *result.failures]
    if problems or result.skipped or result.testsRun != 1:
        detail = "\n".join(trace for _, trace in problems) or f"skipped: {result.skipped}"
        raise HarvestFailed(
            f"HQ's test {test.node_id} did not pass under the harness's HQ boot, so its app is not one HQ "
            f"accepted:\n{detail}"
        )
    if factories:
        return Harvest(test, factories[0].app, "factory0", suites_built_for, factories)
    app = captured.get("self.app")
    if app is None:
        raise HarvestFailed(f"HQ's test {test.node_id} built no app through AppFactory and has no self.app.")
    return Harvest(test, app, "self.app", suites_built_for, factories)


XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"
JR = "http://openrosa.org/javarosa"
XSD = "http://www.w3.org/2001/XMLSchema"


def _read_paths(actions):
    """The form paths a form's case configuration reads: every ``question_path`` and every ``preload`` key."""
    paths = set()

    def walk(value, key=None):
        if isinstance(value, dict):
            for child_key, child in value.items():
                if child_key == "question_path" and isinstance(child, str) and child:
                    paths.add(child)
                elif child_key == "preload" and isinstance(child, dict):
                    paths.update(path for path in child if isinstance(path, str) and path)
                walk(child, child_key)
        elif isinstance(value, list):
            for item in value:
                walk(item, key)

    walk(actions)
    return paths


def generated_source(test: HarvestTest, position: int, form, langs) -> bytes:
    """The source a harvested form is given: see the module's docstring."""
    from lxml import etree

    digest = hashlib.sha256(f"{test.node_id}#{position}".encode()).hexdigest()[:32]
    xmlns = f"http://openrosa.org/formdesigner/{digest}"
    paths = sorted({"/data/question1", *_read_paths(form.actions.to_json())})
    paths = [path for path in paths if path.startswith("/data/") and len(path) > len("/data/")]

    html = etree.Element(f"{{{XHTML}}}html", nsmap={"h": XHTML, None: XFORMS, "jr": JR, "xsd": XSD})
    head = etree.SubElement(html, f"{{{XHTML}}}head")
    etree.SubElement(head, f"{{{XHTML}}}title").text = f"form {position}"
    model = etree.SubElement(head, f"{{{XFORMS}}}model")
    instance = etree.SubElement(model, f"{{{XFORMS}}}instance")
    data = etree.SubElement(instance, f"{{{xmlns}}}data", nsmap={None: xmlns})
    data.set("uiVersion", "1")
    data.set("version", "1")
    data.set("name", f"form {position}")
    for path in paths:
        parent = data
        for segment in path.split("/")[2:]:
            child = parent.find(f"{{{xmlns}}}{segment}")
            parent = child if child is not None else etree.SubElement(parent, f"{{{xmlns}}}{segment}")
    for path in paths:
        bind = etree.SubElement(model, f"{{{XFORMS}}}bind")
        bind.set("nodeset", path)
        bind.set("type", "xsd:string")
    itext = etree.SubElement(model, f"{{{XFORMS}}}itext")
    for index, lang in enumerate(langs or ["en"]):
        translation = etree.SubElement(itext, f"{{{XFORMS}}}translation", lang=lang)
        if index == 0:
            translation.set("default", "")
        for path in paths:
            text = etree.SubElement(translation, f"{{{XFORMS}}}text", id=f"{path[len('/data/') :]}-label")
            etree.SubElement(text, f"{{{XFORMS}}}value").text = path.rsplit("/", 1)[-1]
    body = etree.SubElement(html, f"{{{XHTML}}}body")
    for path in paths:
        control = etree.SubElement(body, f"{{{XFORMS}}}input", ref=path)
        etree.SubElement(control, f"{{{XFORMS}}}label", ref=f"jr:itext('{path[len('/data/') :]}-label')")
    return etree.tostring(html, xml_declaration=True, encoding="utf-8")


def with_sources(harvest: Harvest):
    """Give every non-shadow form of the harvested app its generated source (in place)."""
    app = harvest.app
    for position, form in enumerate(app.get_forms()):
        if form.form_type == "shadow_form":
            continue
        form.source = generated_source(harvest.test, position, form, app.langs).decode("utf-8")
    return app


def source_json(app) -> dict:
    """The app as HQ's app source serves it, which HQ's import receives."""
    return app.export_json(dump_json=False)
