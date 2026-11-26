"""The named changes of variants whose entry is in the manifest area ``questions``.

Most change one form's source as text: ``_change`` hands ``ops.set_form_source`` the source HQ holds with each
``(old, new, count)`` replacement made, each ``old`` held to occur exactly ``count`` times first, so a base whose
builder now writes another source fails the change by name rather than making another one. The forms are the
bases' own: ``hq-questions``' first form (``Survey``, every question kind) unless a function names another.
"""

from __future__ import annotations

from proof.matrix import ops


def _replaced(text, pairs):
    """``text`` with each ``(old, new, count)`` of ``pairs`` made in order, every ``old`` held to occur ``count``
    times where it is replaced (``None``: at least once)."""
    for old, new, count in pairs:
        found = text.count(old)
        if found != count and not (count is None and found > 0):
            raise AssertionError(
                f"The form's source holds {old!r} {found} times, and the change expects it"
                f" {'at least once' if count is None else f'{count} times'}. Look at what the base's builder now writes"
                " for the form."
            )
        text = text.replace(old, new)
    return text


def _between(text, start, end):
    """The part of ``text`` from ``start`` through ``end``, each held to occur once."""
    _replaced(text, [(start, start, 1), (end, end, 1)])
    first = text.index(start)
    last = text.index(end, first) + len(end)
    return text[first:last]


def _moved(text, start, end, after):
    """``text`` with its part from ``start`` through ``end`` taken out and put back after ``after``."""
    part = _between(text, start, end)
    return _replaced(text.replace(part, "", 1), [(after, after + part, 1)])


def _edit(authoring, app_id, what, transform, *, menu=0, form=0):
    """The form at ``(menu, form)`` with its source HQ holds given to ``transform``, whose text is put in through
    the form page's upload (``ops.set_form_source``)."""
    ops.set_form_source(authoring, app_id, menu, form, lambda _root, held: transform(held.source), what=what)


def _change(authoring, app_id, what, *pairs, menu=0, form=0):
    """The form at ``(menu, form)`` with ``pairs`` replaced in the source HQ holds."""
    _edit(authoring, app_id, what, lambda text: _replaced(text, pairs), menu=menu, form=form)


# The first form of hq-questions, as its builder and the form builder's save leave it.
WEIGHT_BIND = 'nodeset="/data/weight" type="xsd:double"'
PIN_BIND = 'nodeset="/data/pin" type="xsd:string" />'
PIN_CONTROL = '<secret vellum:ref="#form/pin" ref="/data/pin">'
PHONE_BIND = 'nodeset="/data/phone" type="xsd:string" />'
COLOUR_BIND = 'nodeset="/data/colour" />'
CROPS_BIND = 'nodeset="/data/crops" />'
INTRO_TRIGGER = '<trigger vellum:ref="#form/intro" ref="/data/intro" appearance="minimal">'
MEMBERS_COUNT = 'vellum:jr__count="#form/household_size" jr:count="/data/household_size"'
VISITS_DUE_BIND = 'nodeset="/data/visits_due" calculate="2"'
DOUBLE_AGE_BIND = 'nodeset="/data/double_age" vellum:calculate'
PHOTO_UPLOAD = '<upload mediatype="image/*" vellum:ref="#form/photo" ref="/data/photo">'
FIRST_SETVALUE = '<setvalue event="xforms-ready" ref="/data/rounds/@ids"'
FULL_NAME_INPUT = '<input vellum:ref="#form/full_name" ref="/data/full_name">'
FULL_NAME_BIND = 'nodeset="/data/full_name" type="xsd:string" />'
TAG_CODE_INPUT = '<input vellum:ref="#form/tag_code" ref="/data/tag_code">'
TAG_CODE_BIND = 'nodeset="/data/tag_code" type="barcode" />'
ROUNDS_DATA_OPEN = '<rounds ids="" count="" current_index="" vellum:role="Repeat">'
ROUNDS_ITEM_BIND = '<bind vellum:nodeset="#form/rounds/item" nodeset="/data/rounds/item" />'
ROUNDS_OPEN = "<group>\n\t\t\t<label ref=\"jr:itext('rounds-label')\" />"
ROUNDS_CLOSE = "ref=\"jr:itext('rounds/item/round_note-label')\" />\n\t\t\t\t</input>\n\t\t\t</repeat>\n\t\t</group>"
MEMBER_NAME_OPEN = '<input vellum:ref="#form/members/member_name" ref="/data/members/member_name">'
MEMBER_NAME_CLOSE = "ref=\"jr:itext('members/member_name-label')\" />\n\t\t\t\t</input>"
NICKNAME_CLOSE = "ref=\"jr:itext('details/nickname-label')\" />\n\t\t\t</input>"
CHECKS_COUNT = 'vellum:jr__count="#form/visits_due" jr:count="/data/visits_due" jr:noAddRemove="true()"'
FULL_NAME_CLOSE = "<help ref=\"jr:itext('full_name-help')\" />\n\t\t</input>"
WEIGHT_LABEL_TEXT = '<text id="weight-label">\n\t\t\t\t\t\t<value>Weight in kilograms</value>\n\t\t\t\t\t</text>'
FULL_NAME_LABEL_VALUE = "<value>Full name</value>"
SAID_LABEL_VALUE = "<value>Write *exactly* what was said</value>"
INTRO_LABEL = "<label ref=\"jr:itext('intro-label')\" />"
PHOTO_LABEL = "<label ref=\"jr:itext('photo-label')\" />"
COLOUR_ITEMS_START = "<item>\n\t\t\t\t<label ref=\"jr:itext('colour-red-label')\" />"
COLOUR_ITEMS_END = "<value>blue</value>\n\t\t\t</item>\n"
CHECKS_OPEN = "<group>\n\t\t\t<label ref=\"jr:itext('checks-label')\" />\n\t\t\t<repeat"
CHECKS_CLOSE = "ref=\"jr:itext('checks/check_note-label')\" />\n\t\t\t\t</input>\n\t\t\t</repeat>\n\t\t</group>"


def document_type_declaration(authoring, app_id):
    """The first form's source with a document type declaration that declares no entity and references none
    (``<!DOCTYPE h:html>``), put in through the form page's upload, or stored as HQ's import stores a form where
    that page refuses it (``ops.set_form_source``)."""
    from lxml import etree

    def declared(root, _held):
        body = etree.tostring(root, encoding="unicode")
        return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE h:html>\n' + body

    ops.set_form_source(authoring, app_id, 0, 0, declared, what="document-type-declaration")


# Question ids and data nodes ----------------------------------------------------------------------------------------


def submitted_case_answer(authoring, app_id):
    _change(authoring, app_id, "submitted-case-answer",
            ("<weight />", "<Case />", 1), ('"#form/weight"', '"#form/Case"', 2), ('"/data/weight"', '"/data/Case"', 2))


def android_answer_name(authoring, app_id):
    _change(authoring, app_id, "android-answer-name", ("<weight />", "<registration />", 1),
            ('"#form/weight"', '"#form/registration"', 2), ('"/data/weight"', '"/data/registration"', 2))


def ordinary_stock_answer(authoring, app_id):
    _change(authoring, app_id, "ordinary-stock-answer", ("<double_age />", '<double_age xmlns="http://commcarehq.org/ledger/v1" />', 1))


def empty_hidden_namespace(authoring, app_id):
    _change(authoring, app_id, "empty-hidden-namespace", ("<double_age />", '<double_age xmlns="" />', 1))


def question_id_script(authoring, app_id):
    """The question ``weight`` renamed ``script``, a name HQ's form builder only warns about, at its data node, its
    bind and its control."""
    _change(
        authoring,
        app_id,
        "question-id-script",
        ("<weight />", "<script />", 1),
        ('"#form/weight"', '"#form/script"', 2),
        ('"/data/weight"', '"/data/script"', 2),
    )


def question_id_grammar(authoring, app_id):
    """The question ``weight`` renamed ``_weight``, an id outside the form builder's grammar, at its data node, its
    bind and its control."""
    _change(
        authoring,
        app_id,
        "question-id-grammar",
        ("<weight />", "<_weight />", 1),
        ('"#form/weight"', '"#form/_weight"', 2),
        ('"/data/weight"', '"/data/_weight"', 2),
    )


def two_siblings_one_name(authoring, app_id):
    """A second data node ``weight`` beside the first, so two answers share one submission path."""
    _change(authoring, app_id, "two-siblings-one-name", ("<weight />", "<weight />\n\t\t\t\t\t<weight />", 1))


def question_node_with_children(authoring, app_id):
    """A child data node under the text question ``full_name``."""
    _change(
        authoring,
        app_id,
        "question-node-with-children",
        ("<full_name />", "<full_name>\n\t\t\t\t\t\t<part />\n\t\t\t\t\t</full_name>", 1),
    )


# Question kinds ------------------------------------------------------------------------------------------------------


def secret_numeric_type(authoring, app_id):
    """The password question ``pin`` bound ``xsd:int``."""
    _change(authoring, app_id, "secret-numeric-type", (PIN_BIND, 'nodeset="/data/pin" type="xsd:int" />', 1))


def secret_untyped_numeric(authoring, app_id):
    """The password question ``pin`` with no bind type and the appearance ``numeric``."""
    _change(
        authoring,
        app_id,
        "secret-untyped-numeric",
        (PIN_BIND, 'nodeset="/data/pin" />', 1),
        (PIN_CONTROL, '<secret vellum:ref="#form/pin" ref="/data/pin" appearance="numeric">', 1),
    )


def long(authoring, app_id):
    """The decimal question ``weight`` bound ``xsd:long``."""
    _change(authoring, app_id, "long", (WEIGHT_BIND, 'nodeset="/data/weight" type="xsd:long"', 1))


def select_int_type(authoring, app_id):
    """The single select ``colour`` bound ``xsd:int``."""
    _change(authoring, app_id, "select-int-type", (COLOUR_BIND, 'nodeset="/data/colour" type="xsd:int" />', 1))


def select_string_type(authoring, app_id):
    """The single select ``colour`` bound ``xsd:string``, a type the form builder's save never writes on a select
    and Core reads as the choice type it infers (``XFormParser.applyControlProperties``)."""
    _change(authoring, app_id, "select-string-type", (COLOUR_BIND, 'nodeset="/data/colour" type="xsd:string" />', 1))


def input_untyped_numeric(authoring, app_id):
    """The phone number question ``phone`` (appearance ``numeric``) with its bind type removed."""
    _change(authoring, app_id, "input-untyped-numeric", (PHONE_BIND, 'nodeset="/data/phone" />', 1))


def choice_type_contradicting(authoring, app_id):
    """The multi-select ``crops`` bound ``select1``, the single select's choice type."""
    _change(authoring, app_id, "choice-type-contradicting", (CROPS_BIND, 'nodeset="/data/crops" type="select1" />', 1))


def acknowledge_label(authoring, app_id):
    """The label ``intro`` with its appearance ``minimal`` removed, which makes it an acknowledge label."""
    _change(
        authoring,
        app_id,
        "acknowledge-label",
        (INTRO_TRIGGER, '<trigger vellum:ref="#form/intro" ref="/data/intro">', 1),
    )


def ref_less_trigger(authoring, app_id):
    """The label ``intro``'s trigger with no ``ref``."""
    _change(authoring, app_id, "ref-less-trigger", (INTRO_TRIGGER, '<trigger appearance="minimal">', 1))


def hidden_calculate_and_default(authoring, app_id):
    """A default of ``1`` on the hidden value ``double_age``, which is calculated, as the form builder places a
    default: a setvalue at the question's place in data-tree order; and a default of ``details/nickname``, which
    the form builder runs after it and which reads ``double_age``, so the form opens with the default in the
    nickname before the calculate replaces it."""
    _change(
        authoring,
        app_id,
        "hidden-calculate-and-default",
        (
            FIRST_SETVALUE,
            '<setvalue event="xforms-ready" ref="/data/double_age" value="1" />\n\t\t\t'
            '<setvalue event="xforms-ready" ref="/data/details/nickname" value="/data/double_age" />\n\t\t\t'
            + FIRST_SETVALUE,
            1,
        ),
    )


def hidden_with_children(authoring, app_id):
    """A child data node under the hidden value ``double_age``."""
    _change(
        authoring,
        app_id,
        "hidden-with-children",
        ("<double_age />", "<double_age>\n\t\t\t\t\t\t<part />\n\t\t\t\t\t</double_age>", 1),
    )


def hidden_int_type(authoring, app_id):
    """The hidden value ``double_age`` bound ``xsd:int``."""
    _change(
        authoring,
        app_id,
        "hidden-int-type",
        (DOUBLE_AGE_BIND, 'nodeset="/data/double_age" type="xsd:int" vellum:calculate', 1),
    )


def image_max_dimension(authoring, app_id):
    """The image question ``photo`` scaled to at most 500 pixels."""
    _change(
        authoring,
        app_id,
        "image-max-dimension",
        (PHOTO_UPLOAD, PHOTO_UPLOAD[:-1] + ' jr:imageDimensionScaledMax="500px">', 1),
    )


def image_max_dimension_invalid(authoring, app_id):
    """The image question ``photo`` with ``jr:imageDimensionScaledMax`` ``big``, which is no number."""
    _change(
        authoring,
        app_id,
        "image-max-dimension-invalid",
        (PHOTO_UPLOAD, PHOTO_UPLOAD[:-1] + ' jr:imageDimensionScaledMax="big">', 1),
    )


def face_capture(authoring, app_id):
    """The image question ``photo`` with the appearance ``face``."""
    _change(authoring, app_id, "face-capture", (PHOTO_UPLOAD, PHOTO_UPLOAD[:-1] + ' appearance="face">', 1))


def upload_other_mediatype(authoring, app_id):
    """The image question ``photo``'s mediatype made ``text/*``."""
    _change(
        authoring,
        app_id,
        "upload-other-mediatype",
        (PHOTO_UPLOAD, PHOTO_UPLOAD.replace('"image/*"', '"text/*"'), 1),
    )


# Choices -------------------------------------------------------------------------------------------------------------


def choice_value_both_quotes(authoring, app_id):
    """The choice value ``blue`` of ``colour`` made ``blue'"s``, which holds both quote marks."""
    _change(authoring, app_id, "choice-value-both-quotes", ("<value>blue</value>", "<value>blue'\"s</value>", 1))


def choice_value_whitespace(authoring, app_id):
    """The choice value ``blue`` of ``colour`` made ``dark blue``, which holds a space."""
    _change(authoring, app_id, "choice-value-whitespace", ("<value>blue</value>", "<value>dark blue</value>", 1))


def choice_value_instance(authoring, app_id):
    """The choice value ``blue`` of ``colour`` made ``instance('casedb')``."""
    _change(authoring, app_id, "choice-value-instance", ("<value>blue</value>", "<value>instance('casedb')</value>", 1))


def item_without_value(authoring, app_id):
    """The choice ``blue`` of ``colour`` with its ``<value>`` removed."""
    _change(authoring, app_id, "item-without-value", ("<value>blue</value>", "", 1))


# Repeats -------------------------------------------------------------------------------------------------------------


def bare_repeat(authoring, app_id):
    """The repeat ``checks`` with the group that wraps it, and that group's label, removed."""
    _change(
        authoring,
        app_id,
        "bare-repeat",
        (CHECKS_OPEN, "<repeat", 1),
        (CHECKS_CLOSE, CHECKS_CLOSE[: -len("\n\t\t</group>")], 1),
    )


def count_non_integer_hidden(authoring, app_id):
    """The hidden value ``visits_due``, which counts ``checks``, calculated ``5 div 2``."""
    _change(
        authoring,
        app_id,
        "count-non-integer-hidden",
        (VISITS_DUE_BIND, 'nodeset="/data/visits_due" calculate="5 div 2"', 1),
    )


def count_decimal(authoring, app_id):
    """The repeat ``members`` counted by the decimal question ``weight``."""
    _change(
        authoring,
        app_id,
        "count-decimal",
        (MEMBERS_COUNT, 'vellum:jr__count="#form/weight" jr:count="/data/weight"', 1),
    )


def count_text(authoring, app_id):
    """The repeat ``members`` counted by the text question ``full_name``."""
    _change(
        authoring,
        app_id,
        "count-text",
        (MEMBERS_COUNT, 'vellum:jr__count="#form/full_name" jr:count="/data/full_name"', 1),
    )


def count_reads_its_rows(authoring, app_id):
    """The hidden value ``visits_due``, which counts ``checks``, calculated ``count(/data/checks) + 1``."""
    _change(
        authoring,
        app_id,
        "count-reads-its-rows",
        (VISITS_DUE_BIND, 'nodeset="/data/visits_due" calculate="count(/data/checks) + 1"', 1),
    )


def count_not_a_path(authoring, app_id):
    """The repeat ``members`` counted by ``/data/household_size + 1``."""
    _change(
        authoring,
        app_id,
        "count-not-a-path",
        (MEMBERS_COUNT, 'vellum:jr__count="#form/household_size + 1" jr:count="/data/household_size + 1"', 1),
    )


def count_no_node(authoring, app_id):
    """The repeat ``members`` counted by ``/data/household_total``, which names no node."""
    _change(
        authoring,
        app_id,
        "count-no-node",
        (MEMBERS_COUNT, 'vellum:jr__count="#form/household_total" jr:count="/data/household_total"', 1),
    )


def no_add_remove_without_count(authoring, app_id):
    """The repeat ``members`` with its count removed and its ``jr:noAddRemove`` kept."""
    _change(authoring, app_id, "no-add-remove-without-count", (MEMBERS_COUNT + " ", "", 1))


ROUNDS_ROW_BIND = '<bind vellum:nodeset="#form/rounds/item" nodeset="/data/rounds/item" />'


def model_iteration_outside_rule(authoring, app_id):
    """A display condition (``true()``) on the model-iteration repeat ``rounds``, on its rows' bind, where the form
    builder writes it."""
    _change(
        authoring,
        app_id,
        "model-iteration-outside-rule",
        (
            ROUNDS_ROW_BIND,
            '<bind vellum:nodeset="#form/rounds/item" nodeset="/data/rounds/item" relevant="true()" />',
            1,
        ),
    )


def model_iteration_container_condition(authoring, app_id):
    """A display condition (``true()``) on the model-iteration repeat ``rounds``' container node, a bind the form
    builder discards (its question is the rows): the repeat's condition, which the first publish writes on the rows."""
    _model(
        authoring,
        app_id,
        "model-iteration-container-condition",
        '<bind vellum:nodeset="#form/rounds" nodeset="/data/rounds" relevant="true()" />',
    )


def model_iteration_blank_answer(authoring, app_id):
    """The model-iteration repeat ``rounds``' ids read from the cases whose id is the answer to ``full_name``, which
    is blank when the form loads and its setvalues run."""
    _change(
        authoring,
        app_id,
        "model-iteration-blank-answer",
        (
            "value=\"join(' ', instance('casedb')/casedb/case/@case_id)\"",
            "value=\"join(' ', instance('casedb')/casedb/case[@case_id = /data/full_name]/@case_id)\"",
            1,
        ),
    )


def model_iteration_late_relevance(authoring, app_id):
    _iteration_under_condition(authoring, app_id, "model-iteration-late-relevance", True)


def model_iteration_initially_relevant(authoring, app_id):
    _iteration_under_condition(authoring, app_id, "model-iteration-initially-relevant", False)


def model_iteration_blank_fallback(authoring, app_id):
    """An unanswered name picks a fixed fallback roster."""
    _change(
        authoring, app_id, "model-iteration-blank-fallback",
        ("""value="join(' ', instance('casedb')/casedb/case/@case_id)" """.strip(),
         """value="join(' ', if(/data/full_name = '', 'east west', /data/full_name))" """.strip(), 1),
    )


def model_iteration_blank_insensitive(authoring, app_id):
    """The filter admits every case whatever the worker enters."""
    _change(
        authoring, app_id, "model-iteration-blank-insensitive",
        ("""value="join(' ', instance('casedb')/casedb/case/@case_id)" """.strip(),
         """value="join(' ', instance('casedb')/casedb/case[@case_id = /data/full_name or @case_id != /data/full_name]/@case_id)" """.strip(), 1),
    )


def _iteration_under_condition(authoring, app_id, name, initialize_age):
    """The model-iteration repeat ``rounds`` moved into a new group ``section`` shown only where ``age`` is over 5,
    an earlier assignment sets it below the threshold before the repeat captures its count."""

    def moved(text):
        text = _replaced(
            text,
            [
                (
                    FIRST_SETVALUE,
                    '<bind vellum:nodeset="#form/section" nodeset="/data/section" relevant="/data/age &gt; 5" />\n'
                    + ('<setvalue event="xforms-ready" ref="/data/age" value="0" />\n' if initialize_age else "")
                    + FIRST_SETVALUE,
                    1,
                ),
                (ROUNDS_DATA_OPEN, "<section>\n" + ROUNDS_DATA_OPEN, 1),
                ("</rounds>", "</rounds>\n</section>", 1),
                ("/data/rounds", "/data/section/rounds", None),
                ("#form/rounds", "#form/section/rounds", None),
                (ROUNDS_OPEN, '<group vellum:ref="#form/section" ref="/data/section">\n' + ROUNDS_OPEN, 1),
                (ROUNDS_CLOSE, ROUNDS_CLOSE + "\n</group>", 1),
            ],
        )
        return text

    _edit(authoring, app_id, name, moved)


