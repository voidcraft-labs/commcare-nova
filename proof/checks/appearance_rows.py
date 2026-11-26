"""The inventory row a body element's ``appearance`` is in, as the lane decides it apart from Nova's reader.

The inventory sorts an appearance by its whole value, on the control it stands on, into exactly one row of
``lib/commcare/surface/entries/questions.json``: a kind's own token (a label's ``minimal``, a Question List's
``field-list``, a signature's ``signature``), one value a row names on that control (``select1 minimal``,
``date ethiopian``), a per-row count, a case variant, a single string Android matches inside, a value no runtime
reads, or a string of several words. The lane also makes a use of each token a runtime reads in the value
(``manifest_usage._appearance_uses``), which the manifest check and the sensitivity check judge as each runtime's
reading; parity joins Nova's reader on the row (``proof.checks.parity``), so this module answers it.

``row_of`` is written from each row's own predicate in the inventory and from the upstream readers each names:
Web Apps' tokens split on a space (``form_ui.js::getMatchingStyles``, ``entries.js::getEntry``), Android's whole
and inside matches (``WidgetFactory.java``: ``buildBasicWidget``, ``buildSelectOne``, ``buildCompactSelectOne``,
``buildSelectMulti``; ``TriggerWidget``), and Core's ``field-list`` (``FormEntryController.isHostWithAppearance``).
It reuses the lane's own value-class readers where a row's class is one (the per-row refusals, the dropped and
unread words, Android's inside matches), never Nova's TypeScript. It answers None for a value whose row it does
not decide (an ``intent:`` value, whitespace no runtime reads otherwise, a lone ``broadcast-`` on a text entry
with no address search): parity reports each such use as undecided, and
``proof/checks/test_appearance_rows.py`` fails where a retained base exhibits one.
"""

from __future__ import annotations

import re
from types import SimpleNamespace

from proof.checks import manifest_value_classes as classes
from proof.checks.manifest_value_classes import XmlAt, _children, _local

Q = "questions/"

