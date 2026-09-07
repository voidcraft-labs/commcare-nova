"""Regenerate Connect forms in native HQ and read their metadata with native Connect extractors."""
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
parser.add_argument("--connect-root", required=True, type=Path)
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


# Only the unused database/HTTP imports are supplied; the actual upstream
# app_xml module and all its XML extraction functions execute unchanged.
import importlib.util
import types
from dataclasses import asdict
connect_root = args.connect_root.resolve()
models = types.ModuleType("commcare_connect.opportunity.models")
models.CommCareApp = object
api = types.ModuleType("commcare_connect.utils.commcarehq_api")
api.CommCareHQAPIException = type("CommCareHQAPIException", (Exception,), {})
httpx = types.ModuleType("httpx")
httpx.get = deny_network
connect_file = connect_root / "commcare_connect/opportunity/app_xml.py"
spec = importlib.util.spec_from_file_location("nova_native_connect_app_xml", connect_file)
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
with patch.dict(sys.modules, {"commcare_connect.opportunity.models": models, "commcare_connect.utils.commcarehq_api": api, "httpx": httpx}):
    spec.loader.exec_module(native)

results = []
scenarios = json.loads((args.exports / "scenarios.json").read_bytes())
assert [s["name"] for s in scenarios] == ["learn-default", "learn-custom", "deliver-default", "deliver-custom", "absent"]
for scenario in scenarios:
    name = scenario["name"]
    raw = (args.exports / f"{name}.json").read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw), "nova-connect-evidence")
    form = app.get_module(0).get_form(0)
    with patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access", return_value=False), patch("corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled", return_value=False), patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled", return_value=False):
        compiled = XForm(form.source, domain="nova-connect-evidence")
        compiled.add_case_and_meta(form)
        compiled.strip_vellum_ns_attributes()
    native_xml = etree.tostring(compiled.xml)
    (args.exports / f"{name}.hq.xml").write_bytes(native_xml)
    expected = {
        "modules": [{"id": "lesson", "name": "Health & care <雪>", "description": "Read 'A' then \"B\"", "time_estimate": 5}] if name.startswith("learn") else [],
        "deliver": [{"id": "visit", "name": "Home & clinic <雪>"}] if name.startswith("deliver") else [],
        "tasks": [{"id": "task", "name": "Record & review", "description": "Ask <then> listen"}] if name.startswith("deliver") else [],
    }
    artifacts = {"hq-source": form.source.encode(), "ccz": (args.exports / f"{name}.xml").read_bytes(), "hq-regenerated": native_xml}
    for path, xml in artifacts.items():
        actual = {
            "modules": [asdict(item) for item in native.extract_connect_blocks(xml)],
            "deliver": [asdict(item) for item in native.extract_deliver_units(xml)],
            "tasks": [asdict(item) for item in native.extract_task_units(xml)],
        }
        assert actual == expected, (name, path, actual, expected)
    results.append({"name": name, "inputSha256": hashlib.sha256(raw).hexdigest(), "artifacts": {path: hashlib.sha256(xml).hexdigest() for path, xml in artifacts.items()}, "metadata": expected})
print(json.dumps({
    "hqCommit": subprocess.check_output(["git", "-C", str(hq_root), "rev-parse", "HEAD"], text=True).strip(),
    "connectCommit": subprocess.check_output(["git", "-C", str(connect_root), "rev-parse", "HEAD"], text=True).strip(),
    "connectSourceSha256": hashlib.sha256(connect_file.read_bytes()).hexdigest(),
    "forms": results,
    "limits": "Native HQ import and case/meta regeneration; native Connect metadata extraction over HQ source, CCZ and HQ-regenerated forms. Network denied; database model, disabled HTTP client and API exception imports are substituted only for Connect's unused download paths. No opportunity initialization, database writes, Connect submission processing, full HQ build or Android installation.",
}, indent=2))
