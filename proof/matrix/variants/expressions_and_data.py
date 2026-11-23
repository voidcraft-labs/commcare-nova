"""The named changes of variants whose entry is in the manifest area ``expressions-and-data``.

Each puts one expression, one secondary instance or one media reference into a form's source through the form
page's upload (``ops.set_form_source``), over the base the change's row names: on ``hq-expressions`` the Hidden Value
``language``'s calculation, which no ``vellum:`` attribute shadows; on ``hq-places`` the Hidden Value ``my_region``'s;
on ``hq-lookups`` a display condition on ``farmer_name``; on ``hq-search`` one on ``visit_note`` of the Clients
menu's Followup Form, which a search that is not inline reaches; on ``hq-advanced`` one on ``notes`` of the advanced
form of Member visits. A media change on ``hq-media`` may attach a file of its own first, with the calls HQ's
template loader makes (``bases/_pages.py::attach_file``), and the variant's reading reads that file through HQ's
media view as a first reading does (``retain.py::read_variant``).

The changes of holding rows put in a use Nova holds where no base holds one: on ``hq-expressions`` again
``language``'s calculation; on ``hq-case-lists`` a display condition on Patients' ``visit_note`` or ``notes``, one of
them beside the list made to choose several patients; on ``hq-search`` one on ``visit_summary`` of the Visits menu's
Followup Form, which its inline search opens, or a column of that menu's list, each beside a Search field the change
gives the menu where it reads one.
"""

from __future__ import annotations

from proof.matrix import ops

XFORMS = "http://www.w3.org/2002/xforms"
SESSION = "instance('commcaresession')/session"
WORKER_PLACE = f"instance('locations')/locations/location[@id = {SESSION}/user/data/commcare_location_id]"


def _bind(root, nodeset):
    for bind in root.iter(f"{{{XFORMS}}}bind"):
        if bind.get("nodeset") == nodeset:
            return bind
    raise AssertionError(f"The form holds no bind of {nodeset}, which this change sets an expression on.")


def _instances(root):
    found = list(root.iter(f"{{{XFORMS}}}instance"))
    if not found:
        raise AssertionError("The form holds no instance, after which this change declares one.")
    return found


def _declare(root, instance_id, src):
    """A secondary instance declared after the model's last instance, as the form builder writes one."""
    from lxml import etree

    declared = etree.Element(f"{{{XFORMS}}}instance")
    declared.set("id", instance_id)
    declared.set("src", src)
    _instances(root)[-1].addnext(declared)
    return declared


def _expression(authoring, app_id, menu, form, nodeset, attribute, expression, what, *, declare=()):
    """The bind of ``nodeset`` in the form at ``(menu, form)`` given ``attribute="expression"``, each
    ``(id, src)`` of ``declare`` declared beside it."""

    def edit(root, _held):
        for instance_id, src in declare:
            _declare(root, instance_id, src)
        _bind(root, nodeset).set(attribute, expression)
        return None

    ops.set_form_source(authoring, app_id, menu, form, edit, what=what)


def _language(authoring, app_id, expression, what, *, declare=()):
    """``hq-expressions``: the Hidden Value ``language`` calculated by ``expression``."""
    _expression(authoring, app_id, 0, 0, "/data/language", "calculate", expression, what, declare=declare)


def _region(authoring, app_id, expression, what, *, declare=()):
    """``hq-places``: the Hidden Value ``my_region`` calculated by ``expression``."""
    _expression(authoring, app_id, 0, 0, "/data/my_region", "calculate", expression, what, declare=declare)


def _farmer_shown_when(authoring, app_id, expression, what, *, declare=()):
    """``hq-lookups``: ``farmer_name`` shown only where ``expression`` holds."""
    _expression(authoring, app_id, 0, 0, "/data/farmer_name", "relevant", expression, what, declare=declare)


def _visit_note_shown_when(authoring, app_id, expression, what, *, declare=()):
    """``hq-search``: ``visit_note`` of the Clients menu's Followup Form shown only where ``expression`` holds."""
    _expression(authoring, app_id, 0, 1, "/data/visit_note", "relevant", expression, what, declare=declare)


def _itext_value(root, text_id, form=None, *, lang="en"):
    """The ``<value>`` of ``text_id`` in the translation ``lang``, the one of ``form`` (image, audio, video) where
    given, else the plain one; None where the text holds none."""
    for translation in root.iter(f"{{{XFORMS}}}translation"):
        if translation.get("lang") != lang:
            continue
        for text in translation.iter(f"{{{XFORMS}}}text"):
            if text.get("id") != text_id:
                continue
            for value in text.iter(f"{{{XFORMS}}}value"):
                if value.get("form") == form:
                    return value
            return None
    raise AssertionError(f"The form's {lang} translation holds no text {text_id}, whose media this change sets.")


def _media_path(authoring, app_id, menu, form, text_id, kind, path, what):
    """The ``kind`` media of the text ``text_id`` in the form at ``(menu, form)`` set to ``path``, a value added where
    the text holds none."""
    from lxml import etree

    def edit(root, _held):
        value = _itext_value(root, text_id, kind)
        if value is None:
            plain = _itext_value(root, text_id)
            if plain is None:
                raise AssertionError(f"The text {text_id} holds no value beside which a {kind} is added.")
            value = etree.Element(f"{{{XFORMS}}}value")
            value.set("form", kind)
            plain.addnext(value)
        value.text = path
        return None

    ops.set_form_source(authoring, app_id, menu, form, edit, what=what)


# Session values -----------------------------------------------------------------------------------------------------


def session_datum_not_supplied(authoring, app_id):
    """A read of ``session/data/case_id`` in a survey form, whose entry supplies no datum."""
    _language(authoring, app_id, f"{SESSION}/data/case_id", "session-datum-not-supplied")


def supply_point_id_outside_an_advanced_form(authoring, app_id):
    """A read of ``session/data/supply_point_id`` in a survey form, which no computed datum supplies."""
    _language(authoring, app_id, f"{SESSION}/data/supply_point_id", "supply-point-id-outside-an-advanced-form")


