"""Bind Android's form title and the name of its completed save to the attachment the session opened."""

from proof.checks import changes
from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml, qname

FORM = "/walks/*/steps/*/form/"
CONTROLLER = "formTitle"
DEFAULT = "FormEntryInstanceState.getDefaultFormTitle"
RECORD = "FormRecord.getDisplayName"
DISPLAY = "saved/records/*/" + RECORD
PATHS = {FORM + name for name in (CONTROLLER, DEFAULT, DISPLAY)}
NS = {"h": "http://www.w3.org/1999/xhtml", "f": "http://www.w3.org/2002/xforms"}
AMBIGUOUS = object()


def candidate(difference):
    return (
        difference.artifact.startswith(("android@", "android-tablet@"))
        and difference.kind == "changed"
        and difference.path in PATHS
    )


def _form(xml):
    if not xml:
        return None
    try:
        root = parse_xml(xml)
    except XmlNotWellFormed:
        return None
    heads = root.findall("h:head", NS)
    if root.tag != f"{{{NS['h']}}}html" or len(heads) != 1:
        return None
    models = heads[0].findall("f:model", NS)
    if len(models) != 1:
        return None
    instances = models[0].findall("f:instance", NS)
    if not instances or instances[0].get("src") or len(instances[0]) != 1:
        return None
    tag = instances[0][0].tag
    if not isinstance(tag, str):
        return None
    namespace = qname(tag)[0]
    titles = heads[0].findall("h:title", NS)
    if len(titles) > 1 or (titles and len(titles[0])):
        # Its namespace is known, so an unsupported title need not disqualify a different form in the suite.
        return namespace, AMBIGUOUS
    # No title leaves FormDef.getTitle() null; the parser's "Form" fallback sets getName() only.
    # XFormParser.parseTitle also reads an empty element as null and trims XML whitespace from text.
    text = titles[0].text if titles else None
    return namespace, text.strip(" \t\r\n") if text is not None else None


def installed(files, differing):
    """Each unambiguous command's installed primary-instance namespace and XForm title."""
    if not files or not files.get("suite.xml") or "suite.xml" in differing:
        return {}
    try:
        suite = parse_xml(files["suite.xml"])
    except XmlNotWellFormed:
        return {}
    resources = {}
    for resource in suite.findall("xform/resource"):
        locations = resource.findall("location[@authority='local']")
        if len(locations) != 1 or not locations[0].text:
            return {}
        path = locations[0].text.removeprefix("./")
        form = _form(files.get(path))
        if form is None or path in differing:
            return {}
        namespace = form[0]
        resources[namespace] = form if namespace not in resources else None
    found = {}
    for entry in suite.findall("entry"):
        commands = entry.findall("command")
        namespaces = entry.findall("form")
        form = resources.get(namespaces[0].text) if len(namespaces) == 1 and len(commands) == 1 else None
        for command in commands:
            place = changes.command_place(command.get("id"))
            if place[:1] == ("form",):
                found[place[1]] = form if place[1] not in found else None
    return found


def expected(app, position, installed, *, before):
    """The retained source attachment's title on A and its form's first-language name on B and local."""
    menu, index = map(int, position.split("."))
    modules, languages = app.get("modules") or [], app.get("langs") or []
    if not languages or menu >= len(modules) or index >= len(modules[menu].get("forms") or []):
        return None
    form = modules[menu]["forms"][index]
    original = _form((app.get("_attachments") or {}).get(f"{form.get('unique_id')}.xml"))
    name = (form.get("name") or {}).get(languages[0])
    # An HQ override of the generated entry label can supply the effective name instead of form.name.
    override = (app.get("translations") or {}).get(languages[0], {})
    if not isinstance(override, dict) or f"forms.m{menu}f{index}" in override:
        return None
    if (
        not original
        or not original[0]
        or original[1] is AMBIGUOUS
        or not isinstance(name, str)
        or not name.strip(" \t\r\n")
    ):
        return None
    new = name.strip(" \t\r\n")
    if original[1] == new:
        return None
    expected = original if before else (original[0], new)
    return expected if installed.get(position) == expected else None


def witnesses(difference, rest, form, expected, *, before):
    """A menu launch's controller title, proposed save name, or the single form record its Finish changed."""
    if expected is None or form.get("loaded") is not True:
        return False
    title = expected[1]
    controller = "null" if title is None else title  # Forms.describe calls String.valueOf.
    if form.get(CONTROLLER) != controller:
        return False
    value = difference.before if before else difference.after
    if difference.path == FORM + CONTROLLER:
        return rest == [CONTROLLER] and value == controller
    # A previously saved instance can supply its own display name. Only this new form's default witnesses the title.
    if DEFAULT not in form or form[DEFAULT] != title:
        return False
    if difference.path == FORM + DEFAULT:
        return rest == [DEFAULT] and value == title
    saved = form.get("saved") or {}
    records = saved.get("records") or []
    if rest != ["saved", "records", "0", RECORD] or not (
        form.get("ended") == "end"
        and form.get("finishShown") is True
        and saved.get("finishing") is True
        and saved.get("resultCode") == -1
        and len(records) == 1
    ):
        return False
    record = records[0]
    # Forms.changedSince saw exactly this completed save. For a null default SaveToDiskTask takes the
    # installed FormDefRecord's display name, which XFormAndroidInstaller.customInstall sets to NAME.
    return (
        record.get("status") == "unsent"
        and record.get("AndroidCommCarePlatform.getFormDefId") == "held"
        and record.get(RECORD) == value == ("NAME" if title is None else title)
    )
