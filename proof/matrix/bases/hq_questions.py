"""``hq-questions``: an app made in HQ holding every kind of question Nova holds, as HQ's form builder writes each.

1. A new app (``views/apps.py::default_new_app``), named "Question kinds" on
   the app page (``edit_app_attr``), with Web Apps turned on on the settings
   page.
2. A survey menu "Questions" (``views/modules.py::new_module`` with
   ``module_type`` ``survey``), whose one form is joined by a second
   (``views/forms.py::new_form``).
3. The first form's source, written by HQ's own form writer
   (``xform_builder.py::XFormBuilder``) and, for each control
   ``XFormBuilder`` has no type for (``xform_builder.py::ODK_TYPES`` writes
   no bind type for a location, a barcode or an upload, and no secret, label
   or upload control), in the shape HQ's form builder writes it
   (``Vellum/src/mugs/types/*.js``: each type's ``dataType``, ``tagName``,
   ``mediaType`` and ``appearance``), uploaded on the form page and saved in
   the form builder (``vellum``), so every byte of it is the builder's own:

   - a label holding a date chip (``richText.js``'s ``dateFormat`` output,
     ``format-date(date(<path>), '%e/%n/%y')``);
   - a text question with a hint typed plainly and help text typed plainly;
     a Phone Number question (``appearance`` ``numeric``) with a hint typed
     with formatting; a password with help text typed with formatting (each
     formatted text holding the ``markdown`` form the builder writes for one,
     ``javaRosa/plugin.js``, ``item.hasMarkdown``);
   - an integer with a validation and its message; a decimal; a date; a
     time; a date and time; a location; a barcode; a single select; a
     multi-select and a Hidden Value counting what it holds; an image, a
     signature, an audio, a video and a document capture; a Hidden Value
     calculating from the integer;
   - a Question List at the root (a group of appearance ``field-list``);
   - a count repeat whose count is a question, and one whose count is a
     Hidden Value;
   - a model-iteration repeat ``rounds`` holding a text question, in the
     shape the form builder's model iteration writes
     (``Vellum/src/modeliteration.js``: the wrapper's ``ids``, ``count``,
     ``current_index`` and ``vellum:role="Repeat"``, the row ``item`` with
     ``id``, ``index`` and ``jr:template``, the ``@current_index`` bind and the
     four setvalues, the repeat's ``jr:count`` and ``jr:noAddRemove``; its
     fixture ``tests/static/modeliteration/case-list-iteration-with-questions.xml``),
     whose ID query is every case the worker holds,
     ``join(' ', instance('casedb')/casedb/case/@case_id)``, over the
     ``casedb`` instance the form declares: it is in no repeat, has no
     display condition and reads no answer, so it is inside Nova's rule for
     model iteration;
   - a validation holding an inline count of a filtered question in a repeat,
     ``count(/data/members/member_name[. != ''])``, which Nova writes as a
     Hidden Value beside it (``validation-counts-moved``), and a validation
     message that shows the answer (``validation-messages-composed``).
4. The second form's source, written the same way with Disable Text
   Formatting on (``vellum:ignore="markdown"`` on the form, ``parser.js``,
   ``writer.js``): a group of appearance ``field-list`` and a text question.
   It is saved in the form builder, which writes the token in lower case, and
   then its group's appearance is written ``Field-List`` through the form
   page's upload (``ops.set_form_source``), which HQ stores as posted and
   Core reads ignoring case (``FormEntryController.java::isHostWithAppearance``),
   and the label of ``contact_phone`` is written with a no-break space between
   its words through the same upload, since the form builder writes it as a
   plain space (``Vellum/src/xml.js``), which Nova writes as an output
   (``form-text-characters-written-as-outputs``).

It is read as an app that runs on both platforms with its date and time
question split (``date-and-time-questions-split``): a date-and-time question
runs on Android alone, and the split makes it two questions every platform
runs. Its configuration is the lane's floor with ``CLOUDCARE``, which an app
Web Apps lists needs (``proof/checks/configurations.py::_needs_cloudcare``).
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base, Declaration

NAME = "Question kinds"
MENU = "Questions"
DATE_CHIP = "format-date(date(/data/visit_date), '%e/%n/%y')"
IMAGE_MEDIA = "image/*"
VELLUM = "http://commcarehq.org/xforms/vellum"
ROUNDS_QUERY = "instance('casedb')/casedb/case/@case_id"


def _x(xform, tag):
    return f"{{{xform.ns['x']}}}{tag}"


def _child(parent, localname, **attrs):
    """The child of ``parent`` named ``localname`` holding ``attrs``, whatever its namespace: ``XFormBuilder``
    makes its elements with ``lxml.builder.E``, in no namespace until the form is written, and this module makes
    its own in the XForms namespace."""
    from lxml import etree

    for child in parent:
        if (
            isinstance(child.tag, str)
            and etree.QName(child).localname == localname
            and all(child.get(key) == value for key, value in attrs.items())
        ):
            return child
    raise ops.MatrixChangeRefused(f"The form being written holds no {localname} {attrs} where the builder put one.")


def _node(xform, path):
    """The model node, bind and body parents of ``path`` (``/data/<a>/<b>``)."""
    steps = path.split("/")[2:]
    node = xform._data
    for step in steps[:-1]:
        node = node.find(step)
    return node, steps[-1]


def _text(xform, text_id, value, *, markdown=False, safe=False):
    """An itext text ``text_id`` in the form's one translation: its default value and, where ``markdown``, the
    ``markdown`` form HQ's form builder writes beside it for a text typed with formatting."""
    from corehq.util.xml_utils import safe_fromstring
    from lxml import etree

    translation = xform._etree.xpath("./h:head/x:model/x:itext/x:translation", namespaces=xform.ns)[0]
    text = etree.SubElement(translation, _x(xform, "text"), id=text_id)
    forms = [None, "markdown"] if markdown else [None]
    for form in forms:
        if safe:
            element = safe_fromstring(f'<value xmlns="{xform.ns["x"]}">{value}</value>')
            text.append(element)
        else:
            element = etree.SubElement(text, _x(xform, "value"))
            element.text = value
        if form is not None:
            element.set("form", form)