def supply_point_id_read(authoring, app_id):
    """``notes`` of Member visits' advanced form shown where ``session/data/supply_point_id`` is not blank: the form's
    own computed datum of that id supplies it."""
    _expression(
        authoring,
        app_id,
        1,
        0,
        "/data/notes",
        "relevant",
        f"{SESSION}/data/supply_point_id != ''",
        "supply-point-id-read",
    )

    ops.set_json(
        authoring,
        app_id,
        "/modules/1/forms/0/arbitrary_datums",
        [
            {
                "datum_id": "supply_point_id",
                "datum_function": f"{SESSION}/user/data/commcare_location_id",
                "doc_type": "ArbitraryDatum",
            }
        ],
    )


def fingerprint_query(authoring, app_id):
    """A read of ``session/data/fingerprintquery``."""
    _language(authoring, app_id, f"{SESSION}/data/fingerprintquery", "fingerprint-query")


def window_width_in_form_logic(authoring, app_id):
    """A read of ``session/context/window_width`` in a calculation."""
    _language(authoring, app_id, f"{SESSION}/context/window_width", "window-width-in-form-logic")


def worker_data_no_property_takes(authoring, app_id):
    """A read of the worker's ``user/data/external_id``, a name HQ's user fields reserve."""
    _region(authoring, app_id, f"{SESSION}/user/data/external_id", "worker-data-no-property-takes")


# Secondary instances ------------------------------------------------------------------------------------------------


def ledger_read(authoring, app_id):
    """A read of the ``ledgerdb`` instance (``jr://instance/ledgerdb``), declared."""
    _language(
        authoring,
        app_id,
        "instance('ledgerdb')/ledgerdb/ledger/@entity-id",
        "ledger-read",
        declare=[("ledgerdb", "jr://instance/ledgerdb")],
    )


def user_groups_read(authoring, app_id):
    """A read of the case-sharing groups fixture (``jr://fixture/user-groups``), declared as ``groups``."""
    _language(
        authoring,
        app_id,
        "instance('groups')/groups/group/@id",
        "user-groups-read",
        declare=[("groups", "jr://fixture/user-groups")],
    )


def hierarchical_locations_read(authoring, app_id):
    """A read of the hierarchical locations fixture (``jr://fixture/commtrack:locations``), declared."""
    _region(
        authoring,
        app_id,
        "instance('commtrack:locations')/locations/location/@id",
        "hierarchical-locations-read",
        declare=[("commtrack:locations", "jr://fixture/commtrack:locations")],
    )


def mobile_reports_read(authoring, app_id):
    """A read of the mobile reports fixture (``jr://fixture/commcare:reports``), declared as ``reports``."""
    _language(
        authoring,
        app_id,
        "instance('reports')/reports/report/@id",
        "mobile-reports-read",
        declare=[("reports", "jr://fixture/commcare:reports")],
    )


def remote_registry_read(authoring, app_id):
    """A read of the data registry instance (``jr://instance/remote/registry``), declared."""
    _language(
        authoring,
        app_id,
        "instance('registry')/results/case/@case_id",
        "remote-registry-read",
        declare=[("registry", "jr://instance/remote/registry")],
    )


def visit_schedule_read(authoring, app_id):
    """A read of a visit schedule fixture (``jr://fixture/schedule:m0:p0:f0``), declared."""
    _language(
        authoring,
        app_id,
        "instance('schedule:m0:p0:f0')/schedule/visit/@id",
        "visit-schedule-read",
        declare=[("schedule:m0:p0:f0", "jr://fixture/schedule:m0:p0:f0")],
    )


def call_center_indicators_read(authoring, app_id):
    """A read of a call-center indicators fixture (``jr://fixture/indicators:call-center``), declared."""
    _language(
        authoring,
        app_id,
        "instance('indicators:call-center')/indicators/case/@id",
        "call-center-indicators-read",
        declare=[("indicators:call-center", "jr://fixture/indicators:call-center")],
    )


def products_read(authoring, app_id):
    """A read of the products fixture (``jr://fixture/commtrack:products``), declared."""
    _language(
        authoring,
        app_id,
        "instance('commtrack:products')/products/product/@id",
        "products-read",
        declare=[("commtrack:products", "jr://fixture/commtrack:products")],
    )


def case_search_fixture_read(authoring, app_id):
    """A read of a case search fixture (``jr://fixture/case-search-fixture:counts``), declared."""
    _language(
        authoring,
        app_id,
        "instance('case-search-fixture:counts')/values/value",
        "case-search-fixture-read",
        declare=[("case-search-fixture:counts", "jr://fixture/case-search-fixture:counts")],
    )


def inline_instance(authoring, app_id):
    """A secondary instance ``choices`` whose content is written inside it, with no ``src``, which nothing reads."""
    from lxml import etree

    def edit(root, _held):
        inline = etree.Element(f"{{{XFORMS}}}instance")
        inline.set("id", "choices")
        item = etree.SubElement(etree.SubElement(inline, f"{{{XFORMS}}}root"), f"{{{XFORMS}}}item")
        item.text = "a"
        _instances(root)[-1].addnext(inline)
        return None

    ops.set_form_source(authoring, app_id, 0, 0, edit, what="inline-instance")


def unrecognized_instance_source(authoring, app_id):
    """A read of an instance declared with a source no CommCare runtime loads (``jr://instance/nova-proof-notes``)."""
    _language(
        authoring,
        app_id,
        "instance('notes')/notes/note",
        "unrecognized-instance-source",
        declare=[("notes", "jr://instance/nova-proof-notes")],
    )


def undeclared_instance_read(authoring, app_id):
    """A read of an instance ``notes`` the form does not declare, whose id names no scheme."""
    _language(authoring, app_id, "instance('notes')/notes/note", "undeclared-instance-read")


