"""Native HQ wrap behavior for the private consistency-oracle probe corpus.
Enum and dispatch refusals are separated from later build/runtime conventions.
This does not save an app, regenerate suites, or claim general HQ validation.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import traceback
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
from corehq.apps.app_manager.util import get_correct_app_class
from corehq.apps.builds.models import BuildSpec

records=json.loads((args.exports / "hq-oracle-probes.json").read_text())
assert len(records)>=40
fatal_codes={
    "HQJSON_BAD_MODULE_DOC_TYPE",
    "HQJSON_BAD_FORM_REQUIRES", "HQJSON_BAD_POST_FORM_WORKFLOW",
    "HQJSON_BAD_CONDITION_TYPE", "HQJSON_BAD_CONDITION_OPERATOR",
    "HQJSON_BAD_UPDATE_MODE", "HQJSON_BAD_SUBCASE_RELATIONSHIP",
    "HQJSON_BAD_DETAIL_DISPLAY",
}
results=[]
for record in records:
    expected=bool(fatal_codes.intersection(record["codes"]))
    if "HQJSON_BAD_CASE_LIST_FORM" in record["codes"]:
        expected=any(m["case_list_form"].get("post_form_workflow") not in {None,"default","case_list"} for m in record["app"]["modules"])
    # Top-level dispatch is a separate native boundary. RemoteApp is known to
    # HQ even though Nova's generator convention requires Application.
    if "HQJSON_BAD_DOC_TYPE" in record["codes"]:
        dispatched=get_correct_app_class(record["app"]).__name__
        assert dispatched=="RemoteApp",dispatched
        results.append({"test":record["test"],"codes":record["codes"],"nativeApplicationDispatch":dispatched})
        continue
    failure=None
    try:
        # Partial probes omit installation-owned default build configuration.
        # Native model wrapping and choice checks remain unmodified.
        with patch("corehq.apps.app_manager.models.applications.get_default_build_spec",
                   return_value=BuildSpec(version="2.60.0", build_number=1)):
            app=Application.wrap(record["app"])
        app.to_json()
        for module in app.get_modules():
            module.to_json()
            for form in module.get_forms():
                form.to_json()
                actions=form.actions
                for name in ["open_case","update_case","close_case","case_preload","usercase_preload","usercase_update","load_from_form"]:
                    condition=getattr(actions,name).condition
                    _=condition.type,condition.operator
                for update in actions.update_case.update.values(): _=update.update_mode
                for subcase in actions.subcases:
                    _=subcase.relationship,subcase.name_update.update_mode,subcase.condition.type,subcase.close_condition.type
                    for update in subcase.case_properties.values(): _=update.update_mode
            _=module.case_details.short.display,module.case_details.long.display
    except Exception as error:
        failure=type(error).__name__+": "+str(error)
        if not expected: traceback.print_exc()
    assert bool(failure)==expected, (record["test"],record["codes"],expected,failure)
    results.append({"test":record["test"],"codes":record["codes"],"nativeWrapFailure":failure})
print(json.dumps({"nativeHqSha":subprocess.check_output(["git","-C",str(hq_root),"rev-parse","HEAD"],text=True).strip(),"results":results},indent=2))
