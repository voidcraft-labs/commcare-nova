"""``hq-owner-rules``: Nova's first publish of ``location-direct`` over an organization with two clinics.

1. The project space's organization, made with HQ's own models
   (``locations/models.py::LocationType``, ``SQLLocation``), parents first, as
   HQ's organization pages save it: the three levels ``location-direct``
   holds, ``region`` over ``district`` over ``clinic``, each sharing cases
   (``LocationType.shares_cases``), and the places ``north``, ``north_district``
   below it, and two clinics below that district, ``first_clinic`` and
   ``second_clinic``. HQ gives each place its ``location_id``
   (``SQLLocation.save``).
2. The corpus document ``location-direct``'s first publish, as the corpus
   captured it, applied to HQ through HQ's own import view
   (``proof.observe.publish.create``), as ``hq-nova-then-builder`` applies its
   document's. Its form "Transfer" gives each case it changes to the clinic
   below the district that owns it
   (``instance('locations')/locations/location[@type = 'clinic'][@district_id = <owner>]/@id``).

Below ``north_district`` stand two clinics, so the rule names no one place.
Nova's reading asks who owns those cases (``lib/deployment/reading/projectData/ownerRules.ts``)
and the base answers as a person may: the worker who fills in the form
(``owner_rule_choices``). Its first publish then gives those cases to that
worker in CommCare HQ too, the first-publish change
``owner-rule-given-to-worker``, which no reading gives alone. Its
configuration is the document's minimum configuration, which the build holds
the base's to.
"""

from __future__ import annotations

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.registry import Base

DOCUMENT = "location-direct"
CONFIGURATION = Configuration(privileges=frozenset({"LOCATIONS"}))

# Parents first: each level's name, code and parent's code, as ``location-direct`` holds them
# (``lib/commcare/locations/__tests__/locationOwnerFixture.ts::LOCATION_LEVELS``).
LEVELS = (
    {"name": "region", "code": "region", "parent": None},
    {"name": "district", "code": "district", "parent": "region"},
    {"name": "clinic", "code": "clinic", "parent": "district"},
)
# Parents first: each place's name and site code, its level, and its parent's site code.
PLACES = (
    {"site_code": "north", "level": "region", "parent": None},
    {"site_code": "north_district", "level": "district", "parent": "north"},
    {"site_code": "first_clinic", "level": "clinic", "parent": "north_district"},
    {"site_code": "second_clinic", "level": "clinic", "parent": "north_district"},
)


def make_organization(authoring):
    """The levels and the places, made with HQ's own models in the operation ``build:organization``: each level a
    ``LocationType`` that shares cases, and each place an ``SQLLocation`` saved parents first, named by its site
    code."""
    from corehq.apps.locations.models import LocationType, SQLLocation

    state = authoring.state
    digest = json.dumps([LEVELS, PLACES], sort_keys=True).encode()
    with authoring.step("build:organization", digest):
        levels = {}
        for level in LEVELS:
            levels[level["code"]] = LocationType.objects.create(
                domain=state.domain,
                name=level["name"],
                code=level["code"],
                parent_type=None if level["parent"] is None else levels[level["parent"]],
                shares_cases=True,
            )
        made = {}
        for place in PLACES:
            location = SQLLocation(
                domain=state.domain,
                name=place["site_code"],
                site_code=place["site_code"],
                location_type=levels[place["level"]],
                parent=None if place["parent"] is None else made[place["parent"]],
            )
            location.save()
            made[place["site_code"]] = location


def build(authoring) -> str:
    from proof.observe import publish

    export = authoring.documents[DOCUMENT].exports["minimum"]
    configuration = export.configuration.hq()
    if configuration != CONFIGURATION:
        raise ops.MatrixChangeRefused(
            f"{DOCUMENT}'s minimum configuration is {configuration.canonical().decode()}, and hq-owner-rules is"
            f" authored under {CONFIGURATION.canonical().decode()}. The base applies that document's first publish"
            " where Nova's publish of it applies it, so give proof/matrix/bases/owner_rules.py's CONFIGURATION the"
            " document's."
        )
    make_organization(authoring)
    with authoring.step("build:first-publish"):
        app_id, refusal, lookups = publish.create(authoring.state, export)
    if refusal is not None or (lookups is not None and lookups["errors"] != []):
        raise ops.MatrixChangeRefused(
            f"HQ refused the captured first publish of {DOCUMENT} while the lane authors hq-owner-rules:"
            f" {refusal or lookups}. The corpus's capture of that document is what Nova sends, so look at what HQ's"
            " import now asks of it."
        )
    return app_id


BASE = Base(
    id="hq-owner-rules",
    build=build,
    configuration=CONFIGURATION,
    exhibits=(
        "questions/text-input-xsd-string",
        "expressions-and-data/locations-flat-jr-fixture-locations-read-in-an-expression",
    ),
    owner_rule_choices=(("clinic", "worker"),),
)