def declared_table_the_project_space_lacks(authoring, app_id):
    """A lookup table instance ``item-list:harvests`` declared and read by nothing, whose table the project space's
    table list does not hold."""

    def edit(root, _held):
        _declare(root, "item-list:harvests", "jr://fixture/item-list:harvests")
        return None

    ops.set_form_source(authoring, app_id, 0, 0, edit, what="declared-table-the-project-space-lacks")


def declared_report_fixture(authoring, app_id):
    """The mobile reports fixture ``commcare:reports`` declared and read by nothing: Core loads it when the form
    opens, and the form cannot open where the project space serves no mobile report (``loadFixtureRoot``), which no
    export says."""

    def edit(root, _held):
        _declare(root, "commcare:reports", "jr://fixture/commcare:reports")
        return None

    ops.set_form_source(authoring, app_id, 0, 0, edit, what="declared-report-fixture")


def reads_a_table_the_project_space_lacks(authoring, app_id):
    """``farmer_name`` shown where the table ``harvests`` holds a row: the form declares and reads a table the
    project space's table list does not hold."""
    _farmer_shown_when(
        authoring,
        app_id,
        "count(instance('item-list:harvests')/harvests_list/harvests) > 0",
        "reads-a-table-the-project-space-lacks",
        declare=[("item-list:harvests", "jr://fixture/item-list:harvests")],
    )


def second_instance_without_id(authoring, app_id):
    """A second ``<instance>`` with no ``id`` beside the main one."""
    from lxml import etree

    def edit(root, _held):
        second = etree.Element(f"{{{XFORMS}}}instance")
        etree.SubElement(second, f"{{{XFORMS}}}extra")
        _instances(root)[-1].addnext(second)
        return None

    ops.set_form_source(authoring, app_id, 0, 0, edit, what="second-instance-without-id")


# Search -------------------------------------------------------------------------------------------------------------


def results_read_after_search(authoring, app_id):
    """A read of the search's ``results`` in a form a search that is not inline reaches."""
    _visit_note_shown_when(
        authoring,
        app_id,
        "count(instance('results')/results/case) > 0",
        "results-read-after-search",
        declare=[("results", "jr://instance/remote/results")],
    )


def search_input_read_after_search(authoring, app_id):
    """A read of a Search field's answer (``search-input:results``) in a form a search that is not inline
    reaches."""
    _visit_note_shown_when(
        authoring,
        app_id,
        "instance('search-input:results')/input/field[@name = 'village'] = 'North'",
        "search-input-read-after-search",
        declare=[("search-input:results", "jr://instance/search-input/results")],
    )


# Expressions --------------------------------------------------------------------------------------------------------


def reads_a_question_not_there(authoring, app_id):
    """A calculation reading ``/data/nowhere``, which the form does not hold."""
    _language(authoring, app_id, "/data/nowhere", "reads-a-question-not-there")


def location_data_no_property_takes(authoring, app_id):
    """A read of the worker's place's ``location_data/external_id``, a name HQ's location fields reserve."""
    _region(authoring, app_id, f"{WORKER_PLACE}/location_data/external_id", "location-data-no-property-takes")


def text_ordered_comparison(authoring, app_id):
    """A calculation ordering a text answer against text (``/data/code < 'm'``), which Core compares as numbers."""
    _language(authoring, app_id, "if(/data/code < 'm', 'early', 'late')", "text-ordered-comparison")


def choice_name_on_a_lookup_select(authoring, app_id):
    """``farmer_name`` shown where ``jr:choice-name`` of ``crop``, a select whose choices come from a table, is
    ``Maize``."""
    _farmer_shown_when(
        authoring, app_id, "jr:choice-name(/data/crop, '/data/crop') = 'Maize'", "choice-name-on-a-lookup-select"
    )


def here_in_a_form(authoring, app_id):
    """A calculation of ``here()``."""
    _language(authoring, app_id, "here()", "here-in-a-form")


def unknown_function_in_a_calculation(authoring, app_id):
    """A calculation calling ``nova-proof-unknown``, a function Core builds no class for."""
    _language(authoring, app_id, "nova-proof-unknown(/data/code)", "unknown-function-in-a-calculation")


def union_of_two_paths(authoring, app_id):
    """A calculation counting the union ``/data/code | /data/code_again``."""
    _language(authoring, app_id, "count(/data/code | /data/code_again)", "union-of-two-paths")


def filter_on_a_parenthesized_path(authoring, app_id):
    """A calculation filtering a parenthesized path (``(/data/code)[1]``)."""
    _language(authoring, app_id, "(/data/code)[1]", "filter-on-a-parenthesized-path")


def descendant_step(authoring, app_id):
    """A calculation counting ``/data//visit_code``, a descendant step."""
    _language(authoring, app_id, "count(/data//visit_code)", "descendant-step")


def parent_after_a_named_step(authoring, app_id):
    """A calculation reading ``/data/visits/../code``."""
    _language(authoring, app_id, "/data/visits/../code", "parent-after-a-named-step")


def variable_in_a_calculation(authoring, app_id):
    """A calculation of ``$kind``, a variable no form context defines."""
    _language(authoring, app_id, "$kind", "variable-in-a-calculation")


def time_ordered_comparison(authoring, app_id):
    """A calculation ordering an answer against a time (``/data/code < '15:00'``)."""
    _language(authoring, app_id, "if(/data/code < '15:00', 'before', 'after')", "time-ordered-comparison")


def invalid_calculation(authoring, app_id):
    """A calculation Core's parser refuses (``/data/code =``)."""
    _language(authoring, app_id, "/data/code =", "invalid-calculation")


# Media --------------------------------------------------------------------------------------------------------------


def media_key_outside_jr_file(authoring, app_id):
    """``loose_note``'s picture referenced at ``commcare/loose_picture.png``, which is not under ``jr://file/``, and
    the media map given an entry at that key naming the picture's file."""
    from proof.hq import operations

    item = operations.held_app(authoring.state, app_id).multimedia_map["jr://file/loose_picture.png"].to_json()
    ops.set_json(authoring, app_id, "/multimedia_map/commcare~1loose_picture.png", item)
    _media_path(authoring, app_id, 0, 0, "loose_note-label", "image", "commcare/loose_picture.png", "media-key")