def model_iteration_nested(authoring, app_id):
    """The model-iteration repeat ``rounds`` moved into each row of the counted repeat ``members``, its setvalues
    run as each row is added (``jr-insert``), as the form builder writes a nested one."""

    def moved(text):
        text = _moved(text, ROUNDS_DATA_OPEN, "</rounds>", "<member_name />")
        text = _moved(text, ROUNDS_OPEN, ROUNDS_CLOSE, MEMBER_NAME_CLOSE)
        return _replaced(
            text,
            [
                (
                    '<setvalue event="xforms-ready" ref="/data/rounds/',
                    '<setvalue event="jr-insert" ref="/data/rounds/',
                    2,
                ),
                ("/data/rounds", "/data/members/rounds", None),
                ("#form/rounds", "#form/members/rounds", None),
            ],
        )

    _edit(authoring, app_id, "model-iteration-nested", moved)


def user_repeat_in_question_list(authoring, app_id):
    """The repeat ``checks``, its count removed so the worker adds its rows, moved into the question list
    ``details``."""

    def moved(text):
        text = _replaced(text, [(CHECKS_COUNT + " ", "", 1)])
        text = _moved(text, '<checks jr:template="">', "</checks>", "<nickname />")
        text = _moved(text, CHECKS_OPEN[: -len("\n\t\t\t<repeat")], CHECKS_CLOSE, NICKNAME_CLOSE)
        return _replaced(
            text, [("/data/checks", "/data/details/checks", None), ("#form/checks", "#form/details/checks", None)]
        )

    _edit(authoring, app_id, "user-repeat-in-question-list", moved)


def repeat_add_caption(authoring, app_id):
    """An add caption (``jr:addCaption``) on the repeat ``members``."""
    _change(
        authoring,
        app_id,
        "repeat-add-caption",
        (MEMBER_NAME_OPEN, "<jr:addCaption>Add a member</jr:addCaption>\n" + MEMBER_NAME_OPEN, 1),
    )


def long_form_on_repeat_action_caption(authoring, app_id):
    """The add caption's own default text remains visible beside an unused long form."""
    caption = '<text id="members-add"><value>Add a member</value><value form="long">Add another participant</value></text>'
    _change(
        authoring,
        app_id,
        "long-form-on-repeat-action-caption",
        (MEMBERS_LABEL_VALUE, caption + MEMBERS_LABEL_VALUE, 1),
        (MEMBER_NAME_OPEN, "<jr:addCaption ref=\"jr:itext('members-add')\"/>" + MEMBER_NAME_OPEN, 1),
    )


def repeat_caption_itext(authoring, app_id):
    """A remove caption on the repeat ``members`` that names the itext ``members-label``."""
    _change(
        authoring,
        app_id,
        "repeat-caption-itext",
        (MEMBER_NAME_OPEN, "<jr:delCaption ref=\"jr:itext('members-label')\" />\n" + MEMBER_NAME_OPEN, 1),
    )


# Android app callouts ------------------------------------------------------------------------------------------------

ODKX = 'xmlns:odkx="http://opendatakit.org/xforms"'


def _callout(text, *, intent_attributes="", typed=True, inner=""):
    """``text`` with the head's ``odkx:intent`` ``scanner`` and, where ``typed``, ``tag_code`` made its callout
    question (bind type ``intent``, appearance ``intent:scanner``)."""
    intent = f'<odkx:intent {ODKX} id="scanner" class="org.example.SCAN"{intent_attributes}>{inner}</odkx:intent>'
    pairs = [("\t</h:head>", f"\t\t{intent}\n\t</h:head>", 1)]
    if typed:
        pairs += [
            (TAG_CODE_BIND, TAG_CODE_BIND.replace('type="barcode"', 'type="intent"'), 1),
            (TAG_CODE_INPUT, TAG_CODE_INPUT[:-1] + ' appearance="intent:scanner">', 1),
        ]
    return _replaced(text, pairs)


def callout(authoring, app_id):
    """``tag_code`` made an Android app callout: bind type ``intent``, appearance ``intent:scanner``, and the head's
    ``odkx:intent`` ``scanner``."""
    _edit(authoring, app_id, "callout", _callout)


def android_app_question(authoring, app_id):
    """The action and its input have the same ID, as Vellum's AndroidIntent writes;
    the device calls it with a unit and writes the quantity into an integer answer."""
    ops.set_json(authoring, app_id, "/cloudcare_enabled", False)
    _edit(authoring, app_id, "android-app-question", lambda text: _callout(
        text, inner='<extra key="unit" ref="&apos;litres&apos;" /><response key="measurement" ref="/data/household_size" />'
    ).replace('id="scanner"', 'id="tag_code"').replace('appearance="intent:scanner"', 'appearance="intent:tag_code"'))


def android_app_answer(authoring, app_id):
    """A second ordinary input uses the same action, retaining its text datatype."""
    android_app_question(authoring, app_id)
    _change(authoring, app_id, "android-app-answer",
            (FULL_NAME_INPUT, FULL_NAME_INPUT[:-1] + ' appearance="intent:tag_code">', 1))


def callout_quick(authoring, app_id):
    """The callout ``tag_code``'s ``odkx:intent`` with the appearance ``quick``."""
    _edit(authoring, app_id, "callout-quick", lambda text: _callout(text, intent_attributes=' appearance="quick"'))


def callout_print(authoring, app_id):
    """The callout ``tag_code``'s ``odkx:intent`` given the print action and its template extra."""
    _edit(
        authoring,
        app_id,
        "callout-print",
        lambda text: _replaced(
            _callout(
                text, inner='<extra key="cc:print_template_reference" ref="\'jr://file/commcare/text/print.html\'" />'
            ),
            [('class="org.example.SCAN"', 'class="org.commcare.dalvik.action.PRINT"', 1)],
        ),
    )


def intent_on_other_input(authoring, app_id):
    """The text question ``full_name`` given the appearance ``intent:scanner``, the callout ``callout`` makes."""
    _change(
        authoring,
        app_id,
        "intent-on-other-input",
        (FULL_NAME_INPUT, FULL_NAME_INPUT[:-1] + ' appearance="intent:scanner">', 1),
    )


def intent_naming_orphan(authoring, app_id):
    """The text question ``full_name`` given the appearance ``intent:scanner``, naming the head's ``odkx:intent``
    that no callout question writes."""
    _edit(
        authoring,
        app_id,
        "intent-naming-orphan",
        lambda text: _replaced(
            _callout(text, typed=False), [(FULL_NAME_INPUT, FULL_NAME_INPUT[:-1] + ' appearance="intent:scanner">', 1)]
        ),
    )


def intent_naming_nothing(authoring, app_id):
    """The text question ``full_name`` given the appearance ``intent:scanner``, in a form that holds no
    ``odkx:intent``."""
    _change(
        authoring,
        app_id,
        "intent-naming-nothing",
        (FULL_NAME_INPUT, FULL_NAME_INPUT[:-1] + ' appearance="intent:scanner">', 1),
    )


# Data nodes, binds and defaults --------------------------------------------------------------------------------------


def _with_model(text, model):
    """``text`` with ``model`` put in the model before its first setvalue."""
    return _replaced(text, [(FIRST_SETVALUE, model + "\n\t\t\t" + FIRST_SETVALUE, 1)])


def _model(authoring, app_id, what, model):
    _edit(authoring, app_id, what, lambda text: _with_model(text, model))


def data_parent_other_group(authoring, app_id):
    """The nickname question is shown just after full name and still submits its answer under details."""
    _edit(
        authoring,
        app_id,
        "data-parent-other-group",
        lambda text: _moved(text, NICKNAME_OPEN, NICKNAME_CLOSE, FULL_NAME_CLOSE),
    )


def data_parent_at_form_root(authoring, app_id):
    """The full-name question is shown inside details but still submits its answer at the form root."""
    _edit(
        authoring,
        app_id,
        "data-parent-at-form-root",
        lambda text: _moved(text, FULL_NAME_INPUT, FULL_NAME_CLOSE, NICKNAME_CLOSE),
    )


def data_parent_of_a_group(authoring, app_id):
    """The details group remains on the main screen and submits its group under a separate container."""
    def relocate(text):
        text = _replaced(text, [
            ("<details>", "<archive><details>", 1),
            ("</details>", "</details></archive>", 1),
            (FULL_NAME_CLOSE, FULL_NAME_CLOSE + '\n<group ref="/data/archive"><label>Archive</label></group>', 1),
        ])
        # Keep both the raw references and Vellum's companion references pointing at the source data nodes.
        return text.replace("/data/details", "/data/archive/details").replace("#form/details", "#form/archive/details")

    _edit(authoring, app_id, "data-parent-of-a-group", relocate)


def file_default(authoring, app_id):
    """A stored photo question supplies a file name as its default, without supplying that file."""
    _change(authoring, app_id, "photo-file-default", ("<photo />", "<photo>opening.jpg</photo>", 1))


def data_parent_crossing_repeat(authoring, app_id):
    """The text question ``full_name``'s control moved into the repeat ``members``, its data node left at the
    form's root."""
    _edit(
        authoring,
        app_id,
        "data-parent-crossing-repeat",
        lambda text: _moved(text, FULL_NAME_INPUT, FULL_NAME_CLOSE, MEMBER_NAME_CLOSE),
    )


def default_data_value(authoring, app_id):
    """The text question ``full_name``'s data node holding the text ``Ann``."""
    _change(authoring, app_id, "default-data-value", ("<full_name />", "<full_name>Ann</full_name>", 1))


def default_event_mismatch(authoring, app_id):
    """A default on ``full_name``, outside every repeat, set on the event ``jr-insert``."""
    _model(
        authoring,
        app_id,
        "default-event-mismatch",
        '<setvalue event="jr-insert" ref="/data/full_name" value="\'Ann\'" />',
    )


def hidden_value_xmlns(authoring, app_id):
    """The hidden value ``double_age``'s data node in a namespace of its own."""
    _change(
        authoring,
        app_id,
        "hidden-value-xmlns",
        ("<double_age />", '<double_age xmlns="http://example.org/special" />', 1),
    )


def unrecognized_question_lock(authoring, app_id):
    _change(authoring, app_id, "unrecognized-question-lock",
            ('<full_name />', '<full_name vellum:lock="partial" />', 1))


def locked_question(authoring, app_id):
    """The text question ``full_name`` locked (``vellum:lock="all"``) on its data node and its bind."""
    _change(
        authoring,
        app_id,
        "locked-question",
        ("<full_name />", '<full_name vellum:lock="all" />', 1),
        (FULL_NAME_BIND, FULL_NAME_BIND[: -len(" />")] + ' vellum:lock="all" />', 1),
    )


def required_on_label(authoring, app_id):
    """The label ``intro`` required."""
    _change(
        authoring,
        app_id,
        "required-on-label",
        ('nodeset="/data/intro" />', 'nodeset="/data/intro" required="true()" />', 1),
    )


def required_condition_differing(authoring, app_id):
    """The text question ``full_name`` required, with a required condition (``vellum:requiredCondition``) that
    differs from it."""
    _change(
        authoring,
        app_id,
        "required-condition-differing",
        (
            FULL_NAME_BIND,
            FULL_NAME_BIND[: -len(" />")] + ' required="true()" vellum:requiredCondition="/data/age &gt; 5" />',
            1,
        ),
    )


def constraint_on_hidden_value(authoring, app_id):
    """Vellum's Hidden Value has no Validation Condition property."""
    _change(
        authoring,
        app_id,
        "constraint-on-hidden-value",
        (DOUBLE_AGE_BIND, 'nodeset="/data/double_age" constraint="true()" vellum:calculate', 1),
    )


def constraint_on_capture(authoring, app_id):
    """A validation condition on the image question ``photo``."""
    _change(
        authoring,
        app_id,
        "constraint-on-capture",
        ('nodeset="/data/photo" type="binary" />', 'nodeset="/data/photo" type="binary" constraint=". != \'\'" />', 1),
    )


def message_without_condition(authoring, app_id):
    """A validation message on the decimal question ``weight``, which has no validation condition."""
    _change(
        authoring,
        app_id,
        "message-without-condition",
        (WEIGHT_BIND, WEIGHT_BIND + " jr:constraintMsg=\"jr:itext('weight-constraintMsg')\"", 1),
        (WEIGHT_LABEL_TEXT, WEIGHT_LABEL_TEXT + '\n<text id="weight-constraintMsg"><value>Too heavy</value></text>', 1),
    )


def message_on_capture(authoring, app_id):
    """A validation message on the location question without a validation condition."""
    _location_message(authoring, app_id, "message-on-capture", "")


def message_on_capture_with_condition(authoring, app_id):
    """The location question carries both a validation condition and the message it displays."""
    _location_message(authoring, app_id, "message-on-capture-with-condition", ' constraint="true()"')


def _location_message(authoring, app_id, name, condition):
    _change(
        authoring,
        app_id,
        name,
        (
            'nodeset="/data/location" type="geopoint" />',
            f'nodeset="/data/location" type="geopoint"{condition} jr:constraintMsg="jr:itext(\'location-constraintMsg\')" />',
            1,
        ),
        (
            '<text id="location-label">',
            '<text id="location-constraintMsg"><value>Stand outside</value></text>\n<text id="location-label">',
            1,
        ),
    )


def literal_constraint_message(authoring, app_id):
    """The validation message of ``age`` written as literal text in place of its itext."""
    _change(
        authoring,
        app_id,
        "literal-constraint-message",
        ("jr:constraintMsg=\"jr:itext('age-constraintMsg')\"", 'jr:constraintMsg="Enter an age from 0 to 120"', 1),
    )


def calculate_on_visible(authoring, app_id):
    """A calculation (``'Ann'``) on the text question ``full_name``, which the worker sees."""
    _change(
        authoring,
        app_id,
        "calculate-on-visible",
        (FULL_NAME_BIND, FULL_NAME_BIND[: -len(" />")] + " calculate=\"'Ann'\" />", 1),
    )


def bind_readonly(authoring, app_id):
    """The text question ``full_name``'s bind ``readonly``."""
    _change(
        authoring, app_id, "bind-readonly", (FULL_NAME_BIND, FULL_NAME_BIND[: -len(" />")] + ' readonly="true()" />', 1)
    )


def bind_id_other(authoring, app_id):
    """The text question ``full_name``'s bind given the id ``name_bind``, which its control names in place of its
    ``ref``."""
    _change(
        authoring,
        app_id,
        "bind-id-other",
        (FULL_NAME_BIND, 'id="name_bind" ' + FULL_NAME_BIND, 1),
        (FULL_NAME_INPUT, '<input bind="name_bind">', 1),
    )


def bind_on_data_root(authoring, app_id):
    """A bind on the data root ``/data`` with a display condition."""
    _model(authoring, app_id, "bind-on-data-root", '<bind nodeset="/data" relevant="true()" />')


def control_naming_no_node(authoring, app_id):
    """A text control whose ``ref`` names ``/data/missing``, which the data holds no node at."""
    _change(
        authoring,
        app_id,
        "control-naming-no-node",
        ("\t</h:body>", '\t\t<input ref="/data/missing">\n\t\t\t<label>Missing</label>\n\t\t</input>\n\t</h:body>', 1),
    )


def bind_on_attribute(authoring, app_id):
    """A bind calculating the attribute ``note`` of ``full_name``'s data node."""
    _model(authoring, app_id, "bind-on-attribute", '<bind nodeset="/data/full_name/@note" calculate="\'x\'" />')


def default_on_capture(authoring, app_id):
    """A default naming a file, ``x``, on the image question ``photo``."""
    _model(authoring, app_id, "default-on-capture", '<setvalue event="xforms-ready" ref="/data/photo" value="\'x\'" />')


def default_blank_on_capture(authoring, app_id):
    """A blank default on the image question ``photo``."""
    _model(
        authoring, app_id, "default-blank-on-capture", '<setvalue event="xforms-ready" ref="/data/photo" value="\'\'" />'
    )


def second_default(authoring, app_id):
    """Two defaults on the text question ``full_name``."""
    _model(
        authoring,
        app_id,
        "second-default",
        '<setvalue event="xforms-ready" ref="/data/full_name" value="\'Ann\'" />\n'
        '<setvalue event="xforms-ready" ref="/data/full_name" value="\'Bea\'" />',
    )


def defaults_out_of_order(authoring, app_id):
    """A default of ``age`` that reads ``full_name``'s default, set before it, where a form-builder save sets
    ``full_name``'s first."""
    _model(
        authoring,
        app_id,
        "defaults-out-of-order",
        '<setvalue event="xforms-ready" ref="/data/age" value="string-length(/data/full_name)" />\n'
        '<setvalue event="xforms-ready" ref="/data/full_name" value="\'Ann\'" />',
    )


def form_level_setvalue(authoring, app_id):
    """A setvalue on the event ``xforms-revalidate`` in the model."""
    _model(authoring, app_id, "form-level-setvalue", '<setvalue event="xforms-revalidate" ref="/data/age" value="1" />')


def setvalue_bind_redirected(authoring, app_id):
    """A default on ``age``, as the form builder reads its ``ref``, whose ``bind`` names the bind of ``full_name``,
    which Core sets in its place (``XFormParser.parseSetValueAction`` reads ``bind`` before ``ref``). The bind's id
    is its node's path, which ``full_name``'s control names, as ``bind_id_by_path`` writes it."""
    _edit(
        authoring,
        app_id,
        "setvalue-bind-redirected",
        lambda text: _with_model(
            _replaced(
                text,
                [
                    (FULL_NAME_BIND, 'id="full_name" ' + FULL_NAME_BIND, 1),
                    (FULL_NAME_INPUT, '<input bind="full_name">', 1),
                ],
            ),
            '<setvalue event="xforms-ready" ref="/data/age" bind="full_name" value="\'Ann\'" />',
        ),
    )


def action_inside_control(authoring, app_id):
    """A setvalue inside the control of ``full_name``."""
    _change(
        authoring,
        app_id,
        "action-inside-control",
        (FULL_NAME_INPUT, FULL_NAME_INPUT + '\n<setvalue event="xforms-value-changed" ref="/data/age" value="1" />', 1),
    )


def send_submission(authoring, app_id):
    """A submission and the ``send`` that names it, in the model."""
    _model(
        authoring,
        app_id,
        "send-submission",
        '<submission id="out" resource="http://example.org" targetref="/data/full_name" />\n<send submission="out" />',
    )


def submission_refused(authoring, app_id):
    """A submission with no ``resource``, in the model."""
    _model(authoring, app_id, "submission-refused", '<submission id="out" targetref="/data/full_name" />')


def pollsensor(authoring, app_id):
    """An ``orx:pollsensor`` for ``location``, in the model."""
    _model(authoring, app_id, "pollsensor", '<orx:pollsensor event="xforms-ready" ref="/data/location" />')


def foreign_model_setvalue(authoring, app_id):
    """A ``setvalue`` of a namespace of its own, in the model."""
    _model(
        authoring,
        app_id,
        "foreign-model-setvalue",
        '<x:setvalue xmlns:x="http://example.org/x" event="xforms-ready" ref="/data/age" value="1" />',
    )


def unknown_model_child(authoring, app_id):
    """An XForms element ``note``, which no reader knows, in the model."""
    _model(authoring, app_id, "unknown-model-child", "<note />")


def head_control(authoring, app_id):
    """An ``input`` of a namespace of its own in the head."""
    _change(
        authoring,
        app_id,
        "head-control",
        ("\t</h:head>", '\t\t<x:input xmlns:x="http://example.org/x" ref="/data/age" />\n\t</h:head>', 1),
    )


def authored_meta(authoring, app_id):
    """A data node ``meta`` with a child, at the end of the form's data."""
    _change(authoring, app_id, "authored-meta", ("</rounds>\n", "</rounds>\n\t\t\t\t\t<meta>\n<note />\n</meta>\n", 1))


def ui_version(authoring, app_id):
    """The data root's ``uiVersion`` made ``2``."""
    _change(authoring, app_id, "ui-version", ('uiVersion="1"', 'uiVersion="2"', 1))


def data_root_named_survey(authoring, app_id):
    """The data root named ``survey``, at the element and in every path."""
    _change(
        authoring,
        app_id,
        "data-root-named-survey",
        ("<data xmlns:jrm=", "<survey xmlns:jrm=", 1),
        ("</data>", "</survey>", 1),
        ("/data/", "/survey/", None),
    )