# The value each row names on a control, by the control as the inventory names it (``control_kind``).
SINGLE = {
    "select1": {
        "minimal": "select1-minimal",
        "quick": "select1-quick",
        "combobox": "select1-combobox",
        "list": "select1-list",
        "list-nolabel": "select1-list-nolabel",
        "label": "select1-label",
        "button-select": "select1-button-select",
    },
    "select": {
        "minimal": "select-minimal",
        "list": "select-list",
        "list-nolabel": "select-list-nolabel",
        "label": "select-label",
        "quick": "select-combobox-quick-button-select",
        "button-select": "select-combobox-quick-button-select",
    },
    "text": {
        "numbers": "text-secret-numbers",
        "address": "text-address",
    },
    "secret": {
        "numeric": "secret-numeric",
        "numbers": "text-secret-numbers",
        "address": "secret-address",
    },
    "barcode": {
        "numeric": "barcode-numeric-address-or-receive-topic-field",
        "address": "barcode-numeric-address-or-receive-topic-field",
        "quick": "barcode-quick",
        "editable": "barcode-editable",
    },
    "date": {
        "ethiopian": "date-ethiopian",
        "nepali": "date-nepali",
        "gregorian": "date-gregorian-gregorian-cancel",
    },
    "time": {"12-hour": "time-12-hour"},
    "geopoint": {"maps": "geopoint-maps"},
    "image": {"acquire": "image-acquire", "overlay-small": "image-overlay-small"},
    "audio": {
        "legacy": "audio-legacy",
        "acquire": "audio-acquire",
        "acquire-or-upload": "audio-acquire-or-upload",
        "long": "audio-long",
    },
    "video": {"acquire": "video-acquire"},
    "trigger": {"selectable": "trigger-selectable"},
    "group": {
        "compact": "group-compact",
        "group-collapse": "group-group-collapse",
        "collapse-open": "group-collapse-open-without-collapsing",
        "collapse-closed": "group-collapse-closed",
        "group-border": "group-group-border",
    },
}
# The values every question reads, on any control (the numeric input's and document upload's rows set them apart).
EVERY_QUESTION = {
    "short": "short",
    "medium": "medium",
    "text-align-center": "text-align-center-text-align-right",
    "text-align-right": "text-align-center-text-align-right",
}
# The several words a row of its own names, as a set of the words (Android reads them inside the string, Web Apps
# by its tokens: the order changes neither's reading, ``buildCompactSelectOne``, ``buildComboboxSelectOne``).
SEVERAL = (
    ("select1", re.compile(r"(quick (compact(-\d+)?)|(compact(-\d+)?) quick)"), "select1-quick-compact-n"),
    ("select1", re.compile(r"combobox multiword"), "select1-combobox-multiword"),
    ("select1", re.compile(r"combobox fuzzy"), "select1-combobox-fuzzy"),
    ("date", re.compile(r"gregorian cancel"), "date-gregorian-gregorian-cancel"),
)
COMPACT = re.compile(r"compact(-\d+)?")
RECEIVE = re.compile(r"receive-.+-.+")
RECEIVERS = {
    "select1": "select1-receive-topic-field",
    "text": "text-receive-topic-field",
    "secret": "secret-receive-topic-field",
    "barcode": "barcode-numeric-address-or-receive-topic-field",
}
SENDERS = frozenset({"image", "audio", "video", "document"})
FLOATING_STATUS = frozenset({"floating-good", "floating-caution", "floating-bad"})
EXACT_PER_ROW = re.compile(r"\d+-per-row")
EXACT_PER_ROW_REPEAT = re.compile(r"\d+-per-row-repeat")
# Core's data types as the inventory's control names (``XFormParser.getDataType`` over the bind's ``type``).
INPUT_TYPES = {
    "": "text",
    "string": "text",
    "barcode": "barcode",
    "date": "date",
    "time": "time",
    "dateTime": "datetime",
    "geopoint": "geopoint",
    "int": "numeric",
    "integer": "numeric",
    "long": "numeric",
    "decimal": "numeric",
    "double": "numeric",
    "intent": "intent",
}
UPLOADS = {"image/*": "image", "audio/*": "audio", "video/*": "video", "application/*,text/*": "document"}


FORM_ELEMENTS = frozenset({"input", "secret", "select", "select1", "trigger", "upload", "range", "group", "repeat"})


def _form_children(element):
    """The children Core makes form elements of (a label, a hint or a help is the element's own text)."""
    return [child for child in _children(element) if _local(child) in FORM_ELEMENTS]


def _collapses(element) -> bool:
    """Whether Core takes a group for the repeat it wraps: a group whose one form element is a repeat
    (``XFormParser.collapseRepeatGroups``), a Vellum Repeat."""
    children = _form_children(element)
    return _local(element) == "group" and len(children) == 1 and _local(children[0]) == "repeat"


def control_kind(form, element) -> str:
    """The control as the inventory's rows name it: a group Core takes for its repeat is the repeat, and a group
    holding a repeat as a direct child once Core has collapsed its wrappers is a repeat's outer group."""
    local = _local(element)
    if local == "group":
        if _collapses(element):
            return "repeat"
        held = _form_children(element)
        return (
            "repeat-wrapper" if any(_local(child) == "repeat" or _collapses(child) for child in held) else "group"
        )
    if local in ("input", "secret"):
        bind = form.control_bind(element) if isinstance(form, classes.Form) else None
        kind = ((bind.get("type") if bind is not None else None) or "").split(":")[-1]
        if local == "secret":
            return "secret"
        return INPUT_TYPES.get(kind, "input-other")
    if local == "upload":
        return UPLOADS.get(element.get("mediatype"), "upload-other")
    return local


def _untyped(form, element) -> bool:
    bind = form.control_bind(element) if isinstance(form, classes.Form) else None
    return bind is None or not bind.get("type")


def _labelled(element) -> bool:
    label = next((child for child in _children(element) if _local(child) == "label"), None)
    return label is not None and (label.get("ref") or (label.text or "").strip() or len(_children(label)) > 0)