def audio_label_names_a_video_file(authoring, app_id):
    """``animal_name``'s audio label referencing the path HQ's map files as a video (``animal-hen.mp4``)."""
    _media_path(
        authoring,
        app_id,
        0,
        0,
        "animal_name-label",
        "audio",
        "jr://file/commcare/video/data/animal-hen.mp4",
        "audio-label-names-a-video-file",
    )


def question_image_without_map_entry(authoring, app_id):
    """``place_note``'s picture referenced at a path the media map holds no entry for."""
    _media_path(
        authoring,
        app_id,
        0,
        0,
        "place_note-label",
        "image",
        "jr://file/commcare/image/data/nowhere.png",
        "question-image-without-map-entry",
    )


def note_image_without_map_entry(authoring, app_id):
    """``note`` given an English picture at a path the media map holds no entry for."""
    _media_path(
        authoring,
        app_id,
        0,
        0,
        "note-label",
        "image",
        "jr://file/commcare/image/data/note.png",
        "note-image-without-map-entry",
    )


def _attached_media(authoring, app_id, path, data, text_id, kind, what):
    """``data`` attached at ``path`` in the operation ``variant:media:<path>``, then the ``kind`` media of the text
    ``text_id`` of ``hq-media``'s survey set to ``path``."""
    from proof.matrix.bases import _pages

    _pages.attach_file(authoring, app_id, path, data, label="variant")
    _media_path(authoring, app_id, 0, 0, text_id, kind, path, what)


def _refused_file(authoring, app_id, path, text_id, kind, what):
    """The lane's file of the refused format ``path``'s extension names (``media.py::refused_stand_in``), attached
    and referenced as ``_attached_media`` does."""
    from proof.matrix import media

    _attached_media(authoring, app_id, path, media.refused_stand_in(path), text_id, kind, what)


SVG_PICTURE = "jr://file/commcare/image/data/place_note.svg"
TIFF_PICTURE = "jr://file/commcare/image/data/place_note.tif"
WAV_SOUND = "jr://file/commcare/audio/data/animal_name.wav"
AVI_VIDEO = "jr://file/commcare/video/data/animal_name.avi"
LARGE_PICTURE = "jr://file/commcare/image/data/place_note_large.png"
# Nova's cap on a picture's bytes (``lib/domain/multimedia.ts::ASSET_SIZE_CAPS_BYTES``), five megabytes.
PICTURE_CAP_BYTES = 5 * 1024 * 1024


def svg_picture(authoring, app_id):
    """``place_note``'s picture an SVG (``media.py::svg_of``), which HQ stores as an image only once Pillow opens
    it (``CommCareImage.attach_data``)."""
    _refused_file(authoring, app_id, SVG_PICTURE, "place_note-label", "image", "svg-picture")


def tiff_picture(authoring, app_id):
    """``place_note``'s picture a TIFF of one pixel (``media.py::tif_of``)."""
    _refused_file(authoring, app_id, TIFF_PICTURE, "place_note-label", "image", "tiff-picture")


def wav_24_bit_sound(authoring, app_id):
    """``animal_name``'s sound a WAVE file of 24-bit PCM (``media.py::wav_of``)."""
    _refused_file(authoring, app_id, WAV_SOUND, "animal_name-label", "audio", "wav-24-bit-sound")


def avi_video(authoring, app_id):
    """``animal_name``'s video an AVI file (``media.py::avi_of``)."""
    _refused_file(authoring, app_id, AVI_VIDEO, "animal_name-label", "video", "avi-video")


def picture_over_nova_s_cap(authoring, app_id):
    """``place_note``'s picture a PNG one byte past Nova's cap on a picture (``media.py::oversize_png_of``), which HQ
    stores whatever its size."""
    from proof.matrix import media

    data = media.oversize_png_of(LARGE_PICTURE, PICTURE_CAP_BYTES + 1)
    _attached_media(authoring, app_id, LARGE_PICTURE, data, "place_note-label", "image", "picture-over-nova-s-cap")


# The composed row's second change ------------------------------------------------------------------------------------


def unknown_function_call(authoring, app_id):
    """The second form's ``remark`` shown only where a function Core builds no class for answers
    (``nova-proof-unknown(/data/members)``, which Core parses as an ``XPathCustomRuntimeFunc`` and its evaluation
    throws), set on the question's bind and put in through the form page's upload (``ops.set_form_source``)."""

    def relevant(root, _held):
        for bind in root.iter(f"{{{XFORMS}}}bind"):
            if bind.get("nodeset") == "/data/remark":
                bind.set("relevant", "nova-proof-unknown(/data/members)")
                return None
        raise AssertionError("The second form holds no bind of /data/remark, which this change sets a condition on.")

    ops.set_form_source(authoring, app_id, 0, 1, relevant, what="unknown-function-call")


# Holding rows: a held use, put in where a base holds none ------------------------------------------------------------
#
# Each change below writes the form's source as text: the source HQ holds with each ``(old, new, count)`` replacement
# made, every ``old`` held to occur exactly ``count`` times first, so a base whose builder now writes another source
# fails the change by name rather than making another one.

