"""Native HQ location fixtures and regenerated Nova forms, with network denied.

Only ORM reads and external configuration are supplied. The real flat serializer,
index schema producer and case/meta compiler remain unmodified.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch
from xml.etree.ElementTree import Element, tostring

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--hq-root", required=True, type=Path)
parser.add_argument("--exports", required=True, type=Path)
parser.add_argument("--python-path", type=Path)
args = parser.parse_args()
sys.path.insert(0, str(args.hq_root.resolve()))
if args.python_path:
    sys.path.append(str(args.python_path.resolve()))
def deny_network(*_args, **_kwargs):
    raise RuntimeError("Network disabled for native HQ location evidence")
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
override_settings(CACHES={name: {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": f"nova-location-{name}"} for name in settings.CACHES}).enable()
from corehq.apps.locations.fixtures import FlatLocationSerializer
from corehq.apps.locations.models import LocationType
from corehq.apps.app_manager.models import Application
from corehq.apps.app_manager.xform import XForm
from corehq.apps.builds.models import BuildSpec
from lxml import etree

class Rows(list):
    def order_by(self, field):
        assert field == "site_code"
        return sorted(self, key=lambda row: row.site_code)

def place(pk, code, parent=None):
    return SimpleNamespace(pk=pk, location_id=f"place-{pk}", location_type=LocationType(code=code), parent_id=parent.pk if parent else None, parent=parent, name=f"{code} & North", site_code=f"site-{pk}", external_id=None, latitude=None, longitude=None, supply_point_id=None, metadata={"ward": "A & B"} if code == "clinic" else {})
region=place(1,"region")
district=place(2,"district",region)
clinic=place(3,"clinic",district)
other_region=place(4,"region")
other_district=place(5,"district",other_region)
other_clinic=place(6,"clinic",other_district)
records=[]
for scenario, rows in [("complete",Rows([other_clinic,clinic,other_region,region,other_district,district])),("empty",Rows()),("missing",Rows([region,district])),("skipped",Rows([region,place(3,"clinic",region)]))]:
    with patch("corehq.apps.locations.fixtures.get_location_data_fields", return_value=[SimpleNamespace(slug="ward"),SimpleNamespace(slug="unset")]), patch("corehq.apps.locations.fixtures.LocationType.objects.filter") as types:
        types.return_value.values_list.return_value=["region","district","clinic"]
        nodes=FlatLocationSerializer().get_xml_nodes("nova-location-evidence","locations","worker",rows)
    fixture=nodes[1]
    assert fixture.attrib == {"id":"locations","user_id":"worker","indexed":"true"}
    assert [node.attrib["id"] for node in fixture.find("locations")] == [row.location_id for row in sorted(rows,key=lambda row:row.site_code)]
    if scenario=="complete":
        node=fixture.find("locations")[2]
        assert node.attrib == {"type":"clinic","id":"place-3","region_id":"place-1","district_id":"place-2","clinic_id":"place-3"}
        assert node.find("location_data/ward").text == "A & B"
        assert node.find("location_data/unset").text == ""
    if scenario=="skipped":
        assert fixture.find("locations")[1].attrib["district_id"] == ""
    restore=Element("OpenRosaResponse", {"xmlns":"http://openrosa.org/http/response"})
    for node in nodes: restore.append(node)
    raw=tostring(restore)
    (args.exports / f"location-{scenario}.restore.xml").write_bytes(raw)
    records.append({"fixture":scenario,"sha256":hashlib.sha256(raw).hexdigest()})
assert {path.stem for path in args.exports.glob("*.json")} == {"location-direct","location-multirung","location-plain"}
for scenario in ["direct","multirung","plain"]:
    path=args.exports / f"location-{scenario}.json"
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0",build_number=1)):
        app=Application.from_source(json.loads(path.read_bytes()),"nova-location-evidence")
    if scenario != "plain": assert app.location_fixture_restore == "both_fixtures"
    form=app.get_module(0).get_form(0)
    with patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access",return_value=False), patch("corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled",return_value=False), patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled",return_value=False):
        xform=XForm(form.source,domain="nova-location-evidence")
        xform.add_case_and_meta(form)
        xform.strip_vellum_ns_attributes()
        raw=etree.tostring(xform.xml)
    (args.exports / f"location-{scenario}.hq.xml").write_bytes(raw)
    records.append({"form":scenario,"inputSha256":hashlib.sha256(path.read_bytes()).hexdigest(),"nativeSha256":hashlib.sha256(raw).hexdigest()})
print(json.dumps({"hqCommit":subprocess.check_output(["git","-C",str(args.hq_root),"rev-parse","HEAD"],text=True).strip(),"sourceSha256":hashlib.sha256((args.hq_root / "corehq/apps/locations/fixtures.py").read_bytes()).hexdigest(),"records":records,"limits":"ORM rows are supplied; no HQ footprint SQL, network restore, save or remote build is claimed. Native Core consumes these exact restore and form artifacts."},indent=2))
