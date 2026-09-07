"""Read actual Nova exports through native HQ models and case-form compilation.

Only external configuration boundaries are replaced. No DB, remote HQ, Android
build, or form submission runs. Every socket connection is refused.
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
results=[]
for source in sorted(args.exports.glob('container-*.json')):
    with patch('corehq.apps.app_manager.models.applications.get_default_build_spec', return_value=BuildSpec(version='2.53.0',build_number=1)):
        app=Application.from_source(json.loads(source.read_bytes()),'nova-container-evidence')
    form=app.get_module(0).get_form(0)
    with patch('corehq.apps.app_manager.models.applications.domain_has_usercase_access',return_value=False), patch('corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled',return_value=False), patch('corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled',return_value=False):
        xform=XForm(form.source,domain='nova-container-evidence')
        xform.add_case_and_meta(form)
        xform.strip_vellum_ns_attributes()
        native=etree.tostring(xform.xml)
    output=source.with_suffix('.hq.xml');output.write_bytes(native)
    results.append({'scenario':source.stem,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'hqXmlSha256':hashlib.sha256(native).hexdigest()})
assert len(results)==16,len(results)
print(json.dumps({'results':results,'hqCommit':subprocess.check_output(['git','-C',str(hq_root),'rev-parse','HEAD'],text=True).strip(),'limits':'Actual native Application.from_source and XForm.add_case_and_meta and native editor-attribute stripping; no whole-app build, native client layout, network or database persistence.'},indent=2))
