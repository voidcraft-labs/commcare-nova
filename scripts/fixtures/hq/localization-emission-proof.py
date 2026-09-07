"""Native HQ import, form compilation, localized suite and custom locale production.
Stock platform translation catalog is omitted; app-specific overrides and all native
contributors/serializers execute. No network, database persistence or whole build.
"""
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
parser.add_argument("--corpus", choices=["localization", "worker"], default="localization")
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

from corehq.apps.app_manager.models.applications import validate_lang
from corehq.apps.app_manager.app_strings import SelectKnownAppStrings
results=[]
for source in sorted(args.exports.glob("locale-*.json" if args.corpus == "localization" else "worker-*.json")):
    raw=source.read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec",return_value=BuildSpec(version="2.53.0",build_number=1)):
        app=Application.from_source(json.loads(raw),"nova-localization-evidence")
    app._id="localization-evidence";app.version=1;app.custom_base_url="https://www.commcarehq.org"
    for lang in app.langs:validate_lang(lang)
    with ExitStack() as scope:
        for flag in ["MOBILE_UCR","CASE_LIST_OPTIMIZATIONS","USH_EMPTY_CASE_LIST_TEXT","DATA_REGISTRY","CASE_SEARCH_ENDPOINTS","SYNC_SEARCH_CASE_CLAIM"]:
            scope.enter_context(patch("corehq.toggles."+flag+".enabled",return_value=False))
        scope.enter_context(patch("corehq.apps.app_manager.app_strings.domain_has_privilege",return_value=False))
        scope.enter_context(patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access",return_value=False))
        scope.enter_context(patch("corehq.apps.app_manager.suite_xml.sections.entries.case_search_sync_cases_on_form_entry_enabled_for_domain",return_value=False))
        scope.enter_context(patch("corehq.toggles.CASE_SEARCH_ADVANCED.enabled",return_value=True))
        scope.enter_context(patch("corehq.util.view_utils.get_url_base",return_value="https://www.commcarehq.org"))
        scope.enter_context(patch("corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled",return_value=False))
        scope.enter_context(patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled",return_value=False))
        form=app.get_module(0).get_form(0)
        xform=XForm(form.source,domain="nova-localization-evidence")
        xform.add_case_and_meta(form);xform.strip_vellum_ns_attributes()
        source.with_suffix(".hq.xml").write_bytes(etree.tostring(xform.xml))
        generator=SuiteGenerator(app);details=generator.add_section(DetailContributor)
        entries=EntriesContributor(generator.suite,app,generator.modules,None)
        menus=MenuContributor(generator.suite,app,generator.modules,None)
        for module in generator.modules:
            generator.suite.entries.extend(entries.get_module_contributions(module))
            generator.suite.menus.extend(menus.get_module_contributions(module,None))
        RemoteRequestsHelper(generator.suite,app,generator.modules).update_suite(details)
        WorkflowHelper(generator.suite,app,generator.modules).update_suite()
        InstancesHelper(generator.suite,app,generator.modules).update_suite()
        source.with_suffix(".hq-suite.xml").write_bytes(generator.suite.serializeDocument(pretty=True))
        # Actual HQ custom strings and overlay composition, with no stock UI
        # translation catalog (those strings are outside this artifact scope).
        strings=SelectKnownAppStrings(lambda *_a,**_kw:{})
        for lang in app.langs if args.corpus == "localization" else []:
            value=strings.create_app_strings(app,lang)
            (args.exports/f"{source.stem}.hq.{lang}.strings.txt").write_text(value)
    results.append({"scenario":source.stem,"languages":app.langs,"sourceSha256":hashlib.sha256(raw).hexdigest()})
assert len(results)==(6 if args.corpus == "localization" else 3),len(results)
print(json.dumps({"results":results,"hqCommit":subprocess.check_output(["git","-C",str(hq_root),"rev-parse","HEAD"],text=True).strip(),"limits":__doc__},indent=2))
