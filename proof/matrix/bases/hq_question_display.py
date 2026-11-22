"""Question display on a real visit. The form builder saves the authored source.

Some pairs have deliberately different results in the two workers. The choice
value, civil day, file name and received value remain observable in the form.
The geocoder needs both of HQ's own gates (cloudcare/views.py::has_geocoder_privs).
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.hq_questions import _child, _question, _with_vellum_prefix
from proof.matrix.registry import Base, Declaration

CHOICES = {"north": "North valley", "upper": "Upper valley", "south": "South ridge"}


def source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder
    from lxml import etree

    form = XFormBuilder(name)
    _question(
        form,
        "visit_code",
        "Visit code",
        tag="secret",
        bind_type="xsd:string",
        appearance="numeric",
    )
    _question(
        form, "arrival", "Arrival day", bind_type="xsd:date", appearance="ethiopian"
    )
    _question(
        form,
        "follow_up",
        "Follow-up day",
        bind_type="xsd:date",
        appearance="ethiopian 2-per-row",
    )
    _question(
        form, "return_day", "Return day", bind_type="xsd:date", appearance="nepali"
    )
    _question(
        form, "start_time", "Start time", bind_type="xsd:time", appearance="12-hour"
    )
    for question, label, appearance in [
        ("place", "Choose the place", "minimal hint-as-placeholder"),
        ("route", "Search for a route", "fuzzy combobox"),
        ("weather", "Choose the weather", "quick compact-2"),
    ]:
        form.new_question(
            question, label, "select1", choices=CHOICES, hint="Pick a place"
        )
        _child(form._body, "select1", ref=f"/data/{question}").set(
            "appearance", appearance
        )
    for question, label, appearance in [
        ("plain_place", "Place list", "minimal"),
        ("ranked_route", "Rank route spellings", "combobox fuzzy"),
        ("auto_weather", "Choose automatically sized weather", "compact-2 quick"),
    ]:
        form.new_question(question, label, "select1", choices=CHOICES)
        _child(form._body, "select1", ref=f"/data/{question}").set(
            "appearance", appearance
        )
    _question(
        form,
        "agreement",
        "Signature",
        tag="upload",
        bind_type="binary",
        mediatype="image/*",
        appearance="signature",
    )
    _question(
        form,
        "web_agreement",
        "Signature or photo",
        tag="upload",
        bind_type="binary",
        mediatype="image/*",
        appearance="signature 2-per-row",
    )
    _question(
        form,
        "address",
        "Meeting point",
        bind_type="xsd:string",
        appearance="address broadcast-stop",
    )
    _question(
        form, "city", "City", bind_type="xsd:string", appearance="receive-stop-city"
    )
    _question(
        form,
        "photo",
        "Visit photo",
        tag="upload",
        bind_type="binary",
        mediatype="image/*",
        appearance="acquire broadcast-image",
    )
    _question(
        form,
        "filename",
        "Photo name",
        bind_type="xsd:string",
        appearance="receive-image-filename",
    )
    _question(form, "code", "Scan the tag", bind_type="barcode", appearance="editable")
    form.new_group("review", "Visit review")
    _child(form._body, "group", ref="/data/review").set(
        "appearance", "group-collapse collapse-open group-border"
    )
    for question, label in [("village", "Village"), ("ward", "Ward")]:
        _question(
            form,
            question,
            label,
            bind_type="xsd:string",
            appearance="2-per-row",
            parent="review",
        )
    _question(form, "saved", "Ready", tag="trigger", appearance="floating-good")
    total = form.new_question("stop_count", "How many stops?", "int")
    stops = form.new_group("stops", "Visit stops")
    repeated = stops.new_group(
        "places", "Stop", data_type="repeatGroup", repeat_count=total
    )
    repeated.new_question("landmark", "Landmark")
    _child(form._body, "group", ref="/data/stops").set("appearance", "2-per-row-repeat")
    form.new_group("directions", "Directions")
    form.new_question("entrance", "Entrance", group="directions")
    _child(form._body, "group", ref="/data/directions").set(
        "appearance", "2-per-row-repeat"
    )
    return etree.tostring(
        _with_vellum_prefix(form), encoding="utf-8", xml_declaration=True
    ).decode("utf-8")


# The second menu gives each independently read setting a control of its own.
# Every row names the inventory class witnessed at that control after Vellum saves it.
PALETTE = (
    ("secret-address", "private_location", "secret", "address"),
    ("secret-receive-topic-field", "private_postcode", "secret", "receive-stop-postcode"),
    (
        "a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of",
        "house_suffix",
        "text",
        "Numbers",
    ),
    (
        "a-label-whose-appearance-string-starts-with-floating-other-than",
        "mobile_note",
        "label",
        "floating-note",
    ),
    (
        "a-multi-token-string-holding-tokens-no-runtime-reads-on-that",
        "display_place",
        "select1",
        "minimal hint-as-placeholder foo",
    ),
    (
        "a-single-string-no-row-names-that-holds-values-android-matches",
        "display_season",
        "select1",
        "compact2",
    ),
    (
        "any-other-per-row-token-the-first-token-web-apps-per-row-pattern",
        "tray_size",
        "text",
        "1x2-per-row",
    ),
    ("audio-acquire-or-upload", "spoken_note", "audio", "acquire-or-upload"),
    ("audio-legacy", "earlier_recording", "audio", "legacy"),
    ("audio-long", "interview", "audio", "long"),
    (
        "barcode-numeric-address-or-receive-topic-field",
        "parcel_number",
        "barcode",
        "numeric",
    ),
    ("barcode-quick", "quick_scan", "barcode", "quick"),
    ("date-gregorian-gregorian-cancel", "planned_date", "date", "gregorian"),
    ("geopoint-maps", "map_point", "geopoint", "maps"),
    ("group-compact", "quick_summary", "group", "compact"),
    ("group-group-border", "final_details", "group", "group-border"),
    ("group-group-collapse", "optional_details", "group", "group-collapse"),
    (
        "hint-as-placeholder-on-any-other-entry",
        "arrival_date",
        "date",
        "hint-as-placeholder",
    ),
    (
        "hint-as-placeholder-on-text-other-than-a-secret-without-numeric",
        "arrival_gate",
        "text",
        "hint-as-placeholder",
    ),
    ("image-acquire", "door_photo", "image", "acquire"),
    ("image-overlay-small", "sign_photo", "image", "overlay-small"),
    ("medium", "neighbourhood", "text", "medium"),
    ("select-compact-compact-n", "packed_items", "select", "compact"),
    ("select-label", "supply_headings", "select", "label"),
    ("select-list", "comfort_items", "select", "list"),
    ("select-list-nolabel", "health_items", "select", "list-nolabel"),
    ("select-minimal", "supplies", "select", "minimal"),
    ("select1-button-select", "travel_stage", "select1", "button-select"),
    ("select1-combobox", "district", "select1", "combobox"),
    ("select1-combobox-fuzzy", "market", "select1", "combobox fuzzy"),
    ("select1-combobox-multiword", "route_name", "select1", "combobox multiword"),
    ("select1-compact-compact-n", "visit_rating", "select1", "compact-2"),
    ("select1-label", "stop_headings", "select1", "label"),
    ("select1-list", "travel_mode", "select1", "list"),
    ("select1-list-nolabel", "road_surface", "select1", "list-nolabel"),
    ("select1-minimal", "door_colour", "select1", "minimal"),
    ("select1-quick", "arrival_status", "select1", "quick"),
    (
        "select1-receive-topic-field",
        "received_district",
        "select1",
        "receive-household-colour",
    ),
    ("short", "zone_code", "text", "short"),
    ("text-address", "followup_location", "text", "address"),
    (
        "text-align-center-text-align-right",
        "collection_site",
        "text",
        "text-align-center",
    ),
    ("text-secret-numbers", "house_number", "text", "numbers"),
    ("trigger-selectable", "copyable_note", "label", "selectable"),
    ("video-acquire", "access_video", "video", "acquire"),
)


def palette_source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder
    from lxml import etree

    form = XFormBuilder(name)
    uploads = {"image": "image/*", "video": "video/*", "audio": "audio/*"}
    for _, qid, kind, style in PALETTE:
        label = qid.replace("_", " ").capitalize()
        if kind in ("select1", "select"):
            form.new_question(qid, label, kind, choices=CHOICES, hint="Choose a place")
            _child(form._body, kind, ref=f"/data/{qid}").set("appearance", style)
        elif kind == "group":
            group = form.new_group(qid, label)
            group.new_question("remark", "Remark")
            _child(form._body, "group", ref=f"/data/{qid}").set("appearance", style)
        elif kind in uploads:
            _question(
                form,
                qid,
                label,
                tag="upload",
                bind_type="binary",
                mediatype=uploads[kind],
                appearance=style,
            )
        elif kind == "secret":
            _question(form, qid, label, tag="secret", bind_type="xsd:string", appearance=style)
        elif kind == "label":
            _question(form, qid, label, tag="trigger", appearance=style)
        else:
            wire_type = {
                "date": "xsd:date",
                "geopoint": "geopoint",
                "text": "xsd:string",
                "barcode": "barcode",
            }[kind]
            _question(
                form,
                qid,
                label,
                bind_type=wire_type,
                hint="Visit information",
                appearance=style,
            )
    return etree.tostring(
        _with_vellum_prefix(form), encoding="utf-8", xml_declaration=True
    ).decode("utf-8")


def build(authoring):
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Visit display")
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.new_survey_module(authoring, app_id, name="Visits")
    ops.upload_form_source(authoring, app_id, 0, 0, source, "visit-display")
    _pages.new_survey_module(authoring, app_id, name="Visit options")
    ops.upload_form_source(authoring, app_id, 1, 0, palette_source, "visit-options")
    return app_id


BASE = Base(
    id="hq-question-display",
    build=build,
    configuration=Configuration(
        flags=frozenset({"CASE_SEARCH_ADVANCED"}),
        privileges=frozenset({"CLOUDCARE", "GEOCODER"}),
    ),
    exhibits=(
        "questions/secret-numeric",
        "questions/date-ethiopian",
        "questions/date-nepali",
        "questions/time-12-hour",
        "questions/multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2",
        "questions/select1-quick-compact-n",
        "questions/broadcast-topic-an-address-entry-under-the-gates-above-and",
        "questions/text-receive-topic-field",
        "questions/barcode-editable",
        "questions/n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one",
        "questions/floating-good-floating-caution-floating-bad",
        "questions/group-collapse-open",
        "questions/n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or",
        "questions/group-repeat-row-without-a-repeat",
    )
    + tuple(f"questions/{entry}" for entry, *_ in PALETTE),
    vellum=((0, 0), (1, 0)),
    declaration=Declaration(runs_only_on=None),
)