def _question_list(form, element) -> str:
    """The Question List row a ``field-list`` group is in: labelled, a root section (every root field a section and
    no display condition on it), or unlabelled anywhere else."""
    if _labelled(element):
        return "question-list-group-appearance-field-list-labelled"
    body = element.getparent()
    roots = _children(body) if body is not None else []
    sections = all(
        _local(root) == "group" and (root.get("appearance") or "").lower() == "field-list" for root in roots
    )
    bind = form.control_bind(element) if isinstance(form, classes.Form) else None
    shown_always = bind is None or bind.get("relevant") is None
    if body is not None and _local(body) == "body" and sections and shown_always:
        return "question-list-unlabelled-when-every-root-field-is-a-section-and"
    return "question-list-unlabelled-anywhere-else"


def _use(form, element):
    """A use of the element's appearance as the lane's value-class readers take one."""
    return SimpleNamespace(at=XmlAt(form, element), key=None, artifact=form.artifact)


def _reads_any(manifest, form, element, value) -> bool:
    facts = classes.element_facts(manifest, form, element)
    return any(
        rule.reads(facts) and classes.appearance_matches(value, rule) for rule in classes.appearance_rules(manifest)
    )


def _hint_as_placeholder(kind, form, element) -> str:
    """``hint-as-placeholder`` is a text box's placeholder on Web Apps on text other than a secret without
    ``numeric``, numeric, barcode and the ``minimal``/``combobox`` selects; any other entry's otherwise."""
    if kind in ("text", "numeric", "barcode"):
        return "hint-as-placeholder-on-text-other-than-a-secret-without-numeric"
    return "hint-as-placeholder-on-any-other-entry"


def _single(manifest, form, element, kind, value) -> str | None:
    if kind == "repeat":
        return "any-value-on-a-vellum-repeat-written-on-its-wrapping-group-or-on"
    if EXACT_PER_ROW_REPEAT.fullmatch(value):
        return "n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or" if kind == "repeat-wrapper" else (
            "group-repeat-row-without-a-repeat" if kind == "group" else None
        )
    if kind == "repeat-wrapper":
        # Any other value on the group around a repeat is a group's.
        kind = "group"
    control = classes._row_control(form, element)
    if classes._per_row_token(value, False) is not None:
        if classes._per_row_without_leading_digits(value, control):
            return "a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does"
        if classes._per_row_holding_read(manifest, form, element, value, control):
            return "a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-start"
        if EXACT_PER_ROW.fullmatch(value):
            return "n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one"
        return "any-other-per-row-token-the-first-token-web-apps-per-row-pattern"
    if value in EVERY_QUESTION and kind != "group":
        return EVERY_QUESTION[value]
    if value == "hint-as-placeholder" and kind not in ("group", "trigger"):
        return _hint_as_placeholder(kind, form, element)
    if kind == "trigger" and value.startswith("floating-"):
        return (
            "floating-good-floating-caution-floating-bad"
            if value in FLOATING_STATUS
            else "a-label-whose-appearance-string-starts-with-floating-other-than"
        )
    if kind == "datetime" and not value.startswith("intent:"):
        return "datetime-any-value-apart-from-the-values-every-question-reads"
    if kind == "numeric" and value not in FLOATING_STATUS and not value.startswith("intent:"):
        return "numeric-input-int-decimal-any-other-value-apart-from-the-values"
    if kind == "document" and not value.startswith("broadcast-"):
        return "document-upload-any-value-except-broadcast-and-the-values-every"
    if RECEIVE.fullmatch(value) and kind in RECEIVERS:
        return RECEIVERS[kind]
    if value.startswith("broadcast-") and kind in SENDERS:
        return "broadcast-topic-an-address-entry-under-the-gates-above-and"
    if kind == "text" and value == "numeric":
        return "phone-number-xsd-string-appearance-numeric"
    if kind in ("select1", "select") and COMPACT.fullmatch(value):
        return f"{kind}-compact-compact-n"
    if kind == "select" and value.startswith("combobox"):
        return "select-combobox-quick-button-select"
    if value in SINGLE.get(kind, {}):
        return SINGLE[kind][value]
    if value == "field-list" or (value == "compact" and kind not in ("select1", "select", "group")):
        return "field-list-on-any-question-compact-on-a-question-that-is-not-a"
    inside = classes.android_inside_match_other(_use(form, element), manifest)
    if inside is True:
        return "any-other-single-string-no-row-names-that-holds-a-value-android"
    if inside is False and classes._android_inside(manifest, classes.element_facts(manifest, form, element), value):
        return "a-single-string-no-row-names-that-holds-values-android-matches"
    if not _reads_any(manifest, form, element, value):
        return "any-other-value-read-by-no-runtime-not-an-intent-value-on-an"
    return None


