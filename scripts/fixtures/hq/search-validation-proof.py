"""Exercise selected HQ search build refusals on actual imported Nova apps."""
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

from corehq.apps.app_manager.const import WORKFLOW_PREVIOUS, WORKFLOW_MODULE
from corehq.apps.app_manager.helpers.validators import FormBaseValidator, ModuleBaseValidator

def load(scenario):
    raw = (args.exports / (scenario + ".json")).read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw), "nova-search-validation")
    app._id = "native-search-validation"
    return app

def codes(errors):
    return [error["type"] for error in errors]

results=[]
app=load("inline")
module=app.get_module(0)
form=module.get_form(0)
assert codes(FormBaseValidator(form).validate_for_module(module)) == []
form.post_form_workflow=WORKFLOW_PREVIOUS
assert codes(FormBaseValidator(form).validate_for_module(module)) == ["workflow previous inline search"]
module.search_config.inline_search=False
assert codes(FormBaseValidator(form).validate_for_module(module)) == []
results.append("previous workflow rejected only with inline case loading")

app=load("registration-link")
parent=app.get_module(0)
child=app.get_module(1)
assert codes(ModuleBaseValidator(child).validate_search_config()) == []
child.root_module_id=parent.unique_id
assert codes(ModuleBaseValidator(child).validate_search_config()) == ["non-unique instance name with parent module"]
parent.search_config.inline_search=False
assert codes(ModuleBaseValidator(child).validate_search_config()) == []
results.append("submenu under inline Search duplicates actual native result-instance names")

app=load("parent")
child=app.get_module(0)
parent=app.get_module(1)
assert codes(ModuleBaseValidator(child).validate_parent_select()) == []
parent.search_config.inline_search=True
parent.search_config.auto_launch=True
parent.search_config.properties=child.search_config.properties
assert codes(ModuleBaseValidator(child).validate_parent_select()) == ["non-unique instance name with parent select module"]
results.append("parent selection from inline Search duplicates actual native result-instance names")

app=load("registration-link")
host=app.get_module(0)
registration=app.get_module(1).get_form(0)
with patch("corehq.toggles.FOLLOWUP_FORMS_AS_CASE_LIST_FORM.enabled", return_value=False):
    host.case_list_form.form_id=registration.unique_id
    assert codes(ModuleBaseValidator(host).validate_case_list_form()) == []
    host.case_list_form.form_id=host.get_form(0).unique_id
    assert codes(ModuleBaseValidator(host).validate_case_list_form()) == ["case list form not registration"]
    host.case_list_form.form_id="missing-native-form"
    assert codes(ModuleBaseValidator(host).validate_case_list_form()) == ["case list form missing"]
results.append("case-list form must resolve to a registration of the host case type with default capability")

sources=[hq_root / "corehq/apps/app_manager/helpers/validators.py", hq_root / "corehq/apps/app_manager/views/modules.py", hq_root / "corehq/apps/app_manager/util.py", hq_root / "corehq/apps/app_manager/models/case_search.py", Path(__file__)]
print(json.dumps({"checks":results,"sourceSha256":{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},"artifacts":{name:hashlib.sha256((args.exports/(name+".json")).read_bytes()).hexdigest() for name in ["inline","parent","registration-link"]},"limits":"Actual HQ Application import and selected validator methods. Native models mutated for paired wire counterexamples; no whole-build acceptance claim. Default build supplied and FOLLOWUP_FORMS_AS_CASE_LIST_FORM disabled; no network or writes."},indent=2))