def data_root_reserved_by_designer(authoring, app_id):
    _change(authoring, app_id, "data-root-reserved-by-designer",
            ("<data xmlns:jrm=", "<instance xmlns:jrm=", 1),
            ("</data>", "</instance>", 1), ("/data/", "/instance/", None))


def data_root_unaddressable(authoring, app_id):
    """The data root named ``患者``, at the element and in every path."""
    _change(
        authoring,
        app_id,
        "data-root-unaddressable",
        ("<data xmlns:jrm=", "<患者 xmlns:jrm=", 1),
        ("</data>", "</患者>", 1),
        ("/data/", "/患者/", None),
    )


def data_root_attribute(authoring, app_id):
    """The data root given the attribute ``jr:modeltype``."""
    _change(
        authoring,
        app_id,
        "data-root-attribute",
        ('version="3" name="Survey">', 'version="3" name="Survey" jr:modeltype="survey">', 1),
    )


def document_type_declaration_alone(authoring, app_id):
    """The first form's source with a document type declaration that declares no entity and references none
    (``<!DOCTYPE h:html>``) after its XML declaration."""
    _change(authoring, app_id, "document-type-declaration-alone", ("?>\n<h:html", "?>\n<!DOCTYPE h:html>\n<h:html", 1))


def select_without_choices(authoring, app_id):
    """The single select ``colour`` with both its choices removed."""
    _edit(
        authoring,
        app_id,
        "select-without-choices",
        lambda text: text.replace(_between(text, COLOUR_ITEMS_START, COLOUR_ITEMS_END), "", 1),
    )


# Question text -------------------------------------------------------------------------------------------------------


def _label_form(authoring, app_id, what, value):
    """A ``<value>`` of ``full_name``'s label put after its default text: ``value`` is the element whole."""
    _change(authoring, app_id, what, (FULL_NAME_LABEL_VALUE, FULL_NAME_LABEL_VALUE + "\n" + value, 1))


def long_form(authoring, app_id):
    """A ``long`` form of ``full_name``'s label."""
    _label_form(authoring, app_id, "long-form", '<value form="long">Full name of the person</value>')


def markdown_differing(authoring, app_id):
    """A ``markdown`` form of ``full_name``'s label that differs from its default text."""
    _label_form(authoring, app_id, "markdown-differing", '<value form="markdown">Full **name**</value>')


def label_qrcode(authoring, app_id):
    """A ``qrcode`` form of ``full_name``'s label."""
    _label_form(authoring, app_id, "label-qrcode", '<value form="qrcode">household</value>')


def label_tts(authoring, app_id):
    """A ``tts`` form of ``full_name``'s label."""
    _label_form(authoring, app_id, "label-tts", '<value form="tts">Say the full name</value>')


FULL_NAME_HELP_VALUE = "<value>The name the household is known by</value>"
MEMBERS_LABEL_VALUE = '<text id="members-label">\n\t\t\t\t\t\t<value>Members</value>'


def long_form_on_help(authoring, app_id):
    """A ``long`` form of ``full_name``'s help text, which both runtimes show in place of the help text."""
    _change(
        authoring,
        app_id,
        "long-form-on-help",
        (FULL_NAME_HELP_VALUE, FULL_NAME_HELP_VALUE + '<value form="long">Ask who heads the household</value>', 1),
    )


def qrcode_on_help(authoring, app_id):
    """A ``qrcode`` form of ``full_name``'s help text, which no runtime asks a help text for."""
    _change(
        authoring,
        app_id,
        "qrcode-on-help",
        (FULL_NAME_HELP_VALUE, FULL_NAME_HELP_VALUE + '<value form="qrcode">household</value>', 1),
    )


def long_form_on_group_label(authoring, app_id):
    """A ``long`` form of the ``members`` repeat's label, which both runtimes show as its header."""
    _change(
        authoring,
        app_id,
        "long-form-on-group-label",
        (MEMBERS_LABEL_VALUE, MEMBERS_LABEL_VALUE + '<value form="long">Every member of the household</value>', 1),
    )


def xhtml_inside_value(authoring, app_id):
    """An XHTML ``b`` element inside the default text of ``full_name``'s label."""
    _change(authoring, app_id, "xhtml-inside-value", (FULL_NAME_LABEL_VALUE, "<value>Full <h:b>name</h:b></value>", 1))


def plain_label_holding_markup(authoring, app_id):
    """``weight``'s label, which holds no ``markdown`` form, given text Web Apps reads as markup when it draws a
    plain label (``Weight in <b>kilograms</b>``, escaped in the source as the form builder escapes typed text)."""
    _change(
        authoring,
        app_id,
        "plain-label-holding-markup",
        ("<value>Weight in kilograms</value>", "<value>Weight in &lt;b&gt;kilograms&lt;/b&gt;</value>", 1),
    )


def label_without_default_text(authoring, app_id):
    """``full_name``'s label holding a ``long`` form and no default text."""
    _change(
        authoring,
        app_id,
        "label-without-default-text",
        (FULL_NAME_LABEL_VALUE, '<value form="long">Full name</value>', 1),
    )


def markdown_formatting_off(authoring, app_id):
    """A ``markdown`` form of ``said``'s label in the second form, whose text formatting is off."""
    _change(
        authoring,
        app_id,
        "markdown-formatting-off",
        (SAID_LABEL_VALUE, SAID_LABEL_VALUE + '\n<value form="markdown">Write *exactly* what was said</value>', 1),
        form=1,
    )


def hint_on_label(authoring, app_id):
    """A hint on the label ``intro``."""
    _change(
        authoring,
        app_id,
        "hint-on-label",
        (INTRO_LABEL, INTRO_LABEL + "\n<hint ref=\"jr:itext('intro-hint')\" />", 1),
        (
            '<text id="full_name-label">',
            '<text id="intro-hint"><value>Read this first</value></text>\n<text id="full_name-label">',
            1,
        ),
    )


def help_on_capture(authoring, app_id):
    """A help text on the image question ``photo``."""
    _change(
        authoring,
        app_id,
        "help-on-capture",
        (PHOTO_LABEL, PHOTO_LABEL + "\n<help ref=\"jr:itext('photo-help')\" />", 1),
        (
            '<text id="photo-label">',
            '<text id="photo-help"><value>Stand back from the house</value></text>\n<text id="photo-label">',
            1,
        ),
    )


def output_only_expression_text(authoring, app_id):
    """An itext entry ``note`` that only an output of ``intro``'s label reads (``jr:itext('note')``)."""
    _change(
        authoring,
        app_id,
        "output-only-expression-text",
        ("Answer each question.", "Answer each question <output value=\"jr:itext('note')\" />.", 1),
        ('<text id="full_name-label">', '<text id="note"><value>Note</value></text>\n<text id="full_name-label">', 1),
    )


def pragma_entry(authoring, app_id):
    """An itext entry ``Pragma-Submit-Automatically`` that no question references."""
    _change(
        authoring,
        app_id,
        "pragma-entry",
        (
            '<text id="full_name-label">',
            '<text id="Pragma-Submit-Automatically"><value>true</value></text>\n<text id="full_name-label">',
            1,
        ),
    )


def pragma_question_text(authoring, app_id):
    """``weight``'s label text given the itext id ``Pragma-Volatility-Key``."""
    _change(
        authoring,
        app_id,
        "pragma-question-text",
        ('"weight-label"', '"Pragma-Volatility-Key"', 1),
        ("jr:itext('weight-label')", "jr:itext('Pragma-Volatility-Key')", 1),
    )


def pragma_presence_text(authoring, app_id):
    """``weight``'s label text given the itext id ``Pragma-Submit-Automatically``."""
    _change(
        authoring,
        app_id,
        "pragma-presence-text",
        ('"weight-label"', '"Pragma-Submit-Automatically"', 1),
        ("jr:itext('weight-label')", "jr:itext('Pragma-Submit-Automatically')", 1),
    )


def pragma_form_descriptor_text(authoring, app_id):
    """``weight``'s label text given the itext id ``Pragma-Form-Descriptor``."""
    _change(
        authoring,
        app_id,
        "pragma-form-descriptor-text",
        ('"weight-label"', '"Pragma-Form-Descriptor"', 1),
        ("jr:itext('weight-label')", "jr:itext('Pragma-Form-Descriptor')", 1),
    )


def duplicate_text_id(authoring, app_id):
    """A second itext entry ``weight-label`` in the one translation."""
    _change(
        authoring, app_id, "duplicate-text-id", (WEIGHT_LABEL_TEXT, WEIGHT_LABEL_TEXT + "\n" + WEIGHT_LABEL_TEXT, 1)
    )


# hq-kept-settings' form, in English and French.
NOTE_EN = "<value>Note</value>"
NOTE_FRA = "<value>Remarque de la tournée</value>"


def markdown_one_language(authoring, app_id):
    """A ``markdown`` form of ``note``'s label in French alone, which the default language lacks."""
    _change(
        authoring,
        app_id,
        "markdown-one-language",
        (NOTE_FRA, NOTE_FRA + '<value form="markdown">Remarque *de la* tournée</value>', 1),
    )


def media_one_language(authoring, app_id):
    """An image on ``note``'s label in French alone, at the Android home logo's path."""
    _change(
        authoring,
        app_id,
        "media-one-language",
        (NOTE_FRA, NOTE_FRA + '<value form="image">jr://file/commcare/logo/data/hq_logo_android_home.png</value>', 1),
    )


def label_text_one_language(authoring, app_id):
    """A ``long`` form of ``note``'s label in French alone, a key the English default lacks."""
    _change(
        authoring,
        app_id,
        "label-text-one-language",
        (NOTE_FRA, NOTE_FRA + '<value form="long">Remarque de la tournée, en détail</value>', 1),
    )


def media_empty_translation(authoring, app_id):
    """Core keeps this blank value; Vellum fills it with the English image on save."""
    _change(
        authoring, app_id, "media-empty-translation",
        (NOTE_EN, NOTE_EN + '<value form="image">jr://file/commcare/logo/data/hq_logo_android_home.png</value>', 1),
        (NOTE_FRA, NOTE_FRA + '<value form="image"/>', 1),
    )


def localized_label_images(authoring, app_id):
    """The same question shows a different existing Project image in each language."""
    _change(
        authoring, app_id, "localized-label-images",
        (NOTE_EN, NOTE_EN + '<value form="image">jr://file/commcare/logo/data/hq_logo_android_home.png</value>', 1),
        (NOTE_FRA, NOTE_FRA + '<value form="image">jr://file/commcare/logo/data/hq_logo_android_login.png</value>', 1),
    )


def outputs_differ(authoring, app_id):
    """``note``'s French label showing the answer to ``note``, which its English label does not."""
    _change(authoring, app_id, "outputs-differ", (NOTE_FRA, '<value>Remarque <output value="/data/note" /></value>', 1))


def blank_first_language(authoring, app_id):
    """``note``'s English label blank where its French one holds text."""
    _change(authoring, app_id, "blank-first-language", (NOTE_EN, "<value />", 1))


# hq-media's first form, whose label and choices hold media at HQ's own paths.
ANIMAL_NAME_IMAGE = '<value form="image">jr://file/commcare/image/data/animal_name.png</value>'


def label_video_inline(authoring, app_id):
    """A ``video-inline`` form of ``animal_name``'s label, at the path its video form names."""
    _change(
        authoring,
        app_id,
        "label-video-inline",
        (
            ANIMAL_NAME_IMAGE,
            ANIMAL_NAME_IMAGE + '\n<value form="video-inline">jr://file/commcare/video/data/animal_name.mp4</value>',
            1,
        ),
    )


def label_big_image(authoring, app_id):
    """A ``big-image`` form of ``animal_name``'s label, at the path of the goat choice's image."""
    _change(
        authoring,
        app_id,
        "label-big-image",
        (
            ANIMAL_NAME_IMAGE,
            ANIMAL_NAME_IMAGE + '\n<value form="big-image">jr://file/commcare/image/data/animal-goat.png</value>',
            1,
        ),
    )


def choice_big_image(authoring, app_id):
    """A ``big-image`` form of the goat choice's label, at the path of ``animal_name``'s image."""
    _change(
        authoring,
        app_id,
        "choice-big-image",
        (
            '<value form="image">jr://file/commcare/image/data/animal-goat.png</value>',
            '<value form="image">jr://file/commcare/image/data/animal-goat.png</value>\n'
            '<value form="big-image">jr://file/commcare/image/data/animal_name.png</value>',
            1,
        ),
    )


PLACE_NOTE_INPUT = (
    '<input vellum:ref="#form/place_note" ref="/data/place_note">\n'
    "\t\t\t<label ref=\"jr:itext('place_note-label')\" />\n\t\t</input>"
)


def help_media_on_label(authoring, app_id):
    """``place_note`` made a label, with a help whose itext holds an image at the path its label's image names and
    a blank text."""
    _change(
        authoring,
        app_id,
        "help-media-on-label",
        ('nodeset="/data/place_note" type="xsd:string" />', 'nodeset="/data/place_note" />', 1),
        (
            PLACE_NOTE_INPUT,
            '<trigger vellum:ref="#form/place_note" ref="/data/place_note" appearance="minimal">\n'
            "<label ref=\"jr:itext('place_note-label')\" />\n<help ref=\"jr:itext('place_note-help')\" />\n</trigger>",
            1,
        ),
        (
            '<text id="loose_note-label">',
            '<text id="place_note-help"><value />'
            '<value form="image">jr://file/commcare/image/data/place.png</value></text>\n<text id="loose_note-label">',
            1,
        ),
    )


# Appearances ---------------------------------------------------------------------------------------------------------

# Each question's control as the first form holds it, and the appearance it holds there (None: none).
CONTROLS = {
    "intro": (INTRO_TRIGGER, "minimal"),
    "full_name": (FULL_NAME_INPUT, None),
    "phone": ('<input vellum:ref="#form/phone" ref="/data/phone" appearance="numeric">', "numeric"),
    "pin": (PIN_CONTROL, None),
    "visit_date": ('<input vellum:ref="#form/visit_date" ref="/data/visit_date">', None),
    "visit_time": ('<input vellum:ref="#form/visit_time" ref="/data/visit_time">', None),
    "location": ('<input vellum:ref="#form/location" ref="/data/location">', None),
    "tag_code": (TAG_CODE_INPUT, None),
    "colour": ('<select1 vellum:ref="#form/colour" ref="/data/colour">', None),
    "crops": ('<select vellum:ref="#form/crops" ref="/data/crops">', None),
    "photo": (PHOTO_UPLOAD, None),
    "voice": ('<upload mediatype="audio/*" vellum:ref="#form/voice" ref="/data/voice">', None),
    "clip": ('<upload mediatype="video/*" vellum:ref="#form/clip" ref="/data/clip">', None),
    "details": ('<group vellum:ref="#form/details" ref="/data/details" appearance="field-list">', "field-list"),
    "members": ("<group>\n\t\t\t<label ref=\"jr:itext('members-label')\" />", None),
}


def _appearance(authoring, app_id, what, question, value):
    """``question``'s control given the appearance ``value``, in place of the one it holds."""
    control, held = CONTROLS[question]
    if held is not None:
        changed = control.replace(f'appearance="{held}"', f'appearance="{value}"')
    elif control.startswith("<group>"):
        changed = control.replace("<group>", f'<group appearance="{value}">', 1)
    else:
        changed = control[:-1] + f' appearance="{value}">'
    _change(authoring, app_id, what, (control, changed, 1))


def select1_minimal(authoring, app_id):
    """The single select ``colour`` with the appearance ``minimal``."""
    _appearance(authoring, app_id, "select1-minimal", "colour", "minimal")


def select1_compact(authoring, app_id):
    """The single select ``colour`` with the appearance ``compact-2``."""
    _appearance(authoring, app_id, "select1-compact", "colour", "compact-2")


def select1_quick(authoring, app_id):
    """The single select ``colour`` with the appearance ``quick``."""
    _appearance(authoring, app_id, "select1-quick", "colour", "quick")


def select1_quick_compact(authoring, app_id):
    """The single select ``colour`` with the appearance ``quick compact-2``."""
    _appearance(authoring, app_id, "select1-quick-compact", "colour", "quick compact-2")


def select1_combobox(authoring, app_id):
    """The single select ``colour`` with the appearance ``combobox``."""
    _appearance(authoring, app_id, "select1-combobox", "colour", "combobox")


def select1_combobox_multiword(authoring, app_id):
    """The single select ``colour`` with the appearance ``combobox multiword``."""
    _appearance(authoring, app_id, "select1-combobox-multiword", "colour", "combobox multiword")


def select1_combobox_fuzzy(authoring, app_id):
    """The single select ``colour`` with the appearance ``combobox fuzzy``."""
    _appearance(authoring, app_id, "select1-combobox-fuzzy", "colour", "combobox fuzzy")


def select1_list(authoring, app_id):
    """The single select ``colour`` with the appearance ``list``."""
    _appearance(authoring, app_id, "select1-list", "colour", "list")


def select1_list_nolabel(authoring, app_id):
    """The single select ``colour`` with the appearance ``list-nolabel``."""
    _appearance(authoring, app_id, "select1-list-nolabel", "colour", "list-nolabel")


def select1_label(authoring, app_id):
    """The single select ``colour`` with the appearance ``label``."""
    _appearance(authoring, app_id, "select1-label", "colour", "label")


def select1_button_select(authoring, app_id):
    """The single select ``colour`` with the appearance ``button-select``."""
    _appearance(authoring, app_id, "select1-button-select", "colour", "button-select")


def select1_receive(authoring, app_id):
    """The single select ``colour`` with the appearance ``receive-household-colour``."""
    _appearance(authoring, app_id, "select1-receive", "colour", "receive-household-colour")


def select_minimal(authoring, app_id):
    """The multi-select ``crops`` with the appearance ``minimal``."""
    _appearance(authoring, app_id, "select-minimal", "crops", "minimal")


def select_compact(authoring, app_id):
    """The multi-select ``crops`` with the appearance ``compact``."""
    _appearance(authoring, app_id, "select-compact", "crops", "compact")


def select_list(authoring, app_id):
    """The multi-select ``crops`` with the appearance ``list``."""
    _appearance(authoring, app_id, "select-list", "crops", "list")


def select_list_nolabel(authoring, app_id):
    """The multi-select ``crops`` with the appearance ``list-nolabel``."""
    _appearance(authoring, app_id, "select-list-nolabel", "crops", "list-nolabel")


def select_label(authoring, app_id):
    """The multi-select ``crops`` with the appearance ``label``."""
    _appearance(authoring, app_id, "select-label", "crops", "label")


def secret_numeric(authoring, app_id):
    """The password question ``pin`` with the appearance ``numeric``."""
    _appearance(authoring, app_id, "secret-numeric", "pin", "numeric")


def text_numbers(authoring, app_id):
    """The text question ``full_name`` with the appearance ``numbers``."""
    _appearance(authoring, app_id, "text-numbers", "full_name", "numbers")


def text_short(authoring, app_id):
    """The text question ``full_name`` with the appearance ``short``."""
    _appearance(authoring, app_id, "text-short", "full_name", "short")


def text_medium(authoring, app_id):
    """The text question ``full_name`` with the appearance ``medium``."""
    _appearance(authoring, app_id, "text-medium", "full_name", "medium")


def text_address(authoring, app_id):
    """The text question ``full_name`` with the appearance ``address``."""
    _appearance(authoring, app_id, "text-address", "full_name", "address")


def upload_broadcast(authoring, app_id):
    """The image question ``photo`` with the appearance ``broadcast-photos``."""
    _appearance(authoring, app_id, "upload-broadcast", "photo", "broadcast-photos")


def text_receive(authoring, app_id):
    """The text question ``full_name`` with the appearance ``receive-household-name``."""
    _appearance(authoring, app_id, "text-receive", "full_name", "receive-household-name")


def barcode_numeric(authoring, app_id):
    """The barcode question ``tag_code`` with the appearance ``numeric``."""
    _appearance(authoring, app_id, "barcode-numeric", "tag_code", "numeric")


def text_hint_as_placeholder(authoring, app_id):
    """The text question ``full_name`` with the appearance ``hint-as-placeholder``."""
    _appearance(authoring, app_id, "text-hint-as-placeholder", "full_name", "hint-as-placeholder")


def date_hint_as_placeholder(authoring, app_id):
    """The date question ``visit_date`` with the appearance ``hint-as-placeholder``."""
    _appearance(authoring, app_id, "date-hint-as-placeholder", "visit_date", "hint-as-placeholder")


def barcode_quick(authoring, app_id):
    """The barcode question ``tag_code`` with the appearance ``quick``."""
    _appearance(authoring, app_id, "barcode-quick", "tag_code", "quick")


def date_ethiopian(authoring, app_id):
    """The date question ``visit_date`` with the appearance ``ethiopian``."""
    _appearance(authoring, app_id, "date-ethiopian", "visit_date", "ethiopian")


def date_nepali(authoring, app_id):
    """The date question ``visit_date`` with the appearance ``nepali``."""
    _appearance(authoring, app_id, "date-nepali", "visit_date", "nepali")


