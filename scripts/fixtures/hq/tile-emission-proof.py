"""Regenerate tile details with native HQ and compare their consumer contract."""
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
from corehq.apps.builds.models import BuildSpec
from lxml import etree

from corehq.apps.app_manager.suite_xml.sections.details import DetailContributor
from corehq.apps.app_manager.suite_xml.xml_models import Suite

def detail_contract(root):
    result = {}
    for detail in root.findall("detail"):
        fields = []
        for field in detail.findall("field"):
            style = field.find("style")
            style_contract = None
            if style is not None:
                style_contract = {
                    "grid": dict(style.find("grid").attrib),
                    "horizontal": style.get("horz-align"),
                    "vertical": style.get("vert-align"),
                    "font": style.get("font-size"),
                    "border": style.get("show-border") == "true",
                    "shading": style.get("show-shading") == "true",
                }
            sort = field.find("sort")
            fields.append({
                "style": style_contract,
                "headerWidth": field.find("header").get("width"),
                "templateWidth": field.find("template").get("width"),
                "value": field.find("template/text/xpath").get("function"),
                "sort": None if sort is None else {
                    "type": sort.get("type"), "order": sort.get("order"),
                    "direction": sort.get("direction"),
                    "value": sort.find("text/xpath").get("function"),
                },
            })
        group = detail.find("group")
        assert detail.attrib["id"] not in result, "Duplicate detail identity"
        result[detail.attrib["id"]] = {
            "fields": fields,
            "group": None if group is None else dict(group.attrib),
            "actions": len(detail.findall("action")),
        }
    return result

expected = {"plain", "tile", "boxed", "persistent", "grouped-one", "grouped-two", "grouped-search", "grouped-browse"}
sources = sorted(args.exports.glob("*.json"))
assert {source.stem for source in sources} == expected, "Missing or unexpected tile scenarios"
results = []
for source in sources:
    raw = source.read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw), "nova-tile-evidence")
    # These external domain flags govern unrelated features. Fail closed on any
    # other network dependency; the tile/detail contributors run unmodified.
    with (
        patch("corehq.apps.app_manager.suite_xml.sections.details.toggles.MOBILE_UCR.enabled", return_value=False),
        patch("corehq.apps.app_manager.feature_support.toggles.CASE_LIST_OPTIMIZATIONS.enabled", return_value=False),
        patch("corehq.apps.app_manager.feature_support.toggles.USH_EMPTY_CASE_LIST_TEXT.enabled", return_value=False),
        patch("corehq.apps.app_manager.feature_support.toggles.DATA_REGISTRY.enabled", return_value=False),
    ):
        details = DetailContributor(Suite(), app, list(app.get_modules())).get_section_elements()
    root = etree.Element("suite", version="1")
    for detail in details:
        root.append(etree.fromstring(detail.serialize()))
    output = args.exports / f"{source.stem}.hq-details.xml"
    output.write_bytes(etree.tostring(root))
    local_path = args.exports / f"{source.stem}.suite.xml"
    local = etree.fromstring(local_path.read_bytes())
    native_contract = detail_contract(root)
    assert detail_contract(local) == native_contract, source.stem
    results.append({
        "scenario": source.stem, "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "suiteSha256": hashlib.sha256(local_path.read_bytes()).hexdigest(),
        "nativeDetailsSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "details": native_contract,
    })
print(json.dumps({
    "hqCommit": subprocess.check_output(["git", "-C", str(hq_root), "rev-parse", "HEAD"], text=True).strip(),
    "scenarios": results,
    "limits": "Native Application.from_source and DetailContributor regeneration compared with actual CCZ details, including grid/style values, hidden sorting, grouping values and actions. False/absent border flags are equivalent. This is not a full HQ build or Android/Web Apps rendering. Domain-only UCR, optimization, empty-list text and registry flags are disabled; network access is refused.",
}, indent=2))