# hq-expressions' Hidden Value ``language``, as the form builder's save leaves its bind.
LANGUAGE_BIND = 'nodeset="/data/language" calculate="instance(\'commcaresession\')/session/context/applanguage"'
# The main instance's end in a form source the base's builder posted, after which a change declares an instance.
MAIN_INSTANCE_END = "</data></instance>"
# hq-case-lists: Patients' Followup Form's ``visit_note`` and Registration Form's ``notes``, as posted.
CASE_LISTS_VISIT_NOTE_BIND = '<bind nodeset="/data/visit_note" type="xsd:string"/>'
CASE_LISTS_NOTES_BIND = '<bind nodeset="/data/notes" type="xsd:string"/>'
# hq-search: Visits' Followup Form's ``visit_summary``, as posted.
SEARCH_VISIT_SUMMARY_BIND = '<bind nodeset="/data/visit_summary" type="xsd:string"/>'
# A Search field ``village`` as HQ's search page saves a plain one (hq-search's Clients menu holds the same).
VILLAGE_SEARCH_FIELD = {
    "name": "village",
    "label": {"en": "Village"},
    "hint": {},
    "hidden": False,
    "allow_blank_value": False,
    "exclude": False,
    "required": {"test": None, "text": {}, "doc_type": "Assertion"},
    "validations": [],
    "itemset": {"doc_type": "Itemset"},
    "is_group": False,
    "doc_type": "CaseSearchProperty",
}
# The answer to ``village`` in an inline search's forms and list.
INLINE_VILLAGE_ANSWER = "instance('search-input:results:inline')/input/field[@name = 'village']"


def _replaced(text, pairs):
    """``text`` with each ``(old, new, count)`` of ``pairs`` made in order, every ``old`` held to occur ``count``
    times where it is replaced."""
    for old, new, count in pairs:
        found = text.count(old)
        if found != count:
            raise AssertionError(
                f"The form's source holds {old!r} {found} times, and the change expects it {count} times. Look at"
                " what the base's builder now writes for the form."
            )
        text = text.replace(old, new)
    return text


def _changed_source(authoring, app_id, menu, form, pairs, what):
    """The form at ``(menu, form)`` with ``pairs`` replaced in the source HQ holds, put in through the form page's
    upload (``ops.set_form_source``)."""
    ops.set_form_source(authoring, app_id, menu, form, lambda _root, held: _replaced(held.source, pairs), what=what)


def _calculated(authoring, app_id, expression, what):
    """``hq-expressions``: the Hidden Value ``language`` calculated by ``expression``, which holds no character an
    attribute value escapes."""
    _changed_source(
        authoring, app_id, 0, 0, [(LANGUAGE_BIND, f'nodeset="/data/language" calculate="{expression}"', 1)], what
    )


def _shown_when(authoring, app_id, menu, form, bind, condition, what, *, declare=None):
    """The question whose bind the base's builder posted as ``bind`` (closing ``/>``) shown only where ``condition``
    holds, an attribute value with its markup escaped; ``declare``, an ``(id, src)``, declared after the main
    instance."""
    pairs = [(bind, f'{bind[: -len("/>")]} relevant="{condition}"/>', 1)]
    if declare is not None:
        instance_id, src = declare
        pairs.insert(0, (MAIN_INSTANCE_END, f'{MAIN_INSTANCE_END}<instance id="{instance_id}" src="{src}"/>', 1))
    _changed_source(authoring, app_id, menu, form, pairs, what)


def _calculated_column(header, field):
    """A calculated case list column as HQ's Case List page saves one."""
    return {
        "format": "plain",
        "header": {"en": header},
        "field": field,
        "model": "case",
        "hasAutocomplete": False,
        "useXpathExpression": True,
        "grid_x": None,
        "grid_y": None,
        "enum": [],
        "graph_configuration": {
            "config": {},
            "locale_specific_config": {},
            "annotations": [],
            "series": [],
            "doc_type": "GraphConfiguration",
        },
        "late_flag": 30,
        "time_ago_interval": 365.25,
        "date_format": "%d/%m/%y",
        "doc_type": "DetailColumn",
    }


def calls_abs(authoring, app_id):
    """``language`` calculated ``abs(-2)``."""
    _calculated(authoring, app_id, "abs(-2)", "calls-abs")


def calls_acos(authoring, app_id):
    """``language`` calculated ``acos(1)``."""
    _calculated(authoring, app_id, "acos(1)", "calls-acos")


def calls_asin(authoring, app_id):
    """``language`` calculated ``asin(0)``."""
    _calculated(authoring, app_id, "asin(0)", "calls-asin")


def calls_atan(authoring, app_id):
    """``language`` calculated ``atan(1)``."""
    _calculated(authoring, app_id, "atan(1)", "calls-atan")


def calls_atan2(authoring, app_id):
    """``language`` calculated ``atan2(1, 1)``."""
    _calculated(authoring, app_id, "atan2(1, 1)", "calls-atan2")


def calls_boolean(authoring, app_id):
    """``language`` calculated ``boolean(/data/code)``."""
    _calculated(authoring, app_id, "boolean(/data/code)", "calls-boolean")


def calls_boolean_from_string(authoring, app_id):
    """``language`` calculated ``boolean-from-string(/data/code)``."""
    _calculated(authoring, app_id, "boolean-from-string(/data/code)", "calls-boolean-from-string")


def calls_ceiling(authoring, app_id):
    """``language`` calculated ``ceiling(1.5)``."""
    _calculated(authoring, app_id, "ceiling(1.5)", "calls-ceiling")


def calls_checklist(authoring, app_id):
    """``language`` calculated ``checklist(1, 2, /data/code = 'a', /data/code_again = 'b')``."""
    _calculated(authoring, app_id, "checklist(1, 2, /data/code = 'a', /data/code_again = 'b')", "calls-checklist")


def calls_checksum(authoring, app_id):
    """``language`` calculated ``checksum('verhoeff', /data/code)``."""
    _calculated(authoring, app_id, "checksum('verhoeff', /data/code)", "calls-checksum")


def calls_closest_point_on_polygon(authoring, app_id):
    """``language`` calculated ``closest-point-on-polygon('0.5 0.5', '0 0 0 1 1 1 1 0 0 0')``."""
    _calculated(
        authoring,
        app_id,
        "closest-point-on-polygon('0.5 0.5', '0 0 0 1 1 1 1 0 0 0')",
        "calls-closest-point-on-polygon",
    )


