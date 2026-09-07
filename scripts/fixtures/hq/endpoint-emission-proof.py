"""Regenerate actual HQ session endpoints and claim requests from admitted Nova apps."""
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

from corehq.apps.app_manager.suite_xml.post_process.endpoints import EndpointsHelper
results=[]
for source in sorted(args.exports.glob("endpoint-*.json")):
    raw=source.read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec",return_value=BuildSpec(version="2.53.0",build_number=1)):
        app=Application.from_source(json.loads(raw),"test-domain")
    app._id="endpoint-evidence";app.version=1;app.custom_base_url="https://www.commcarehq.org"
    with ExitStack() as scope:
        for flag in ["MOBILE_UCR","CASE_LIST_OPTIMIZATIONS","USH_EMPTY_CASE_LIST_TEXT","DATA_REGISTRY","CASE_SEARCH_ENDPOINTS"]:
            scope.enter_context(patch("corehq.toggles."+flag+".enabled",return_value=False))
        for flag in ["CASE_SEARCH_ADVANCED","SESSION_ENDPOINTS"]:
            scope.enter_context(patch("corehq.toggles."+flag+".enabled",return_value=True))
        scope.enter_context(patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access",return_value=False))
        scope.enter_context(patch("corehq.apps.app_manager.suite_xml.sections.entries.case_search_sync_cases_on_form_entry_enabled_for_domain",return_value=False))
        scope.enter_context(patch("corehq.util.view_utils.get_url_base",return_value="https://www.commcarehq.org"))
        generator=SuiteGenerator(app);details=generator.add_section(DetailContributor)
        entries=EntriesContributor(generator.suite,app,generator.modules,None)
        menus=MenuContributor(generator.suite,app,generator.modules,None)
        for module in generator.modules:
            generator.suite.entries.extend(entries.get_module_contributions(module))
            generator.suite.menus.extend(menus.get_module_contributions(module,None))
        RemoteRequestsHelper(generator.suite,app,generator.modules).update_suite(details)
        EndpointsHelper(generator.suite,app,generator.modules).update_suite()
        WorkflowHelper(generator.suite,app,generator.modules).update_suite()
        InstancesHelper(generator.suite,app,generator.modules).update_suite()
        output=source.with_suffix(".hq-suite.xml");output.write_bytes(generator.suite.serializeDocument(pretty=True))
    local=etree.fromstring(source.with_suffix(".suite.xml").read_bytes());native=etree.fromstring(output.read_bytes())
    assert [shape(e) for e in local.findall("endpoint")]==[shape(e) for e in native.findall("endpoint")],(source.stem,"endpoint")
    commands={e.get("value")[1:-1] for e in local.findall("endpoint/stack/push/command")}
    def reachable_requests(root):
        return [shape(e) for e in root.findall("remote-request") if e.find("command").get("id") in commands]
    # HQ also creates an unused claim definition for inline search. Its endpoint
    # uses the case-fixture query instead, so compare only referenced requests.
    assert reachable_requests(local)==reachable_requests(native),(source.stem,"reachable remote-request")
    results.append({"scenario":source.stem,"sourceSha256":hashlib.sha256(raw).hexdigest(),"nativeSha256":hashlib.sha256(output.read_bytes()).hexdigest()})
assert len(results)==7,len(results)
print(json.dumps({"results":results,"hqCommit":subprocess.check_output(["git","-C",str(hq_root),"rev-parse","HEAD"],text=True).strip(),"limits":"Actual imported HQ model and endpoint/claim contributors; complete endpoint and reachable remote-request trees compared retaining all text/attributes/children. Supplied default build2.53/origin; disabled external feature lookups except session endpoints+advanced search enabled. No real claim HTTP request, whole HQ build or resource installation."},indent=2))
