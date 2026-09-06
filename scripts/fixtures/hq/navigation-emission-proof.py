"""Regenerate navigation fixture forms with the owning native HQ compiler."""
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

from corehq.apps.app_manager.suite_xml.sections.entries import EntriesHelper

results = []
expected = {"base", "conditions", "owner", "links", "search-legacy", "search-date-add", "search-datetime-add", "search-day-range"}
sources = sorted(args.exports.glob("*.json"))
assert {source.stem for source in sources} == expected
for source in sources:
    raw = source.read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw), "nova-navigation-evidence")
    for index, form in enumerate(app.get_module(0).get_forms()):
        with patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access", return_value=False), patch("corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled", return_value=False), patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled", return_value=False), patch("corehq.apps.app_manager.feature_support.toggles.DATA_REGISTRY.enabled", return_value=False):
            xform = XForm(form.source, domain="nova-navigation-evidence")
            xform.add_case_and_meta(form)
            xform.strip_vellum_ns_attributes()
        output = args.exports / f"{source.stem}.{index}.hq.xml"
        output.write_bytes(etree.tostring(xform.xml))
        datums = EntriesHelper.get_new_case_id_datums_meta(form)
        if source.stem == "base" and index == 1:
            assert [(d.datum.id, d.datum.function) for d in datums] == [("case_id_new_patient_0", "uuid()")]
        results.append({"scenario": source.stem, "form": index, "inputSha256": hashlib.sha256(raw).hexdigest(), "nativeFormSha256": hashlib.sha256(output.read_bytes()).hexdigest()})
print(json.dumps({"hqCommit": subprocess.check_output(["git", "-C", str(hq_root), "rev-parse", "HEAD"], text=True).strip(), "forms": results, "limits": "Native HQ source import, XForm case/meta regeneration and registration datum allocation. No full HQ build, DB or remote calls; only domain config boundaries replaced."}, indent=2))