def calls_contains(authoring, app_id):
    """``language`` calculated ``contains(/data/code, 'a')``."""
    _calculated(authoring, app_id, "contains(/data/code, 'a')", "calls-contains")


def calls_cos(authoring, app_id):
    """``language`` calculated ``cos(0)``."""
    _calculated(authoring, app_id, "cos(0)", "calls-cos")


def calls_decrypt_string(authoring, app_id):
    """``language`` calculated ``decrypt-string(/data/code, 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=', 'AES')``."""
    _calculated(
        authoring,
        app_id,
        "decrypt-string(/data/code, 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=', 'AES')",
        "calls-decrypt-string",
    )


def calls_depend(authoring, app_id):
    """``language`` calculated ``depend(/data/code, /data/code_again)``."""
    _calculated(authoring, app_id, "depend(/data/code, /data/code_again)", "calls-depend")


def calls_distance(authoring, app_id):
    """``language`` calculated ``distance('0 0', '1 1')``."""
    _calculated(authoring, app_id, "distance('0 0', '1 1')", "calls-distance")


def calls_distinct_values(authoring, app_id):
    """``language`` calculated ``distinct-values(/data/visits/visit_code)``."""
    _calculated(authoring, app_id, "distinct-values(/data/visits/visit_code)", "calls-distinct-values")


def calls_double(authoring, app_id):
    """``language`` calculated ``double(/data/code)``."""
    _calculated(authoring, app_id, "double(/data/code)", "calls-double")


def calls_encrypt_string(authoring, app_id):
    """``language`` calculated ``encrypt-string(/data/code, 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=', 'AES')``."""
    _calculated(
        authoring,
        app_id,
        "encrypt-string(/data/code, 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=', 'AES')",
        "calls-encrypt-string",
    )


def calls_ends_with(authoring, app_id):
    """``language`` calculated ``ends-with(/data/code, 'a')``."""
    _calculated(authoring, app_id, "ends-with(/data/code, 'a')", "calls-ends-with")


def calls_exp(authoring, app_id):
    """``language`` calculated ``exp(1)``."""
    _calculated(authoring, app_id, "exp(1)", "calls-exp")


def calls_floor(authoring, app_id):
    """``language`` calculated ``floor(1.5)``."""
    _calculated(authoring, app_id, "floor(1.5)", "calls-floor")


def calls_format_date_for_calendar(authoring, app_id):
    """``language`` calculated ``format-date-for-calendar(today(), 'nepali')``."""
    _calculated(authoring, app_id, "format-date-for-calendar(today(), 'nepali')", "calls-format-date-for-calendar")


def calls_id_compress(authoring, app_id):
    """``language`` calculated ``id-compress(7, 'ABC', 'DEF', 'GHJ', 3)``."""
    _calculated(authoring, app_id, "id-compress(7, 'ABC', 'DEF', 'GHJ', 3)", "calls-id-compress")


def calls_index_of(authoring, app_id):
    """``language`` calculated ``index-of(/data/visits/visit_code, /data/code)``."""
    _calculated(authoring, app_id, "index-of(/data/visits/visit_code, /data/code)", "calls-index-of")


def calls_is_point_inside_polygon(authoring, app_id):
    """``language`` calculated ``is-point-inside-polygon('0.5 0.5', '0 0 0 1 1 1 1 0 0 0')``."""
    _calculated(
        authoring, app_id, "is-point-inside-polygon('0.5 0.5', '0 0 0 1 1 1 1 0 0 0')", "calls-is-point-inside-polygon"
    )


def calls_is_selected(authoring, app_id):
    """``language`` calculated ``is-selected(/data/code, 'a')``."""
    _calculated(authoring, app_id, "is-selected(/data/code, 'a')", "calls-is-selected")


def calls_join(authoring, app_id):
    """``language`` calculated ``join(' ', /data/visits/visit_code)``."""
    _calculated(authoring, app_id, "join(' ', /data/visits/visit_code)", "calls-join")


def calls_join_chunked(authoring, app_id):
    """``language`` calculated ``join-chunked('-', 3, /data/code)``."""
    _calculated(authoring, app_id, "join-chunked('-', 3, /data/code)", "calls-join-chunked")


def calls_json_property(authoring, app_id):
    """``language`` calculated ``json-property(/data/code, 'name')``."""
    _calculated(authoring, app_id, "json-property(/data/code, 'name')", "calls-json-property")


def calls_log(authoring, app_id):
    """``language`` calculated ``log(2)``."""
    _calculated(authoring, app_id, "log(2)", "calls-log")


def calls_log10(authoring, app_id):
    """``language`` calculated ``log10(100)``."""
    _calculated(authoring, app_id, "log10(100)", "calls-log10")


def calls_max(authoring, app_id):
    """``language`` calculated ``max(1, 2)``."""
    _calculated(authoring, app_id, "max(1, 2)", "calls-max")


def calls_min(authoring, app_id):
    """``language`` calculated ``min(1, 2)``."""
    _calculated(authoring, app_id, "min(1, 2)", "calls-min")


def calls_not(authoring, app_id):
    """``language`` calculated ``not(/data/code = 'a')``."""
    _calculated(authoring, app_id, "not(/data/code = 'a')", "calls-not")


def calls_number(authoring, app_id):
    """``language`` calculated ``number(/data/code)``."""
    _calculated(authoring, app_id, "number(/data/code)", "calls-number")


def calls_pi(authoring, app_id):
    """``language`` calculated ``pi()``."""
    _calculated(authoring, app_id, "pi()", "calls-pi")


def calls_position(authoring, app_id):
    """``language`` calculated ``position(/data/visits)``."""
    _calculated(authoring, app_id, "position(/data/visits)", "calls-position")


def calls_pow(authoring, app_id):
    """``language`` calculated ``pow(2, 3)``."""
    _calculated(authoring, app_id, "pow(2, 3)", "calls-pow")


def calls_random(authoring, app_id):
    """``language`` calculated ``random()``."""
    _calculated(authoring, app_id, "random()", "calls-random")


