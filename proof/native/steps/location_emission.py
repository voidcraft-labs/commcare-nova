"""HQ's flat location fixture and its regeneration of Nova's owner forms (``location`` family).

For each fixture scenario the check's project space holds real places: the
location types region, district and clinic, the location data fields
``ward`` and ``unset``, and the scenario's places, saved through HQ's own
models. HQ's ``FlatLocationSerializer.get_xml_nodes`` serializes them for the
worker ``worker`` (fixture id ``locations``), and the step wraps its nodes in
an ``OpenRosaResponse`` as ``location-<scenario>.restore.xml``, which
``LocationOwnerRuntimeTest`` parses into Core's fixture storage. The
``skipped`` scenario's clinic hangs directly under its region, so each
scenario has a project space of its own. HQ then regenerates the three owner
forms (``location-<scenario>.hq.xml``).
"""

from xml.etree.ElementTree import Element, tostring

from proof.native.hq_support import import_source, native_check, regenerate_form, sha256

DOMAIN = "nova-location-evidence"
LOCATION_TYPES = [("region", None), ("district", "region"), ("clinic", "district")]
DATA_FIELDS = ["ward", "unset"]
# Place number -> (location type, parent place number).
_REGION, _DISTRICT, _CLINIC = "region", "district", "clinic"
FIXTURES = {
    "complete": {
        6: (_CLINIC, 5),
        3: (_CLINIC, 2),
        4: (_REGION, None),
        1: (_REGION, None),
        5: (_DISTRICT, 4),
        2: (_DISTRICT, 1),
    },
    "empty": {},
    "missing": {1: (_REGION, None), 2: (_DISTRICT, 1)},
    "skipped": {1: (_REGION, None), 3: (_CLINIC, 1)},
}
FORM_SCENARIOS = ["direct", "multirung", "plain"]


def place_id(number):
    return f"place-{number}"


def site_code(number):
    return f"site-{number}"


def _seed(places):
    from corehq.apps.custom_data_fields.models import CustomDataFieldsDefinition, Field
    from corehq.apps.locations.models import LocationType, SQLLocation
    from corehq.apps.locations.views import LocationFieldsView

    types = {}
    for code, parent in LOCATION_TYPES:
        types[code] = LocationType.objects.create(domain=DOMAIN, name=code, code=code, parent_type=types.get(parent))
    definition = CustomDataFieldsDefinition.get_or_create(DOMAIN, LocationFieldsView.field_type)
    definition.set_fields([Field(slug=slug, label=slug) for slug in DATA_FIELDS])
    saved = {}

    def save(number):
        if number in saved:
            return saved[number]
        code, parent = places[number]
        saved[number] = SQLLocation.objects.create(
            domain=DOMAIN,
            name=f"{code} & North",
            site_code=site_code(number),
            location_id=place_id(number),
            location_type=types[code],
            parent=save(parent) if parent is not None else None,
            metadata={"ward": "A & B"} if code == _CLINIC else {},
        )
        return saved[number]

    for number in places:
        save(number)
    return SQLLocation.objects.filter(domain=DOMAIN)


def _fixture(session, exports, scenario, places):
    from corehq.apps.locations.fixtures import FlatLocationSerializer

    with native_check(DOMAIN):
        nodes = FlatLocationSerializer().get_xml_nodes(DOMAIN, "locations", "worker", _seed(places))
    fixture = nodes[1]
    restore = Element("OpenRosaResponse", {"xmlns": "http://openrosa.org/http/response"})
    for node in nodes:
        restore.append(node)
    raw = tostring(restore)
    (exports / f"location-{scenario}.restore.xml").write_bytes(raw)
    return {
        "fixture": scenario,
        "sha256": sha256(raw),
        "attrib": dict(fixture.attrib),
        "locations": [
            {
                "attrib": dict(location.attrib),
                "data": {child.tag: child.text for child in location.find("location_data")},
            }
            for location in fixture.find("locations")
        ],
    }


def locations(session):
    exports = session.family("location")
    fixtures = [_fixture(session, exports, scenario, places) for scenario, places in FIXTURES.items()]
    forms = []
    with native_check(DOMAIN):
        for scenario in FORM_SCENARIOS:
            path = exports / f"location-{scenario}.json"
            raw = path.read_bytes()
            app = import_source(raw, DOMAIN)
            native = regenerate_form(app.get_module(0).get_form(0), DOMAIN)
            (exports / f"location-{scenario}.hq.xml").write_bytes(native)
            forms.append(
                {
                    "form": scenario,
                    "locationFixtureRestore": app.location_fixture_restore,
                    "inputSha256": sha256(raw),
                    "nativeSha256": sha256(native),
                }
            )
    return {"sources": sorted(path.stem for path in exports.glob("*.json")), "fixtures": fixtures, "forms": forms}