def _question(
    xform,
    name,
    label,
    *,
    tag="input",
    bind_type=None,
    appearance=None,
    mediatype=None,
    hint=None,
    hint_markdown=False,
    help_text=None,
    help_markdown=False,
    safe_label=False,
    parent=None,
):
    """A question HQ's form builder writes and ``XFormBuilder`` has no type for: its data node, its bind (with
    ``type`` where given), its label's itext (``<name>-label``), its control ``tag`` with
    ``appearance`` and ``mediatype`` where given, and a hint (``<name>-hint``) and help text (``<name>-help``)
    where given. ``parent`` is the group ``XFormBuilder`` made it in, as its body element."""
    from lxml import etree

    groups = [] if parent is None else [parent]
    path = xform.get_data_ref(name, groups or None)
    node, last = _node(xform, path)
    etree.SubElement(node, last)
    attrs = {"nodeset": path}
    if bind_type is not None:
        attrs["type"] = bind_type
    xform._model.append(etree.Element(_x(xform, "bind"), attrs))
    _text(xform, xform.get_text_id(name, groups or None), label, safe=safe_label)
    control = etree.Element(_x(xform, tag), ref=path)
    if appearance is not None:
        control.set("appearance", appearance)
    if mediatype is not None:
        control.set("mediatype", mediatype)
    etree.SubElement(control, _x(xform, "label"), ref=f"jr:itext('{xform.get_text_id(name, groups or None)}')")
    if hint is not None:
        hint_id = xform.get_text_id(name, groups or None, is_hint=True)
        _text(xform, hint_id, hint, markdown=hint_markdown)
        etree.SubElement(control, _x(xform, "hint"), ref=f"jr:itext('{hint_id}')")
    if help_text is not None:
        help_id = f"{name}-help"
        _text(xform, help_id, help_text, markdown=help_markdown)
        etree.SubElement(control, _x(xform, "help"), ref=f"jr:itext('{help_id}')")
    body = xform._body if parent is None else _group_body(xform, parent)
    body.append(control)
    return path