def row_of(manifest, form, element) -> str | None:
    """The full id of the inventory row the element's appearance is in, or None where the lane does not decide it."""
    value = element.get("appearance")
    if value is None:
        return None
    kind = control_kind(form, element)
    spaced = " ".join(value.split())
    if spaced != value:
        if classes.appearance_whitespace_read_otherwise(_use(form, element), manifest):
            return Q + "an-appearance-holding-such-whitespace-that-some-runtime-reads"
        return None
    if value.startswith("intent:"):
        return None
    # A kind's own token, as the whole value.
    if kind == "trigger" and value == "minimal":
        return Q + "label-trigger-whose-appearance-is-exactly-minimal"
    if kind in ("group", "repeat-wrapper") and value.lower() == "field-list":
        return Q + _question_list(form, element)
    if kind == "image" and value == "signature":
        return Q + "signature-image-signature"
    if kind == "image" and value == "face":
        return Q + "face-capture-image-face"
    # An untyped text box or secret with ``numeric`` or ``numbers``, ignoring case, as the whole value: its own row,
    # before any case variant's (a Vellum save types the bind and keeps the value, which Android then reads).
    lower = value.lower()
    if lower in ("numeric", "numbers") and kind in ("text", "secret") and _untyped(form, element):
        return Q + (
            "an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring"
            if kind == "text"
            else "a-secret-whose-bind-has-no-type-with-numeric-or-numbers-ignoring"
        )
    # A case variant of a value a whole-value read takes ignoring case.
    if lower != value and " " not in value:
        alike = {"numbers": ("text", "secret"), "nepali": ("date",), "maps": ("geopoint",), "compact": ("group",)}
        apart = {"numeric": ("text", "secret"), "short": ("text", "secret"), "ethiopian": ("date",)}
        if kind in alike.get(lower, ()) or (kind == "video" and lower == "acquire"):
            return Q + "a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of"
        if kind in apart.get(lower, ()):
            return Q + "a-case-variant-of-numeric-short-or-ethiopian-as-the-whole"
    if " " not in value:
        found = _single(manifest, form, element, kind, value)
        return None if found is None else Q + found
    for control, pattern, row in SEVERAL:
        if kind == control and pattern.fullmatch(value):
            return Q + row
    # A collapsing group opened at first, whatever else its value sets: the row beside it takes ``collapse-open``
    # without a collapse setting, which Web Apps ignores (``form_ui.js::Group``: ``collapsible`` from
    # ``group-collapse``, then ``showChildren`` where the group is not collapsible or holds ``collapse-open``).
    if kind in ("group", "repeat-wrapper") and {"group-collapse", "collapse-open"} <= set(value.split(" ")):
        return Q + "group-collapse-open"
    control = classes._row_control(form, element)
    if classes._per_row_without_leading_digits(value, control):
        return Q + "a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does"
    if classes._per_row_holding_read(manifest, form, element, value, control):
        return Q + "a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-start"
    unread = classes.appearance_words(manifest, form, element, value)[1]
    if unread:
        if classes.unread_words_dropped(manifest, form, element, value):
            return Q + "a-multi-token-string-holding-tokens-no-runtime-reads-on-that"
        if classes.appearance_token_no_runtime_reads(_use(form, element), manifest):
            return Q + "any-other-multi-token-string-holding-a-token-no-runtime-reads-on"
        return None
    return Q + "multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2"