def date_gregorian(authoring, app_id):
    """The date question ``visit_date`` with the appearance ``gregorian``."""
    _appearance(authoring, app_id, "date-gregorian", "visit_date", "gregorian")


def time_12_hour(authoring, app_id):
    """The time question ``visit_time`` with the appearance ``12-hour``."""
    _appearance(authoring, app_id, "time-12-hour", "visit_time", "12-hour")


def geopoint_maps(authoring, app_id):
    """The location question ``location`` with the appearance ``maps``."""
    _appearance(authoring, app_id, "geopoint-maps", "location", "maps")


def barcode_editable(authoring, app_id):
    """The barcode question ``tag_code`` with the appearance ``editable``."""
    _appearance(authoring, app_id, "barcode-editable", "tag_code", "editable")


def image_acquire(authoring, app_id):
    """The image question ``photo`` with the appearance ``acquire``."""
    _appearance(authoring, app_id, "image-acquire", "photo", "acquire")


def image_overlay_small(authoring, app_id):
    """The image question ``photo`` with the appearance ``overlay-small``."""
    _appearance(authoring, app_id, "image-overlay-small", "photo", "overlay-small")


def audio_legacy(authoring, app_id):
    """The audio question ``voice`` with the appearance ``legacy``."""
    _appearance(authoring, app_id, "audio-legacy", "voice", "legacy")


def audio_acquire_or_upload(authoring, app_id):
    """The audio question ``voice`` with the appearance ``acquire-or-upload``."""
    _appearance(authoring, app_id, "audio-acquire-or-upload", "voice", "acquire-or-upload")


def audio_long(authoring, app_id):
    """The audio question ``voice`` with the appearance ``long``."""
    _appearance(authoring, app_id, "audio-long", "voice", "long")


def video_acquire(authoring, app_id):
    """The video question ``clip`` with the appearance ``acquire``."""
    _appearance(authoring, app_id, "video-acquire", "clip", "acquire")


def label_selectable(authoring, app_id):
    """The label ``intro`` with the appearance ``selectable``."""
    _appearance(authoring, app_id, "label-selectable", "intro", "selectable")


def label_floating_good(authoring, app_id):
    """The label ``intro`` with the appearance ``floating-good``."""
    _appearance(authoring, app_id, "label-floating-good", "intro", "floating-good")


def label_floating_other(authoring, app_id):
    """The label ``intro`` with the appearance ``floating-note``."""
    _appearance(authoring, app_id, "label-floating-other", "intro", "floating-note")


def group_compact(authoring, app_id):
    """The group ``details`` with the appearance ``compact`` in place of ``field-list``."""
    _appearance(authoring, app_id, "group-compact", "details", "compact")


def group_collapse(authoring, app_id):
    """The group ``details`` with the appearance ``group-collapse`` in place of ``field-list``."""
    _appearance(authoring, app_id, "group-collapse", "details", "group-collapse")


def group_collapse_open(authoring, app_id):
    """The group ``details`` with the appearance ``collapse-open`` in place of ``field-list``."""
    _appearance(authoring, app_id, "group-collapse-open", "details", "collapse-open")


def group_border(authoring, app_id):
    """The group ``details`` with the appearance ``group-border`` in place of ``field-list``."""
    _appearance(authoring, app_id, "group-border", "details", "group-border")


def text_two_per_row(authoring, app_id):
    """The text question ``full_name`` with the appearance ``2-per-row``."""
    _appearance(authoring, app_id, "text-two-per-row", "full_name", "2-per-row")


def repeat_group_two_per_row(authoring, app_id):
    """The group around the repeat ``members`` with the appearance ``2-per-row-repeat``."""
    _appearance(authoring, app_id, "repeat-group-two-per-row", "members", "2-per-row-repeat")


def text_per_row_other(authoring, app_id):
    """The text question ``full_name`` with the appearance ``1x2-per-row``."""
    _appearance(authoring, app_id, "text-per-row-other", "full_name", "1x2-per-row")


def text_per_row_without_digits(authoring, app_id):
    """The text question ``full_name`` with the appearance ``x2-per-row``."""
    _appearance(authoring, app_id, "text-per-row-without-digits", "full_name", "x2-per-row")


def text_per_row_holding_receive(authoring, app_id):
    """The text question ``full_name`` with the appearance ``2receive3-per-row``."""
    _appearance(authoring, app_id, "text-per-row-holding-receive", "full_name", "2receive3-per-row")


def text_align_center(authoring, app_id):
    """The text question ``full_name`` with the appearance ``text-align-center``."""
    _appearance(authoring, app_id, "text-align-center", "full_name", "text-align-center")


def appearance_trailing_space(authoring, app_id):
    """The single select ``colour`` with the appearance ``minimal`` and a trailing space."""
    _appearance(authoring, app_id, "appearance-trailing-space", "colour", "minimal ")


def appearance_several_tokens(authoring, app_id):
    """The single select ``colour`` with the appearance ``minimal hint-as-placeholder``."""
    _appearance(authoring, app_id, "appearance-several-tokens", "colour", "minimal hint-as-placeholder")


def appearance_unread_token_dropped(authoring, app_id):
    """The single select ``colour`` with the appearance ``minimal hint-as-placeholder foo``."""
    _appearance(authoring, app_id, "appearance-unread-token-dropped", "colour", "minimal hint-as-placeholder foo")


def appearance_unread_token_refused(authoring, app_id):
    """The single select ``colour`` with the appearance ``minimal foo``."""
    _appearance(authoring, app_id, "appearance-unread-token-refused", "colour", "minimal foo")


def appearance_android_inside_held(authoring, app_id):
    """The single select ``colour`` with the appearance ``compact2``."""
    _appearance(authoring, app_id, "appearance-android-inside-held", "colour", "compact2")


def appearance_android_inside_refused(authoring, app_id):
    """The single select ``colour`` with the appearance ``combobox2``."""
    _appearance(authoring, app_id, "appearance-android-inside-refused", "colour", "combobox2")


def appearance_case_variant_held(authoring, app_id):
    """The text question ``full_name`` with the appearance ``Numbers``."""
    _appearance(authoring, app_id, "appearance-case-variant-held", "full_name", "Numbers")


def appearance_case_variant_refused(authoring, app_id):
    """The phone number question ``phone`` with the appearance ``Numeric`` in place of ``numeric``."""
    _appearance(authoring, app_id, "appearance-case-variant-refused", "phone", "Numeric")


# Save to Case --------------------------------------------------------------------------------------------------------
# A Save to Case create of a ``household`` named by ``full_name``, in the shape Nova's own export writes one (its
# trimmed name and owner, and the guard block that refuses a blank or long name or owner), put in the first form of
# hq-questions; each change below then makes one thing of it otherwise.

CASE_XMLNS = 'xmlns="http://commcarehq.org/case/transaction/v2"'
TRIM = "&apos;^[\\x00-\\x20]+|[\\x00-\\x20]+$&apos;, &apos;&apos;"
OPS = "/data/nova_operations"
MAKE = f"{OPS}/make_household/case"
GUARD = f"{OPS}/nova_guard_make_household_text/case"
STC_CREATE = "<create><case_type/><case_name/><owner_id/></create>"
STC_UPDATE = "<update><head/></update>"
STC_DATA = (
    '<nova_operations><make_household vellum:role="SaveToCase" vellum:case_type="household">'
    f'<case case_id="" date_modified="" user_id="" {CASE_XMLNS}>{STC_CREATE}{STC_UPDATE}</case></make_household>'
    '<nova_guard_make_household_text vellum:role="SaveToCase" vellum:case_type="household">'
    f'<case case_id="" date_modified="" user_id="" {CASE_XMLNS}><update><case_type/></update></case>'
    "</nova_guard_make_household_text></nova_operations>"
)
STC_TYPE_BIND = f'<bind nodeset="{MAKE}/create/case_type" calculate="&apos;household&apos;"/>'
STC_NAME_BIND = f'<bind nodeset="{MAKE}/create/case_name" calculate="replace(/data/full_name, {TRIM})"/>'
STC_OWNER_BIND = f'<bind nodeset="{MAKE}/create/owner_id" calculate="replace(/data/meta/userID, {TRIM})"/>'
STC_HEAD_BIND = f'<bind nodeset="{MAKE}/update/head" calculate="/data/full_name"/>'
STC_ID_SETVALUE = f'<setvalue event="xforms-ready" ref="{MAKE}/@case_id" value="uuid()"/>'
GUARD_NAME = "current()/../../../make_household/case/create/case_name"
GUARD_OWNER = "current()/../../../make_household/case/create/owner_id"
STC_BINDS = "".join(
    [
        STC_TYPE_BIND,
        STC_NAME_BIND,
        STC_OWNER_BIND,
        STC_HEAD_BIND,
        f'<bind type="xsd:dateTime" nodeset="{MAKE}/@date_modified" calculate="/data/meta/timeEnd"/>',
        f'<bind nodeset="{MAKE}/@user_id" calculate="/data/meta/userID"/>',
        f'<bind nodeset="{GUARD}/update/case_type" calculate="&apos;household&apos;"/>',
        f'<bind type="xsd:dateTime" nodeset="{GUARD}/@date_modified" calculate="/data/meta/timeEnd"/>',
        f'<bind nodeset="{GUARD}/@user_id" calculate="/data/meta/userID"/>',
        f'<bind nodeset="{GUARD}/@case_id" calculate="if(string-length({GUARD_NAME}) &gt; 0 and'
        f" string-length({GUARD_NAME}) &lt;= 255 and string-length({GUARD_OWNER}) &gt; 0 and"
        f" string-length({GUARD_OWNER}) &lt;= 255, current()/../../../make_household/case/@case_id,"
        ' &apos;&apos;)"/>',
    ]
)


def _with_save_to_case(text):
    """``text`` with the Save to Case create of a ``household`` put in: its data first in the form's data, its
    binds after the form's own, the setvalue of its case id before the form's own setvalues, and its group first in
    the body."""
    return _replaced(
        text,
        [
            ("<intro />", STC_DATA + "\n\t\t\t\t\t<intro />", 1),
            (FIRST_SETVALUE, STC_BINDS + STC_ID_SETVALUE + "\n\t\t\t" + FIRST_SETVALUE, 1),
            ("<h:body>", f'<h:body>\n\t\t<group ref="{OPS}"/>', 1),
        ],
    )


def _save_to_case(authoring, app_id, what, *pairs):
    """The first form with the Save to Case create put in and ``pairs`` then replaced in it."""
    _edit(authoring, app_id, what, lambda text: _replaced(_with_save_to_case(text), pairs))


def save_to_case_bare_name(authoring, app_id):
    """The create's name the bare answer ``full_name``, as the form builder writes it, where Nova trims it."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-bare-name",
        (STC_NAME_BIND, f'<bind nodeset="{MAKE}/create/case_name" calculate="/data/full_name"/>', 1),
    )


def save_to_case_type_expression(authoring, app_id):
    """The create's case type calculated ``concat('house', 'hold')``."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-type-expression",
        (
            'make_household vellum:role="SaveToCase" vellum:case_type="household"',
            'make_household vellum:role="SaveToCase" vellum:case_type=""',
            1,
        ),
        (
            STC_TYPE_BIND,
            f'<bind nodeset="{MAKE}/create/case_type" calculate="concat(&apos;house&apos;, &apos;hold&apos;)"/>',
            1,
        ),
    )
    _computed_type_references(authoring, app_id, guard_type="household")


def _computed_type_references(authoring, app_id, *, guard_type):
    # The source upload and the reference rows together reproduce a Vellum save.
    ops.set_json(authoring, app_id, "/modules/0/forms/0/case_references_data/save", {
        f"{OPS}/make_household": {
            "doc_type": "CaseSaveReference",
            "case_type": "",
            "properties": ["head", "case_type", "case_name", "owner_id"],
            "create": True,
            "close": False,
        },
        f"{OPS}/nova_guard_make_household_text": {
            "doc_type": "CaseSaveReference",
            "case_type": guard_type,
            "properties": ["case_type"],
            "create": False,
            "close": False,
        },
    })


def save_to_case_declared_type_choice(authoring, app_id):
    """Two declared case types, the same saved field and a guard reading the computed type."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    from proof.matrix.bases import _pages

    def visit_form(name):
        form = XFormBuilder(name)
        form.new_question("note", "Note", "string")
        return form.tostring().decode("utf-8")

    _pages.new_survey_module(authoring, app_id, name="Visits")
    ops.upload_form_source(authoring, app_id, 1, 0, visit_form, "visit-type-carrier")
    ops.set_json(authoring, app_id, "/modules/0/case_type", "household")
    ops.set_json(authoring, app_id, "/modules/1/case_type", "visit")
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-declared-type-choice",
        ('vellum:role="SaveToCase" vellum:case_type="household"',
         'vellum:role="SaveToCase" vellum:case_type=""', 2),
        (STC_TYPE_BIND,
         f'<bind nodeset="{MAKE}/create/case_type" calculate="if(/data/age &gt; 5, &apos;household&apos;, &apos;visit&apos;)"/>',
         1),
        (f'<bind nodeset="{GUARD}/update/case_type" calculate="&apos;household&apos;"/>',
         f'<bind nodeset="{GUARD}/update/case_type" calculate="current()/../../../../make_household/case/create/case_type"/>',
         1),
    )
    _computed_type_references(authoring, app_id, guard_type="")


def save_to_case_dynamic_type(authoring, app_id):
    """Vellum clears the fixed-type metadata when the create's type uses an answer."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-dynamic-type",
        (
            'make_household vellum:role="SaveToCase" vellum:case_type="household"',
            'make_household vellum:role="SaveToCase" vellum:case_type=""',
            1,
        ),
        (
            STC_TYPE_BIND,
            f'<bind nodeset="{MAKE}/create/case_type" calculate="if(/data/age &gt; 5, &apos;household&apos;, &apos;visit&apos;)"/>',
            1,
        ),
    )


def save_to_case_authored_id(authoring, app_id):
    """The create's case id set when the form loads to ``concat('h-', today())``."""
    _save_to_case(
        authoring, app_id, "save-to-case-authored-id", ('value="uuid()"', "value=\"concat('h-', today())\"", 1)
    )


def save_to_case_blank_id(authoring, app_id):
    """The create's case id set when the form loads to the answer ``full_name``, which is blank then."""
    _save_to_case(authoring, app_id, "save-to-case-blank-id", ('value="uuid()"', 'value="/data/full_name"', 1))


def save_to_case_live_id(authoring, app_id):
    """The create's case id calculated (``uuid()``) by a bind in place of its setvalue."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-live-id",
        (STC_ID_SETVALUE, f'<bind nodeset="{MAKE}/@case_id" calculate="uuid()"/>', 1),
    )


def save_to_case_type_outside_grammar(authoring, app_id):
    """The create's case type ``house hold``, at the block and its rows."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-type-outside-grammar",
        ('vellum:case_type="household"', 'vellum:case_type="house hold"', 2),
        ('calculate="&apos;household&apos;"', 'calculate="&apos;house hold&apos;"', 2),
    )


def save_to_case_reserved_key(authoring, app_id):
    """The create's update row ``head`` renamed ``date_opened``, a word a case keeps for its own facts."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-reserved-key",
        ("<update><head/></update>", "<update><date_opened/></update>", 1),
        (f"{MAKE}/update/head", f"{MAKE}/update/date_opened", 1),
    )


def save_to_case_user_type(authoring, app_id):
    """The create's case type ``commcare-user``, the worker's record, at the block and its rows."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-user-type",
        ('vellum:case_type="household"', 'vellum:case_type="commcare-user"', 2),
        ('calculate="&apos;household&apos;"', 'calculate="&apos;commcare-user&apos;"', 2),
    )


def save_to_case_block_relevance(authoring, app_id):
    """A display condition on the create's own node."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-block-relevance",
        (STC_TYPE_BIND, f'<bind nodeset="{OPS}/make_household" relevant="/data/age &gt; 5"/>' + STC_TYPE_BIND, 1),
    )


def save_to_case_leaf_constraint(authoring, app_id):
    """A validation condition on the create's update row ``head``."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-leaf-constraint",
        (
            STC_HEAD_BIND,
            f'<bind nodeset="{MAKE}/update/head" calculate="/data/full_name" constraint=". != &apos;&apos;"/>',
            1,
        ),
    )


def save_to_case_leaf_type(authoring, app_id):
    """The create's update row ``head`` bound ``xsd:string``."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-leaf-type",
        (STC_HEAD_BIND, f'<bind type="xsd:string" nodeset="{MAKE}/update/head" calculate="/data/full_name"/>', 1),
    )


def save_to_case_attachment(authoring, app_id):
    """An ``attachment`` element in the create's case block."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-attachment",
        (
            STC_UPDATE + "</case></make_household>",
            STC_UPDATE + "<attachment><photo/></attachment></case></make_household>",
            1,
        ),
    )


def save_to_case_owner_condition(authoring, app_id):
    """A condition on the create's owner row (``relevant`` on ``create/owner_id``)."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-owner-condition",
        (STC_OWNER_BIND, STC_OWNER_BIND[: -len("/>")] + ' relevant="/data/age &gt; 5"/>', 1),
        (
            f"string-length({GUARD_NAME}) &gt; 0 and string-length({GUARD_NAME}) &lt;= 255 and"
            f" string-length({GUARD_OWNER}) &gt; 0 and string-length({GUARD_OWNER}) &lt;= 255",
            f"(not(/data/age &gt; 5) or string-length({GUARD_OWNER}) &gt; 0 and"
            f" string-length({GUARD_OWNER}) &lt;= 255) and string-length({GUARD_NAME}) &gt; 0 and"
            f" string-length({GUARD_NAME}) &lt;= 255",
            1,
        ),
    )


def save_to_case_conditional_owner_aliased_create(authoring, app_id):
    """The case can already exist when its conditional owner leaf is absent."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-conditional-owner-aliased-create",
        (STC_OWNER_BIND, STC_OWNER_BIND[: -len("/>")] + ' relevant="/data/age &gt; 5"/>', 1),
        (STC_ID_SETVALUE, STC_ID_SETVALUE.replace('uuid()', "'household-01'"), 1),
    )


def save_to_case_update_owner_condition(authoring, app_id):
    """The same conditional facet on a targeted update has its own standing."""
    owner_path = GUARD_OWNER.replace("/create/", "/update/")
    existing_household = (
        "instance(&apos;casedb&apos;)/casedb/case"
        "[@case_id = &apos;household-01&apos; and @case_type = &apos;household&apos;]/@case_id"
    )
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-update-owner-condition",
        (STC_CREATE + STC_UPDATE, '<update><owner_id/><head/></update>', 1),
        (STC_TYPE_BIND, '', 1),
        (STC_NAME_BIND, '', 1),
        (
            STC_OWNER_BIND,
            STC_OWNER_BIND.replace('/create/owner_id', '/update/owner_id')[: -len("/>")] + ' relevant="/data/age &gt; 5"/>',
            1,
        ),
        (STC_ID_SETVALUE, f'<bind nodeset="{MAKE}/@case_id" calculate="{existing_household}"/>', 1),
        (
            f"string-length({GUARD_NAME}) &gt; 0 and string-length({GUARD_NAME}) &lt;= 255 and"
            f" string-length({GUARD_OWNER}) &gt; 0 and string-length({GUARD_OWNER}) &lt;= 255",
            f"not(/data/age &gt; 5) or string-length({owner_path}) &gt; 0 and"
            f" string-length({owner_path}) &lt;= 255",
            1,
        ),
    )


def save_to_case_create_with_conditioned_owner_update(authoring, app_id):
    """A create's later update of the owner is a separate effect from its create owner."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-create-with-conditioned-owner-update",
        (STC_UPDATE, "<update><head/><owner_id/></update>", 1),
        (
            STC_HEAD_BIND,
            STC_HEAD_BIND
            + f'<bind nodeset="{MAKE}/update/owner_id" calculate="/data/full_name"'
            ' relevant="/data/age &gt; 5"/>',
            1,
        ),
    )


def save_to_case_fresh_create_with_later_owner(authoring, app_id):
    """A fresh root create with a later guarded owner inside the same case block."""
    condition = "/data/age &gt; 5"
    owner = GUARD_OWNER.replace("/create/", "/update/")
    existing_guard = (
        f"string-length({GUARD_NAME}) &gt; 0 and string-length({GUARD_NAME}) &lt;= 255 and"
        f" string-length({GUARD_OWNER}) &gt; 0 and string-length({GUARD_OWNER}) &lt;= 255"
    )
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-fresh-create-with-later-owner",
        (STC_UPDATE, "<update><owner_id/><head/></update>", 1),
        (
            STC_HEAD_BIND,
            f'<bind nodeset="{MAKE}/update/owner_id" calculate="replace(/data/full_name, {TRIM})"'
            f' relevant="{condition}"/>' + STC_HEAD_BIND,
            1,
        ),
        (
            existing_guard,
            f"(not({condition}) or string-length({owner}) &gt; 0 and string-length({owner}) &lt;= 255) and "
            + existing_guard,
            1,
        ),
    )


def save_to_case_create_and_close(authoring, app_id):
    """A create that closes its new case only when the close condition holds."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-create-and-close",
        (STC_UPDATE + "</case></make_household>", STC_UPDATE + "<close/></case></make_household>", 1),
        (STC_HEAD_BIND, STC_HEAD_BIND + f'<bind nodeset="{MAKE}/close" relevant="/data/age &gt; 5"/>', 1),
    )


