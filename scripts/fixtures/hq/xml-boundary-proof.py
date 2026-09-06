"""Check XML syntax and accepted text through the owning native HQ parser."""
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
parser.add_argument("--corpus", required=True, type=Path)
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


corpus_bytes = args.corpus.read_bytes()
results = []
for case in json.loads(corpus_bytes):
    if case.get("policyOnly"):
        continue  # Nova intentionally accepts neither DTDs nor XML 1.1 resources.
    error_name = None
    try:
        etree.fromstring(case["xml"].encode("utf-8"), parser=etree.XMLParser(recover=False, resolve_entities=False, no_network=True))
        accepted = True
    except (etree.XMLSyntaxError, UnicodeEncodeError) as error:
        accepted = False
        error_name = type(error).__name__
    assert accepted == case["accepted"], case["name"]
    results.append({"name": case["name"], "accepted": accepted, "error": error_name})

forms = []
ns = {"x": "http://www.w3.org/2002/xforms"}
for scenario in json.loads((args.exports / "scenarios.json").read_bytes()):
    raw_bytes = (args.exports / f'{scenario["name"]}.json').read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw_bytes), "nova-xml-evidence")
    form = app.get_module(0).get_form(0)
    error_name = None
    try:
        tree = XForm(form.source, domain="nova-xml-evidence").xml
        accepted = True
    except Exception as error:
        accepted = False
        error_name = type(error).__name__
    assert accepted == scenario["accepted"], scenario["name"]
    if accepted:
        with patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access", return_value=False), patch("corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled", return_value=False), patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled", return_value=False):
            compiled = XForm(form.source, domain="nova-xml-evidence")
            compiled.add_case_and_meta(form)
            compiled.strip_vellum_ns_attributes()
        (args.exports / f'{scenario["name"]}.hq.xml').write_bytes(etree.tostring(compiled.xml))
        local = etree.fromstring((args.exports / f'{scenario["name"]}.xml').read_bytes())
        profile = etree.fromstring((args.exports / f'{scenario["name"]}.ccpr').read_bytes())
        for artifact in [tree, local]:
            labels = artifact.xpath('//x:itext/x:translation/x:text[@id="answer-label"]/x:value[not(@form)]/text()', namespaces=ns)
            assert labels == [scenario["text"]], labels
            # Character references preserve XML attribute whitespace; literal
            # whitespace would instead be normalized by the native parser.
            starting = artifact.xpath('//x:model/x:setvalue[@ref="/data/answer"]/@value', namespaces=ns)
            assert starting == ["'A\tB\nC\rD'"], starting
        assert profile.attrib["name"] == "Café 雪 😀"
    forms.append({"name": scenario["name"], "accepted": accepted, "error": error_name, "inputSha256": hashlib.sha256(raw_bytes).hexdigest()})
print(json.dumps({
    "hqCommit": subprocess.check_output(["git", "-C", str(hq_root), "rev-parse", "HEAD"], text=True).strip(),
    "lxmlVersion": etree.LXML_VERSION,
    "libxmlVersion": etree.LIBXML_VERSION,
    "corpusSha256": hashlib.sha256(corpus_bytes).hexdigest(),
    "xmlCases": results,
    "nativeHqForms": forms,
    "limits": "Read-only native HQ Application.from_source and XForm.xml, native libxml well-formedness, and decoded text from actual CCZ artifacts. No DB writes, remote calls, HQ build or Android installation. DTD and XML 1.1 refusal is Nova policy, excluded from native malformedness claims.",
}, indent=2))