def calls_regex(authoring, app_id):
    """``language`` calculated ``regex(/data/code, '^a')``."""
    _calculated(authoring, app_id, "regex(/data/code, '^a')", "calls-regex")


def calls_replace(authoring, app_id):
    """``language`` calculated ``replace(/data/code, 'a', 'b')``."""
    _calculated(authoring, app_id, "replace(/data/code, 'a', 'b')", "calls-replace")


def calls_round(authoring, app_id):
    """``language`` calculated ``round(1.5)``."""
    _calculated(authoring, app_id, "round(1.5)", "calls-round")


def calls_selected_at(authoring, app_id):
    """``language`` calculated ``selected-at(/data/code, 0)``."""
    _calculated(authoring, app_id, "selected-at(/data/code, 0)", "calls-selected-at")


def calls_sin(authoring, app_id):
    """``language`` calculated ``sin(0)``."""
    _calculated(authoring, app_id, "sin(0)", "calls-sin")


def calls_sleep(authoring, app_id):
    """``language`` calculated ``sleep(1, /data/code)``."""
    _calculated(authoring, app_id, "sleep(1, /data/code)", "calls-sleep")


def calls_sort(authoring, app_id):
    """``language`` calculated ``sort(/data/code)``."""
    _calculated(authoring, app_id, "sort(/data/code)", "calls-sort")


def calls_sort_by(authoring, app_id):
    """``language`` calculated ``sort-by(/data/code, /data/code_again)``."""
    _calculated(authoring, app_id, "sort-by(/data/code, /data/code_again)", "calls-sort-by")


def calls_sqrt(authoring, app_id):
    """``language`` calculated ``sqrt(4)``."""
    _calculated(authoring, app_id, "sqrt(4)", "calls-sqrt")


def calls_starts_with(authoring, app_id):
    """``language`` calculated ``starts-with(/data/code, 'a')``."""
    _calculated(authoring, app_id, "starts-with(/data/code, 'a')", "calls-starts-with")


def calls_string(authoring, app_id):
    """``language`` calculated ``string(1)``."""
    _calculated(authoring, app_id, "string(1)", "calls-string")


def calls_substr(authoring, app_id):
    """``language`` calculated ``substr(/data/code, 0, 1)``."""
    _calculated(authoring, app_id, "substr(/data/code, 0, 1)", "calls-substr")


def calls_substring_after(authoring, app_id):
    """``language`` calculated ``substring-after(/data/code, 'a')``."""
    _calculated(authoring, app_id, "substring-after(/data/code, 'a')", "calls-substring-after")


def calls_substring_before(authoring, app_id):
    """``language`` calculated ``substring-before(/data/code, 'a')``."""
    _calculated(authoring, app_id, "substring-before(/data/code, 'a')", "calls-substring-before")


def calls_sum(authoring, app_id):
    """``language`` calculated ``sum(/data/visits/visit_code)``."""
    _calculated(authoring, app_id, "sum(/data/visits/visit_code)", "calls-sum")


def calls_tan(authoring, app_id):
    """``language`` calculated ``tan(0)``."""
    _calculated(authoring, app_id, "tan(0)", "calls-tan")


def calls_translate(authoring, app_id):
    """``language`` calculated ``translate(/data/code, 'abc', 'ABC')``."""
    _calculated(authoring, app_id, "translate(/data/code, 'abc', 'ABC')", "calls-translate")


def calls_weighted_checklist(authoring, app_id):
    """``language`` calculated ``weighted-checklist(1, 2, /data/code = 'a', 1, /data/code_again = 'b', 1)``."""
    _calculated(
        authoring,
        app_id,
        "weighted-checklist(1, 2, /data/code = 'a', 1, /data/code_again = 'b', 1)",
        "calls-weighted-checklist",
    )


def reads_a_label_s_text(authoring, app_id):
    """``language`` calculated as the text of ``code``'s label (``jr:itext('code-label')``), which shows no answer."""
    _calculated(authoring, app_id, "jr:itext('code-label')", "reads-a-label-s-text")


def reads_the_worker_s_id_and_name(authoring, app_id):
    """``language`` calculated as the worker's id and name joined (``session/context/userid``, ``context/username``)."""
    _calculated(
        authoring,
        app_id,
        f"concat({SESSION}/context/userid, {SESSION}/context/username)",
        "reads-the-worker-s-id-and-name",
    )


def reads_the_device_id(authoring, app_id):
    """``language`` calculated as the device's id (``session/context/deviceid``)."""
    _calculated(authoring, app_id, f"{SESSION}/context/deviceid", "reads-the-device-id")


def reads_the_app_version(authoring, app_id):
    """``language`` calculated as the app's version (``session/context/appversion``)."""
    _calculated(authoring, app_id, f"{SESSION}/context/appversion", "reads-the-app-version")


def reads_the_clock_drift(authoring, app_id):
    """``language`` calculated as the device clock's drift (``session/context/drift``)."""
    _calculated(authoring, app_id, f"{SESSION}/context/drift", "reads-the-clock-drift")


def visit_note_reads_the_list_search_text(authoring, app_id):
    """Patients' Followup Form shows ``visit_note`` only where the text typed into the case list's search box
    (``session/data/stringquery``) is not blank."""
    _shown_when(
        authoring,
        app_id,
        0,
        1,
        CASE_LISTS_VISIT_NOTE_BIND,
        f"{SESSION}/data/stringquery != ''",
        "visit-note-reads-the-list-search-text",
        declare=("commcaresession", "jr://instance/session"),
    )


def notes_read_a_choice_s_label(authoring, app_id):
    """Patients' Registration Form shows ``notes`` only where the label of the choice ``village`` holds, a select
    whose choices the form lists, is ``North`` (``jr:choice-name``)."""
    _shown_when(
        authoring,
        app_id,
        0,
        0,
        CASE_LISTS_NOTES_BIND,
        "jr:choice-name(/data/village, '/data/village') = 'North'",
        "notes-read-a-choice-s-label",
    )