def save_to_case_link_long_name(authoring, app_id):
    """A link of the created case by a name of 256 characters."""
    _save_to_case_link(authoring, app_id, "save-to-case-link-long-name", "p" * 256)


def save_to_case_hyphenated_link_name(authoring, app_id):
    """The create keeps the exact spelling of its hyphenated connection."""
    _save_to_case_link_with_guard(authoring, app_id, "save-to-case-hyphenated-link-name", "par-ent")


def save_to_case_link_name_outside_grammar(authoring, app_id):
    """The bind path contains a period that Vellum does not parse as an index bind."""
    _save_to_case_link(authoring, app_id, "save-to-case-link-name-outside-grammar", "par.ent")


def save_to_case_unicode_link_name(authoring, app_id):
    """A valid XML index name outside Vellum's ASCII bind matcher."""
    _save_to_case_link_with_guard(authoring, app_id, "save-to-case-unicode-link-name", "parént")


def save_to_case_unicode_link_name_cjk(authoring, app_id):
    """An XML index name for which Nova's XPath layer cannot own the bind."""
    _save_to_case_link_with_guard(authoring, app_id, "save-to-case-unicode-link-name-cjk", "亲属")


def save_to_case_link_stops_form_designer(authoring, app_id):
    """An ordinary case link whose element uses the reserved instance name."""
    _save_to_case_link_with_guard(authoring, app_id, "save-to-case-link-stops-form-designer", "instance")


def save_to_case_index_close_adds_action(authoring, app_id):
    """This block creates a case without a close action, before Vellum saves it."""
    _save_to_case_link(authoring, app_id, "save-to-case-index-close-adds-action", "close")


def _save_to_case_link(authoring, app_id, what, name, value="'abc'"):
    """The create with a link ``name`` (a child of a ``household``) to the case whose id is ``value``."""
    _save_to_case(
        authoring,
        app_id,
        what,
        (
            STC_UPDATE + "</case></make_household>",
            STC_UPDATE + f'<index><{name} case_type="household" relationship="child"/></index></case></make_household>',
            1,
        ),
        (STC_HEAD_BIND, STC_HEAD_BIND + f'<bind nodeset="{MAKE}/index/{name}" calculate="{value}"/>', 1),
    )


def save_to_case_link_to_itself(authoring, app_id):
    """A link ``parent`` of the created case to itself."""
    _save_to_case_link(authoring, app_id, "save-to-case-link-to-itself", "parent", value=f"{MAKE}/@case_id")


def save_to_case_without_role(authoring, app_id):
    """The create's block with its ``vellum:role`` removed, a case block written by hand."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-without-role",
        ('<make_household vellum:role="SaveToCase" ', "<make_household ", 1),
    )


def save_to_case_untyped_value(authoring, app_id):
    """The create's update row ``head`` calculated ``/data/age + /data/full_name``, which no type of Nova's
    holds."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-untyped-value",
        (STC_HEAD_BIND, f'<bind nodeset="{MAKE}/update/head" calculate="/data/age + /data/full_name"/>', 1),
    )


# Itemsets: hq-lookups' form, whose selects read lookup tables -------------------------------------------------------

DISTRICTS = "<itemset nodeset=\"instance('item-list:districts')/districts_list/districts\">"
DISTRICT_LABEL = '<label ref="name" />\n\t\t\t\t<value ref="id" />'
VILLAGE_FILTER = 'villages[district = /data/district]"'


from proof.matrix.bases.lookups import changes_lookup_data, qualify_districts


@changes_lookup_data
def itemset_attribute_ref(authoring, app_id):
    """The district select saves a row attribute and labels the filtered French occurrence."""
    qualify_districts(authoring)
    _change(
        authoring,
        app_id,
        "itemset-attribute-ref",
        (DISTRICTS + "\n\t\t\t\t" + DISTRICT_LABEL, DISTRICTS + '\n<label ref="name[@lang=&quot;fr&quot;][1]" />\n<value ref="@row_code" />', 1),
    )


@changes_lookup_data
def itemset_property_as_label(authoring, app_id):
    """A field property's value as a question label, outside Vellum's fixture choices."""
    qualify_districts(authoring)
    _change(
        authoring, app_id, "itemset-property-as-label",
        (DISTRICTS + "\n\t\t\t\t" + DISTRICT_LABEL, DISTRICTS + '\n<label ref="name[1]/@lang" />\n<value ref="id" />', 1),
    )


def itemset_itext_label(authoring, app_id):
    """The district select's choices labelled ``jr:itext(name)``."""
    _change(
        authoring,
        app_id,
        "itemset-itext-label",
        (
            DISTRICTS + "\n\t\t\t\t" + DISTRICT_LABEL,
            DISTRICTS + '\n<label ref="jr:itext(name)" />\n<value ref="id" />',
            1,
        ),
    )


def itemset_sort(authoring, app_id):
    """The district select's choices sorted by ``name`` (``<sort ref>``)."""
    _change(
        authoring,
        app_id,
        "itemset-sort",
        (DISTRICTS + "\n\t\t\t\t" + DISTRICT_LABEL, DISTRICTS + "\n" + DISTRICT_LABEL + '\n<sort ref="name" />', 1),
    )


def itemset_copy(authoring, app_id):
    """The district select's choices copying ``id`` (``<copy ref>``) in place of a value."""
    _change(
        authoring,
        app_id,
        "itemset-copy",
        (DISTRICTS + "\n\t\t\t\t" + DISTRICT_LABEL, DISTRICTS + '\n<label ref="name" />\n<copy ref="id" />', 1),
    )


def itemset_filter_by_row_position(authoring, app_id):
    """The village select reads the first two fixture rows in source order."""
    _change(
        authoring,
        app_id,
        "itemset-filter-by-row-position",
        ('villages[district = #form/district]"', 'villages[position() &lt; 3]"', 1),
        (VILLAGE_FILTER, 'villages[position() &lt; 3]"', 1),
    )


def itemset_filter_outside_predicate(authoring, app_id):
    """A position of an explicitly supplied reference is not the choice candidate's position."""
    _change(
        authoring,
        app_id,
        "itemset-filter-outside-predicate",
        ('villages[district = #form/district]"', 'villages[position(/data/district) &lt; 3]"', 1),
        (VILLAGE_FILTER, 'villages[position(/data/district) &lt; 3]"', 1),
    )


def itemset_filter_position_of_scalar(authoring, app_id):
    """The Core position function with an argument expects a nodeset."""
    _change(
        authoring,
        app_id,
        "itemset-filter-position-of-scalar",
        ('villages[district = #form/district]"', 'villages[position(3) &lt; 3]"', 1),
        (VILLAGE_FILTER, 'villages[position(3) &lt; 3]"', 1),
    )


def itemset_filter_numeric_row_index(authoring, app_id):
    """A bare numeric predicate chooses a single one-based fixture row."""
    def change(tree, form):
        itemset, = tree.xpath(
            "//*[local-name()='select1' and @ref='/data/village']/*[local-name()='itemset']"
        )
        for key, value in itemset.attrib.items():
            if key == "nodeset" or key.endswith("}nodeset"):
                source, _, _ = value.partition("[")
                itemset.set(key, source + "[2]")
    ops.set_form_source(authoring, app_id, 0, 0, change, what="itemset-filter-numeric-row-index")


def itemset_over_cases(authoring, app_id):
    """The district select's choices read from every case the worker holds (``instance('casedb')``), declared in
    the model, in place of the table."""
    _case_itemset(authoring, app_id, "itemset-over-cases", "")


def itemset_over_open_cases(authoring, app_id):
    """The district select filters the worker's cases across all case types."""
    _case_itemset(authoring, app_id, "itemset-over-open-cases", "[@status = &apos;open&apos;]")


def itemset_over_closed_cases(authoring, app_id):
    """A closed-only all-type itemset lies outside the admitted open selector."""
    _case_itemset(authoring, app_id, "itemset-over-closed-cases", "[@status = &apos;closed&apos;]")


def _case_itemset(authoring, app_id, name, predicate):
    _change(
        authoring,
        app_id,
        name,
        (
            '<instance id="item-list:seasons"',
            '<instance src="jr://instance/casedb" id="casedb" />\n<instance id="item-list:seasons"',
            1,
        ),
        (
            DISTRICTS + "\n\t\t\t\t" + DISTRICT_LABEL,
            f'<itemset nodeset="instance(\'casedb\')/casedb/case{predicate}">'
            '\n<label ref="case_name" />\n<value ref="@case_id" />',
            1,
        ),
    )


# Case management: hq-new-app's registration form, which opens a case --------------------------------------------------


def root_question_case(authoring, app_id):
    """A text question ``case`` at the root of the registration form, where HQ writes the form's case block."""
    _change(
        authoring,
        app_id,
        "root-question-case",
        ("<full_name />", "<full_name />\n<case />", 1),
        (
            'nodeset="/data/full_name" type="xsd:string" />',
            'nodeset="/data/full_name" type="xsd:string" />\n<bind nodeset="/data/case" type="xsd:string" />',
            1,
        ),
        ("\t</h:body>", '<input ref="/data/case">\n<label>Case note</label>\n</input>\n\t</h:body>', 1),
    )


def root_question_usercase(authoring, app_id):
    """A text question ``commcare_usercase`` at the root of hq-case-management's first follow-up form, which saves
    to the worker's record."""
    _change(
        authoring,
        app_id,
        "root-question-usercase",
        ("</data>", "<commcare_usercase />\n</data>", 1),
        ("<itext>", '<bind nodeset="/data/commcare_usercase" type="xsd:string" />\n<itext>', 1),
        ("</h:body>", '<input ref="/data/commcare_usercase">\n<label>Note</label>\n</input>\n</h:body>', 1),
        form=1,
    )


def ledger_balance(authoring, app_id):
    """A Balance block of the form builder's CommTrack plugin at the end of the form's data, as the plugin writes
    one (Vellum ``tests/static/commtrack/balance-block.xml``): a ``balance`` element in the ledger namespace, its
    entry's quantity calculated by a bind that names the block by its ``type``."""
    _change(
        authoring,
        app_id,
        "ledger-balance",
        (
            "</rounds>\n",
            '</rounds>\n<balance xmlns="http://commcarehq.org/ledger/v1" entity-id="" date="" section-id="stock"'
            ' type="bal-0"><entry id="" quantity="" /></balance>\n',
            1,
        ),
        (
            FIRST_SETVALUE,
            '<bind nodeset="/data/balance[@type=\'bal-0\']/entry/@quantity" calculate="/data/tag_code" />\n'
            + FIRST_SETVALUE,
            1,
        ),
    )


# Connect: hq-connect-learn's form, which holds a learn module and an assessment ---------------------------------------

LEARN_XMLNS = 'xmlns="http://commcareconnect.com/data/v1/learn"'
LEARN_DATA_END = "</intro_check>"
LEARN_BIND_END = '<bind vellum:nodeset="#form/intro_check" nodeset="/data/intro_check" />'


def _connect_block(text, data, binds):
    """``text`` with a Connect block's ``data`` put after the form's assessment and its ``binds`` after the
    assessment's bind."""
    return _replaced(
        text, [(LEARN_DATA_END, LEARN_DATA_END + "\n" + data, 1), (LEARN_BIND_END, LEARN_BIND_END + "\n" + binds, 1)]
    )


def connect_time_estimate_zero(authoring, app_id):
    """The learn module's time estimate made ``0``."""
    _change(
        authoring,
        app_id,
        "connect-time-estimate-zero",
        ("<time_estimate>5</time_estimate>", "<time_estimate>0</time_estimate>", 1),
    )


def connect_two_assessments(authoring, app_id):
    """A second assessment ``final_check``, scored by ``quiz_score``, in the form."""
    _edit(
        authoring,
        app_id,
        "connect-two-assessments",
        lambda text: _connect_block(
            text,
            f'<final_check vellum:role="ConnectAssessment"><assessment {LEARN_XMLNS} id="final_check"><user_score />'
            "</assessment></final_check>",
            '<bind vellum:nodeset="#form/final_check" nodeset="/data/final_check" />\n'
            '<bind nodeset="/data/final_check/assessment/user_score" calculate="/data/quiz_score" />',
        ),
    )


def connect_learn_and_deliver(authoring, app_id):
    """A deliver unit ``visit_unit`` in the learn form, so the app holds learn and deliver blocks."""
    _edit(
        authoring,
        app_id,
        "connect-learn-and-deliver",
        lambda text: _connect_block(
            text,
            f'<visit_unit vellum:role="ConnectDeliverUnit"><deliver {LEARN_XMLNS} id="visit_unit"><name>Visit</name>'
            "<entity_id /><entity_name /><work_area_id /></deliver></visit_unit>",
            '<bind vellum:nodeset="#form/visit_unit" nodeset="/data/visit_unit" />\n'
            '<bind nodeset="/data/visit_unit/deliver/entity_id" calculate="/data/quiz_score" />\n'
            '<bind nodeset="/data/visit_unit/deliver/entity_name" calculate="/data/quiz_score" />\n'
            '<bind nodeset="/data/visit_unit/deliver/work_area_id" />',
        ),
    )


def connect_text_instance(authoring, app_id):
    """The learn module's description made ``Read instance('casedb') first``."""
    _change(
        authoring,
        app_id,
        "connect-text-instance",
        (
            "<description>Why and when to wash hands</description>",
            "<description>Read instance('casedb') first</description>",
            1,
        ),
    )


def connect_long_id(authoring, app_id):
    """The learn module's id, which names its data node, made 51 characters long, at the node, its bind and its
    element's ``id``."""
    _change(authoring, app_id, "connect-long-id", ("intro_module", "m" * 51, 5))


def connect_receiver_id_changed(authoring, app_id):
    """The module's submitted ID differs from the question ID that Vellum saves."""
    _change(authoring, app_id, "connect-receiver-id-changed", ('id="intro_module"', 'id="prior_lesson"', 1))


def connect_work_area_photo(authoring, app_id):
    """Vellum's work-area shape including the photo leaf the HQ forwarder sends as a filename."""
    leaves = ("work_area_id", "status", "reason", "additional_details", "photo_evidence")
    data = "".join(f"<{leaf}/>" for leaf in leaves)
    binds = "".join(f"""<bind nodeset="/data/area/work_area_update/{leaf}" calculate="'value'"/>""" for leaf in leaves)
    _edit(
        authoring, app_id, "connect-work-area-photo",
        lambda text: _connect_block(text, f'<area vellum:role="ConnectWorkAreaUpdate"><work_area_update {LEARN_XMLNS} id="area">{data}</work_area_update></area>',
                                    '<bind vellum:nodeset="#form/area" nodeset="/data/area" />' + binds),
    )


def constant_work_area_calculation(authoring, app_id):
    """A stable source form puts the constant in a calculate bind."""
    _change(authoring, app_id, "constant-work-area-calculation",
            ('nodeset="/data/visit_unit/deliver/work_area_id"',
             """nodeset="/data/visit_unit/deliver/work_area_id" calculate="'5b2f7d1e-8c3a-4e6b-9d0f-1a2b3c4d5e6f'" """.rstrip(), 1))


def connect_work_area_update(authoring, app_id):
    """A work area update block (``vellum:role="ConnectWorkAreaUpdate"``) in the learn form."""
    _edit(
        authoring,
        app_id,
        "connect-work-area-update",
        lambda text: _connect_block(
            text,
            f'<area vellum:role="ConnectWorkAreaUpdate"><work_area {LEARN_XMLNS} id="area" /></area>',
            '<bind vellum:nodeset="#form/area" nodeset="/data/area" />',
        ),
    )


def connect_assessment_without_score(authoring, app_id):
    """The assessment's score left without its calculation, so the submission sends an empty score."""
    _change(
        authoring,
        app_id,
        "connect-assessment-without-score",
        (
            '<bind nodeset="/data/intro_check/assessment/user_score" vellum:calculate="#form/quiz_score"'
            ' calculate="/data/quiz_score" />',
            '<bind nodeset="/data/intro_check/assessment/user_score" />',
            1,
        ),
    )


def connect_estimate_outside_receiver_range(authoring, app_id):
    """The learn module's time estimate made one past what Connect's signed 32-bit column holds."""
    _change(
        authoring,
        app_id,
        "connect-estimate-outside-receiver-range",
        ("<time_estimate>5</time_estimate>", "<time_estimate>2147483648</time_estimate>", 1),
    )


def connect_repeated_module(authoring, app_id):
    """A learn module ``row_module`` in each row of a worker-added repeat ``lessons``, so one submission can
    complete the same module once per row."""
    _edit(
        authoring,
        app_id,
        "connect-repeated-module",
        lambda text: _replaced(
            text,
            [
                (
                    LEARN_DATA_END,
                    LEARN_DATA_END
                    + f'\n<lessons jr:template=""><row_module vellum:role="ConnectLearnModule"><module {LEARN_XMLNS}'
                    ' id="row_module"><name>Practice</name><description>Practice again</description>'
                    "<time_estimate>1</time_estimate></module></row_module></lessons>",
                    1,
                ),
                (
                    LEARN_BIND_END,
                    LEARN_BIND_END
                    + '\n<bind vellum:nodeset="#form/lessons" nodeset="/data/lessons" />'
                    '\n<bind vellum:nodeset="#form/lessons/row_module" nodeset="/data/lessons/row_module" />',
                    1,
                ),
                (
                    "</h:body>",
                    "<group><label>Lessons</label>"
                    '<repeat vellum:nodeset="#form/lessons" nodeset="/data/lessons" /></group>\n</h:body>',
                    1,
                ),
            ],
        ),
    )


# hq-connect-deliver's forms: the deliver unit ``visit_unit`` in the first, the task ``follow_up_task`` in the
# second.


def _grouped_delivery_source(text, group):
    """Place the existing delivery under one data group without changing its recipient or activity ID."""
    path = f"/data/{group}"
    return _replaced(
        text,
        [
            ("<visit_unit ", f"<{group}><visit_unit ", 1),
            ("</visit_unit>", f"</visit_unit></{group}>", 1),
            ("#form/visit_unit", f"#form/{group}/visit_unit", 1),
            ("/data/visit_unit", f"{path}/visit_unit", 4),
            ("<itext>", f'<bind vellum:nodeset="#form/{group}" nodeset="{path}" />\n<itext>', 1),
            ("</h:body>", f'<group ref="{path}"><label>Visit details</label></group>\n</h:body>', 1),
        ],
    )


def deliver_under_receiver_key(authoring, app_id):
    """The delivery is under `task`, which HQ forwards and Connect mistakes for its own task block."""
    _edit(authoring, app_id, "deliver-under-receiver-key", lambda text: _grouped_delivery_source(text, "task"))


def deliver_under_capitalized_receiver_key(authoring, app_id):
    """The same delivery under `Task`, beside Connect's exact case-sensitive receiver key."""
    _edit(authoring, app_id, "deliver-under-capitalized-receiver-key", lambda text: _grouped_delivery_source(text, "Task"))


def deliver_work_area_expression(authoring, app_id):
    """The deliver unit's work area id calculated from ``household_id``."""
    _change(
        authoring,
        app_id,
        "deliver-work-area-expression",
        (
            'nodeset="/data/visit_unit/deliver/work_area_id"',
            'nodeset="/data/visit_unit/deliver/work_area_id" calculate="/data/household_id"',
            1,
        ),
    )


def deliver_work_area_fixed_id(authoring, app_id):
    """The deliver unit's work area id written as a fixed id in its data node, which Connect files every visit
    under (``form_receiver/processor.py::process_deliver_unit``)."""
    _change(
        authoring,
        app_id,
        "deliver-work-area-fixed-id",
        ("<work_area_id />", "<work_area_id>5b2f7d1e-8c3a-4e6b-9d0f-1a2b3c4d5e6f</work_area_id>", 1),
    )


def deliver_unit_and_task(authoring, app_id):
    """A task ``visit_task`` beside the deliver unit in the deliver form."""
    _change(
        authoring,
        app_id,
        "deliver-unit-and-task",
        (
            "</data>",
            f'<visit_task vellum:role="ConnectTask"><task {LEARN_XMLNS} id="visit_task"><name>Visit task</name>'
            "<description>Visit the household</description></task></visit_task>\n</data>",
            1,
        ),
        ("<itext>", '<bind vellum:nodeset="#form/visit_task" nodeset="/data/visit_task" />\n<itext>', 1),
    )


