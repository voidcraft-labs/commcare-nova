"""Regenerate search suite sections with the owning native HQ contributors."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from unittest.mock import patch

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--hq-root", required=True, type=Path)
parser.add_argument("--exports", required=True, type=Path)
parser.add_argument("--python-path", type=Path, help="Optional dependency overlay for the HQ environment")
parser.add_argument("--corpus", choices=["search", "prompts", "functions", "quotes", "static-quotes"], default="search")
args = parser.parse_args()
hq_root = args.hq_root.resolve()
sys.path.insert(0, str(hq_root))
if args.python_path:
    sys.path.append(str(args.python_path.resolve()))

def deny_network(*_args, **_kwargs):
    raise RuntimeError("Network disabled for native HQ evidence")

socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
os.environ["CCHQ_TESTING"] = "1"
os.environ["DJANGO_SETTINGS_MODULE"] = "testsettings"
from manage import init_hq_python_path
init_hq_python_path()
import django
django.setup()
from django.conf import settings
from django.test import override_settings
# HQ constructs Redis-backed limiter objects at import without connecting. Swap
# caches only after setup; then Form.source uses in-process storage exclusively.
override_settings(CACHES={name: {
    "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
    "LOCATION": f"nova-case-evidence-{name}",
} for name in settings.CACHES}).enable()
from corehq.apps.app_manager.models import Application
from corehq.apps.app_manager.xform import XForm
from corehq.apps.builds.models import BuildSpec
from lxml import etree

from contextlib import ExitStack
from corehq.apps.app_manager.suite_xml.generator import SuiteGenerator
from corehq.apps.app_manager.suite_xml.sections.details import DetailContributor
from corehq.apps.app_manager.suite_xml.sections.entries import EntriesContributor
from corehq.apps.app_manager.suite_xml.sections.menus import MenuContributor
from corehq.apps.app_manager.suite_xml.post_process.remote_requests import RemoteRequestsHelper
from corehq.apps.app_manager.suite_xml.post_process.workflow import WorkflowHelper
from corehq.apps.app_manager.suite_xml.post_process.instances import InstancesHelper

def shape(element):
    # Attribute order and inter-element indentation have no XML meaning.
    # Leaf text, all attributes and the complete element sequence survive.
    return (element.tag, dict(element.attrib),
            (element.text or "") if len(element) == 0 else (element.text or "").strip(),
            [shape(child) for child in element])

def compare_entries(local, native, scenario):
    differences = []
    if scenario == "automatic":
        extra = native.findall("entry/session/query/data[@key='_xpath_query']")
        assert len(extra) == 1 and dict(extra[0].attrib) == {"key": "_xpath_query", "ref": "'match-all()'"}
        assert not local.findall("entry/session/query/data[@key='_xpath_query']")
        extra[0].getparent().remove(extra[0])
        differences.append("HQ adds an explicit match-all query to unprompted unfiltered Search")
    if scenario == "remote-multiple":
        extra = local.findall("entry/instance[@id='selected_cases']")
        assert len(extra) == 1 and dict(extra[0].attrib) == {"id": "selected_cases", "src": "jr://instance/selected-entities/selected_cases"}
        assert not native.findall("entry/instance[@id='selected_cases']")
        extra[0].getparent().remove(extra[0])
        differences.append("Nova declares the ordinary collection instance even without a suite expression reading it")
    for tag in ["entry", "remote-request"]:
        assert [shape(e) for e in local.findall(tag)] == [shape(e) for e in native.findall(tag)], (scenario, tag)
    return differences

expected = {"inline", "browse", "multiple", "parent", "registration-link", "hidden-link", "automatic", "hidden", "advanced", "remote", "remote-multiple", "remote-defaults"}
if args.corpus == "prompts":
    expected = {"prompt-widgets", "prompt-guards", "prompt-dataflow"}
if args.corpus == "functions":
    expected = {"nested-lookup", "function-arguments"}
if args.corpus == "quotes":
    expected = {"runtime-quotes"}
if args.corpus == "static-quotes":
    expected = {"static-quotes"}
sources = sorted(args.exports.glob("*.json"))
assert {source.stem for source in sources} == expected
results = []
for source in sources:
    raw = source.read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw), "nova-search-evidence")
    app._id = "search-evidence"
    app.version = 1
    app.custom_base_url = "https://www.commcarehq.org"
    with ExitStack() as scope:
        for flag in ["MOBILE_UCR", "CASE_LIST_OPTIMIZATIONS", "USH_EMPTY_CASE_LIST_TEXT", "DATA_REGISTRY", "CASE_SEARCH_ENDPOINTS"]:
            scope.enter_context(patch("corehq.toggles." + flag + ".enabled", return_value=False))
        scope.enter_context(patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access", return_value=False))
        scope.enter_context(patch("corehq.apps.app_manager.suite_xml.sections.entries.case_search_sync_cases_on_form_entry_enabled_for_domain", return_value=False))
        scope.enter_context(patch("corehq.toggles.CASE_SEARCH_ADVANCED.enabled", return_value=True))
        scope.enter_context(patch("corehq.util.view_utils.get_url_base", return_value="https://www.commcarehq.org"))
        generator = SuiteGenerator(app)
        details = generator.add_section(DetailContributor)
        entries = EntriesContributor(generator.suite, app, generator.modules, None)
        menus = MenuContributor(generator.suite, app, generator.modules, None)
        for module in generator.modules:
            generator.suite.entries.extend(entries.get_module_contributions(module))
            generator.suite.menus.extend(menus.get_module_contributions(module, None))
        RemoteRequestsHelper(generator.suite, app, generator.modules).update_suite(details)
        WorkflowHelper(generator.suite, app, generator.modules).update_suite()
        InstancesHelper(generator.suite, app, generator.modules).update_suite()
        output = args.exports / f"{source.stem}.hq-suite.xml"
        output.write_bytes(generator.suite.serializeDocument(pretty=True))
    local_path = args.exports / f"{source.stem}.suite.xml"
    differences = compare_entries(etree.fromstring(local_path.read_bytes()), etree.fromstring(output.read_bytes()), source.stem)
    results.append({"scenario": source.stem, "sourceSha256": hashlib.sha256(raw).hexdigest(), "suiteSha256": hashlib.sha256(local_path.read_bytes()).hexdigest(), "nativeSuiteSha256": hashlib.sha256(output.read_bytes()).hexdigest(), "differences": differences})
print(json.dumps({"hqCommit": subprocess.check_output(["git", "-C", str(hq_root), "rev-parse", "HEAD"], text=True).strip(), "scenarios": results, "limits": "Native HQ Application import and detail/entry/menu contributors, remote request/workflow/instance post-processing. Complete entry and remote-request trees compared, retaining leaf text and child order; only explicitly recorded structural differences. Build version and URL origin are supplied; no resource install, full HQ build or network. Domain-only UCR, optimization, empty-list text, registry, endpoint and sync-on-form-entry flags disabled; advanced Search enabled for defaults."}, indent=2))