def visit_note_reads_the_chosen_cases(authoring, app_id):
    """Patients' list choosing several patients, and its Followup Form showing ``visit_note`` only where the
    worker chose one (``instance('selected_cases')``, declared as HQ's build names a multi-select list's cases)."""
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/multi_select", True)
    _shown_when(
        authoring,
        app_id,
        0,
        1,
        CASE_LISTS_VISIT_NOTE_BIND,
        "count(instance('selected_cases')/results/value) &gt; 0",
        "visit-note-reads-the-chosen-cases",
        declare=("selected_cases", "jr://instance/selected-entities/selected_cases"),
    )


def visits_form_reads_the_inline_results(authoring, app_id):
    """Visits' Followup Form shows ``visit_summary`` only where its inline search found a case
    (``instance('results:inline')``, related cases excluded)."""
    _shown_when(
        authoring,
        app_id,
        2,
        0,
        SEARCH_VISIT_SUMMARY_BIND,
        "count(instance('results:inline')/results/case[not(commcare_is_related_case = true())]) &gt; 0",
        "visits-form-reads-the-inline-results",
        declare=("results:inline", "jr://instance/remote/results:inline"),
    )


def visits_form_reads_a_search_field(authoring, app_id):
    """Visits' inline search given the Search field ``village``, and its Followup Form showing ``visit_summary``
    only where the worker searched for ``north`` (``instance('search-input:results:inline')``)."""
    ops.set_json(authoring, app_id, "/modules/2/search_config/properties/0", VILLAGE_SEARCH_FIELD)
    _shown_when(
        authoring,
        app_id,
        2,
        0,
        SEARCH_VISIT_SUMMARY_BIND,
        f"{INLINE_VILLAGE_ANSWER} = 'north'",
        "visits-form-reads-a-search-field",
        declare=("search-input:results:inline", "jr://instance/search-input/results:inline"),
    )


def visits_list_shows_a_search_field(authoring, app_id):
    """Visits' inline search given the Search field ``village``, and its case list a calculated column showing the
    answer (``instance('search-input:results:inline')``)."""
    ops.set_json(authoring, app_id, "/modules/2/search_config/properties/0", VILLAGE_SEARCH_FIELD)
    ops.set_json(
        authoring,
        app_id,
        "/modules/2/case_details/short/columns/1",
        _calculated_column("Village searched", INLINE_VILLAGE_ANSWER),
    )


def visits_list_reads_the_inline_results(authoring, app_id):
    """Visits' case list given a calculated column reading the row's own case in the inline search's results
    (``instance('results:inline')``, related cases excluded)."""
    ops.set_json(
        authoring,
        app_id,
        "/modules/2/case_details/short/columns/1",
        _calculated_column(
            "Found in",
            "instance('results:inline')/results/case[not(commcare_is_related_case = true())]"
            "[@case_id = current()/@case_id]/village",
        ),
    )


# hq-plain's Followup Form: its head's hashtag map as HQ's form builder saved it.
_PLAIN_HASHTAGS = "<vellum:hashtags>{&quot;#case/members&quot;:null}</vellum:hashtags>"


def head_map_naming_a_form_question(authoring, app_id):
    """``hq-plain``'s Followup Form, its head's hashtag map (``vellum:hashtags``) naming the form's own question
    ``#form/remark`` beside ``#case/members``."""
    _changed_source(
        authoring,
        app_id,
        0,
        1,
        [
            (
                _PLAIN_HASHTAGS,
                "<vellum:hashtags>{&quot;#case/members&quot;:null,&quot;#form/remark&quot;:null}</vellum:hashtags>",
                1,
            )
        ],
        "head-map-naming-a-form-question",
    )


# Holding rows of held formats: a file of a format Nova holds beyond png, mp3 and mp4 (``media.py::HELD``), attached on
# ``hq-media`` and referenced where its kind is the slot's: ``place_note``'s picture, ``animal_name``'s sound or video.
BMP_PICTURE = "jr://file/commcare/image/data/place_note.bmp"
ICO_PICTURE = "jr://file/commcare/image/data/place_note.ico"
OGG_SOUND = "jr://file/commcare/audio/data/animal_name.ogg"
AMR_SOUND = "jr://file/commcare/audio/data/animal_name.amr"
MKV_VIDEO = "jr://file/commcare/video/data/animal_name.mkv"


def _held_file(authoring, app_id, path, text_id, kind, what):
    """The lane's file of the held format ``path``'s extension names (``media.py::held_stand_in``), attached and
    referenced as ``_attached_media`` does."""
    from proof.matrix import media

    _attached_media(authoring, app_id, path, media.held_stand_in(path), text_id, kind, what)


def bmp_picture(authoring, app_id):
    """``place_note``'s picture a BMP of one pixel (``media.py::bmp_of``)."""
    _held_file(authoring, app_id, BMP_PICTURE, "place_note-label", "image", "bmp-picture")


def ico_picture(authoring, app_id):
    """``place_note``'s picture an icon of one PNG (``media.py::ico_of``)."""
    _held_file(authoring, app_id, ICO_PICTURE, "place_note-label", "image", "ico-picture")


def ogg_opus_sound(authoring, app_id):
    """``animal_name``'s sound an Ogg file of Opus audio (``media.py::ogg_of``)."""
    _held_file(authoring, app_id, OGG_SOUND, "animal_name-label", "audio", "ogg-opus-sound")


def amr_sound(authoring, app_id):
    """``animal_name``'s sound an AMR narrowband file (``media.py::amr_of``)."""
    _held_file(authoring, app_id, AMR_SOUND, "animal_name-label", "audio", "amr-sound")


def mkv_vp8_video(authoring, app_id):
    """``animal_name``'s video a Matroska file of VP8 video (``media.py::mkv_of``)."""
    _held_file(authoring, app_id, MKV_VIDEO, "animal_name-label", "video", "mkv-vp8-video")