# Save to Case blocks of other changes, each in the shape Nova's own export writes for it: the block in a
# ``nova_operations`` group, its rows' binds, then its modified date, user and case id.

SESSION_INSTANCE = '<instance src="jr://instance/session" id="commcaresession" />'
MENU_CASE = "instance('commcaresession')/session/data/case_id"
WORKER_CASE = (
    "instance('casedb')/casedb/case[@case_type = 'commcare-user']"
    "[hq_user_id = instance('commcaresession')/session/context/userid]/@case_id"
)


def _block(name, case_type, inner, case_id, rows=(), group=OPS):
    """A block ``name`` of ``case_type`` in the group ``group``, holding ``inner`` in its case: its data (without
    the group) and its binds, the case id ``case_id`` and each ``(leaf, attributes)`` of ``rows``, a leaf under the
    case."""
    data = (
        f'<{name} vellum:role="SaveToCase" vellum:case_type="{case_type}"><case case_id="" date_modified=""'
        f' user_id="" {CASE_XMLNS}>{inner}</case></{name}>'
    )
    case = f"{group}/{name}/case"
    binds = "".join(f'<bind nodeset="{case}/{leaf}" {attributes}/>' for leaf, attributes in rows) + (
        f'<bind type="xsd:dateTime" nodeset="{case}/@date_modified" calculate="/data/meta/timeEnd"/>'
        f'<bind nodeset="{case}/@user_id" calculate="/data/meta/userID"/>'
        f'<bind nodeset="{case}/@case_id" calculate="{case_id}"/>'
    )
    return data, binds


def _with_blocks(text, blocks, *, data_before, binds_before, group_after, group=OPS, instances=(SESSION_INSTANCE,)):
    """``text`` with ``blocks`` in one ``nova_operations`` group before ``data_before``, their binds before
    ``binds_before``, the group's body element after ``group_after`` and ``instances`` declared after the form's
    own data."""
    data = "<nova_operations>" + "".join(one for one, _ in blocks) + "</nova_operations>"
    binds = "".join(one for _, one in blocks)
    declared = "".join(f"\t\t\t{instance}\n" for instance in instances)
    return _replaced(
        text,
        [
            (data_before, data + "\n" + data_before, 1),
            (binds_before, binds + "\n" + binds_before, 1),
            (group_after, group_after + f'\n<group ref="{group}"/>', 1),
            ("</instance>\n", "</instance>\n" + declared, 1),
        ],
    )


def save_to_case_menu_case_in_survey(authoring, app_id):
    """In hq-questions' survey, whose menu chooses no case, the Save to Case create linked (``parent``) to the case
    the menu chooses."""
    _edit(
        authoring,
        app_id,
        "save-to-case-menu-case-in-survey",
        lambda text: _replaced(
            _with_save_to_case(text),
            [
                (
                    STC_UPDATE + "</case></make_household>",
                    STC_UPDATE
                    + '<index><parent case_type="household" relationship="child"/></index></case></make_household>',
                    1,
                ),
                (STC_HEAD_BIND, STC_HEAD_BIND + f'<bind nodeset="{MAKE}/index/parent" calculate="{MENU_CASE}"/>', 1),
                ("</instance>\n", "</instance>\n\t\t\t" + SESSION_INSTANCE + "\n", 1),
            ],
        ),
    )


def save_to_case_worker_under_condition(authoring, app_id):
    """One root update of `commcare-user`, only when the submitted weight is positive."""
    group = "/data/nova_operations/nova_condition_worker"
    data, binds = _block(
        "worker", "commcare-user", "<update><last_review/></update>", WORKER_CASE,
        [("update/last_review", "calculate=\"'reviewed'\"")], group=group,
    )
    _change(
        authoring, app_id, "save-to-case-worker-under-condition",
        ("</data>", f"<nova_operations><nova_condition_worker>{data}</nova_condition_worker></nova_operations>\n</data>", 1),
        (FIRST_SETVALUE, f'<bind nodeset="{group}" relevant="/data/weight &gt; 0"/>' + binds + FIRST_SETVALUE, 1),
        ("</h:body>", f'<group ref="/data/nova_operations"><group ref="{group}"/></group>\n</h:body>', 1),
        ("</instance>\n", "</instance>\n" + SESSION_INSTANCE + "\n", 1),
    )


def save_to_case_worker_in_repeat(authoring, app_id):
    """In each row of hq-questions' repeat ``members``, a Save to Case update of the worker's record
    (``commcare-user``) saving the row's ``member_name``."""
    group = "/data/members/nova_operations"
    read = "current()/../../../../../member_name"
    block = _block(
        "worker",
        "commcare-user",
        "<update><last_member/></update>",
        WORKER_CASE,
        [("update/last_member", f'relevant="count({read}) &gt; 0" calculate="{read}"')],
        group=group,
    )
    _edit(
        authoring,
        app_id,
        "save-to-case-worker-in-repeat",
        lambda text: _with_blocks(
            text,
            [block],
            data_before="</members>",
            binds_before=FIRST_SETVALUE,
            group_after=MEMBER_NAME_CLOSE,
            group=group,
        ),
    )


def save_to_case_worker_under_repeat_condition(authoring, app_id):
    """An extra condition around a repeated worker update is still a separate scope."""
    group = "/data/members/nova_operations"
    condition = f"{group}/nova_condition_worker"
    read = "current()/../../../../../../member_name"
    data, binds = _block(
        "worker", "commcare-user", "<update><last_member/></update>", WORKER_CASE,
        [("update/last_member", f'relevant="count({read}) &gt; 0" calculate="{read}"')],
        group=condition,
    )

    def transform(text):
        wrapped = _with_blocks(
            text,
            [(f"<nova_condition_worker>{data}</nova_condition_worker>",
              f'<bind nodeset="{condition}" relevant="/data/weight &gt; 0"/>' + binds)],
            data_before="</members>",
            binds_before=FIRST_SETVALUE,
            group_after=MEMBER_NAME_CLOSE,
            group=group,
        )
        return _replaced(wrapped, [(f'<group ref="{group}"/>',
                                    f'<group ref="{group}"><group ref="{condition}"/></group>', 1)])

    _edit(authoring, app_id, "save-to-case-worker-under-repeat-condition", transform)


# hq-new-app's follow-up form, which a menu of case type ``case`` opens with its case chosen.
FOLLOWUP_DATA = "<default_label />"
FOLLOWUP_BIND = '<bind vellum:nodeset="#form/default_label" nodeset="/data/default_label" />'


def _followup(authoring, app_id, what, *blocks, instances=(SESSION_INSTANCE,)):
    """hq-new-app's follow-up form with ``blocks`` put in."""
    _edit(
        authoring,
        app_id,
        what,
        lambda text: _with_blocks(
            text,
            blocks,
            data_before=FOLLOWUP_DATA,
            binds_before="<itext>",
            group_after="<h:body>",
            instances=instances,
        ),
        form=1,
    )


def save_to_case_close_only_condition(authoring, app_id):
    """A Save to Case block that only closes the menu's case, its close under a condition (``relevant`` on
    ``case/close``)."""
    _followup(
        authoring,
        app_id,
        "save-to-case-close-only-condition",
        _block("shut", "case", "<close/>", MENU_CASE, [("close", "relevant=\"today() &gt; date('2020-01-01')\"")]),
    )


def save_to_case_another_case_close_condition(authoring, app_id):
    """A separate case whose block remains present when its close condition is false."""
    case_id = "instance('casedb')/casedb/case[@case_id = 'another-case' and @case_type = 'case']/@case_id"
    _followup(
        authoring,
        app_id,
        "save-to-case-another-case-close-condition",
        _block("shut", "case", "<close/>", case_id, [("close", "relevant=\"today() &gt; date('2020-01-01')\"")]),
        instances=(SESSION_INSTANCE, '<instance src="jr://instance/casedb" id="casedb" />'),
    )


def save_to_case_other_type(authoring, app_id):
    """A Save to Case update of the menu's case, whose type is ``case``, naming it a ``household``."""
    _followup(
        authoring,
        app_id,
        "save-to-case-other-type",
        _block("again", "household", "<update><seen/></update>", MENU_CASE, [("update/seen", "calculate=\"'yes'\"")]),
    )


# Changes of several Save to Case blocks, each as Nova's own export writes them for hq-questions' questions
# (``full_name``, ``visit_date``, ``members/member_name``): the blocks' data, their binds and setvalues, and their
# group in the body.

TYPE_CHANGE_DATA = (
    '<nova_operations><nova_count_nova_keyed_mk/><nova_keyed_mk jr:template=""><mk '
    'vellum:role="SaveToCase" vellum:case_type="visit"><case case_id="" date_modified="" user_id="" '
    'xmlns="http://commcarehq.org/case/transaction/v2"><create><case_type/><case_name/><owner_id/>'
    '</create></case></mk></nova_keyed_mk><nova_guard_mk_text vellum:role="SaveToCase" '
    'vellum:case_type="visit"><case case_id="" date_modified="" user_id="" '
    'xmlns="http://commcarehq.org/case/transaction/v2"><update><case_type/></update></case>'
    '</nova_guard_mk_text><again vellum:role="SaveToCase" vellum:case_type="visit"><case case_id="" '
    'date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2"><update>'
    '<case_type/></update></case></again><nova_guard_again_retype vellum:role="SaveToCase" '
    'vellum:case_type="patient"><case case_id="" date_modified="" user_id="" '
    'xmlns="http://commcarehq.org/case/transaction/v2"><update><case_type/></update></case>'
    "</nova_guard_again_retype></nova_operations>"
)

TYPE_CHANGE_MODEL = (
    '<bind type="xsd:int" nodeset="/data/nova_operations/nova_count_nova_keyed_mk" calculate="1"/>'
    '<bind nodeset="/data/nova_operations/nova_keyed_mk/mk/case/@case_id" '
    'calculate="if(string-length(/data/full_name) &gt; 0 and string-length(/data/full_name) &lt;= '
    "205, concat(&apos;nova-case-v1:4f1856cb-4f1d-5a46-b511-decacb3cc17a:&apos;, /data/full_name), "
    '&apos;&apos;)"/><bind nodeset="/data/nova_operations/nova_keyed_mk/mk/case/create/case_type" '
    'calculate="&apos;visit&apos;"/><bind '
    'nodeset="/data/nova_operations/nova_keyed_mk/mk/case/create/case_name" '
    'calculate="replace(/data/full_name, &apos;^[\\x00-\\x20]+|[\\x00-\\x20]+$&apos;, &apos;&apos;)"/>'
    '<bind nodeset="/data/nova_operations/nova_keyed_mk/mk/case/create/owner_id" '
    'calculate="replace(/data/meta/userID, &apos;^[\\x00-\\x20]+|[\\x00-\\x20]+$&apos;, &apos;&apos;)"/>'
    '<bind type="xsd:dateTime" nodeset="/data/nova_operations/nova_keyed_mk/mk/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind '
    'nodeset="/data/nova_operations/nova_keyed_mk/mk/case/@user_id" calculate="/data/meta/userID"/>'
    '<bind nodeset="/data/nova_operations/nova_guard_mk_text/case/update/case_type" '
    'calculate="&apos;visit&apos;"/><bind type="xsd:dateTime" '
    'nodeset="/data/nova_operations/nova_guard_mk_text/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind '
    'nodeset="/data/nova_operations/nova_guard_mk_text/case/@user_id" calculate="/data/meta/userID"/>'
    '<bind nodeset="/data/nova_operations/nova_guard_mk_text/case/@case_id" '
    'calculate="if(string-length(current()/../../../nova_keyed_mk/mk/case/create/case_name) &gt; 0 '
    "and string-length(current()/../../../nova_keyed_mk/mk/case/create/case_name) &lt;= 255 and "
    "string-length(current()/../../../nova_keyed_mk/mk/case/create/owner_id) &gt; 0 and "
    "string-length(current()/../../../nova_keyed_mk/mk/case/create/owner_id) &lt;= 255, "
    'current()/../../../nova_keyed_mk/mk/case/@case_id, &apos;&apos;)"/><bind '
    'nodeset="/data/nova_operations/again/case/update/case_type" calculate="&apos;patient&apos;"/>'
    '<bind type="xsd:dateTime" nodeset="/data/nova_operations/again/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind nodeset="/data/nova_operations/again/case/@user_id" '
    'calculate="/data/meta/userID"/><bind nodeset="/data/nova_operations/again/case/@case_id" '
    'calculate="current()/../../../nova_keyed_mk/mk/case/@case_id"/><bind '
    'nodeset="/data/nova_operations/nova_guard_again_retype/case/update/case_type" '
    'calculate="&apos;patient&apos;"/><bind type="xsd:dateTime" '
    'nodeset="/data/nova_operations/nova_guard_again_retype/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind '
    'nodeset="/data/nova_operations/nova_guard_again_retype/case/@user_id" '
    'calculate="/data/meta/userID"/><bind '
    'nodeset="/data/nova_operations/nova_guard_again_retype/case/@case_id" '
    'calculate="if(not(starts-with(current()/../../../again/case/@case_id, '
    '&apos;nova-case-v1:&apos;)), current()/../../../again/case/@case_id, &apos;&apos;)"/>'
)

TYPE_CHANGE_BODY = (
    '<group ref="/data/nova_operations"><group><repeat jr:noAddRemove="true()" '
    'nodeset="/data/nova_operations/nova_keyed_mk" '
    'jr:count="/data/nova_operations/nova_count_nova_keyed_mk"/></group></group>'
)

RETYPE_CONVERTS_DATA = (
    '<nova_operations><mk vellum:role="SaveToCase" vellum:case_type="patient"><case case_id="" '
    'date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2"><create>'
    "<case_type/><case_name/><owner_id/></create><update><kept/></update></case></mk>"
    '<nova_guard_mk_text vellum:role="SaveToCase" vellum:case_type="patient"><case case_id="" '
    'date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2"><update>'
    '<case_type/></update></case></nova_guard_mk_text><again vellum:role="SaveToCase" '
    'vellum:case_type="patient"><case case_id="" date_modified="" user_id="" '
    'xmlns="http://commcarehq.org/case/transaction/v2"><update><case_type/><kept/></update></case>'
    '</again><nova_guard_again_retype vellum:role="SaveToCase" vellum:case_type="visit"><case '
    'case_id="" date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2">'
    "<update><case_type/></update></case></nova_guard_again_retype></nova_operations>"
)

RETYPE_CONVERTS_MODEL = (
    '<bind nodeset="/data/nova_operations/mk/case/create/case_type" calculate="&apos;patient&apos;"/>'
    '<bind nodeset="/data/nova_operations/mk/case/create/case_name" '
    'calculate="replace(/data/full_name, &apos;^[\\x00-\\x20]+|[\\x00-\\x20]+$&apos;, &apos;&apos;)"/>'
    '<bind nodeset="/data/nova_operations/mk/case/create/owner_id" '
    'calculate="replace(/data/meta/userID, &apos;^[\\x00-\\x20]+|[\\x00-\\x20]+$&apos;, &apos;&apos;)"/>'
    '<bind nodeset="/data/nova_operations/mk/case/update/kept" calculate="/data/visit_date"/><bind '
    'type="xsd:dateTime" nodeset="/data/nova_operations/mk/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind nodeset="/data/nova_operations/mk/case/@user_id" '
    'calculate="/data/meta/userID"/><bind '
    'nodeset="/data/nova_operations/nova_guard_mk_text/case/update/case_type" '
    'calculate="&apos;patient&apos;"/><bind type="xsd:dateTime" '
    'nodeset="/data/nova_operations/nova_guard_mk_text/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind '
    'nodeset="/data/nova_operations/nova_guard_mk_text/case/@user_id" calculate="/data/meta/userID"/>'
    '<bind nodeset="/data/nova_operations/nova_guard_mk_text/case/@case_id" '
    'calculate="if(string-length(current()/../../../mk/case/create/case_name) &gt; 0 and '
    "string-length(current()/../../../mk/case/create/case_name) &lt;= 255 and "
    "string-length(current()/../../../mk/case/create/owner_id) &gt; 0 and "
    "string-length(current()/../../../mk/case/create/owner_id) &lt;= 255, "
    'current()/../../../mk/case/@case_id, &apos;&apos;)"/><bind '
    'nodeset="/data/nova_operations/again/case/update/case_type" calculate="&apos;visit&apos;"/>'
    '<bind nodeset="/data/nova_operations/again/case/update/kept" calculate="/data/full_name"/><bind '
    'type="xsd:dateTime" nodeset="/data/nova_operations/again/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind nodeset="/data/nova_operations/again/case/@user_id" '
    'calculate="/data/meta/userID"/><bind nodeset="/data/nova_operations/again/case/@case_id" '
    'calculate="current()/../../../mk/case/@case_id"/><bind '
    'nodeset="/data/nova_operations/nova_guard_again_retype/case/update/case_type" '
    'calculate="&apos;visit&apos;"/><bind type="xsd:dateTime" '
    'nodeset="/data/nova_operations/nova_guard_again_retype/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind '
    'nodeset="/data/nova_operations/nova_guard_again_retype/case/@user_id" '
    'calculate="/data/meta/userID"/><bind '
    'nodeset="/data/nova_operations/nova_guard_again_retype/case/@case_id" '
    'calculate="if(not(starts-with(current()/../../../again/case/@case_id, '
    '&apos;nova-case-v1:&apos;)), current()/../../../again/case/@case_id, &apos;&apos;)"/><setvalue '
    'event="xforms-ready" ref="/data/nova_operations/mk/case/@case_id" value="uuid()"/>'
)

RETYPE_CONVERTS_BODY = '<group ref="/data/nova_operations"/>'

KEYED_IN_REPEAT_DATA = (
    '<nova_operations><kid vellum:role="SaveToCase" vellum:case_type="visit"><case case_id="" '
    'date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2"><create>'
    "<case_type/><case_name/><owner_id/></create></case></kid><nova_guard_kid_text "
    'vellum:role="SaveToCase" vellum:case_type="visit"><case case_id="" date_modified="" user_id="" '
    'xmlns="http://commcarehq.org/case/transaction/v2"><update><case_type/></update></case>'
    "</nova_guard_kid_text></nova_operations>"
)

KEYED_IN_REPEAT_MODEL = (
    '<bind nodeset="/data/members/nova_operations/kid/case/@case_id" '
    'calculate="if(string-length(current()/../../../../member_name) &gt; 0 and '
    "string-length(current()/../../../../member_name) &lt;= 205, "
    "concat(&apos;nova-case-v1:6a2a4ff6-d872-5db2-ad07-aa04dcf38390:&apos;, "
    'current()/../../../../member_name), &apos;&apos;)"/><bind '
    'nodeset="/data/members/nova_operations/kid/case/create/case_type" '
    'calculate="&apos;visit&apos;"/><bind '
    'nodeset="/data/members/nova_operations/kid/case/create/case_name" '
    'calculate="replace(current()/../../../../../member_name, '
    '&apos;^[\\x00-\\x20]+|[\\x00-\\x20]+$&apos;, &apos;&apos;)"/><bind '
    'nodeset="/data/members/nova_operations/kid/case/create/owner_id" '
    'calculate="replace(/data/meta/userID, &apos;^[\\x00-\\x20]+|[\\x00-\\x20]+$&apos;, &apos;&apos;)"/>'
    '<bind type="xsd:dateTime" nodeset="/data/members/nova_operations/kid/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind nodeset="/data/members/nova_operations/kid/case/@user_id" '
    'calculate="/data/meta/userID"/><bind '
    'nodeset="/data/members/nova_operations/nova_guard_kid_text/case/update/case_type" '
    'calculate="&apos;visit&apos;"/><bind type="xsd:dateTime" '
    'nodeset="/data/members/nova_operations/nova_guard_kid_text/case/@date_modified" '
    'calculate="/data/meta/timeEnd"/><bind '
    'nodeset="/data/members/nova_operations/nova_guard_kid_text/case/@user_id" '
    'calculate="/data/meta/userID"/><bind '
    'nodeset="/data/members/nova_operations/nova_guard_kid_text/case/@case_id" '
    'calculate="if(string-length(current()/../../../kid/case/create/case_name) &gt; 0 and '
    "string-length(current()/../../../kid/case/create/case_name) &lt;= 255 and "
    "string-length(current()/../../../kid/case/create/owner_id) &gt; 0 and "
    "string-length(current()/../../../kid/case/create/owner_id) &lt;= 255, "
    'current()/../../../kid/case/@case_id, &apos;&apos;)"/>'
)

KEYED_IN_REPEAT_BODY = '<group ref="/data/members/nova_operations"/>'


def _transplanted(text, data, model, body, *, data_before="<intro />", body_after="<h:body>"):
    """``text`` with ``data`` before ``data_before``, ``model`` before the form's own setvalues and ``body`` after
    ``body_after``."""
    return _replaced(
        text,
        [
            (data_before, data + "\n" + data_before, 1),
            (FIRST_SETVALUE, model + "\n" + FIRST_SETVALUE, 1),
            (body_after, body_after + "\n" + body, 1),
        ],
    )