def _group_body(xform, name):
    return _child(xform._body, "group", ref=f"/data/{name}")


def _validation_message(xform, path, name, message, *, safe=False):
    """``path``'s bind given ``jr:constraintMsg`` naming the itext ``<name>-constraintMsg``, as HQ's form builder
    writes a validation message."""
    text_id = f"{name}-constraintMsg"
    _text(xform, text_id, message, safe=safe)
    bind = _child(xform._model, "bind", nodeset=path)
    bind.set(xform.get_namespaced("jr:constraintMsg"), f"jr:itext('{text_id}')")


def kinds_source(name):
    """The first form: every question kind, written by ``XFormBuilder`` and, where it has no type, in the shape
    HQ's form builder writes."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder
    from lxml import etree

    xform = XFormBuilder(name)
    _question(
        xform,
        "intro",
        f'Answer each question. The visit was on <output value="{DATE_CHIP}"/>.',
        tag="trigger",
        appearance="minimal",
        safe_label=True,
    )
    xform.new_question("full_name", "Full name", "string", hint="First name and family name")
    _text(xform, "full_name-help", "The name the household is known by")
    full_name = _child(xform._body, "input", ref="/data/full_name")
    etree.SubElement(full_name, _x(xform, "help"), ref="jr:itext('full_name-help')")
    _question(
        xform,
        "phone",
        "Phone number",
        bind_type="xsd:string",
        appearance="numeric",
        hint="Ten digits, **no spaces**",
        hint_markdown=True,
    )
    _question(
        xform,
        "pin",
        "Household PIN",
        tag="secret",
        bind_type="xsd:string",
        help_text="Keep the PIN *private*",
        help_markdown=True,
    )
    xform.new_question("age", "Age", "int", constraint=". >= 0 and . <= 120")
    _validation_message(xform, "/data/age", "age", "Enter an age from 0 to 120")
    _question(xform, "weight", "Weight in kilograms", bind_type="xsd:double")
    xform.new_question("visit_date", "Visit date", "date")
    xform.new_question("visit_time", "Visit time", "time")
    xform.new_question("seen_at", "Seen at", "dateTime")
    _question(xform, "location", "Location", bind_type="geopoint")
    _question(xform, "tag_code", "Tag code", bind_type="barcode")
    xform.new_question("colour", "Door colour", "select1", choices={"red": "Red", "blue": "Blue"})
    xform.new_question("crops", "Crops grown", "select", choices={"maize": "Maize", "beans": "Beans", "rice": "Rice"})
    xform.new_question("crop_count", None, None, calculate="count-selected(/data/crops)")
    _question(xform, "photo", "Photo of the house", tag="upload", bind_type="binary", mediatype=IMAGE_MEDIA)
    _question(
        xform,
        "sign",
        "Signature",
        tag="upload",
        bind_type="binary",
        mediatype=IMAGE_MEDIA,
        appearance="signature",
    )
    _question(xform, "voice", "Voice note", tag="upload", bind_type="binary", mediatype="audio/*")
    _question(xform, "clip", "Video of the field", tag="upload", bind_type="binary", mediatype="video/*")
    _question(xform, "document", "Land document", tag="upload", bind_type="binary", mediatype="application/*,text/*")
    xform.new_question("double_age", None, None, calculate="/data/age * 2")
    # The advanced bind attributes on a no-control value survive Vellum's
    # editor. Core's "integer" is the same data class as "int".
    count_path = xform.get_data_ref("opening_count")
    parent, name = _node(xform, count_path)
    etree.SubElement(parent, name)
    xform._model.append(etree.Element(_x(xform, "bind"), {"nodeset": count_path, "type": "xsd:integer", "calculate": "1"}))

    xform.new_group("details", "Details")
    _group_body(xform, "details").set("appearance", "field-list")
    xform.new_question("nickname", "Nickname", "string", group="details")
    household_size = xform.new_question("household_size", "People in the household", "int")
    members = xform.new_group("members", "Members", data_type="repeatGroup", repeat_count=household_size)
    members.new_question("member_name", "Member name", "string")
    visits_due = xform.new_question("visits_due", None, None, calculate="2")
    checks = xform.new_group("checks", "Checks", data_type="repeatGroup", repeat_count=visits_due)
    checks.new_question("check_note", "Check note", "string")
    xform.new_question("adults", "Adults", "int", constraint=". <= count(/data/members/member_name[. != ''])")
    _validation_message(xform, "/data/adults", "adults", "There are not that many members")
    xform.new_question("children", "Children", "int", constraint=". >= 0")
    _validation_message(
        xform,
        "/data/children",
        "children",
        'You entered <output value="/data/children"/>, and a count starts at zero',
        safe=True,
    )
    rounds = _model_iteration(xform)
    root = _with_vellum_prefix(xform)
    # Set once the root declares the prefix, so lxml writes the attribute under it.
    rounds.set(f"{{{VELLUM}}}role", "Repeat")
    return etree.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")


def _model_iteration(xform):
    """The model-iteration repeat ``rounds``, in the shape HQ's form builder writes one
    (``Vellum/src/modeliteration.js``, ``getExtraDataAttributes``, ``getBindList``, ``getSetValues`` and the
    ``controlChildFilter`` that writes ``jr:count`` and ``jr:noAddRemove``), holding the text question
    ``round_note``, with the ``casedb`` instance its ID query reads declared. Returns the wrapper's data node,
    which takes ``vellum:role`` once the root declares the ``vellum`` prefix."""
    from lxml import etree

    from proof.matrix.bases.hq_expressions import declare_instances

    jr = xform.ns["jr"]
    rounds = etree.SubElement(xform._data, "rounds", ids="", count="", current_index="")
    item = etree.SubElement(rounds, "item", id="", index="")
    item.set(f"{{{jr}}}template", "")
    etree.SubElement(item, "round_note")
    declare_instances(xform, (("casedb", "jr://instance/casedb"),))
    for attrs in (
        {"nodeset": "/data/rounds/@current_index", "calculate": "count(/data/rounds/item)"},
        {"nodeset": "/data/rounds/item"},
        {"nodeset": "/data/rounds/item/round_note", "type": "xsd:string"},
    ):
        xform._model.append(etree.Element(_x(xform, "bind"), attrs))
    for event, ref, value in (
        ("xforms-ready", "/data/rounds/@ids", f"join(' ', {ROUNDS_QUERY})"),
        ("xforms-ready", "/data/rounds/@count", "count-selected(/data/rounds/@ids)"),
        ("jr-insert", "/data/rounds/item/@index", "int(/data/rounds/@current_index)"),
        ("jr-insert", "/data/rounds/item/@id", "selected-at(/data/rounds/@ids, ../@index)"),
    ):
        xform._model.append(etree.Element(_x(xform, "setvalue"), event=event, ref=ref, value=value))
    _text(xform, "rounds-label", "Rounds")
    _text(xform, "rounds/item/round_note-label", "Round note")
    group = etree.SubElement(xform._body, _x(xform, "group"))
    etree.SubElement(group, _x(xform, "label"), ref="jr:itext('rounds-label')")
    repeat = etree.SubElement(group, _x(xform, "repeat"), nodeset="/data/rounds/item")
    repeat.set(f"{{{jr}}}count", "/data/rounds/@count")
    repeat.set(f"{{{jr}}}noAddRemove", "true()")
    note = etree.SubElement(repeat, _x(xform, "input"), ref="/data/rounds/item/round_note")
    etree.SubElement(note, _x(xform, "label"), ref="jr:itext('rounds/item/round_note-label')")
    return rounds


def _with_vellum_prefix(xform):
    """The form's root again, declaring the prefix ``vellum`` as HQ's form builder writes it (``writer.js``):
    its parser reads its attributes by that name (``parser.js``: ``xmlAttr('vellum:ignore')``, and the data
    node's ``vellum:role``), and lxml declares a namespace only on the element made with it."""
    from lxml import etree

    written = xform._etree
    root = etree.Element(written.tag, attrib=dict(written.attrib), nsmap={**written.nsmap, "vellum": VELLUM})
    for child in list(written):
        root.append(child)
    return root


def plain_source(name):
    """The second form, with Disable Text Formatting on: a group of appearance ``field-list`` holding a text
    question, and a text question whose label holds asterisks the form shows as typed."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder
    from lxml import etree

    xform = XFormBuilder(name)
    xform.new_group("contact", "Contact")
    _group_body(xform, "contact").set("appearance", "field-list")
    xform.new_question("contact_phone", "Contact phone", "string", group="contact")
    xform.new_question("said", "Write *exactly* what was said", "string")
    root = _with_vellum_prefix(xform)
    root.set(f"{{{VELLUM}}}ignore", "markdown")
    return etree.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")


# The label of ``contact_phone`` as the second form's upload writes it: a no-break space between its words, which
# HQ's form builder writes as a plain space on every save (``Vellum/src/xml.js``), so it is put in after the save.
CONTACT_PHONE_LABEL = "Contact\u00a0phone"


def _appearance_written_as_hq_reads_it(root, _form):
    """The ``contact`` group's appearance written ``Field-List``, and ``contact_phone``'s label holding a no-break
    space (``CONTACT_PHONE_LABEL``)."""
    namespace = "http://www.w3.org/2002/xforms"
    groups = [group for group in root.iter(f"{{{namespace}}}group") if group.get("ref") == "/data/contact"]
    values = [
        value
        for text in root.iter(f"{{{namespace}}}text")
        if text.get("id") == "contact/contact_phone-label"
        for value in text.iter(f"{{{namespace}}}value")
        if value.get("form") is None
    ]
    if len(groups) != 1 or not values:
        raise ops.MatrixChangeRefused(
            "HQ's form builder saved the second form of hq-questions with no group at /data/contact, or no text"
            " contact/contact_phone-label; the builder uploads both, so look at what the builder now writes."
        )
    groups[0].set("appearance", "Field-List")
    for value in values:
        value.text = CONTACT_PHONE_LABEL
    return None


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.new_survey_module(authoring, app_id, name=MENU)
    _pages.new_form(authoring, app_id, 0)
    ops.upload_form_source(authoring, app_id, 0, 0, kinds_source, "kinds-source")
    ops.upload_form_source(authoring, app_id, 0, 1, plain_source, "plain-source")
    # The second form is saved in the form builder here, before its group's appearance is written in another
    # case, which a later save of the builder's would write in lower case again.
    ops.builder_save(authoring, app_id, 0, 1)
    ops.set_form_source(
        authoring, app_id, 0, 1, _appearance_written_as_hq_reads_it, what="field-list-in-another-case", label="build"
    )
    return app_id


BASE = Base(
    id="hq-questions",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE"})),
    exhibits=(
        "questions/label-trigger-whose-appearance-is-exactly-minimal",
        "questions/text-input-xsd-string",
        "questions/phone-number-xsd-string-appearance-numeric",
        "questions/password-secret-xsd-string",
        "questions/integer-xsd-int-xsd-integer-read-as-the-same",
        "questions/decimal-xsd-double",
        "questions/date-xsd-date",
        "questions/time-xsd-time",
        "questions/date-and-time-xsd-datetime",
        "questions/gps-geopoint",
        "questions/barcode-barcode",
        "questions/multiple-choice-select1-item",
        "questions/checkbox-select-item",
        "questions/image-capture-upload-image",
        "questions/signature-image-signature",
        "questions/audio-capture-audio",
        "questions/video-capture-video",
        "questions/document-upload-application-text",
        "questions/hidden-value-data-node-bind-no-control-with-calculate-or-default",
        "questions/question-list-group-appearance-field-list-labelled",
        "questions/repeat-with-jr-count-naming-an-integer-question-of-the-form-s",
        "questions/jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in",
        "questions/repeat-model-iteration-vellum-role-repeat-ids-count-current",
        "questions/hint-text",
        "questions/help-text-with-no-markdown-form",
        "questions/help-text-markdown-form",
        "questions/bind-constraint",
        "questions/validation-message-text",
        "questions/output-value-any-other-expression",
        "questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable",
    ),
    vellum=((0, 0),),
    declaration=Declaration(runs_only_on=None, split_datetime=True),
)