def save_to_case_retype_keyed(authoring, app_id):
    """A ``visit`` created under an id ``full_name`` keys (``nova-case-v1:``), and an update of it giving it the
    type ``patient``: the key can name a case an earlier submission made, which another change reads as a
    ``visit``."""
    _edit(
        authoring,
        app_id,
        "save-to-case-retype-keyed",
        lambda text: _transplanted(text, TYPE_CHANGE_DATA, TYPE_CHANGE_MODEL, TYPE_CHANGE_BODY),
    )


def save_to_case_date_as_text(authoring, app_id):
    """A patient date and a visit text write share one property across a literal retype."""
    _edit(
        authoring,
        app_id,
        "save-to-case-date-as-text",
        lambda text: _transplanted(text, RETYPE_CONVERTS_DATA, RETYPE_CONVERTS_MODEL, RETYPE_CONVERTS_BODY),
    )


def save_to_case_retype_converts(authoring, app_id):
    """Reverse the two question sources. The retained property would have to become a date."""
    model = RETYPE_CONVERTS_MODEL.replace(
        'mk/case/update/kept" calculate="/data/visit_date"',
        'mk/case/update/kept" calculate="/data/full_name"',
    ).replace(
        'again/case/update/kept" calculate="/data/full_name"',
        'again/case/update/kept" calculate="/data/visit_date"',
    )
    _edit(
        authoring,
        app_id,
        "save-to-case-retype-converts",
        lambda text: _transplanted(text, RETYPE_CONVERTS_DATA, model, RETYPE_CONVERTS_BODY),
    )


def save_to_case_keyed_from_outside_its_row(authoring, app_id):
    """A create in members keys all its rows from the one root answer full_name."""
    _edit(
        authoring,
        app_id,
        "save-to-case-keyed-from-outside-its-row",
        lambda text: _transplanted(
            text,
            KEYED_IN_REPEAT_DATA,
            KEYED_IN_REPEAT_MODEL.replace("current()/../../../../member_name", "/data/full_name"),
            KEYED_IN_REPEAT_BODY,
            data_before="</members>",
            body_after=MEMBER_NAME_CLOSE,
        ),
    )


def save_to_case_keyed_beside_worker(authoring, app_id):
    """A ``visit`` created in each row of ``members`` under an id ``member_name`` keys, in a form whose Case
    Management also writes the worker's record (``usercase_update``, set on the form's actions)."""
    _edit(
        authoring,
        app_id,
        "save-to-case-keyed-beside-worker",
        lambda text: _transplanted(
            text,
            KEYED_IN_REPEAT_DATA,
            KEYED_IN_REPEAT_MODEL,
            KEYED_IN_REPEAT_BODY,
            data_before="</members>",
            body_after=MEMBER_NAME_CLOSE,
        ),
    )
    always = {"doc_type": "FormActionCondition", "type": "always", "question": None, "answer": None, "operator": None}
    ops.set_json(
        authoring,
        app_id,
        "/modules/0/forms/0/actions/usercase_update",
        {
            "doc_type": "UpdateCaseAction",
            "condition": always,
            "update": {
                "team_note": {
                    "doc_type": "ConditionalCaseUpdate",
                    "question_path": "/data/full_name",
                    "update_mode": "always",
                }
            },
        },
    )


# hq-case-management's follow-up forms: the first writes the worker's record (``usercase_update``), the third the
# household's ``note`` under a condition.


def save_to_case_worker_twice(authoring, app_id):
    """In hq-case-management's first follow-up form, which writes the worker's record, a Save to Case update of
    the worker's record."""
    block = _block(
        "worker",
        "commcare-user",
        "<update><visit_seen/></update>",
        WORKER_CASE,
        [("update/visit_seen", "calculate=\"'yes'\"")],
    )
    _edit(
        authoring,
        app_id,
        "save-to-case-worker-twice",
        lambda text: _with_blocks(
            text,
            [block],
            data_before="<members />",
            binds_before="<itext>",
            group_after="<h:body>",
            instances=('<instance src="jr://instance/casedb" id="casedb" />', SESSION_INSTANCE),
        ),
        form=1,
    )


def save_to_case_own_case_beside(authoring, app_id):
    """In hq-case-management's third follow-up form, which writes the household's ``note``, a Save to Case update
    of the household writing ``note`` too."""
    block = _block(
        "again", "household", "<update><note/></update>", MENU_CASE, [("update/note", 'calculate="/data/new_member"')]
    )
    _edit(
        authoring,
        app_id,
        "save-to-case-own-case-beside",
        lambda text: _with_blocks(
            text, [block], data_before="<visited />", binds_before="<itext>", group_after="<h:body>"
        ),
        form=2,
    )


def save_to_case_positioned_beside_own(authoring, app_id):
    """In the same household visit, the update stands in the authored form itself beside the managed write."""
    data, binds = _block(
        "again", "household", "<update><note/></update>", MENU_CASE,
        [("update/note", 'calculate="/data/new_member"')], group="/data",
    )
    _change(
        authoring, app_id, "save-to-case-positioned-beside-own",
        ("<visited />", data + "\n<visited />", 1),
        ("<itext>", binds + "\n<itext>", 1),
        ("</instance>\n", f"</instance>\n{SESSION_INSTANCE}\n", 1),
        form=2,
    )


# More questions ------------------------------------------------------------------------------------------------------


def range_control(authoring, app_id):
    """A ``range`` control of a new number question ``level``."""
    _change(
        authoring,
        app_id,
        "range-control",
        ("<full_name />", "<full_name />\n<level />", 1),
        (FULL_NAME_BIND, FULL_NAME_BIND + '\n<bind nodeset="/data/level" type="xsd:int" />', 1),
        (
            "\t</h:body>",
            '<range ref="/data/level" start="1" end="5" step="1">\n<label>Level</label>\n</range>\n\t</h:body>',
            1,
        ),
    )


def ignored_content(authoring, app_id):
    """The form's content marked ``vellum:ignore="retain"`` on its ``h:html``."""
    _change(
        authoring,
        app_id,
        "ignored-content",
        (
            'xmlns:vellum="http://commcarehq.org/xforms/vellum">',
            'xmlns:vellum="http://commcarehq.org/xforms/vellum" vellum:ignore="retain">',
            1,
        ),
    )


def readonly_input(authoring, app_id):
    """The text question ``full_name``'s control ``readonly``."""
    _change(authoring, app_id, "readonly-input", (FULL_NAME_INPUT, FULL_NAME_INPUT[:-1] + ' readonly="true()">', 1))


def input_decimal_type(authoring, app_id):
    """The text question ``full_name`` bound ``xsd:decimal``."""
    _change(
        authoring, app_id, "input-decimal-type", (FULL_NAME_BIND, 'nodeset="/data/full_name" type="xsd:decimal" />', 1)
    )


# Holding rows: classes Nova holds or reads past, each read where the change makes it -----------------------------


def secret_without_type(authoring, app_id):
    """The password question ``pin``'s bind with no ``type``."""
    _change(authoring, app_id, "secret-without-type", (PIN_BIND, 'nodeset="/data/pin" />', 1))


def text_without_type(authoring, app_id):
    """The text question ``full_name``'s bind with no ``type``."""
    _change(authoring, app_id, "text-without-type", (FULL_NAME_BIND, 'nodeset="/data/full_name" />', 1))


def submission_without_send(authoring, app_id):
    """A ``submission`` Core accepts (an id, a resource and a target, fetched with ``get``) that no ``send``
    names, in the model."""
    _change(
        authoring,
        app_id,
        "submission-without-send",
        (
            "<itext>",
            '<submission id="lookup" method="get" resource="https://example.org/lookup"'
            ' targetref="/data/full_name" />\n\t\t\t<itext>',
            1,
        ),
    )


def text_appearance_read_by_no_runtime(authoring, app_id):
    """The text question ``full_name`` with the appearance ``spotlight``, which no runtime reads."""
    _appearance(authoring, app_id, "text-appearance-read-by-no-runtime", "full_name", "spotlight")


def repeat_appearance(authoring, app_id):
    """The repeat ``checks`` with the appearance ``compact`` on its ``repeat``."""
    _change(authoring, app_id, "repeat-appearance", (CHECKS_COUNT, CHECKS_COUNT + ' appearance="compact"', 1))


def audio_acquire(authoring, app_id):
    """The audio question ``voice`` with the appearance ``acquire``."""
    _appearance(authoring, app_id, "audio-acquire", "voice", "acquire")


def bind_id_by_path(authoring, app_id):
    """The text question ``full_name``'s bind given the id ``full_name``, its path from the form's root, which its
    control names in place of its ``ref`` (and of the form builder's ``vellum:ref``, which shadows a ``ref``)."""
    _change(
        authoring,
        app_id,
        "bind-id-by-path",
        (FULL_NAME_BIND, 'id="full_name" ' + FULL_NAME_BIND, 1),
        (FULL_NAME_INPUT, '<input bind="full_name">', 1),
    )


def bind_without_node(authoring, app_id):
    """A bind whose nodeset ``/data/spare`` names no node of the form's data."""
    _model(authoring, app_id, "bind-without-node", '<bind nodeset="/data/spare" type="xsd:string" />')


QUERY_DATA = (
    '<visits jr:template=""><cases><nova_query_ids_cases /><nova_query_count_cases />'
    '<item jr:template=""><nova_query_id_cases /><nova_query_index_cases /><case_note /></item></cases></visits>'
)
QUERY_MODEL = (
    '<bind nodeset="/data/visits/cases/nova_query_ids_cases" vellum:nodeset="#form/visits/cases/nova_query_ids_cases"'
    " calculate=\"join(' ', instance('casedb')/casedb/case/@case_id)\" />"
    '<bind type="xsd:int" nodeset="/data/visits/cases/nova_query_count_cases"'
    ' vellum:nodeset="#form/visits/cases/nova_query_count_cases" calculate="count-selected(../nova_query_ids_cases)" />'
    '<bind vellum:nodeset="#form/visits/cases/item" nodeset="/data/visits/cases/item"'
    ' relevant="position() &lt; ../nova_query_count_cases" />'
    '<bind nodeset="/data/visits/cases/item/nova_query_id_cases"'
    ' vellum:nodeset="#form/visits/cases/item/nova_query_id_cases"'
    ' calculate="if(../nova_query_index_cases &lt; ../../nova_query_count_cases,'
    " selected-at(../../nova_query_ids_cases, ../nova_query_index_cases), '')\" />"
    '<bind type="xsd:int" nodeset="/data/visits/cases/item/nova_query_index_cases"'
    ' vellum:nodeset="#form/visits/cases/item/nova_query_index_cases" />'
    '<bind type="xsd:string" vellum:nodeset="#form/visits/cases/item/case_note"'
    ' nodeset="/data/visits/cases/item/case_note" />'
    '<setvalue event="jr-insert" ref="/data/visits/cases/item/nova_query_id_cases"'
    ' value="if(position(..) &lt; int(../../nova_query_count_cases), selected-at(../../nova_query_ids_cases,'
    " position(..)), '')\" />"
    '<setvalue event="jr-insert" ref="/data/visits/cases/item/nova_query_index_cases" value="position(..)" />'
)
QUERY_TEXTS = (
    '<text id="visits-label"><value>Visits</value></text>'
    '<text id="visits-cases-label"><value>Cases</value></text>'
    '<text id="visits-cases-case_note-label"><value>Case note</value></text>'
)
QUERY_BODY = (
    '<group><label ref="jr:itext(\'visits-label\')" /><repeat nodeset="/data/visits">'
    '<group ref="/data/visits/cases"><group><label ref="jr:itext(\'visits-cases-label\')" />'
    '<repeat jr:noAddRemove="true()" nodeset="/data/visits/cases/item" vellum:nodeset="#form/visits/cases/item"'
    ' jr:count="/data/visits/cases/nova_query_count_cases"'
    ' vellum:jr__count="#form/visits/cases/nova_query_count_cases">'
    '<input ref="/data/visits/cases/item/case_note"><label ref="jr:itext(\'visits-cases-case_note-label\')" />'
    "</input></repeat></group></group></repeat></group>"
)


def query_repeat_in_count_placement(authoring, app_id):
    """A repeat ``visits`` the worker adds rows to, holding a repeat ``cases`` of one row a case the worker holds,
    in the shape Nova writes a query repeat inside another repeat: the query's ids, its count and each row's id in
    the hidden values Nova generates, the count naming its own."""
    _change(
        authoring,
        app_id,
        "query-repeat-in-count-placement",
        ("</rounds>\n", "</rounds>\n" + QUERY_DATA + "\n", 1),
        ("<itext>", QUERY_MODEL + "\n\t\t\t<itext>", 1),
        ("</translation>", QUERY_TEXTS + "</translation>", 1),
        ("\t</h:body>", QUERY_BODY + "\n\t</h:body>", 1),
    )


def custom_text_form(authoring, app_id):
    """A form ``abbrev`` of ``full_name``'s label, a name no runtime asks for."""
    _label_form(authoring, app_id, "custom-text-form", '<value form="abbrev">Name</value>')


SEEN_AT_INPUT = '<input vellum:ref="#form/seen_at" ref="/data/seen_at">'
DOCUMENT_UPLOAD = '<upload mediatype="application/*,text/*" vellum:ref="#form/document" ref="/data/document">'
WEIGHT_INPUT = '<input vellum:ref="#form/weight" ref="/data/weight">'


def datetime_appearance(authoring, app_id):
    """The date-and-time question ``seen_at`` with the appearance ``spaced``, which no runtime reads."""
    _change(authoring, app_id, "datetime-appearance", (SEEN_AT_INPUT, SEEN_AT_INPUT[:-1] + ' appearance="spaced">', 1))


def document_appearance(authoring, app_id):
    """The document question ``document`` with the appearance ``spaced``, which no runtime reads."""
    _change(
        authoring,
        app_id,
        "document-appearance",
        (DOCUMENT_UPLOAD, DOCUMENT_UPLOAD[:-1] + ' appearance="spaced">', 1),
    )


def field_list_on_question(authoring, app_id):
    """The text question ``full_name`` with the appearance ``field-list``, which only a group reads."""
    _appearance(authoring, app_id, "field-list-on-question", "full_name", "field-list")


def number_appearance_read_by_no_runtime(authoring, app_id):
    """The decimal question ``weight`` with the appearance ``spaced``, which no runtime reads."""
    _change(
        authoring,
        app_id,
        "number-appearance-read-by-no-runtime",
        (WEIGHT_INPUT, WEIGHT_INPUT[:-1] + ' appearance="spaced">', 1),
    )


def group_collapse_closed(authoring, app_id):
    """The group ``details`` with the appearance ``collapse-closed`` in place of ``field-list``."""
    _appearance(authoring, app_id, "group-collapse-closed", "details", "collapse-closed")


NICKNAME_OPEN = '<input vellum:ref="#form/details/nickname" ref="/data/details/nickname">'


def group_in_question_list(authoring, app_id):
    """The question ``nickname`` put in a group ``inner`` inside the Question List ``details``."""
    _change(
        authoring,
        app_id,
        "group-in-question-list",
        ("<nickname />", "<inner>\n<nickname />\n</inner>", 1),
        (
            '<bind vellum:nodeset="#form/details/nickname"',
            '<bind vellum:nodeset="#form/details/inner" nodeset="/data/details/inner" />\n'
            '\t\t\t<bind vellum:nodeset="#form/details/nickname"',
            1,
        ),
        ("#form/details/nickname", "#form/details/inner/nickname", 2),
        ("/data/details/nickname", "/data/details/inner/nickname", 2),
        (
            '<input vellum:ref="#form/details/inner/nickname"',
            '<group vellum:ref="#form/details/inner" ref="/data/details/inner">\n'
            "<label ref=\"jr:itext('details/inner-label')\" />\n"
            '<input vellum:ref="#form/details/inner/nickname"',
            1,
        ),
        (NICKNAME_CLOSE, NICKNAME_CLOSE + "\n</group>", 1),
        (
            '<text id="details/nickname-label">',
            '<text id="details/inner-label"><value>More details</value></text>\n<text id="details/nickname-label">',
            1,
        ),
    )


def weight_label_inline(authoring, app_id):
    """``weight``'s label written inline as its text, with no itext."""
    _change(
        authoring,
        app_id,
        "weight-label-inline",
        ("<label ref=\"jr:itext('weight-label')\" />", "<label>Weight in kilograms</label>", 1),
        (WEIGHT_LABEL_TEXT, "", 1),
    )


def unreferenced_text(authoring, app_id):
    """An itext entry ``spare-note`` that no question and no expression references."""
    _change(
        authoring,
        app_id,
        "unreferenced-text",
        (
            '<text id="full_name-label">',
            '<text id="spare-note"><value>Spare</value></text>\n<text id="full_name-label">',
            1,
        ),
    )


HOUSEHOLD_SIZE_INPUT = (
    '<input vellum:ref="#form/household_size" ref="/data/household_size">\n'
    "\t\t\t<label ref=\"jr:itext('household_size-label')\" />\n\t\t</input>"
)


def count_from_whole_number_choices(authoring, app_id):
    """``household_size``, which the repeat ``members`` counts, made a single select whose choices are ``1``,
    ``2`` and ``3``."""
    _change(
        authoring,
        app_id,
        "count-from-whole-number-choices",
        ('nodeset="/data/household_size" type="xsd:int" />', 'nodeset="/data/household_size" />', 1),
        (
            HOUSEHOLD_SIZE_INPUT,
            '<select1 vellum:ref="#form/household_size" ref="/data/household_size">\n'
            "<label ref=\"jr:itext('household_size-label')\" />\n"
            + "".join(
                f"<item>\n<label ref=\"jr:itext('household_size-{n}-label')\" />\n<value>{n}</value>\n</item>\n"
                for n in (1, 2, 3)
            )
            + "</select1>",
            1,
        ),
        (
            '<text id="members-label">',
            "".join(f'<text id="household_size-{n}-label"><value>{n}</value></text>\n' for n in (1, 2, 3))
            + '<text id="members-label">',
            1,
        ),
    )


SIGN_UPLOAD = '<upload mediatype="image/*" vellum:ref="#form/sign" ref="/data/sign" appearance="signature">'


def signature_max_dimension(authoring, app_id):
    """``jr:imageDimensionScaledMax`` of ``800px`` on the signature question ``sign``, which no widget of a
    signature reads."""
    _change(
        authoring,
        app_id,
        "signature-max-dimension",
        (SIGN_UPLOAD, SIGN_UPLOAD[:-1] + ' jr:imageDimensionScaledMax="800px">', 1),
    )


def bind_preload(authoring, app_id):
    """``jr:preload`` and ``jr:preloadParams`` on the text question ``full_name``'s bind."""
    _change(
        authoring,
        app_id,
        "bind-preload",
        (FULL_NAME_BIND, FULL_NAME_BIND[: -len(" />")] + ' jr:preload="property" jr:preloadParams="deviceid" />', 1),
    )


def unreferenced_intent(authoring, app_id):
    """An ``odkx:intent`` in the head that no question's appearance names."""
    _change(
        authoring,
        app_id,
        "unreferenced-intent",
        (
            "\t</h:head>",
            f'\t\t<odkx:intent {ODKX} id="spare_scanner" class="org.example.SPARE" />\n\t</h:head>',
            1,
        ),
    )


def element_inside_value(authoring, app_id):
    """An element ``mark`` inside the default text of ``weight``'s label, after its text."""
    _change(
        authoring,
        app_id,
        "element-inside-value",
        ("<value>Weight in kilograms</value>", "<value>Weight in kilograms<mark /></value>", 1),
    )


def repeat_choose_caption(authoring, app_id):
    """A choose caption (``jr:chooseCaption``) with literal text on the repeat ``members``."""
    _change(
        authoring,
        app_id,
        "repeat-choose-caption",
        (MEMBER_NAME_OPEN, "<jr:chooseCaption>Choose a member</jr:chooseCaption>\n" + MEMBER_NAME_OPEN, 1),
    )


def foreign_model_child(authoring, app_id):
    """An element ``memo`` of a namespace of its own in the model."""
    _model(authoring, app_id, "foreign-model-child", '<x:memo xmlns:x="http://example.org/x" />')


def output_ref(authoring, app_id):
    """The answer ``children`` shown in its validation message through an ``output`` that names it by ``ref``."""
    _change(
        authoring,
        app_id,
        "output-ref",
        ('<output value="/data/children" vellum:value="#form/children" />', '<output ref="/data/children" />', 1),
    )


CHILDREN_BIND = (
    '<bind vellum:nodeset="#form/children" nodeset="/data/children" type="xsd:int" constraint=". &gt;= 0"'
    " jr:constraintMsg=\"jr:itext('children-constraintMsg')\" />"
)
PROTECTED_MESSAGE = (
    "if(jr:itext('children-constraintMsg;__nova_mode') = 'media', jr:itext('children-constraintMsg'),"
    " if(count(/data/children) &gt; 1, '', concat(json-property(jr:itext('children-constraintMsg;__nova_piece_0'),"
    " 'v'), /data/children, json-property(jr:itext('children-constraintMsg;__nova_piece_2'), 'v'))))"
)
PROTECTED_FORMS = "".join(
    f'<value form="{form}">{value}</value>'
    for form, value in (
        ("__nova_identity", "children-constraintMsg"),
        ("__nova_mode", "plain"),
        ("__nova_mode;markdown", "plain"),
        ("__nova_locale", "en"),
        ("__nova_locale;markdown", "en"),
        ("__nova_piece_0", "{&quot;v&quot;:&quot;You entered &quot;}"),
        ("__nova_piece_0;markdown", "{&quot;v&quot;:&quot;You entered &quot;}"),
        ("__nova_piece_2", "{&quot;v&quot;:&quot;, and a count starts at zero&quot;}"),
        ("__nova_piece_2;markdown", "{&quot;v&quot;:&quot;, and a count starts at zero&quot;}"),
    )
)
CHILDREN_LABEL_CLOSE = "<label ref=\"jr:itext('children-label')\" />"


def protected_validation_message(authoring, app_id):
    """``children``'s validation message, which shows its answer, in the shape Nova writes it: an expression on
    the bind that composes the message from its text's own forms, and the text held by the label of an empty,
    never relevant, read-only sibling."""
    _change(
        authoring,
        app_id,
        "protected-validation-message",
        ("<children />", "<children />\n<nova_constraint_message_children />", 1),
        (
            CHILDREN_BIND,
            CHILDREN_BIND.replace("jr:itext('children-constraintMsg')", PROTECTED_MESSAGE)
            + '\n<bind type="xsd:string" nodeset="/data/nova_constraint_message_children" relevant="false()"'
            ' readonly="true()" />',
            1,
        ),
        (", and a count starts at zero</value>", ", and a count starts at zero</value>" + PROTECTED_FORMS, 1),
        ("\n\t\t\t<alert ref=\"jr:itext('children-constraintMsg')\" />", "", 1),
        (
            CHILDREN_LABEL_CLOSE + "\n\t\t</input>",
            CHILDREN_LABEL_CLOSE + "\n\t\t</input>\n"
            '<input ref="/data/nova_constraint_message_children">'
            "<label ref=\"jr:itext('children-constraintMsg')\" /></input>",
            1,
        ),
    )


SAID_INPUT = '<input vellum:ref="#form/said" ref="/data/said">'
SAID_CLOSE = "<label ref=\"jr:itext('said-label')\"/>\n\t\t</input>"
CONTACT_TEXT = '<text id="contact-label">\n\t\t\t\t\t\t<value>Contact</value>\n\t\t\t\t\t</text>'
CONTACT_PHONE_CLOSE = "<label ref=\"jr:itext('contact/contact_phone-label')\"/>\n\t\t\t</input>"


def unlabelled_root_question_list(authoring, app_id):
    """The second form's Question List ``contact`` with no label, and ``said`` moved into it, so every field at
    the form's root is that one Question List."""

    def transform(text):
        text = _moved(text, SAID_INPUT, SAID_CLOSE, CONTACT_PHONE_CLOSE)
        return _replaced(
            text,
            [
                ("<said/>", "", 1),
                ("<contact_phone/>", "<contact_phone/>\n<said/>", 1),
                ("#form/said", "#form/contact/said", 2),
                ("/data/said", "/data/contact/said", 2),
                ("<label ref=\"jr:itext('contact-label')\"/>", "", 1),
                (CONTACT_TEXT, "", 1),
            ],
        )

    _edit(authoring, app_id, "unlabelled-root-question-list", transform, form=1)


def required_condition_alone(authoring, app_id):
    """A required condition (``vellum:requiredCondition``) on ``weight``'s bind, which is not required."""
    _change(
        authoring,
        app_id,
        "required-condition-alone",
        (WEIGHT_BIND, WEIGHT_BIND + ' vellum:requiredCondition="#form/age &gt; 5"', 1),
    )


def save_to_case_owner(authoring, app_id):
    """The Save to Case create's owner the text ``team-a``, in the shape Nova writes an owner."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-owner",
        (STC_OWNER_BIND, STC_OWNER_BIND.replace("/data/meta/userID", "&apos;team-a&apos;"), 1),
    )


def save_to_case_hyphenated_property(authoring, app_id):
    """The Save to Case create's update row ``head`` renamed ``head-name``."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-hyphenated-property",
        ("<update><head/></update>", "<update><head-name/></update>", 1),
        (f"{MAKE}/update/head", f"{MAKE}/update/head-name", 1),
    )


CONDITION = f"{OPS}/nova_condition_make_household"


def save_to_case_open_condition(authoring, app_id):
    """The Save to Case create made only where ``age`` is above 5, in the shape Nova writes a condition: the
    condition on the create's case, and its text guard in a group under the same condition."""
    _save_to_case(
        authoring,
        app_id,
        "save-to-case-open-condition",
        ("</make_household><nova_guard", "</make_household><nova_condition_make_household><nova_guard", 1),
        (
            "</nova_guard_make_household_text></nova_operations>",
            "</nova_guard_make_household_text></nova_condition_make_household></nova_operations>",
            1,
        ),
        (STC_TYPE_BIND, f'<bind nodeset="{MAKE}" relevant="/data/age &gt; 5"/>' + STC_TYPE_BIND, 1),
        (
            f'<bind nodeset="{GUARD}/update/case_type"',
            f'<bind nodeset="{CONDITION}" relevant="/data/age &gt; 5"/><bind nodeset="{GUARD}/update/case_type"',
            1,
        ),
        (f"{OPS}/nova_guard_make_household_text/", f"{CONDITION}/nova_guard_make_household_text/", 4),
        ("current()/../../../make_household/", "current()/../../../../make_household/", 5),
        (f'<group ref="{OPS}"/>', f'<group ref="{OPS}"><group ref="{CONDITION}"/></group>', 1),
    )


PARENT_HOUSEHOLD = (
    "instance(&apos;casedb&apos;)/casedb/case"
    "[@case_id = /data/full_name and @case_type = &apos;household&apos;]/@case_id"
)
TYPE_GUARD = f"{OPS}/nova_guard_make_household_type/case"
TYPE_GUARD_DATA = (
    '<nova_guard_make_household_type vellum:role="SaveToCase" vellum:case_type="household">'
    f'<case case_id="" date_modified="" user_id="" {CASE_XMLNS}><update><case_type/></update></case>'
    "</nova_guard_make_household_type>"
)
TYPE_GUARD_BINDS = "".join(
    [
        f'<bind nodeset="{TYPE_GUARD}/update/case_type" calculate="&apos;household&apos;"/>',
        f'<bind type="xsd:dateTime" nodeset="{TYPE_GUARD}/@date_modified" calculate="/data/meta/timeEnd"/>',
        f'<bind nodeset="{TYPE_GUARD}/@user_id" calculate="/data/meta/userID"/>',
        f'<bind nodeset="{TYPE_GUARD}/@case_id" calculate="if(count({PARENT_HOUSEHOLD}) &gt; 0 and'
        f" string({PARENT_HOUSEHOLD}) != current()/../../../make_household/case/@case_id,"
        ' current()/../../../make_household/case/@case_id, &apos;&apos;)"/>',
    ]
)


def save_to_case_child_link(authoring, app_id):
    """The Save to Case create's ``household`` linked as a child (``index/parent``) to the ``household`` whose case
    id is the answer to ``full_name``, in the shape Nova writes a link: the index, its value, and the block that
    holds the linked case to its type."""
    _save_to_case_link_with_guard(authoring, app_id, "save-to-case-child-link", "parent")


def _save_to_case_link_with_guard(authoring, app_id, what, name):
    _save_to_case(
        authoring,
        app_id,
        what,
        (
            STC_UPDATE + "</case></make_household>",
            STC_UPDATE + f'<index><{name} case_type="household" relationship="child"/></index></case></make_household>',
            1,
        ),
        ("</make_household>", "</make_household>" + TYPE_GUARD_DATA, 1),
        (STC_HEAD_BIND, STC_HEAD_BIND + f'<bind nodeset="{MAKE}/index/{name}" calculate="{PARENT_HOUSEHOLD}"/>', 1),
        (
            f'<bind nodeset="{GUARD}/update/case_type"',
            TYPE_GUARD_BINDS + f'<bind nodeset="{GUARD}/update/case_type"',
            1,
        ),
    )


def select_multi_combobox(authoring, app_id):
    """The multi-select ``crops`` with the appearance ``combobox``, which no runtime reads on a multi-select."""
    _appearance(authoring, app_id, "select-multi-combobox", "crops", "combobox")


def default_inside_repeat(authoring, app_id):
    """A default ``'Member'`` on ``member_name`` inside the repeat ``members``, set as each row is added."""
    _model(
        authoring,
        app_id,
        "default-inside-repeat",
        '<setvalue event="jr-insert" ref="/data/members/member_name" value="\'Member\'" />',
    )


def short_text_form(authoring, app_id):
    """A ``short`` form of ``full_name``'s label."""
    _label_form(authoring, app_id, "short-text-form", '<value form="short">Name</value>')


def case_mappings_in_head(authoring, app_id):
    """The form builder's case mappings (``vellum:case_mappings``) in the head."""
    _change(
        authoring,
        app_id,
        "case-mappings-in-head",
        (
            "\t</h:head>",
            '\t\t<vellum:case_mappings><mapping property="name"><question question_path="/data/full_name"'
            ' update_mode="edit" /></mapping></vellum:case_mappings>\n\t</h:head>',
            1,
        ),
    )


def question_comment(authoring, app_id):
    """A comment (``vellum:comment``) on ``weight``'s data node."""
    _change(
        authoring, app_id, "question-comment", ("<weight />", '<weight vellum:comment="Weighed on the scale" />', 1)
    )


def ignore_rich_text(authoring, app_id):
    """The first form's ``h:html`` marked ``vellum:ignore="richText"``."""
    _change(
        authoring,
        app_id,
        "ignore-rich-text",
        (
            'xmlns:vellum="http://commcarehq.org/xforms/vellum">',
            'xmlns:vellum="http://commcarehq.org/xforms/vellum" vellum:ignore="richText">',
            1,
        ),
    )


def _pragma_label(authoring, app_id, what, pragma, *, twin=False):
    """``weight``'s label text given the itext id ``pragma``, and, where ``twin``, a text ``Label-weight`` holding
    the same value, whose id sorts before it."""
    pairs = [
        ('"weight-label"', f'"{pragma}"', 1),
        ("jr:itext('weight-label')", f"jr:itext('{pragma}')", 1),
    ]
    if twin:
        pairs.append(
            (
                '<text id="full_name-label">',
                '<text id="Label-weight"><value>Weight in kilograms</value></text>\n<text id="full_name-label">',
                1,
            )
        )
    _change(authoring, app_id, what, *pairs)


def pragma_text_merged(authoring, app_id):
    """``weight``'s label text given the itext id ``Pragma-Submit-Automatically``, beside a text of the same value
    whose id sorts before it, which HQ's build merges it into."""
    _pragma_label(authoring, app_id, "pragma-text-merged", "Pragma-Submit-Automatically", twin=True)


def pragma_volatility_title(authoring, app_id):
    """``weight``'s label text given the itext id ``Pragma-Volatility-Entity-Title``, in a form with no volatility
    key."""
    _pragma_label(authoring, app_id, "pragma-volatility-title", "Pragma-Volatility-Entity-Title")


# hq-kept-settings' form, whose texts are in English and French.


def markdown_default_language_only(authoring, app_id):
    """A ``markdown`` form of ``note``'s label in English alone, French holding English's ``markdown`` text as its
    own."""
    _change(
        authoring,
        app_id,
        "markdown-default-language-only",
        (NOTE_EN, '<value>Note *one*</value><value form="markdown">Note *one*</value>', 1),
        (NOTE_FRA, "<value>Note *one*</value>", 1),
    )


# hq-media's first form, whose label media are files the project space holds.

ANIMAL_NAME_LABEL = "<label ref=\"jr:itext('animal_name-label')\" />"
ANIMAL_NAME_BIND = 'nodeset="/data/animal_name" type="xsd:string" />'
ANIMAL_NAME_TEXT = '<text id="animal_name-label">'


def _animal_name_text(authoring, app_id, what, slot, value, *, bind=None):
    """A ``slot`` element on ``animal_name`` naming the text ``animal_name-<slot>``, whose values are ``value``,
    and ``bind`` in place of the question's bind where given."""
    pairs = [
        (ANIMAL_NAME_LABEL, ANIMAL_NAME_LABEL + f"\n<{slot} ref=\"jr:itext('animal_name-{slot}')\" />", 1),
        (ANIMAL_NAME_TEXT, f'<text id="animal_name-{slot}">{value}</text>\n' + ANIMAL_NAME_TEXT, 1),
    ]
    if bind is not None:
        pairs.append((ANIMAL_NAME_BIND, bind, 1))
    _change(authoring, app_id, what, *pairs)


def help_media(authoring, app_id):
    """A help text on ``animal_name`` with an image, at the path its label's image names."""
    _animal_name_text(
        authoring, app_id, "help-media", "help", "<value>Say what the animal is called</value>" + ANIMAL_NAME_IMAGE
    )


def video_inline_on_help(authoring, app_id):
    """A help text on ``animal_name`` with an inline video, at the path its label's video form names: a form no
    runtime reads of a help text."""
    _animal_name_text(
        authoring,
        app_id,
        "video-inline-on-help",
        "help",
        '<value>Say what the animal is called</value><value form="video-inline">'
        "jr://file/commcare/video/data/animal_name.mp4</value>",
    )


def video_inline_as_only_help(authoring, app_id):
    """An otherwise empty help element using the existing question video file."""
    _animal_name_text(
        authoring,
        app_id,
        "video-inline-as-only-help",
        "help",
        '<value/><value form="video-inline">jr://file/commcare/video/data/animal_name.mp4</value>',
    )


def video_as_only_help(authoring, app_id):
    """An ordinary help video keeps its file even when help has no text."""
    _animal_name_text(
        authoring,
        app_id,
        "video-as-only-help",
        "help",
        '<value/><value form="video">jr://file/commcare/video/data/animal_name.mp4</value>',
    )


def hint_media(authoring, app_id):
    """A hint on ``animal_name`` with an image, at the path its label's image names."""
    _animal_name_text(authoring, app_id, "hint-media", "hint", "<value>Its own name</value>" + ANIMAL_NAME_IMAGE)


def validation_message_media(authoring, app_id):
    """A validation condition on ``animal_name`` whose message holds an image, at the path its label's image
    names."""
    _animal_name_text(
        authoring,
        app_id,
        "validation-message-media",
        "alert",
        "<value>Write two letters or more</value>" + ANIMAL_NAME_IMAGE,
        bind='nodeset="/data/animal_name" type="xsd:string" constraint="string-length(.) &gt; 1"'
        " jr:constraintMsg=\"jr:itext('animal_name-alert')\" />",
    )


def group_label_media(authoring, app_id):
    """A group ``notes`` holding a new text question ``remark``, whose label holds an image at the path
    ``animal_name``'s label's image names."""
    _change(
        authoring,
        app_id,
        "group-label-media",
        ("<loose_note />", "<loose_note />\n<notes>\n<remark />\n</notes>", 1),
        (
            'nodeset="/data/loose_note" type="xsd:string" />',
            'nodeset="/data/loose_note" type="xsd:string" />\n'
            '<bind vellum:nodeset="#form/notes" nodeset="/data/notes" />\n'
            '<bind vellum:nodeset="#form/notes/remark" nodeset="/data/notes/remark" type="xsd:string" />',
            1,
        ),
        (
            ANIMAL_NAME_TEXT,
            f'<text id="notes-label"><value>Notes</value>{ANIMAL_NAME_IMAGE}</text>\n'
            '<text id="notes/remark-label"><value>Remark</value></text>\n' + ANIMAL_NAME_TEXT,
            1,
        ),
        (
            "\t</h:body>",
            '<group vellum:ref="#form/notes" ref="/data/notes">\n<label ref="jr:itext(\'notes-label\')" />\n'
            '<input vellum:ref="#form/notes/remark" ref="/data/notes/remark">\n'
            "<label ref=\"jr:itext('notes/remark-label')\" />\n</input>\n</group>\n\t</h:body>",
            1,
        ),
    )


# hq-new-app's registration form, in a menu of the case type ``case``.

CHOICES_ITEMSET = (
    "<itemset nodeset=\"instance('casedb')/casedb/case[@case_type = 'case']\">"
    '<label ref="case_name" /><value ref="@case_id" /></itemset>'
)


def case_choices(authoring, app_id):
    """A single select ``buddy`` whose choices are the worker's cases of the type ``case``, in the shape Nova writes
    a question's case choices."""
    _change(
        authoring,
        app_id,
        "case-choices",
        ("<full_name />", "<full_name />\n<buddy />", 1),
        ("</instance>", '</instance>\n<instance src="jr://instance/casedb" id="casedb" />', 1),
        (
            'nodeset="/data/full_name" type="xsd:string" />',
            'nodeset="/data/full_name" type="xsd:string" />\n'
            '<bind vellum:nodeset="#form/buddy" nodeset="/data/buddy" type="xsd:string" />',
            1,
        ),
        ("</translation>", '<text id="buddy-label"><value>Buddy</value></text>\n</translation>', 1),
        (
            "\t</h:body>",
            '<select1 vellum:ref="#form/buddy" ref="/data/buddy">\n<label ref="jr:itext(\'buddy-label\')" />\n'
            + CHOICES_ITEMSET
            + "\n</select1>\n\t</h:body>",
            1,
        ),
    )


def display_remove_date_row(authoring, app_id):
    """Removing a date's row width restores Android's Ethiopian calendar."""
    _change(authoring, app_id, "remove-date-row",
            ('ref="/data/follow_up" appearance="ethiopian 2-per-row"',
             'ref="/data/follow_up" appearance="ethiopian"', 1))


def display_restore_dropdown(authoring, app_id):
    """The bare dropdown also selects Android's spinner."""
    _change(authoring, app_id, "restore-dropdown",
            ('ref="/data/place" appearance="minimal hint-as-placeholder"',
             'ref="/data/place" appearance="minimal"', 1))


def display_restore_signature(authoring, app_id):
    """The sole signature appearance restores signing on Android and Vellum's signature mug."""
    _change(authoring, app_id, "restore-signature",
            ('ref="/data/web_agreement" appearance="signature 2-per-row"',
             'ref="/data/web_agreement" appearance="signature"', 1))


def display_fix_grid_columns(authoring, app_id):
    """A final column count restores the fixed grid without changing quick selection."""
    _change(authoring, app_id, "fix-grid-columns",
            ('ref="/data/auto_weather" appearance="compact-2 quick"',
             'ref="/data/auto_weather" appearance="quick compact-2"', 1))


def display_search_android_only(authoring, app_id):
    """Changing the word order changes the matching rule on Web Apps only."""
    _change(authoring, app_id, "search-android-only",
            ('ref="/data/ranked_route" appearance="combobox fuzzy"',
             'ref="/data/ranked_route" appearance="fuzzy combobox"', 1))


def deliver_shared_receiver_key(authoring, app_id):
    """A deliver unit ``row_visit`` in each row of a worker-added repeat ``visits``, every row delivering to the
    same fixed recipient, so one submission can file two visits under one unit and recipient."""
    _change(
        authoring,
        app_id,
        "deliver-shared-receiver-key",
        (
            "</visit_unit>",
            '</visit_unit>\n<visits jr:template=""><row_visit vellum:role="ConnectDeliverUnit"><deliver'
            f' {LEARN_XMLNS} id="row_visit"><name>Row visit</name><entity_id /><entity_name /><work_area_id />'
            "</deliver></row_visit></visits>",
            1,
        ),
        (
            '<bind nodeset="/data/visit_unit/deliver/work_area_id" />',
            '<bind nodeset="/data/visit_unit/deliver/work_area_id" />'
            '\n<bind vellum:nodeset="#form/visits" nodeset="/data/visits" />'
            '\n<bind vellum:nodeset="#form/visits/row_visit" nodeset="/data/visits/row_visit" />'
            """\n<bind nodeset="/data/visits/row_visit/deliver/entity_id" calculate="'same'" />"""
            """\n<bind nodeset="/data/visits/row_visit/deliver/entity_name" calculate="'Same'" />"""
            '\n<bind nodeset="/data/visits/row_visit/deliver/work_area_id" />',
            1,
        ),
        (
            "</h:body>",
            "<group><label>Visits</label>"
            '<repeat vellum:nodeset="#form/visits" nodeset="/data/visits" /></group>\n</h:body>',
            1,
        ),
    )
